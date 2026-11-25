let appState = null;
let browserPath = '.';
let toastTimer = null;
let lastCompletedWrites = '';

const $ = (selector) => document.querySelector(selector);
const els = {
  workspaceName: $('#workspaceName'),
  workspacePath: $('#workspacePath'),
  sidebarWorkspaceName: $('#sidebarWorkspaceName'),
  sidebarWorkspacePath: $('#sidebarWorkspacePath'),
  connectionPill: $('#connectionPill'),
  connectionLabel: $('#connectionLabel'),
  navConnectionDot: $('#navConnectionDot'),
  navApprovalCount: $('#navApprovalCount'),
  bridgeStepMark: $('#bridgeStepMark'),
  ngrokSetup: $('#ngrokSetup'),
  liveConnection: $('#liveConnection'),
  ngrokTokenInput: $('#ngrokTokenInput'),
  ngrokTokenStatus: $('#ngrokTokenStatus'),
  tokenIndicator: $('#tokenIndicator'),
  forgetNgrokTokenBtn: $('#forgetNgrokTokenBtn'),
  startTunnelBtn: $('#startTunnelBtn'),
  tunnelUrl: $('#tunnelUrl'),
  pairingHint: $('#pairingHint'),
  permissionMode: $('#permissionMode'),
  permissionDescription: $('#permissionDescription'),
  changeRule: $('#changeRule'),
  approvalQueue: $('#approvalQueue'),
  approvalCount: $('#approvalCount'),
  activityList: $('#activityList'),
  fileBreadcrumbs: $('#fileBreadcrumbs'),
  fileList: $('#fileList'),
  fileFoot: $('#fileFoot'),
  fileDialog: $('#fileDialog'),
  toast: $('#toast'),
};

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3_300);
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayName(value) {
  if (!value || value === '.') return appState?.workspaceName || 'Workspace';
  return String(value).split(/[\\/]/).filter(Boolean).at(-1) || value;
}

function applyState(state) {
  if (!state) return;
  const wasLive = Boolean(appState?.tunnelActive);
  appState = state;
  const name = state.workspaceName || displayName(state.workspaceRoot);
  const root = state.workspaceRoot || '—';
  els.workspaceName.textContent = name;
  els.workspacePath.textContent = root;
  els.workspacePath.title = root;
  els.sidebarWorkspaceName.textContent = name;
  els.sidebarWorkspacePath.textContent = root;
  els.permissionMode.value = state.permissionMode || 'ask';
  updatePermissionCopy();
  updateConnectionPanel();
  renderApprovals();
  renderActivity();

  const writeSignature = (state.tasks || []).filter((task) => task.action === 'write_file' && task.status === 'completed').map((task) => task.taskId).join('|');
  if (writeSignature !== lastCompletedWrites) {
    lastCompletedWrites = writeSignature;
    if (writeSignature) loadFiles(browserPath);
  }
  if (wasLive && !state.tunnelActive) showToast('Remote connection stopped. The public URL is no longer active.');
}

function updateConnectionPanel() {
  const live = Boolean(appState?.tunnelActive && appState?.tunnelUrl);
  const configured = Boolean(appState?.ngrokTokenConfigured);
  els.connectionPill.classList.toggle('live', live);
  els.connectionPill.classList.toggle('disconnected', !live);
  els.connectionLabel.textContent = live ? 'REMOTE LINK ACTIVE' : 'REMOTE LINK OFF';
  els.navConnectionDot.classList.toggle('live', live);
  els.bridgeStepMark.textContent = live ? '02 / CONNECTED' : configured ? '02 / READY' : '01 / SET UP';
  els.ngrokSetup.hidden = live;
  els.liveConnection.hidden = !live;
  els.startTunnelBtn.disabled = !configured;
  els.tunnelUrl.textContent = appState?.tunnelUrl || '—';
  els.tunnelUrl.title = appState?.tunnelUrl || '';
  els.pairingHint.textContent = configured ? (appState?.pairingTokenHint || '••••••') : '••••••';
  els.tokenIndicator.classList.toggle('saved', configured);
  els.ngrokTokenStatus.textContent = !configured
    ? 'No ngrok token saved'
    : appState.ngrokTokenPersistent
      ? 'ngrok token stored with this computer’s secure storage'
      : 'ngrok token available for this session only';
  els.forgetNgrokTokenBtn.hidden = !configured;
  els.ngrokTokenInput.placeholder = configured ? 'Saved token — leave blank to keep' : 'Paste ngrok authtoken';
}

