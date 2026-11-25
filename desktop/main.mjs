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
  const config = { workspaceRoot, permissionMode, encryptedNgrokToken: savedEncryptedNgrokToken };
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
  return `Use Arena Local to work in my selected local workspace. Use your bash tool and curl to call this bridge; do not try to reach my computer by any other route.\n\nBase URL: ${tunnelUrl}\nAuthorization: Bearer ${pairingToken}\n\nAllowed actions are list_files, read_file, search_text, write_file, and run_command. Submit a task with POST /v1/tasks using JSON {"requestId":"a-unique-id-8-or-more-chars","action":"read_file","args":{"path":"README.md"}} and the Authorization: Bearer header. Poll GET /v1/tasks/{taskId} until status is completed, denied, expired, cancelled, or error. Completed responses contain result. Use a new requestId for each distinct action and reuse it only to retry the same request. Paths must be relative to the selected workspace. Never read credentials or try to escape the workspace. File writes and terminal commands pause for approval in my desktop app; wait for approval rather than retrying or bypassing it. Shell commands run with my normal OS permissions, so request only commands required for my task. Do not print, reuse, or share the bearer token.\n\nExample read request:\ncurl -sS -X POST '${tunnelUrl}/v1/tasks' -H 'Authorization: Bearer ${pairingToken}' -H 'Content-Type: application/json' --data '{"requestId":"readme-demo-01","action":"read_file","args":{"path":"README.md"}}'`;
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
    if (tunnelListener) await stopTunnel('ngrok credentials were removed.');
    ngrokAuthtoken = '';
    savedEncryptedNgrokToken = '';
    await savePreferences();
    publishState();
    return { forgotten: true };
  });
  ipcMain.handle('arena:start-tunnel', () => startTunnel());
  ipcMain.handle('arena:stop-tunnel', () => stopTunnel());
  ipcMain.handle('arena:rotate-pairing-token', () => {
    pairingToken = createPairingToken();
    api?.cancelPendingChanges('Pairing token rotated by the user.');
    api?.clearApprovedActions();
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
    if (mode !== 'ask' && mode !== 'read-only') throw new Error('Unsupported permission mode.');
    if (permissionMode !== mode) {
      permissionMode = mode;
      api?.cancelPendingChanges(mode === 'read-only' ? 'Blocked because Read only mode was enabled.' : 'Permission mode changed.');
      api?.clearApprovedActions();
      await savePreferences();
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
