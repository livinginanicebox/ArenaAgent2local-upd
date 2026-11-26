import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, safeStorage } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createRemoteApi } from '../src/remote-api.mjs';
import { RobloxMcpClient } from '../src/roblox-mcp-client.mjs';
import { listWorkspace, readWorkspaceFile, resolveWorkspaceRoot } from '../src/workspace.mjs';
import { assertTrustedUiEvent as assertTrustedDesktopUiEvent } from './trusted-ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ENTRY_PATH = path.resolve(HERE, '..', 'public', 'index.html');
const DEFAULT_PERMISSION_MODE = 'ask';
const FULL_NO_ASK_WARNING = 'you are SERIOUSLY playing with fire right now. please do NOT use this on a main computer and instead ONLY use this on a computer you do NOT care about at all. I\'m serious. like. really serious. PLEASE. LISTEN. this setting is for purely expiermental purposes';
const FULL_NO_ASK_WAIT_MS = 30_000;
const FULL_NO_ASK_CHALLENGE_TTL_MS = 3 * 60_000;
const FULL_NO_ASK_WAIT_NS = BigInt(FULL_NO_ASK_WAIT_MS) * 1_000_000n;
const FULL_NO_ASK_CHALLENGE_TTL_NS = BigInt(FULL_NO_ASK_CHALLENGE_TTL_MS) * 1_000_000n;
let mainWindow = null;
let api = null;
let robloxMcp = null;
let apiPort = null;
let workspaceRoot = null;
let permissionMode = DEFAULT_PERMISSION_MODE;
let fullComputerAccess = false;
let fullComputerNoAskAuthorized = false;
let combinedAccessUnlockChallenge = null;
let combinedAccessUnlockStarting = false;
let ngrokAuthtoken = '';
let savedEncryptedNgrokToken = '';
let pairingToken = createPairingToken();
let tunnelListener = null;
let tunnelStartPromise = null;
let tunnelStopPromise = null;
let tunnelGeneration = 0;
let tunnelUrl = '';
let userConfigPath = '';
let finishingQuit = false;
let allowQuit = false;
let lastPendingCount = 0;

function createPairingToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertTrustedUiEvent(event) {
  return assertTrustedDesktopUiEvent(event, mainWindow, UI_ENTRY_PATH);
}

function clearFullComputerAccess() {
  const wasEnabled = fullComputerAccess;
  fullComputerAccess = false;
  fullComputerNoAskAuthorized = false;
  combinedAccessUnlockChallenge = null;
  if (wasEnabled) pairingToken = createPairingToken();
  return wasEnabled;
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
    appVersion: app.getVersion(),
    workspaceRoot,
    workspaceName: path.basename(workspaceRoot || '') || 'Workspace',
    permissionMode,
    fullComputerAccess,
    tunnelActive: Boolean(tunnelListener),
    tunnelStarting: Boolean(tunnelStartPromise),
    tunnelStopping: Boolean(tunnelStopPromise),
    tunnelUrl,
    ngrokTokenConfigured: Boolean(ngrokAuthtoken),
    ngrokTokenPersistent: Boolean(savedEncryptedNgrokToken),
    pairingTokenHint: pairingToken.slice(-6),
    robloxMcp: robloxMcp?.getState() || { supported: false, installed: false, status: 'unsupported', error: 'Roblox Studio MCP is supported on Windows and macOS.', toolCount: 0, tools: [] },
    tasks: api?.getTasks() || [],
    localApiPort: apiPort,
  };
}