function updatePermissionCopy() {
  const readOnly = els.permissionMode.value === 'read-only';
  els.permissionDescription.textContent = readOnly
    ? 'Arena can inspect files, but writes and terminal commands are blocked.'
    : 'Reads are available. Writes and commands pause for your desktop approval.';
  els.changeRule.textContent = readOnly ? 'BLOCK' : 'ASK';
  els.changeRule.classList.toggle('blocked-state', readOnly);
}

function taskTitle(task) {
  const args = task.args || {};
  switch (task.action) {
    case 'list_files': return `List files · ${args.path || '.'}`;
    case 'read_file': return `Read · ${args.path || 'file'}`;
    case 'search_text': return `Search · “${String(args.query || '').slice(0, 45)}”`;
    case 'write_file': return `Write · ${args.path || 'file'}`;
    case 'run_command': return `Run · ${String(args.command || '').slice(0, 45)}`;
    default: return task.action || 'Remote request';
  }
}

function requestStatusLabel(status) {
  return ({
    running: 'Running',
    preparing: 'Preparing approval preview',
    awaiting_approval: 'Waiting for you',
    completed: 'Completed',
    denied: 'Denied',
    expired: 'Expired',
    cancelled: 'Cancelled',
    error: 'Failed',
  })[status] || status;
}

function renderApprovals() {
  const pending = (appState?.tasks || []).filter((task) => task.status === 'awaiting_approval');
  els.approvalCount.textContent = String(pending.length);
  els.approvalCount.classList.toggle('pending', pending.length > 0);
  els.navApprovalCount.textContent = String(pending.length);
  els.navApprovalCount.classList.toggle('pending', pending.length > 0);
  els.approvalQueue.replaceChildren();
  if (!pending.length) {
    const empty = makeElement('div', 'empty-state');
    empty.append(makeElement('span', 'empty-orbit', '◇'));
    const copy = makeElement('div');
    copy.append(makeElement('strong', '', 'Nothing needs approval'));
    copy.append(makeElement('p', '', 'When Arena requests a file write or terminal command, review it here first.'));
    empty.append(copy);
    els.approvalQueue.append(empty);
    return;
  }
  for (const task of pending) els.approvalQueue.append(renderApprovalCard(task));
}

function appendDiff(pre, preview) {
  const before = String(preview?.before || '').split('\n');
  const after = String(preview?.after || '').split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (preview?.exists && prefix === before.length && prefix === after.length) {
    pre.textContent = 'No visible text changes.';
    return;
  }
  if (preview?.exists && prefix > 2) pre.append(makeElement('span', 'diff-context', `… ${prefix - 2} unchanged line(s) above …\n`));
  if (preview?.exists && prefix > 0) pre.append(makeElement('span', 'diff-context', before.slice(Math.max(0, prefix - 2), prefix).map((line) => `  ${line}`).join('\n') + '\n'));
  if (preview?.exists) {
    const removed = before.slice(prefix, before.length - suffix).map((line) => `− ${line}`).join('\n');
    if (removed) pre.append(makeElement('span', 'diff-removed', removed + '\n'));
  }
  const added = after.slice(preview?.exists ? prefix : 0, preview?.exists ? after.length - suffix : after.length).map((line) => `+ ${line}`).join('\n');
  if (added) pre.append(makeElement('span', 'diff-added', added + '\n'));
  if (preview?.exists && suffix > 0) pre.append(makeElement('span', 'diff-context', after.slice(after.length - suffix, after.length - suffix + 2).map((line) => `  ${line}`).join('\n') + '\n'));
  if (preview?.exists && suffix > 2) pre.append(makeElement('span', 'diff-context', `… ${suffix - 2} unchanged line(s) below …`));
}

