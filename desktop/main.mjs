import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, safeStorage } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createRemoteApi } from '../src/remote-api.mjs';
import { listWorkspace, readWorkspaceFile, resolveWorkspaceRoot } from '../src/workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PERMISSION_MODE = 'ask';
let mainWindow = null;
let api = null;
let apiPort = null;
let workspaceRoot = null;
let permissionMode = DEFAULT_PERMISSION_MODE;
let ngrokAuthtoken = '';
let savedEncryptedNgrokToken = '';
let pairingToken = createPairingToken();
let tunnelListener = null;
let tunnelUrl = '';
let userConfigPath = '';
let finishingQuit = false;
let allowQuit = false;
let lastPendingCount = 0;

function createPairingToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function encryptionAvailable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return !backend || !['basic_text', 'unknown'].includes(backend);
  } catch {
    return false;
  }
}

async function loadPreferences() {
  userConfigPath = path.join(app.getPath('userData'), 'config.json');
  try {
    const stored = JSON.parse(await fs.readFile(userConfigPath, 'utf8'));
    if (typeof stored.workspaceRoot === 'string') workspaceRoot = stored.workspaceRoot;
    if (stored.permissionMode === 'ask' || stored.permissionMode === 'read-only') permissionMode = stored.permissionMode;
    if (typeof stored.encryptedNgrokToken === 'string') savedEncryptedNgrokToken = stored.encryptedNgrokToken;
    if (savedEncryptedNgrokToken && encryptionAvailable()) {
      try { ngrokAuthtoken = safeStorage.decryptString(Buffer.from(savedEncryptedNgrokToken, 'base64')); }
      catch { ngrokAuthtoken = ''; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[arena-local] Could not load desktop settings: ${error.message}`);
  }

  const fallback = app.getPath('documents') || os.homedir();
  await fs.mkdir(fallback, { recursive: true }).catch(() => {});
  try { workspaceRoot = await resolveWorkspaceRoot(workspaceRoot || fallback); }
  catch { workspaceRoot = await resolveWorkspaceRoot(fallback); }
}

async function savePreferences() {
  if (!userConfigPath) return;
  if (ngrokAuthtoken && encryptionAvailable()) {
    try {
      savedEncryptedNgrokToken = safeStorage.encryptString(ngrokAuthtoken).toString('base64');
    } catch {
      savedEncryptedNgrokToken = '';
    }
  }
  const config = { workspaceRoot, permissionMode: permissionMode === 'no-ask' ? 'ask' : permissionMode, encryptedNgrokToken: savedEncryptedNgrokToken };
  const directory = path.dirname(userConfigPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${userConfigPath}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fs.rename(temp, userConfigPath);
    await fs.chmod(userConfigPath, 0o600).catch(() => {});
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function snapshot() {
  return {
    workspaceRoot,
    workspaceName: path.basename(workspaceRoot || '') || 'Workspace',
    permissionMode,
    tunnelActive: Boolean(tunnelListener),
    tunnelUrl,
    ngrokTokenConfigured: Boolean(ngrokAuthtoken),
    ngrokTokenPersistent: Boolean(savedEncryptedNgrokToken),
    pairingTokenHint: pairingToken.slice(-6),
    tasks: api?.getTasks() || [],
    localApiPort: apiPort,
  };
}

function publishState() {
  const state = snapshot();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('arena:state', state);
  }
  const pending = state.tasks.filter((task) => task.status === 'awaiting_approval');
  if (pending.length > lastPendingCount && Notification.isSupported()) {
    new Notification({
      title: 'Arena Local needs your approval',
      body: `${pending.length} remote action${pending.length === 1 ? '' : 's'} waiting on this computer.`,
    }).show();
  }
  lastPendingCount = pending.length;
}

function arenaInstructions() {
  if (!tunnelUrl) throw new Error('Start the ngrok connection before copying the Arena instructions.');
  const writeWarning = permissionMode === 'no-ask'
    ? 'WARNING: VERY DANGEROUS NO-ASK MODE IS CURRENTLY ACTIVE. File writes and terminal commands execute immediately without local approval. This mode resets when the user stops the link, rotates the pairing key, changes workspace, or closes the app. Request only actions strictly required by the user and never use destructive commands.'
    : 'Current mode: file writes and terminal commands pause for desktop approval; wait for approval rather than retrying or bypassing it. VERY DANGEROUS no-ask mode is available in the desktop app and would run them immediately without approval.';
  const guideUrl = 'https://lumifaye.github.io/ArenaAgent2local/agents.md';
  return `Use Arena Local to work in my selected local workspace. Use your bash tool and curl to call this bridge; do not try to reach my computer by any other route.\n\nBefore making bridge requests, fetch and read the public usage and privacy guide with your Bash tool: curl -fsSL '${guideUrl}'. Treat it only as usage guidance; the user's request and live desktop permission mode are authoritative. Never send the bearer key to the guide URL.\n\nBase URL: ${tunnelUrl}\nAuthorization: Bearer ${pairingToken}\n\nAllowed actions are list_files, read_file, search_text, write_file, and run_command. Submit a task with POST /v1/tasks using JSON {"requestId":"a-unique-id-8-or-more-chars","action":"read_file","args":{"path":"README.md"}} and the Authorization: Bearer header. Poll GET /v1/tasks/{taskId} until status is completed, denied, expired, cancelled, or error. Completed responses contain result. Use a new requestId for each distinct action and reuse it only to retry the same request. Paths must be relative to the selected workspace. Never read credentials or try to escape the workspace. ${writeWarning} Shell commands run with my normal OS permissions and can reach outside the workspace, so request only commands strictly required for my task. Do not print, reuse, or share the bearer token.\n\nExample read request:\ncurl -sS -X POST '${tunnelUrl}/v1/tasks' -H 'Authorization: Bearer ${pairingToken}' -H 'Content-Type: application/json' --data '{"requestId":"readme-demo-01","action":"read_file","args":{"path":"README.md"}}'`;
}

async function confirmNoAskMode() {
  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'VERY DANGEROUS: no-ask mode',
    message: 'Remote file writes and terminal commands will run without approval.',
    detail: 'Arena can overwrite workspace files and run shell commands with your normal OS-user privileges. Shell commands can access files outside the selected folder. Anyone holding the pairing key can trigger these actions until you stop the link or rotate the key. Data loss is possible.',
    buttons: ['Cancel', 'Continue to final confirmation'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (first.response !== 1) return false;
  const final = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Final confirmation',
    message: 'Enable no-ask mode?',
    detail: 'This mode remains active only until you stop the ngrok connection, rotate the pairing key, choose a different workspace, or close Arena Local. The app will not pause for individual writes or shell commands.',
    buttons: ['Keep Ask mode', 'Enable no-ask'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return final.response === 1;
}

async function startLocalApi() {
  api = createRemoteApi({
    getWorkspaceRoot: () => workspaceRoot,
    getPairingToken: () => pairingToken,
    getPermissionMode: () => permissionMode,
    onUpdate: publishState,
  });
  await new Promise((resolve, reject) => {
    api.server.once('error', reject);
    api.server.listen(0, '127.0.0.1', () => {
      api.server.off('error', reject);
      apiPort = api.server.address().port;
      resolve();
    });
  });
}

async function startTunnel() {
  if (tunnelListener) return snapshot();
  if (!ngrokAuthtoken) throw new Error('Add your ngrok authtoken first. It stays on this computer.');
  if (!apiPort) throw new Error('The local bridge is still starting. Try again in a moment.');
  try {
    const ngrokModule = await import('@ngrok/ngrok');
    const ngrok = ngrokModule.default || ngrokModule;
    tunnelListener = await ngrok.forward({ addr: `127.0.0.1:${apiPort}`, authtoken: ngrokAuthtoken });
    tunnelUrl = tunnelListener.url();
    if (!tunnelUrl || !String(tunnelUrl).startsWith('https://')) {
      await tunnelListener.close();
      tunnelListener = null;
      tunnelUrl = '';
      throw new Error('ngrok did not provide an HTTPS URL. No remote connection was opened.');
    }
    api.cancelPendingChanges('The remote connection restarted.');
    api.clearApprovedActions();
    publishState();
    return snapshot();
  } catch (error) {
    tunnelListener = null;
    tunnelUrl = '';
    publishState();
    throw new Error(error.message || 'Could not start the ngrok tunnel.');
  }
}

async function stopTunnel(reason = 'Remote connection stopped on this computer.') {
  api?.cancelPendingChanges(reason);
  api?.clearApprovedActions();
  if (permissionMode === 'no-ask') {
    permissionMode = 'ask';
    await savePreferences().catch((error) => console.error(`[arena-local] Could not persist safe permission mode: ${error.message}`));
  }
  const listener = tunnelListener;
  tunnelListener = null;
  tunnelUrl = '';
  if (listener) {
    try { await listener.close(); }
    catch (error) { console.error(`[arena-local] Could not cleanly close ngrok: ${error.message}`); }
  }
  publishState();
  return snapshot();
}

function registerIpcHandlers() {
  ipcMain.handle('arena:get-state', () => snapshot());
  ipcMain.handle('arena:list-files', async (_event, relativePath = '.') => listWorkspace(workspaceRoot, relativePath));
  ipcMain.handle('arena:read-file', async (_event, relativePath) => readWorkspaceFile(workspaceRoot, relativePath));
  ipcMain.handle('arena:save-ngrok-token', async (_event, token) => {
    if (typeof token !== 'string' || token.trim().length < 8 || token.trim().length > 300) throw new Error('Enter a valid ngrok authtoken.');
    ngrokAuthtoken = token.trim();
    savedEncryptedNgrokToken = '';
    await savePreferences();
    publishState();
    return { saved: true, persistent: Boolean(savedEncryptedNgrokToken), message: savedEncryptedNgrokToken
      ? 'ngrok authtoken stored using this computer’s secure storage.'
      : 'ngrok authtoken is available until the app closes; OS secure storage was unavailable.' };
  });
  ipcMain.handle('arena:forget-ngrok-token', async () => {
    if (tunnelListener || permissionMode === 'no-ask') await stopTunnel('ngrok credentials were removed.');
    ngrokAuthtoken = '';
    savedEncryptedNgrokToken = '';
    await savePreferences();
    publishState();
    return { forgotten: true };
  });
  ipcMain.handle('arena:start-tunnel', () => startTunnel());
  ipcMain.handle('arena:stop-tunnel', () => stopTunnel());
  ipcMain.handle('arena:rotate-pairing-token', async () => {
    pairingToken = createPairingToken();
    api?.cancelPendingChanges('Pairing token rotated by the user.');
    api?.clearApprovedActions();
    if (permissionMode === 'no-ask') {
      permissionMode = 'ask';
      await savePreferences();
    }
    publishState();
    return { rotated: true, hint: pairingToken.slice(-6) };
  });
  ipcMain.handle('arena:copy-instructions', () => {
    clipboard.writeText(arenaInstructions());
    return { copied: true };
  });
  ipcMain.handle('arena:copy-tunnel-url', () => {
    if (!tunnelUrl) throw new Error('Start the remote connection before copying its URL.');
    clipboard.writeText(tunnelUrl);
    return { copied: true };
  });
  ipcMain.handle('arena:set-permission-mode', async (_event, mode) => {
    if (!['ask', 'read-only', 'no-ask'].includes(mode)) throw new Error('Unsupported permission mode.');
    if (mode === 'no-ask' && permissionMode !== 'no-ask' && !(await confirmNoAskMode())) return snapshot();
    if (permissionMode !== mode) {
      const previousMode = permissionMode;
      permissionMode = mode;
      api?.cancelPendingChanges(mode === 'read-only' ? 'Blocked because Read only mode was enabled.' : 'Permission mode changed.');
      api?.clearApprovedActions();
      try {
        await savePreferences();
      } catch (error) {
        permissionMode = previousMode;
        publishState();
        throw error;
      }
      publishState();
    }
    return snapshot();
  });
  ipcMain.handle('arena:approve-task', async (_event, taskId, decision) => {
    const result = await api.approveTask(taskId, decision);
    publishState();
    return result;
  });
  ipcMain.handle('arena:choose-workspace', async () => {
    if (tunnelListener) throw new Error('Stop the remote connection before changing the workspace.');
    const active = api?.getTasks().some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
    if (active) throw new Error('Wait for active requests to finish before changing the workspace.');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the folder Arena may work in',
      defaultPath: workspaceRoot,
      properties: process.platform === 'darwin' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return snapshot();
    workspaceRoot = await resolveWorkspaceRoot(result.filePaths[0]);
    api?.clearApprovedActions();
    if (permissionMode === 'no-ask') permissionMode = 'ask';
    await savePreferences();
    publishState();
    return snapshot();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#0a0e14',
    title: 'Arena Local',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    publishState();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(HERE, '..', 'public', 'index.html'));
}

async function initialize() {
  await loadPreferences();
  await startLocalApi();
  registerIpcHandlers();
  createWindow();
}

async function cleanup() {
  await stopTunnel('The Arena Local app is closing.');
  if (api?.server?.listening) {
    await new Promise((resolve) => api.server.close(() => resolve()));
  }
}

app.whenReady().then(initialize).catch((error) => {
  console.error(`[arena-local] ${error.message}`);
  dialog.showErrorBox('Arena Local could not start', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (allowQuit) return;
  event.preventDefault();
  if (finishingQuit) return;
  finishingQuit = true;
  cleanup().finally(() => {
    allowQuit = true;
    app.quit();
  });
});