function onRobloxMcpState(state) {
  if (['error', 'disconnected', 'unsupported'].includes(state?.status)) {
    api?.cancelPendingRobloxTasks('Roblox Studio MCP disconnected locally.');
  }
  publishState();
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
    ? fullComputerAccess
      ? 'WARNING: EXTREMELY DANGEROUS FULL-COMPUTER + NO-ASK MODE IS CURRENTLY ACTIVE. File writes, Git commits, terminal commands, and mutating or unknown Roblox Studio MCP tools execute immediately without local approval. Roblox tools can run Luau, change open places, and may access local assets or Roblox services; file tools can reach anywhere this OS account can access. This mode resets when the user stops the link, rotates the key, changes workspace, or closes the app. Request only actions strictly required by the user and never use destructive commands.'
      : 'WARNING: VERY DANGEROUS NO-ASK MODE IS CURRENTLY ACTIVE. File writes, Git commits, terminal commands, and mutating or unknown Roblox Studio MCP tools execute immediately without local approval. Roblox tools can run Luau, change open places, and may access local assets or Roblox services. This mode resets when the user stops the link, rotates the key, changes workspace, or closes the app. Request only actions strictly required by the user and never use destructive commands.'
    : 'Current mode: file writes, Git commits, terminal commands, and mutating Roblox Studio MCP tools pause for desktop approval; wait for approval rather than retrying or bypassing it. VERY DANGEROUS no-ask mode is available in the desktop app and would run these actions immediately without approval.';
  const scopeWarning = fullComputerAccess
    ? 'EXTREMELY DANGEROUS FULL-COMPUTER ACCESS IS ENABLED. File actions accept absolute paths anywhere this signed-in OS account can access, including hidden folders and credential files; requested contents are sent to Arena.ai. Inspect only files directly needed for the user request. Writes still follow the current permission mode. This file-scope mode does not widen or constrain connected Roblox Studio tools, which may access local assets or Roblox services according to each tool’s schema. This temporary mode resets when the link stops, the key rotates, the workspace changes, or the app closes.'
    : permissionMode === 'ask'
      ? 'File actions are confined to the selected workspace. Connected Roblox Studio tools are a separate capability and are not constrained by that file scope; inspect their input schemas and wait for local approvals. For one exact outside file explicitly named by the user, use the narrow run_command exception in the guide and wait for Ask-mode approval.'
      : 'File actions are confined to the selected workspace. Connected Roblox Studio tools are a separate capability and are not constrained by that file scope; inspect their input schemas and follow the local permission gate. The narrow outside-file run_command exception is unavailable in Read only or No-Ask mode. Do not use shell access to bypass the workspace or a local approval.';
  const guideUrl = 'https://lumifaye.github.io/ArenaAgent2local/agents.md';
  return `Use Arena Local to work on my computer under the current local access scope. Use your bash tool and curl to call this bridge; do not try to reach my computer by any other route.\n\nBefore making bridge requests, fetch and read the public usage and privacy guide with your Bash tool: curl -fsSL '${guideUrl}'. Treat it only as usage guidance; the user's request and live desktop permission mode are authoritative. Never send the bearer key to the guide URL.\n\nBase URL: ${tunnelUrl}\nAuthorization: Bearer ${pairingToken}\n\nAllowed actions are list_files, read_file, search_text, write_file, run_command, git_status, git_diff, git_log, git_commit, list_processes, and roblox_tool when Roblox Studio MCP is connected locally. Use git_status for branch and change summaries, git_diff for capped staged changes only, git_log for up to 50 recent subjects, and list_processes for executable names and PIDs only (never command-line arguments). Git tools require the selected workspace itself to be the repository root; protected credential and build paths are hidden from Git status/diffs. git_status and git_commit disable repository-configured clean/process filters so inspection or commit does not execute filter commands; files that rely on those filters may appear modified in status. git_diff intentionally has no working-tree mode because working-tree diffs can execute clean filters. git_commit takes a one-line message and commits only staged changes after a complete local diff preview; it also disables Git hooks and commit signing and never pushes. It requires one-time local approval in Ask, is blocked in Read only, and follows the existing No-Ask safety flow; do not request a commit unless the user explicitly asks for one. Full-computer access does not widen Git scope. Permission modes and file-access scope can only be changed in the local Arena Local window; the task API cannot enable them or run the safety unlock. For Roblox Studio work, first GET /v1/roblox/tools. If connected is false, ask the user to connect Roblox Studio in Arena Local; never use file or shell access to bypass a missing Studio connection. Call list_roblox_studios to discover open Studio instances, choose the one that matches the user's request, then include its non-empty studio_id on every Studio-targeted call; the bridge rejects missing or empty studio_id values. Follow each tool's returned inputSchema. execute_luau requires datamodel_type (Edit, Client, or Server) as well as code. Follow each tool's permission field: known read-only tools can run in Read only mode; mutating or unknown tools require local approval in Ask mode, are blocked in Read only mode, and may run immediately in No-Ask mode. Review exact arguments carefully—Studio tools can run Luau and change open places. Submit a Studio call to POST /v1/tasks as {"requestId":"unique-id-8-or-more-chars","action":"roblox_tool","args":{"name":"execute_luau","arguments":{"studio_id":"...","datamodel_type":"Edit","code":"..."}}}; poll GET /v1/tasks/{taskId} just like other tasks and wait when status is awaiting_approval. Submit other tasks to POST /v1/tasks using JSON {"requestId":"a-unique-id-8-or-more-chars","action":"read_file","args":{"path":"README.md"}} and the Authorization: Bearer header. Poll GET /v1/tasks/{taskId} until status is completed, denied, expired, cancelled, or error. Completed responses contain result. Use a new requestId for each distinct action and reuse it only to retry the same action and arguments. ${scopeWarning} ${writeWarning} Shell commands run with my normal OS permissions and can reach outside the workspace, so request only commands strictly required for my task. Do not print, reuse, or share the bearer token.\n\nExample read request:\ncurl -sS -X POST '${tunnelUrl}/v1/tasks' -H 'Authorization: Bearer ${pairingToken}' -H 'Content-Type: application/json' --data '{"requestId":"readme-demo-01","action":"read_file","args":{"path":"README.md"}}'`;
}