function renderApprovalCard(task) {
  const card = makeElement('article', 'remote-approval-card');
  const head = makeElement('div', 'remote-approval-head');
  const change = task.action === 'write_file' || task.action === 'run_command';
  head.append(makeElement('span', 'remote-approval-icon', task.action === 'run_command' ? '$' : '✎'));
  const title = makeElement('div', 'remote-approval-title');
  title.append(makeElement('strong', '', taskTitle(task)));
  title.append(makeElement('small', '', `Arena request · ${task.requestId}`));
  head.append(title, makeElement('span', 'pending-tag', 'NEEDS APPROVAL'));
  card.append(head);
  card.append(makeElement('div', 'remote-approval-description', task.action === 'run_command'
    ? 'This exact shell command will run from your workspace with your OS account permissions. It is not sandboxed.'
    : 'Arena is asking to change a file in the selected workspace. Review the complete proposed diff.'));

  if (task.action === 'run_command') {
    const warning = makeElement('div', 'preview-box');
    warning.append(makeElement('div', 'preview-label', 'Exact command'));
    warning.append(makeElement('pre', '', task.args?.command || ''));
    card.append(warning);
    card.append(makeElement('div', 'command-warning', '⚠  Shell can reach files outside this workspace. Only approve commands you understand.'));
  } else if (task.preview) {
    const box = makeElement('div', 'preview-box');
    box.append(makeElement('div', 'preview-label', task.preview.exists ? 'Proposed diff' : 'New file contents'));
    const diff = document.createElement('pre');
    appendDiff(diff, task.preview);
    box.append(diff);
    card.append(box);
  }

  const controls = makeElement('div', 'approval-buttons');
  controls.append(approvalButton(task, 'Approve once', 'approve', 'approve-once'));
  controls.append(approvalButton(task, 'Allow exact action for session', 'approve_session', 'approve-session'));
  controls.append(approvalButton(task, 'Deny', 'deny', 'deny-action'));
  card.append(controls);
  return card;
}

function approvalButton(task, label, decision, className) {
  const button = makeElement('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    const siblings = button.parentElement.querySelectorAll('button');
    siblings.forEach((item) => { item.disabled = true; });
    try {
      await window.arenaLocal.approveTask(task.taskId, decision);
      showToast(decision === 'deny' ? 'Request denied.' : decision === 'approve_session' ? 'Exact action approved for this connection.' : 'Action approved.');
    } catch (error) {
      siblings.forEach((item) => { item.disabled = false; });
      showToast(error.message, true);
    }
  });
  return button;
}