async function confirmNoAskMode() {
  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'VERY DANGEROUS: no-ask mode',
    message: 'Remote file writes, Git commits, terminal commands, and mutating Roblox Studio MCP tools will run without approval.',
    detail: 'Arena can overwrite workspace files, commit staged Git changes, run shell commands with your normal OS-user privileges, and—if Roblox Studio MCP is connected—run Luau or change open Roblox places. Shell commands can access files outside the selected folder. The Git action commits staged changes locally, disables hooks/signing, and never pushes. Anyone holding the pairing key can trigger these actions until you stop the link or rotate the key. Data loss or unintended game changes are possible.',
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
    detail: 'This mode remains active only until you stop the ngrok connection, rotate the pairing key, choose a different workspace, or close Arena Local. The app will not pause for individual writes, Git commits, or shell commands.',
    buttons: ['Keep Ask mode', 'Enable no-ask'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return final.response === 1;
}

async function confirmFullComputerAccess() {
  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'EXTREMELY DANGEROUS: full-computer access',
    message: 'Arena will be able to request files from anywhere this OS account can access.',
    detail: 'This removes the selected-workspace boundary and disables file-tool protections for hidden folders, credential filenames, and absolute paths. File contents you request can be sent over the ngrok tunnel to Arena.ai. Writes still follow Ask or Read only mode. Combining with No-Ask requires a separate, local-only 30-second lockout, slide-to-unlock, and final warning sequence. This is not an OS sandbox and does not elevate permissions. Only continue if you trust the connected Arena session and understand the data exposure risk.',
    buttons: ['Cancel', 'I understand — continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (first.response !== 1) return false;
  const final = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Final confirmation: full-computer access',
    message: 'Enable full-computer access for the next remote connection?',
    detail: 'This session-only mode can expose private files, source code, and credentials to Arena if requested. Reads do not require per-file approval. Writes require local approval in Ask mode. Combining with No-Ask is a separate high-risk flow: exact warning, 30-second lockout, slide-to-unlock, and another native confirmation. The app rotates the pairing key when the mode changes and resets full-computer access when the link stops, the key rotates, the workspace changes, or the app closes.',
    buttons: ['Keep workspace confinement', 'Enable EXTREMELY DANGEROUS mode'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return final.response === 1;
}

async function beginFullComputerNoAskUnlock() {
  if (combinedAccessUnlockStarting) throw new Error('A combined-mode warning is already open. Finish or cancel it first.');
  combinedAccessUnlockStarting = true;
  try {
    return await runFullComputerNoAskUnlockFlow();
  } finally {
    combinedAccessUnlockStarting = false;
  }
}

async function runFullComputerNoAskUnlockFlow() {
  if (!fullComputerAccess) throw new Error('Enable full-computer access first, then request the combined-mode unlock locally.');
  if (permissionMode === 'no-ask') throw new Error('No-Ask mode is already active.');
  const now = process.hrtime.bigint();
  if (combinedAccessUnlockChallenge && now <= combinedAccessUnlockChallenge.expiresAt) {
    throw new Error('A combined-mode unlock is already in progress. Finish or cancel it first.');
  }
  combinedAccessUnlockChallenge = null;
  if (tunnelListener || tunnelStartPromise || tunnelStopPromise) {
    throw new Error('Stop the remote connection before requesting the combined-mode unlock.');
  }
  if ([...(api?.getTasks() || [])].some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status))) {
    throw new Error('Wait for all active requests to finish before starting the combined-mode unlock.');
  }
  const initialScope = { workspaceRoot, permissionMode, pairingToken };

  const first = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'EXTREMELY DANGEROUS · FULL COMPUTER + NO-ASK',
    message: FULL_NO_ASK_WARNING,
    detail: 'This combines unrestricted file-tool scope with automatic writes, Git commits, shell commands, and mutating Roblox Studio MCP tools. Reads can expose private data and credentials to Arena.ai; shell commands run as your OS account, and Studio tools can run Luau or change open places without per-action approval. This is not a sandbox and may permanently destroy data or alter a game. The next step waits 30 seconds and requires a local slide-to-unlock; a final native confirmation is still required. Use only a disposable test computer you are willing to lose.',
    buttons: ['Cancel', 'I understand — begin 30-second lockout'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (first.response !== 1) return null;

  const stillInInitialScope = fullComputerAccess
    && permissionMode === initialScope.permissionMode && permissionMode !== 'no-ask'
    && workspaceRoot === initialScope.workspaceRoot && pairingToken === initialScope.pairingToken;
  const hasActiveTasks = [...(api?.getTasks() || [])].some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
  if (!stillInInitialScope || tunnelListener || tunnelStartPromise || tunnelStopPromise || hasActiveTasks) {
    throw new Error('The local access state changed. No-Ask was not enabled; start the warning sequence again while disconnected.');
  }

  const startedAt = process.hrtime.bigint();
  const challengeId = crypto.randomBytes(24).toString('base64url');
  combinedAccessUnlockChallenge = {
    id: challengeId,
    startedAt,
    expiresAt: startedAt + FULL_NO_ASK_CHALLENGE_TTL_NS,
    workspaceRoot,
    permissionMode,
    pairingToken,
  };
  return { challengeId, waitMs: FULL_NO_ASK_WAIT_MS, expiresInMs: FULL_NO_ASK_CHALLENGE_TTL_MS };
}

async function confirmCombinedFullNoAskStart() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'FINAL LINK WARNING · EXTREMELY DANGEROUS',
    message: FULL_NO_ASK_WARNING,
    detail: 'Starting this public HTTPS tunnel exposes full-computer file reads, unapproved file writes/Git commits/shell commands, and mutating Roblox Studio MCP tools to anyone holding the pairing key. Studio tools can run Luau and change open places; the OS account is not sandboxed. Only start on a disposable test computer with no personal files or credentials. Stop the link immediately when finished.',
    buttons: ['Cancel connection', 'Start FULL PC + NO-ASK link'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function confirmRobloxMcpConnection() {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Connect Roblox Studio MCP?',
    message: 'Arena Local will connect to Roblox Studio’s built-in MCP server.',
    detail: 'The server can inspect open places, edit scripts and instances, run Luau, control playtests, and return screenshots or project data to Arena. Some tools may read local asset paths or access Roblox services; the selected file-workspace boundary does not constrain Studio calls. Mutating and unrecognized tools pause for local approval in Ask mode; Read only blocks them; No-Ask can run them without per-action approval. Connect only to a Studio session and AI workflow you trust.',
    buttons: ['Cancel', 'Connect to Roblox Studio'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function startLocalApi() {
  api = createRemoteApi({
    getWorkspaceRoot: () => workspaceRoot,
    getPairingToken: () => pairingToken,
    getPermissionMode: () => permissionMode,
    getFullComputerAccess: () => fullComputerAccess,
    getFullComputerNoAskAuthorized: () => fullComputerNoAskAuthorized,
    getRobloxMcpState: () => robloxMcp?.getState() || { status: 'disconnected', toolCount: 0 },
    getRobloxMcpTools: () => robloxMcp?.getTools() || [],
    refreshRobloxMcpTools: () => robloxMcp?.refreshTools() || Promise.resolve([]),
    callRobloxMcpTool: (name, args) => robloxMcp?.callTool(name, args) || Promise.reject(new Error('Roblox Studio MCP is not connected.')),
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
  if (finishingQuit) throw new Error('Arena Local is closing.');
  if (combinedAccessUnlockStarting || combinedAccessUnlockChallenge) throw new Error('Finish or cancel the local combined-mode unlock before starting the remote link.');
  if (fullComputerAccess && permissionMode === 'no-ask' && !fullComputerNoAskAuthorized) {
    throw new Error('The local 30-second safety unlock is required for full-computer No-Ask mode.');
  }
  if (tunnelStopPromise) await tunnelStopPromise;
  if (tunnelListener) return snapshot();
  if (tunnelStartPromise) {
    await tunnelStartPromise;
    return snapshot();
  }
  if (!ngrokAuthtoken) throw new Error('Add your ngrok authtoken first. It stays on this computer.');
  if (!apiPort) throw new Error('The local bridge is still starting. Try again in a moment.');

  const generation = tunnelGeneration;
  const attempt = (async () => {
    let listener = null;
    try {
      if (fullComputerAccess && permissionMode === 'no-ask') {
        if (!(await confirmCombinedFullNoAskStart())) throw new Error('The full-computer No-Ask connection was cancelled.');
        if (!fullComputerAccess || permissionMode !== 'no-ask' || !fullComputerNoAskAuthorized) {
          throw new Error('The combined access state changed. No remote connection was started.');
        }
      }
      if (generation !== tunnelGeneration || finishingQuit) throw new Error('Connection attempt was cancelled.');
      const ngrokModule = await import('@ngrok/ngrok');
      const ngrok = ngrokModule.default || ngrokModule;
      listener = await ngrok.forward({ addr: `127.0.0.1:${apiPort}`, authtoken: ngrokAuthtoken });
      const url = listener.url();
      if (!url || !String(url).startsWith('https://')) {
        throw new Error('ngrok did not provide an HTTPS URL. No remote connection was opened.');
      }
      if (generation !== tunnelGeneration || finishingQuit) {
        await Promise.resolve(listener.close()).catch(() => {});
        listener = null;
        throw new Error('Connection attempt was cancelled.');
      }
      tunnelListener = listener;
      tunnelUrl = String(url);
      api.cancelPendingChanges('The remote connection restarted.');
      api.clearApprovedActions();
    } catch (error) {
      if (listener) {
        if (tunnelListener === listener) tunnelListener = null;
        await Promise.resolve(listener.close()).catch(() => {});
      }
      tunnelUrl = '';
      throw new Error(error.message || 'Could not start the ngrok tunnel.');
    }
  })();

  tunnelStartPromise = attempt;
  publishState();
  try {
    await attempt;
  } catch (error) {
    if (clearFullComputerAccess()) {
      if (permissionMode === 'no-ask') {
        permissionMode = 'ask';
        await savePreferences().catch((saveError) => console.error(`[arena-local] Could not persist safe permission mode: ${saveError.message}`));
      }
      publishState();
    }
    throw error;
  } finally {
    if (tunnelStartPromise === attempt) {
      tunnelStartPromise = null;
      publishState();
    }
  }
  return snapshot();
}

async function stopTunnel(reason = 'Remote connection stopped on this computer.') {
  if (tunnelStopPromise) {
    await tunnelStopPromise;
    return snapshot();
  }
  const stopping = Promise.resolve().then(async () => {
    tunnelGeneration += 1;
    const starting = tunnelStartPromise;
    if (starting) await starting.catch(() => {});

    api?.cancelPendingChanges(reason);
    api?.clearApprovedActions();
    clearFullComputerAccess();
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
  });
  tunnelStopPromise = stopping;
  try {
    await stopping;
  } finally {
    if (tunnelStopPromise === stopping) {
      tunnelStopPromise = null;
      publishState();
    }
  }
  return snapshot();
}

function registerIpcHandlers() {
  ipcMain.handle('arena:get-state', (event) => {
    assertTrustedUiEvent(event);
    return snapshot();
  });
  ipcMain.handle('arena:list-files', async (event, relativePath = '.') => {
    assertTrustedUiEvent(event);
    return listWorkspace(workspaceRoot, relativePath);
  });
  ipcMain.handle('arena:read-file', async (event, relativePath) => {
    assertTrustedUiEvent(event);
    return readWorkspaceFile(workspaceRoot, relativePath);
  });
  ipcMain.handle('arena:save-ngrok-token', async (event, token) => {
    assertTrustedUiEvent(event);
    if (tunnelListener || tunnelStartPromise || tunnelStopPromise) throw new Error('Stop the remote connection before changing ngrok credentials.');
    if (typeof token !== 'string' || token.trim().length < 8 || token.trim().length > 300) throw new Error('Enter a valid ngrok authtoken.');
    ngrokAuthtoken = token.trim();
    savedEncryptedNgrokToken = '';
    await savePreferences();
    publishState();
    return { saved: true, persistent: Boolean(savedEncryptedNgrokToken), message: savedEncryptedNgrokToken
      ? 'ngrok authtoken stored using this computer’s secure storage.'
      : 'ngrok authtoken is available until the app closes; OS secure storage was unavailable.' };
  });
  ipcMain.handle('arena:forget-ngrok-token', async (event) => {
    assertTrustedUiEvent(event);
    if (tunnelListener || tunnelStartPromise || tunnelStopPromise || permissionMode === 'no-ask' || fullComputerAccess) await stopTunnel('ngrok credentials were removed.');
    ngrokAuthtoken = '';
    savedEncryptedNgrokToken = '';
    await savePreferences();
    publishState();
    return { forgotten: true };
  });
  ipcMain.handle('arena:start-tunnel', (event) => {
    assertTrustedUiEvent(event);
    return startTunnel();
  });
  ipcMain.handle('arena:stop-tunnel', (event) => {
    assertTrustedUiEvent(event);
    return stopTunnel();
  });
  ipcMain.handle('arena:connect-roblox-mcp', async (event) => {
    assertTrustedUiEvent(event);
    if (finishingQuit) throw new Error('Arena Local is closing.');
    if (combinedAccessUnlockStarting || combinedAccessUnlockChallenge) throw new Error('Finish or cancel the local combined-mode unlock before connecting Roblox Studio MCP.');
    if (robloxMcp?.getState().status === 'connected') return snapshot();
    const activeRobloxTask = api?.getTasks().some((task) => task.action === 'roblox_tool' && ['running', 'preparing', 'awaiting_approval'].includes(task.status));
    if (activeRobloxTask) throw new Error('Wait for active Roblox Studio requests to finish before reconnecting.');
    if (!(await confirmRobloxMcpConnection())) return snapshot();
    try {
      await robloxMcp.connect();
    } catch (error) {
      publishState();
      throw error;
    }
    publishState();
    return snapshot();
  });
  ipcMain.handle('arena:disconnect-roblox-mcp', async (event) => {
    assertTrustedUiEvent(event);
    api?.cancelPendingRobloxTasks('Roblox Studio MCP was disconnected locally.');
    await robloxMcp?.disconnect();
    publishState();
    return snapshot();
  });
  ipcMain.handle('arena:rotate-pairing-token', async (event) => {
    assertTrustedUiEvent(event);
    pairingToken = createPairingToken();
    fullComputerAccess = false;
    fullComputerNoAskAuthorized = false;
    combinedAccessUnlockChallenge = null;
    api?.cancelPendingChanges('Pairing token rotated by the user.');
    api?.clearApprovedActions();
    if (permissionMode === 'no-ask') {
      permissionMode = 'ask';
      await savePreferences();
    }
    publishState();
    return { rotated: true, hint: pairingToken.slice(-6) };
  });
  ipcMain.handle('arena:copy-instructions', (event) => {
    assertTrustedUiEvent(event);
    clipboard.writeText(arenaInstructions());
    return { copied: true };
  });
  ipcMain.handle('arena:copy-tunnel-url', (event) => {
    assertTrustedUiEvent(event);
    if (!tunnelUrl) throw new Error('Start the remote connection before copying its URL.');
    clipboard.writeText(tunnelUrl);
    return { copied: true };
  });
  ipcMain.handle('arena:set-full-computer-access', async (event, enabled) => {
    assertTrustedUiEvent(event);
    if (typeof enabled !== 'boolean') throw new Error('Full-computer access must be enabled or disabled.');
    if (enabled === fullComputerAccess) return snapshot();
    if (tunnelListener || tunnelStartPromise || tunnelStopPromise) {
      throw new Error('Stop the remote connection before changing file-access scope. This takes effect on the next connection.');
    }
    const active = api?.getTasks().some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
    if (active) throw new Error('Wait for active requests to finish before changing file-access scope.');
    if (enabled && permissionMode === 'no-ask') {
      throw new Error('Switch to Ask or Read only before enabling full-computer access. The combined mode has its own local 30-second unlock.');
    }
    if (enabled) {
      if (!(await confirmFullComputerAccess())) return snapshot();
      const activeAfterWarning = api?.getTasks().some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
      if (tunnelListener || tunnelStartPromise || tunnelStopPromise || activeAfterWarning || permissionMode === 'no-ask') {
        throw new Error('The local access state changed while the warning was open. Full-computer access was not enabled.');
      }
    }

    if (enabled) {
      fullComputerAccess = true;
      fullComputerNoAskAuthorized = false;
      combinedAccessUnlockChallenge = null;
      pairingToken = createPairingToken();
    } else {
      clearFullComputerAccess();
      if (permissionMode === 'no-ask') permissionMode = 'ask';
    }
    api?.cancelPendingChanges(`Full-computer access was ${enabled ? 'enabled' : 'disabled'}; the pairing key was rotated.`);
    api?.clearApprovedActions();
    publishState();
    return snapshot();
  });
  ipcMain.handle('arena:begin-full-computer-no-ask-unlock', (event) => {
    assertTrustedUiEvent(event);
    return beginFullComputerNoAskUnlock();
  });
  ipcMain.handle('arena:cancel-full-computer-no-ask-unlock', (event, challengeId) => {
    assertTrustedUiEvent(event);
    if (combinedAccessUnlockChallenge?.id === challengeId) combinedAccessUnlockChallenge = null;
    return { cancelled: true };
  });
  ipcMain.handle('arena:complete-full-computer-no-ask-unlock', async (event, challengeId) => {
    assertTrustedUiEvent(event);
    const challenge = combinedAccessUnlockChallenge;
    if (!challenge || challenge.id !== challengeId) throw new Error('This combined-mode unlock is no longer valid. Start again locally.');
    const nowMonotonic = process.hrtime.bigint();
    if (nowMonotonic - challenge.startedAt < FULL_NO_ASK_WAIT_NS) {
      throw new Error('The full 30-second safety wait has not finished yet.');
    }
    if (nowMonotonic > challenge.expiresAt) {
      combinedAccessUnlockChallenge = null;
      throw new Error('The safety unlock expired. Start the full warning sequence again.');
    }
    const connectionActive = Boolean(tunnelListener || tunnelStartPromise || tunnelStopPromise);
    const activeTasks = [...(api?.getTasks() || [])].some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
    const permissionModeUnchanged = permissionMode === challenge.permissionMode && permissionMode !== 'no-ask';
    const scopeUnchanged = fullComputerAccess && permissionModeUnchanged
      && workspaceRoot === challenge.workspaceRoot && pairingToken === challenge.pairingToken;
    if (connectionActive || activeTasks || !scopeUnchanged) {
      combinedAccessUnlockChallenge = null;
      throw new Error('The local access state changed. No-Ask was not enabled; start the unlock again while disconnected.');
    }

    const keepModeLabel = challenge.permissionMode === 'read-only' ? 'Cancel — keep Read only' : 'Cancel — keep Ask mode';
    const final = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'FINAL CONFIRMATION · EXTREMELY DANGEROUS',
      message: FULL_NO_ASK_WARNING,
      detail: 'You are about to expose full-computer file access plus automatic writes, Git commits, shell commands, and mutating Roblox Studio MCP tools to the next Arena connection. Studio tools can run Luau and change open places; nothing is sandboxed from this OS account. A copied pairing key can trigger actions until you stop the link or rotate the key. This setting is temporary and will not survive a connection stop or app restart.',
      buttons: [keepModeLabel, 'Enable FULL PC + NO-ASK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const stillValid = combinedAccessUnlockChallenge === challenge
      && process.hrtime.bigint() <= challenge.expiresAt
      && !tunnelListener && !tunnelStartPromise && !tunnelStopPromise
      && ![...(api?.getTasks() || [])].some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status))
      && fullComputerAccess && permissionMode === challenge.permissionMode && permissionMode !== 'no-ask'
      && workspaceRoot === challenge.workspaceRoot && pairingToken === challenge.pairingToken;
    combinedAccessUnlockChallenge = null;
    if (final.response !== 1 || !stillValid) {
      if (!stillValid && final.response === 1) throw new Error('The local access state changed. No-Ask was not enabled.');
      return snapshot();
    }

    permissionMode = 'no-ask';
    fullComputerNoAskAuthorized = true;
    pairingToken = createPairingToken();
    api?.cancelPendingChanges('EXTREMELY DANGEROUS full-computer No-Ask mode was enabled.');
    api?.clearApprovedActions();
    publishState();
    return snapshot();
  });
  ipcMain.handle('arena:set-permission-mode', async (event, mode) => {
    assertTrustedUiEvent(event);
    if (!['ask', 'read-only', 'no-ask'].includes(mode)) throw new Error('Unsupported permission mode.');
    if (mode === 'no-ask' && fullComputerAccess) {
      throw new Error('Use the local 30-second slide-to-unlock flow to combine full-computer access with No-Ask.');
    }
    if (mode === 'no-ask' && permissionMode !== 'no-ask' && !(await confirmNoAskMode())) return snapshot();
    if (permissionMode !== mode) {
      const previousMode = permissionMode;
      combinedAccessUnlockChallenge = null;
      fullComputerNoAskAuthorized = false;
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
  ipcMain.handle('arena:approve-task', async (event, taskId, decision) => {
    assertTrustedUiEvent(event);
    const result = await api.approveTask(taskId, decision);
    publishState();
    return result;
  });
  ipcMain.handle('arena:choose-workspace', async (event) => {
    assertTrustedUiEvent(event);
    if (tunnelListener || tunnelStartPromise || tunnelStopPromise) throw new Error('Stop the remote connection before changing the workspace.');
    const active = api?.getTasks().some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status));
    if (active) throw new Error('Wait for active requests to finish before changing the workspace.');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the folder Arena may work in',
      defaultPath: workspaceRoot,
      properties: process.platform === 'darwin' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return snapshot();
    workspaceRoot = await resolveWorkspaceRoot(result.filePaths[0]);
    clearFullComputerAccess();
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
    backgroundColor: '#07101f',
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
  robloxMcp = new RobloxMcpClient({
    clientInfo: { name: 'arena-local', version: app.getVersion() },
    onState: onRobloxMcpState,
  });
  await startLocalApi();
  registerIpcHandlers();
  createWindow();
}

async function cleanup() {
  await stopTunnel('The Arena Local app is closing.');
  api?.cancelPendingRobloxTasks('The Arena Local app is closing.');
  await robloxMcp?.disconnect();
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