function renderActivity() {
  const tasks = [...(appState?.tasks || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  els.activityList.replaceChildren();
  if (!tasks.length) {
    els.activityList.append(makeElement('div', 'empty-activity', 'No requests yet. Start a connection, then prompt Arena.ai to inspect your workspace.'));
    return;
  }
  for (const task of tasks) {
    const row = makeElement('div', 'activity-row');
    const change = task.action === 'write_file' || task.action === 'run_command';
    row.append(makeElement('span', `activity-action-icon${change ? ' change' : ''}`, task.action === 'run_command' ? '$' : change ? '✎' : '⌕'));
    const main = makeElement('div', 'activity-main');
    main.append(makeElement('strong', '', taskTitle(task)));
    main.append(makeElement('small', '', task.resultSummary || requestStatusLabel(task.status)));
    row.append(main);
    const isError = ['denied', 'expired', 'cancelled', 'error'].includes(task.status);
    row.append(makeElement('span', `activity-state${task.status === 'awaiting_approval' || task.status === 'preparing' ? ' waiting' : isError ? ' error' : ''}`));
    els.activityList.append(row);
  }
}

async function runUiAction(action, successMessage) {
  try {
    const result = await action();
    if (result) applyState(result);
    if (successMessage) showToast(successMessage);
    return result;
  } catch (error) {
    showToast(error.message || 'Action failed.', true);
    return null;
  }
}

async function loadFiles(relativePath = browserPath) {
  browserPath = relativePath || '.';
  renderBreadcrumbs();
  els.fileList.replaceChildren(makeElement('div', 'loading-row', 'Loading files…'));
  try {
    const data = await window.arenaLocal.listFiles(browserPath);
    renderFileList(data);
  } catch (error) {
    els.fileList.replaceChildren(makeElement('div', 'empty-files', error.message));
  }
}

function renderBreadcrumbs() {
  els.fileBreadcrumbs.replaceChildren();
  const root = makeElement('button', '', displayName('.'));
  root.type = 'button';
  root.addEventListener('click', () => loadFiles('.'));
  els.fileBreadcrumbs.append(root);
  if (browserPath === '.') return;
  let current = '';
  for (const part of browserPath.split('/').filter(Boolean)) {
    els.fileBreadcrumbs.append(makeElement('span', '', '/'));
    current = current ? `${current}/${part}` : part;
    const target = current;
    const button = makeElement('button', '', part);
    button.type = 'button';
    button.addEventListener('click', () => loadFiles(target));
    els.fileBreadcrumbs.append(button);
  }
}

function fileGlyph(name) {
  const ext = name.split('.').at(-1)?.toLowerCase();
  if (['js', 'mjs', 'ts', 'tsx', 'jsx', 'py'].includes(ext)) return '◇';
  if (['md', 'txt', 'rst'].includes(ext)) return '≡';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '{}';
  if (['css', 'scss', 'html'].includes(ext)) return '◈';
  return '·';
}

function renderFileList(data) {
  els.fileList.replaceChildren();
  const entries = data.entries || [];
  if (!entries.length) {
    els.fileList.append(makeElement('div', 'empty-files', 'This folder is empty.'));
    return;
  }
  for (const entry of entries) {
    const row = makeElement('button', 'file-row');
    row.type = 'button';
    const directory = entry.type === 'directory';
    row.append(makeElement('span', `file-icon${directory ? ' folder' : ''}`, directory ? '▰' : fileGlyph(entry.name)));
    row.append(makeElement('span', 'file-name', entry.name));
    if (entry.protected) row.append(makeElement('span', 'file-locked', 'LOCKED'));
    else if (directory) row.append(makeElement('span', 'file-chevron', '›'));
    row.disabled = entry.protected || entry.type === 'symlink' || (!directory && entry.type !== 'file');
    row.title = entry.protected ? 'Protected file or symbolic link.' : entry.path;
    if (!row.disabled) row.addEventListener('click', () => directory ? loadFiles(entry.path) : openFile(entry.path));
    els.fileList.append(row);
  }
  els.fileFoot.textContent = data.truncated ? 'Showing the first 300 items.' : 'Arena only receives files it asks to read in this folder.';
}

async function openFile(filePath) {
  try {
    const file = await window.arenaLocal.readFile(filePath);
    $('#fileDialogTitle').textContent = filePath.split('/').at(-1) || filePath;
    $('#filePreviewMeta').textContent = `${filePath} · ${file.bytes.toLocaleString()} bytes`;
    $('#filePreview').textContent = file.content;
    els.fileDialog.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveNgrokToken() {
  const value = els.ngrokTokenInput.value.trim();
  if (!value && appState?.ngrokTokenConfigured) {
    showToast('An ngrok token is already saved. Leave the field blank to keep it.');
    return;
  }
  const button = $('#saveNgrokTokenBtn');
  button.disabled = true;
  try {
    const result = await window.arenaLocal.saveNgrokToken(value);
    els.ngrokTokenInput.value = '';
    const state = await window.arenaLocal.getState();
    applyState(state);
    showToast(result.message || 'ngrok token saved.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function startTunnel() {
  const button = els.startTunnelBtn;
  button.disabled = true;
  button.textContent = 'Starting secure link…';
  try {
    const state = await window.arenaLocal.startTunnel();
    applyState(state);
    showToast('Remote link is active. Copy the Arena setup prompt.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.innerHTML = '<span class="start-icon">↗</span><span>Start remote connection</span>';
    button.disabled = !appState?.ngrokTokenConfigured || appState?.tunnelActive;
  }
}

async function stopTunnel() {
  if (!window.confirm('Stop the remote link and revoke the current Arena connection?')) return;
  await runUiAction(() => window.arenaLocal.stopTunnel(), 'Remote link stopped and pending approvals denied.');
}

async function rotatePairingKey() {
  if (!window.confirm('Rotate the bearer key? This revokes the current Arena instructions and denies any pending approvals.')) return;
  try {
    const result = await window.arenaLocal.rotatePairingToken();
    applyState(await window.arenaLocal.getState());
    showToast(`Pairing key rotated. New ending: ${result.hint}`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function forgetNgrokToken() {
  if (!window.confirm('Forget the saved ngrok authtoken? The remote connection will stop first.')) return;
  try {
    await window.arenaLocal.forgetNgrokToken();
    applyState(await window.arenaLocal.getState());
    showToast('ngrok token removed.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyArenaInstructions() {
  try {
    await window.arenaLocal.copyArenaInstructions();
    showToast('Arena setup prompt copied. Paste it into your Arena.ai conversation.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyTunnelUrl() {
  try {
    await window.arenaLocal.copyTunnelUrl();
    showToast('Public API URL copied. Keep the bearer key private.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function changePermission() {
  const mode = els.permissionMode.value;
  updatePermissionCopy();
  try {
    applyState(await window.arenaLocal.setPermissionMode(mode));
    showToast(mode === 'read-only' ? 'Read only mode enabled; pending changes were denied.' : 'Changes now require desktop approval.');
  } catch (error) {
    els.permissionMode.value = appState?.permissionMode || 'ask';
    updatePermissionCopy();
    showToast(error.message, true);
  }
}

async function chooseWorkspace() {
  const result = await runUiAction(() => window.arenaLocal.chooseWorkspace());
  if (result) {
    browserPath = '.';
    await loadFiles('.');
    showToast('Workspace folder updated.');
  }
}

$('#saveNgrokTokenBtn').addEventListener('click', saveNgrokToken);
$('#startTunnelBtn').addEventListener('click', startTunnel);
$('#stopTunnelBtn').addEventListener('click', stopTunnel);
$('#copyArenaPromptBtn').addEventListener('click', copyArenaInstructions);
$('#copyUrlBtn').addEventListener('click', copyTunnelUrl);
$('#rotatePairingBtn').addEventListener('click', rotatePairingKey);
$('#rotatePairingTopBtn').addEventListener('click', rotatePairingKey);
$('#forgetNgrokTokenBtn').addEventListener('click', forgetNgrokToken);
$('#chooseWorkspaceBtn').addEventListener('click', chooseWorkspace);
$('#refreshFilesBtn').addEventListener('click', () => loadFiles(browserPath));
$('#permissionMode').addEventListener('change', changePermission);
$('#closeFileBtn').addEventListener('click', () => els.fileDialog.close());

for (const link of document.querySelectorAll('.nav-item')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = link.getAttribute('href');
    if (target) document.querySelector(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === link));
  });
}

async function init() {
  try {
    appState = await window.arenaLocal.getState();
    applyState(appState);
    await loadFiles('.');
    window.arenaLocal.onState(applyState);
  } catch (error) {
    showToast(error.message || 'Arena Local could not initialize.', true);
  }
}

init();
