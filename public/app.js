let appState = null;
let browserPath = '.';
let fileLoadSequence = 0;
let currentFileEntries = [];
let currentFileTruncated = false;
let toastTimer = null;
let lastCompletedWrites = '';
let combinedUnlockChallengeId = '';
let combinedUnlockReadyAt = 0;
let combinedUnlockExpiresAt = 0;
let combinedUnlockWorkspaceRoot = '';
let combinedUnlockPermissionMode = '';
let combinedUnlockPairingHint = '';
let combinedUnlockTimer = null;
let combinedUnlockSliderUnlocked = false;
let combinedUnlockStarting = false;

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
  saveNgrokTokenBtn: $('#saveNgrokTokenBtn'),
  ngrokTokenStatus: $('#ngrokTokenStatus'),
  tokenIndicator: $('#tokenIndicator'),
  forgetNgrokTokenBtn: $('#forgetNgrokTokenBtn'),
  startTunnelBtn: $('#startTunnelBtn'),
  startTunnelLabel: $('#startTunnelLabel'),
  cancelTunnelBtn: $('#cancelTunnelBtn'),
  startNote: $('#startNote'),
  chooseWorkspaceBtn: $('#chooseWorkspaceBtn'),
  workspaceScopeIcon: $('#workspaceScopeIcon'),
  workspaceScopeCopy: $('#workspaceScopeCopy'),
  fullComputerAccessBtn: $('#fullComputerAccessBtn'),
  fullComputerAccessCopy: $('#fullComputerAccessCopy'),
  fullComputerAccessBanner: $('#fullComputerAccessBanner'),
  credentialRule: $('#credentialRule'),
  appVersion: $('#appVersion'),
  tunnelUrl: $('#tunnelUrl'),
  pairingHint: $('#pairingHint'),
  permissionMode: $('#permissionMode'),
  sidebarSecurityCopy: $('#sidebarSecurityCopy'),
  bridgeDisclaimerCopy: $('#bridgeDisclaimerCopy'),
  permissionDescription: $('#permissionDescription'),
  changeRule: $('#changeRule'),
  dangerModeBanner: $('#dangerModeBanner'),
  dangerModeTitle: $('#dangerModeTitle'),
  dangerModeCopy: $('#dangerModeCopy'),
  fullComputerAccessBannerCopy: $('#fullComputerAccessBannerCopy'),
  fullNoAskUnlockDialog: $('#fullNoAskUnlockDialog'),
  fullNoAskCountdown: $('#fullNoAskCountdown'),
  fullNoAskProgress: $('#fullNoAskProgress'),
  fullNoAskSlider: $('#fullNoAskSlider'),
  continueFullNoAskUnlock: $('#continueFullNoAskUnlock'),
  cancelFullNoAskUnlock: $('#cancelFullNoAskUnlock'),
  approvalQueue: $('#approvalQueue'),
  approvalCount: $('#approvalCount'),
  activityList: $('#activityList'),
  robloxMcpBadge: $('#robloxMcpBadge'),
  robloxMcpStatus: $('#robloxMcpStatus'),
  robloxMcpStatusText: $('#robloxMcpStatusText'),
  robloxMcpError: $('#robloxMcpError'),
  robloxMcpToolsSummary: $('#robloxMcpToolsSummary'),
  robloxMcpToolsList: $('#robloxMcpToolsList'),
  connectRobloxMcpBtn: $('#connectRobloxMcpBtn'),
  disconnectRobloxMcpBtn: $('#disconnectRobloxMcpBtn'),
  fileBreadcrumbs: $('#fileBreadcrumbs'),
  fileFilter: $('#fileFilter'),
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
  const previousWorkspace = appState?.workspaceRoot;
  appState = state;
  if (combinedUnlockChallengeId && (
    !state.fullComputerAccess
    || state.permissionMode !== combinedUnlockPermissionMode
    || state.workspaceRoot !== combinedUnlockWorkspaceRoot
    || state.pairingTokenHint !== combinedUnlockPairingHint
    || state.tunnelActive || state.tunnelStarting || state.tunnelStopping
    || (state.tasks || []).some((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status))
  )) {
    void cancelCombinedUnlock();
  }
  if (previousWorkspace && previousWorkspace !== state.workspaceRoot) {
    browserPath = '.';
    currentFileEntries = [];
    currentFileTruncated = false;
    if (els.fileFilter) els.fileFilter.value = '';
  }
  const name = state.workspaceName || displayName(state.workspaceRoot);
  const root = state.workspaceRoot || '—';
  els.workspaceName.textContent = name;
  els.workspacePath.textContent = root;
  els.workspacePath.title = root;
  els.sidebarWorkspaceName.textContent = name;
  els.sidebarWorkspacePath.textContent = root;
  if (els.appVersion && state.appVersion) els.appVersion.textContent = `v${state.appVersion}`;
  els.permissionMode.value = state.permissionMode || 'ask';
  updatePermissionCopy();
  updateConnectionPanel();
  updateRobloxMcpPanel();
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
  const starting = Boolean(appState?.tunnelStarting);
  const stopping = Boolean(appState?.tunnelStopping);
  const busy = starting || stopping;
  const configured = Boolean(appState?.ngrokTokenConfigured);
  els.connectionPill.classList.toggle('live', live);
  els.connectionPill.classList.toggle('connecting', busy && !live);
  els.connectionPill.classList.toggle('disconnected', !live && !busy);
  els.connectionLabel.textContent = live ? 'REMOTE LINK ACTIVE' : starting ? 'CONNECTING…' : stopping ? 'STOPPING…' : 'REMOTE LINK OFF';
  els.navConnectionDot.classList.toggle('live', live);
  els.navConnectionDot.classList.toggle('connecting', busy && !live);
  els.bridgeStepMark.textContent = live ? '02 / CONNECTED' : starting ? '02 / CONNECTING' : stopping ? '02 / STOPPING' : configured ? '02 / READY' : '01 / SET UP';
  els.ngrokSetup.hidden = live;
  els.liveConnection.hidden = !live;
  els.startTunnelBtn.disabled = !configured || busy || live;
  els.startTunnelBtn.setAttribute('aria-busy', String(busy));
  els.startTunnelLabel.textContent = starting
    ? 'Opening secure link…'
    : stopping
      ? 'Stopping…'
      : appState?.fullComputerAccess && appState?.permissionMode === 'no-ask'
        ? 'Start FULL PC + NO-ASK link'
        : appState?.fullComputerAccess
          ? 'Start EXTREMELY DANGEROUS link'
          : 'Start remote connection';
  els.startTunnelBtn.classList.toggle('full-access', Boolean(appState?.fullComputerAccess));
  els.cancelTunnelBtn.hidden = !starting || stopping;
  els.startNote.textContent = starting
    ? 'Creating the temporary HTTPS link. You can cancel the attempt.'
    : stopping
      ? 'Closing the temporary link…'
      : appState?.fullComputerAccess && appState?.permissionMode === 'no-ask'
        ? 'EXTREMELY DANGEROUS: final native confirmation required; full file access and writes/commands without approval.'
        : appState?.fullComputerAccess
          ? 'EXTREMELY DANGEROUS: this link can expose all files your OS account can access.'
          : 'The public link is created only when you start it.';
  els.chooseWorkspaceBtn.disabled = live || busy;
  els.chooseWorkspaceBtn.title = live || busy ? 'Stop the remote connection before changing folders.' : 'Choose the local folder Arena may access.';
  els.ngrokTokenInput.disabled = busy;
  els.saveNgrokTokenBtn.disabled = busy;
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

function updateRobloxMcpPanel() {
  const mcp = appState?.robloxMcp || {};
  const status = mcp.status || 'disconnected';
  const connected = status === 'connected';
  const busy = status === 'connecting' || status === 'disconnecting';
  const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
  const labels = {
    connected: `Connected · ${mcp.toolCount ?? tools.length} tools available`,
    connecting: 'Starting the local Studio MCP process…',
    disconnecting: 'Disconnecting from Studio…',
    error: 'Roblox Studio MCP connection failed',
    unsupported: 'Roblox Studio MCP is not supported on this operating system',
    disconnected: mcp.installed === false ? 'Roblox Studio MCP launcher not found' : 'Not connected',
  };
  els.robloxMcpStatus.dataset.state = status;
  els.robloxMcpStatusText.textContent = labels[status] || labels.disconnected;
  els.robloxMcpBadge.textContent = status === 'connected' ? 'CONNECTED'
    : status === 'connecting' ? 'CONNECTING…'
      : status === 'disconnecting' ? 'STOPPING…'
        : status === 'error' ? 'ERROR'
          : status === 'unsupported' ? 'UNSUPPORTED'
            : mcp.installed === false ? 'NOT FOUND' : 'OFFLINE';
  const message = mcp.error || (mcp.supported && mcp.installed === false
    ? 'Install or update Roblox Studio, then enable Assistant → Manage MCP Servers → Enable Studio as MCP server.'
    : '');
  els.robloxMcpError.textContent = message;
  els.robloxMcpError.hidden = !message;
  els.connectRobloxMcpBtn.hidden = connected;
  els.connectRobloxMcpBtn.disabled = busy || !mcp.supported || mcp.installed === false;
  els.connectRobloxMcpBtn.textContent = status === 'connecting' ? 'Connecting…' : 'Connect Roblox Studio';
  els.disconnectRobloxMcpBtn.hidden = !connected;
  els.disconnectRobloxMcpBtn.disabled = busy;
  els.robloxMcpToolsSummary.textContent = `Available tools · ${connected ? (mcp.toolCount ?? tools.length) : 0}`;
  els.robloxMcpToolsList.replaceChildren();
  if (!connected || !tools.length) {
    els.robloxMcpToolsList.append(makeElement('li', '', connected ? 'Studio has not reported any tools.' : 'Connect to Studio to discover its tools.'));
    return;
  }
  for (const tool of tools) {
    const item = document.createElement('li');
    item.append(makeElement('span', '', tool.name));
    const permissionLabel = tool.permission === 'read-only' ? 'READ ONLY' : 'APPROVAL REQUIRED';
    const description = String(tool.description || '').trim();
    item.append(makeElement('small', '', description ? `${permissionLabel} · ${description}` : permissionLabel));
    els.robloxMcpToolsList.append(item);
  }
}

function updateScopePanel() {
  const fullComputerAccess = Boolean(appState?.fullComputerAccess);
  const live = Boolean(appState?.tunnelActive || appState?.tunnelStarting || appState?.tunnelStopping);
  const noAsk = els.permissionMode.value === 'no-ask';
  const noAskOption = els.permissionMode.querySelector('option[value="no-ask"]');
  noAskOption.disabled = false;
  noAskOption.textContent = fullComputerAccess
    ? 'No approval — EXTREMELY DANGEROUS (local unlock required)'
    : 'No approval — VERY DANGEROUS';
  els.workspaceScopeIcon.textContent = fullComputerAccess ? '!' : '✓';
  els.workspaceScopeIcon.classList.toggle('full-access-scope-icon', fullComputerAccess);
  els.workspaceScopeCopy.textContent = fullComputerAccess
    ? 'Full computer access is active; file tools are no longer workspace-confined.'
    : 'Remote file actions stay inside this folder.';
  els.fullComputerAccessBtn.textContent = fullComputerAccess ? 'Disable full-computer access' : 'Enable EXTREMELY DANGEROUS access';
  els.fullComputerAccessBtn.classList.toggle('active', fullComputerAccess);
  els.fullComputerAccessBtn.disabled = live || (!fullComputerAccess && noAsk);
  els.fullComputerAccessBtn.setAttribute('aria-pressed', String(fullComputerAccess));
  els.fullComputerAccessBtn.title = live
    ? 'Stop the remote connection before changing access scope.'
    : noAsk && !fullComputerAccess
      ? 'Switch to Ask or Read only before enabling full-computer access.'
      : fullComputerAccess
        ? 'Disable this temporary mode and rotate the pairing key.'
        : 'EXTREMELY DANGEROUS: requires two local warnings and removes the workspace boundary.';
  els.fullComputerAccessCopy.textContent = fullComputerAccess
    ? noAsk
      ? 'EXTREMELY DANGEROUS: Arena can read private files and credentials; writes, Git commits, shell commands, and mutating Roblox Studio tools run without local approval. Stop the link to disable both modes and rotate the key.'
      : 'EXTREMELY DANGEROUS: private files and credentials may be readable and sent to Arena. Ask mode requires local approval for writes, Git commits, and mutating Studio tools. Git actions remain scoped to the selected repository root. No-Ask is available only through the local 30-second slide-to-unlock safety flow.'
    : noAsk
      ? 'EXTREMELY DANGEROUS. Switch to Ask or Read only before enabling full-computer access.'
      : 'EXTREMELY DANGEROUS. Two native warnings required. Must be enabled while disconnected; resets when the link stops. Combining with No-Ask requires a separate 30-second local slide-to-unlock and final warning.';
  els.fullComputerAccessBannerCopy.textContent = noAsk
    ? 'Full-computer access is combined with No-Ask: file reads can expose private files and credentials to Arena.ai; writes, Git commits, shell commands, and mutating Roblox Studio tools run immediately without per-action approval. Stop the link to disable this mode and rotate the pairing key.'
    : 'Arena can list, read, search, and request writes anywhere this OS account can access, including private and credential files. Requested contents can be sent to Arena.ai. Writes, Git commits, and mutating Studio tools follow the selected permission mode; Git stays rooted at the selected repository. Stop the remote link to disable full-computer access and rotate the pairing key.';
  els.fullComputerAccessBanner.hidden = !fullComputerAccess;
  els.credentialRule.textContent = fullComputerAccess ? 'ACCESSIBLE' : 'BLOCK';
  els.credentialRule.classList.toggle('full-access-rule', fullComputerAccess);
  els.fileFoot.textContent = fullComputerAccess
    ? 'Remote file tools can use absolute paths anywhere this OS account can access. This desktop preview remains in the selected folder.'
    : 'Arena can only see files in the selected folder.';
}

function updatePermissionCopy() {
  const mode = els.permissionMode.value;
  const readOnly = mode === 'read-only';
  const noAsk = mode === 'no-ask';
  const fullComputerAccess = Boolean(appState?.fullComputerAccess);
  els.sidebarSecurityCopy.textContent = fullComputerAccess
    ? noAsk
      ? 'EXTREMELY DANGEROUS: Arena can read files anywhere and run writes, Git commits, commands, and mutating Roblox Studio tools without approval.'
      : 'EXTREMELY DANGEROUS: Arena can read files anywhere this OS account can access. Writes, Git commits, and Roblox Studio changes still follow your permission mode; Git remains scoped to the selected repository.'
    : noAsk
      ? 'VERY DANGEROUS: Arena can write files, commit staged Git changes, run shell commands, and change Roblox Studio without approval.'
      : readOnly
        ? 'File reads, Git inspection, process names/PIDs, and known read-only Studio tools are available. Writes, Git commits, commands, and other Studio tools are blocked.'
        : 'Arena can only request scoped actions. File writes, Git commits, shell commands, and changing Roblox Studio tools wait for you here.';
  els.bridgeDisclaimerCopy.textContent = fullComputerAccess
    ? noAsk
      ? 'EXTREMELY DANGEROUS: full-computer reads plus automatic file writes, Git commits, shell commands, and mutating Roblox Studio calls are active. Private data may be sent to Arena.ai; commands run with your normal OS-user permissions.'
      : 'EXTREMELY DANGEROUS full-computer access is on. Arena can read private and credential files; requested contents are sent to Arena.ai. Writes, Git commits, and mutating Studio tools still follow your permission mode; Git remains rooted at the selected repository.'
    : noAsk
      ? 'VERY DANGEROUS: writes, Git commits, shell commands, and mutating Roblox Studio tools execute immediately without desktop approval. Stop the link, rotate the key, or switch to Ask or Read only to disable this mode.'
      : readOnly
        ? 'The bearer key lets Arena read files in this workspace. File writes, Git commits, shell commands, and mutating Roblox Studio tools are blocked in Read only mode.'
        : 'The bearer key lets Arena read files in this workspace. Writes, Git commits, commands, and mutating Roblox Studio tools pause for desktop approval unless you enable VERY DANGEROUS no-ask mode.';
  els.permissionDescription.textContent = fullComputerAccess
    ? noAsk
      ? 'EXTREMELY DANGEROUS: file reads can reach any location; writes, Git commits, commands, and mutating Studio tools run without approval. Git remains scoped to the selected repository.'
      : readOnly
        ? 'EXTREMELY DANGEROUS: file reads can reach any location; writes, Git commits, commands, and mutating Studio tools are blocked.'
        : 'EXTREMELY DANGEROUS: file reads can reach any location. Writes, Git commits, commands, and mutating Studio tools wait for local approval.'
    : noAsk
      ? 'VERY DANGEROUS: every remote write, Git commit, shell command, and mutating Studio tool runs immediately without approval.'
      : readOnly
        ? 'Arena can inspect files, Git history/diffs, and process names/PIDs and use known read-only Studio tools; writes, Git commits, commands, and other Studio tools are blocked.'
        : 'Reads and local Git/process inspection are available. Writes, Git commits, commands, and mutating Studio calls pause for your desktop approval.';
  els.changeRule.textContent = noAsk ? 'AUTO' : readOnly ? 'BLOCK' : 'ASK';
  els.changeRule.classList.toggle('blocked-state', readOnly);
  els.changeRule.classList.toggle('no-ask-state', noAsk);
  els.dangerModeTitle.textContent = fullComputerAccess
    ? 'EXTREMELY DANGEROUS · FULL COMPUTER + NO-ASK ACTIVE'
    : 'VERY DANGEROUS · NO-ASK MODE ACTIVE';
  els.dangerModeCopy.textContent = fullComputerAccess
    ? 'Full-computer reads and automatic file writes, Git commits, shell commands, and mutating Roblox Studio tools are active. Actions run as your OS user or in open Studio without per-action approval. Stop the link, rotate the key, or close Arena Local to disable this mode.'
    : 'Arena file writes, Git commits, terminal commands, and mutating Roblox Studio tools execute immediately. Shell commands can reach files outside the selected workspace. Stop the link, rotate the key, choose a different folder, switch to Ask or Read only, or close Arena Local to disable this mode.';
  els.dangerModeBanner.hidden = !noAsk;
  updateScopePanel();
}

function taskTitle(task) {
  const args = task.args || {};
  switch (task.action) {
    case 'list_files': return `List files · ${args.path || '.'}`;
    case 'read_file': return `Read · ${args.path || 'file'}`;
    case 'search_text': return `Search · “${String(args.query || '').slice(0, 45)}”`;
    case 'write_file': return `Write · ${args.path || 'file'}`;
    case 'run_command': return `Run · ${String(args.command || '').slice(0, 45)}`;
    case 'git_status': return 'Git status';
    case 'git_diff': return 'Git diff · staged changes';
    case 'git_log': return `Git log · ${args.limit || 20} commits`;
    case 'git_commit': return `Git commit · ${String(args.message || '').slice(0, 45)}`;
    case 'list_processes': return 'List running processes';
    case 'roblox_tool': return `Roblox Studio · ${args.name || 'MCP tool'}`;
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
    const emptyMessage = appState?.permissionMode === 'no-ask'
      ? 'No actions pause here. File writes, Git commits, shell commands, and mutating Roblox Studio tools can run without a prompt.'
      : appState?.permissionMode === 'read-only'
        ? 'File writes, Git commits, shell commands, and mutating Roblox Studio tools are blocked in Read only mode.'
        : 'When Arena requests a file write, Git commit, terminal command, or changing Roblox Studio tool, review it here first.';
    copy.append(makeElement('p', '', emptyMessage));
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
  const isRobloxTool = task.action === 'roblox_tool';
  const isGitCommit = task.action === 'git_commit';
  card.dataset.action = task.action;
  const head = makeElement('div', 'remote-approval-head');
  const outsideWorkspace = task.action === 'write_file' && task.preview?.outsideWorkspace === true;
  const icon = task.action === 'run_command' ? '$' : isRobloxTool ? 'R' : isGitCommit ? 'G' : '✎';
  head.append(makeElement('span', 'remote-approval-icon', icon));
  const title = makeElement('div', 'remote-approval-title');
  title.append(makeElement('strong', '', taskTitle(task)));
  title.append(makeElement('small', '', `Arena request · ${task.requestId}`));
  head.append(title, makeElement('span', 'pending-tag', 'NEEDS APPROVAL'));
  card.append(head);
  card.append(makeElement('div', 'remote-approval-description', task.action === 'run_command'
    ? 'This exact shell command will run from your workspace with your OS account permissions. It is not sandboxed.'
    : isRobloxTool
      ? 'This tool runs in your open Roblox Studio session. It may run Luau, access local assets or Roblox services, or change a place. Review the exact tool name and all arguments before approving.'
      : isGitCommit
        ? 'This creates a local commit from the currently staged changes only. It does not push. Arena Local disables Git hooks and commit signing for this action; inspect the complete staged diff and message.'
        : outsideWorkspace
          ? 'EXTREMELY DANGEROUS: this write targets a file outside the selected workspace. Verify the full path and complete diff before approving.'
          : 'Arena is asking to change a file in the selected workspace. Review the complete proposed diff.'));

  if (isRobloxTool && task.robloxToolDescription) {
    const toolDescription = makeElement('details', 'roblox-tool-description');
    toolDescription.append(makeElement('summary', '', 'Show Studio-provided tool description'));
    toolDescription.append(makeElement('p', '', String(task.robloxToolDescription).slice(0, 2_000)));
    card.append(toolDescription);
  }

  if (task.action === 'run_command') {
    const warning = makeElement('div', 'preview-box');
    warning.append(makeElement('div', 'preview-label', 'Exact command'));
    warning.append(makeElement('pre', '', task.args?.command || ''));
    card.append(warning);
    card.append(makeElement('div', 'command-warning', '⚠  Shell can reach files outside this workspace. Only approve commands you understand.'));
  } else if (isRobloxTool) {
    const box = makeElement('div', 'preview-box');
    box.append(makeElement('div', 'preview-label', 'Exact Roblox Studio MCP call'));
    box.append(makeElement('code', 'preview-path', task.args?.name || 'Unknown tool'));
    const args = makeElement('pre', 'roblox-tool-arguments', JSON.stringify(task.args?.arguments ?? {}, null, 2));
    box.append(args);
    card.append(box);
    card.append(makeElement('div', 'command-warning', '⚠  Studio tools can change live place data or execute code. Approval covers only this exact call.'));
  } else if (isGitCommit) {
    const preview = task.preview || {};
    const box = makeElement('div', 'preview-box');
    box.append(makeElement('div', 'preview-label', `Staged diff · ${preview.fileCount ?? 0} file(s)`));
    box.append(makeElement('code', 'preview-path', `Branch: ${preview.branch || 'HEAD'} · Current HEAD: ${preview.head || '(unborn)'}`));
    box.append(makeElement('div', 'preview-label', 'Commit message'));
    box.append(makeElement('pre', 'git-commit-message', preview.message || task.args?.message || ''));
    box.append(makeElement('div', 'preview-label', 'Files'));
    box.append(makeElement('pre', 'git-commit-files', Array.isArray(preview.files) ? preview.files.join(' · ') : ''));
    box.append(makeElement('pre', 'git-commit-diff', preview.diff || 'No textual diff. Review the staged files above.'));
    card.append(box);
    card.append(makeElement('div', 'command-warning', '⚠  Approval applies only to this exact staged state and message. Hooks/signing are disabled; the commit stays local and is not pushed.'));
  } else if (task.preview) {
    const box = makeElement('div', `preview-box${outsideWorkspace ? ' external-write-preview' : ''}`);
    box.append(makeElement('div', 'preview-label', outsideWorkspace
      ? 'EXTREMELY DANGEROUS · OUTSIDE WORKSPACE'
      : task.preview.exists ? 'Proposed diff' : 'New file contents'));
    if (outsideWorkspace) box.append(makeElement('code', 'preview-path', task.preview.path));
    const diff = document.createElement('pre');
    appendDiff(diff, task.preview);
    box.append(diff);
    card.append(box);
    if (outsideWorkspace) card.append(makeElement('div', 'command-warning external-write-warning', '‼  This can overwrite a private or system file your OS account can access. Approval applies only to this exact write.'));
  }

  const controls = makeElement('div', 'approval-buttons');
  controls.append(approvalButton(task, 'Approve once', 'approve', 'approve-once'));
  if (!isGitCommit) controls.append(approvalButton(task, 'Allow exact action for session', 'approve_session', 'approve-session'));
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
    els.activityList.append(makeElement('div', 'empty-activity', 'No requests yet. Start a connection, then ask Arena.ai to inspect your workspace or use connected Roblox Studio tools.'));
    return;
  }
  for (const task of tasks) {
    const row = makeElement('div', `activity-row${task.autoApproved ? ' auto-approved' : ''}`);
    const isRobloxTool = task.action === 'roblox_tool';
    const change = task.action === 'write_file' || task.action === 'run_command' || task.action === 'git_commit' || (isRobloxTool && task.robloxPermission !== 'read-only');
    const activityIconClass = `activity-action-icon${change ? ' change' : ''}${isRobloxTool ? ' roblox' : ''}`;
    row.append(makeElement('span', activityIconClass, task.action === 'run_command' ? '$' : isRobloxTool ? 'R' : task.action === 'git_commit' ? 'G' : task.action === 'list_processes' ? 'P' : change ? '✎' : '⌕'));
    const main = makeElement('div', 'activity-main');
    main.append(makeElement('strong', '', taskTitle(task)));
    const activitySummary = task.autoApproved
      ? task.status === 'running' ? 'AUTO-APPROVED · running without a prompt' : task.resultSummary || 'AUTO-APPROVED · no prompt was shown'
      : task.resultSummary || requestStatusLabel(task.status);
    main.append(makeElement('small', '', activitySummary));
    row.append(main);
    const isError = ['denied', 'expired', 'cancelled', 'error'].includes(task.status);
    row.append(makeElement('span', `activity-state${task.autoApproved ? ' automatic' : task.status === 'awaiting_approval' || task.status === 'preparing' ? ' waiting' : isError ? ' error' : ''}`));
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
  const targetPath = relativePath || '.';
  const requestSequence = ++fileLoadSequence;
  if (targetPath !== browserPath && els.fileFilter) els.fileFilter.value = '';
  browserPath = targetPath;
  currentFileEntries = [];
  currentFileTruncated = false;
  renderBreadcrumbs();
  els.fileList.replaceChildren(makeElement('div', 'loading-row', 'Loading files…'));
  els.fileFoot.textContent = 'Reading this folder on your computer…';
  try {
    const data = await window.arenaLocal.listFiles(targetPath);
    if (requestSequence !== fileLoadSequence) return;
    renderFileList(data);
  } catch (error) {
    if (requestSequence !== fileLoadSequence) return;
    els.fileList.replaceChildren(makeElement('div', 'empty-files', error.message));
    els.fileFoot.textContent = 'This folder could not be loaded. Check the selected workspace and try again.';
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
  currentFileEntries = Array.isArray(data.entries) ? data.entries : [];
  currentFileTruncated = Boolean(data.truncated);
  const filter = els.fileFilter?.value.trim().toLocaleLowerCase() || '';
  const entries = filter
    ? currentFileEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter))
    : currentFileEntries;
  els.fileList.replaceChildren();
  if (!entries.length) {
    const message = currentFileEntries.length
      ? 'No visible file names match this filter.'
      : 'This folder has no visible files.';
    els.fileList.append(makeElement('div', 'empty-files', message));
    els.fileFoot.textContent = currentFileTruncated ? 'The folder listing is capped at 300 items.' : currentFileEntries.length ? 'Clear the filter to see the full folder listing.' : 'Try another folder or refresh the listing.';
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
  if (currentFileTruncated) {
    els.fileFoot.textContent = filter
      ? `Showing ${entries.length} matches in the first 300 listed items.`
      : 'Showing the first 300 items.';
  } else if (filter) {
    els.fileFoot.textContent = `Showing ${entries.length} of ${currentFileEntries.length} items in this folder.`;
  } else {
    els.fileFoot.textContent = 'Arena only receives files it asks to read in this folder.';
  }
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
    button.disabled = Boolean(appState?.tunnelStarting || appState?.tunnelStopping || appState?.tunnelActive);
  }
}

async function connectRobloxMcp() {
  try {
    const state = await window.arenaLocal.connectRobloxMcp();
    applyState(state);
    if (state.robloxMcp?.status === 'connected') {
      showToast(`Roblox Studio MCP connected · ${state.robloxMcp.toolCount} tools discovered.`);
    }
  } catch (error) {
    showToast(error.message || 'Could not connect to Roblox Studio MCP.', true);
  }
}

async function disconnectRobloxMcp() {
  if (!window.confirm('Disconnect Roblox Studio MCP? Pending Studio approvals will be cancelled. An in-flight Studio tool may already have changed the place.')) return;
  await runUiAction(() => window.arenaLocal.disconnectRobloxMcp(), 'Roblox Studio MCP disconnected.');
}

async function startTunnel() {
  try {
    const state = await window.arenaLocal.startTunnel();
    applyState(state);
    showToast('Remote link is active. Copy the Arena setup prompt.');
  } catch (error) {
    if (!/cancelled/i.test(error.message || '')) showToast(error.message || 'Could not start the remote link.', true);
  }
}

async function cancelTunnelStart() {
  if (!appState?.tunnelStarting) return;
  els.cancelTunnelBtn.disabled = true;
  els.cancelTunnelBtn.textContent = 'Cancelling…';
  try {
    const state = await window.arenaLocal.stopTunnel();
    applyState(state);
    showToast('Connection attempt cancelled.');
  } catch (error) {
    showToast(error.message || 'Could not cancel the connection attempt.', true);
  } finally {
    els.cancelTunnelBtn.disabled = false;
    els.cancelTunnelBtn.textContent = 'Cancel attempt';
  }
}

async function stopTunnel() {
  const confirmation = appState?.fullComputerAccess
    ? 'Stop the remote link? This disables EXTREMELY DANGEROUS full-computer access, rotates the pairing key, and denies pending approvals.'
    : 'Stop the remote link and revoke the current Arena connection?';
  if (!window.confirm(confirmation)) return;
  const success = appState?.fullComputerAccess
    ? 'Remote link stopped; full-computer access disabled, pairing key rotated, and pending approvals denied.'
    : 'Remote link stopped and pending approvals denied.';
  await runUiAction(() => window.arenaLocal.stopTunnel(), success);
}

async function rotatePairingKey() {
  const confirmation = appState?.fullComputerAccess
    ? 'Rotate the bearer key? This disables EXTREMELY DANGEROUS full-computer access, revokes current Arena instructions, and denies pending approvals.'
    : 'Rotate the bearer key? This revokes the current Arena instructions and denies any pending approvals.';
  if (!window.confirm(confirmation)) return;
  const hadFullComputerAccess = Boolean(appState?.fullComputerAccess);
  try {
    const result = await window.arenaLocal.rotatePairingToken();
    applyState(await window.arenaLocal.getState());
    showToast(hadFullComputerAccess
      ? `Pairing key rotated; full-computer access disabled. New ending: ${result.hint}`
      : `Pairing key rotated. New ending: ${result.hint}`);
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

function resetCombinedUnlockDialog() {
  clearInterval(combinedUnlockTimer);
  combinedUnlockTimer = null;
  combinedUnlockChallengeId = '';
  combinedUnlockReadyAt = 0;
  combinedUnlockExpiresAt = 0;
  combinedUnlockWorkspaceRoot = '';
  combinedUnlockPermissionMode = '';
  combinedUnlockPairingHint = '';
  combinedUnlockSliderUnlocked = false;
  if (els.fullNoAskUnlockDialog.open) els.fullNoAskUnlockDialog.close();
  els.fullNoAskSlider.value = '0';
  els.fullNoAskSlider.disabled = true;
  els.continueFullNoAskUnlock.disabled = true;
  els.continueFullNoAskUnlock.textContent = 'Continue to final warning';
  els.fullNoAskProgress.value = 0;
  els.fullNoAskCountdown.textContent = 'Wait 30 seconds before the slider unlocks.';
}

async function cancelCombinedUnlock() {
  const challengeId = combinedUnlockChallengeId;
  resetCombinedUnlockDialog();
  if (!challengeId) return;
  try {
    await window.arenaLocal.cancelFullComputerNoAskUnlock(challengeId);
  } catch (error) {
    showToast(error.message || 'Could not cancel the local safety unlock.', true);
  }
}

function updateCombinedUnlockCountdown() {
  if (!combinedUnlockChallengeId) return;
  const now = performance.now();
  if (now >= combinedUnlockExpiresAt) {
    void cancelCombinedUnlock();
    showToast('Safety unlock expired. No-Ask was not enabled; start the warning sequence again.', true);
    return;
  }
  const remainingMs = Math.max(0, combinedUnlockReadyAt - now);
  const elapsedSeconds = Math.min(30, Math.max(0, (30_000 - remainingMs) / 1_000));
  els.fullNoAskProgress.value = elapsedSeconds;
  if (remainingMs > 0) {
    const remainingSeconds = Math.ceil(remainingMs / 1_000);
    els.fullNoAskCountdown.textContent = `Continue unlocks in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;
    els.fullNoAskSlider.disabled = true;
    els.continueFullNoAskUnlock.disabled = true;
    return;
  }
  els.fullNoAskProgress.value = 30;
  els.fullNoAskCountdown.textContent = combinedUnlockSliderUnlocked
    ? '30-second wait complete. Slider unlocked; Continue is ready.'
    : '30-second wait complete. Slide all the way right to unlock Continue.';
  els.fullNoAskSlider.disabled = false;
  els.continueFullNoAskUnlock.disabled = !combinedUnlockSliderUnlocked;
}

async function beginCombinedUnlock() {
  if (combinedUnlockStarting || combinedUnlockChallengeId) return;
  combinedUnlockStarting = true;
  try {
    const challenge = await window.arenaLocal.beginFullComputerNoAskUnlock();
    if (!challenge) return;
    if (typeof challenge.challengeId !== 'string' || !challenge.challengeId) {
      throw new Error('The local safety challenge was not valid. No-Ask was not enabled.');
    }
    combinedUnlockChallengeId = challenge.challengeId;
    if (challenge.waitMs !== 30_000) throw new Error('The local safety challenge was not valid. No-Ask was not enabled.');
    combinedUnlockWorkspaceRoot = appState?.workspaceRoot || '';
    combinedUnlockPermissionMode = appState?.permissionMode || 'ask';
    combinedUnlockPairingHint = appState?.pairingTokenHint || '';
    const now = performance.now();
    combinedUnlockReadyAt = now + challenge.waitMs;
    combinedUnlockExpiresAt = now + Math.max(challenge.waitMs, (Number(challenge.expiresInMs) || 0) - 1_000);
    combinedUnlockSliderUnlocked = false;
    els.fullNoAskSlider.value = '0';
    els.fullNoAskSlider.disabled = true;
    els.continueFullNoAskUnlock.disabled = true;
    els.continueFullNoAskUnlock.textContent = 'Continue to final warning';
    els.fullNoAskProgress.value = 0;
    els.fullNoAskCountdown.textContent = 'Continue unlocks in 30 seconds.';
    els.fullNoAskUnlockDialog.showModal();
    updateCombinedUnlockCountdown();
    combinedUnlockTimer = setInterval(updateCombinedUnlockCountdown, 200);
  } catch (error) {
    if (combinedUnlockChallengeId) {
      const challengeId = combinedUnlockChallengeId;
      resetCombinedUnlockDialog();
      await window.arenaLocal.cancelFullComputerNoAskUnlock(challengeId).catch(() => {});
    }
    showToast(error.message || 'Could not begin the local safety unlock.', true);
  } finally {
    combinedUnlockStarting = false;
  }
}

function updateCombinedUnlockSlider() {
  if (!combinedUnlockChallengeId || performance.now() < combinedUnlockReadyAt) {
    els.fullNoAskSlider.value = '0';
    combinedUnlockSliderUnlocked = false;
    els.continueFullNoAskUnlock.disabled = true;
    return;
  }
  combinedUnlockSliderUnlocked = Number(els.fullNoAskSlider.value) >= 100;
  els.continueFullNoAskUnlock.disabled = !combinedUnlockSliderUnlocked;
  els.fullNoAskCountdown.textContent = combinedUnlockSliderUnlocked
    ? '30-second wait complete. Slider unlocked; Continue is ready.'
    : '30-second wait complete. Slide all the way right to unlock Continue.';
}

async function completeCombinedUnlock() {
  if (!combinedUnlockChallengeId || !combinedUnlockSliderUnlocked || performance.now() < combinedUnlockReadyAt) return;
  const challengeId = combinedUnlockChallengeId;
  els.fullNoAskSlider.disabled = true;
  els.continueFullNoAskUnlock.disabled = true;
  els.continueFullNoAskUnlock.textContent = 'Waiting for final confirmation…';
  clearInterval(combinedUnlockTimer);
  combinedUnlockTimer = null;
  try {
    const state = await window.arenaLocal.completeFullComputerNoAskUnlock(challengeId);
    resetCombinedUnlockDialog();
    applyState(state);
    if (state.fullComputerAccess && state.permissionMode === 'no-ask') {
      showToast('EXTREMELY DANGEROUS full-computer + No-Ask enabled. The pairing key rotated; the remote link still requires a separate final warning.', true);
    } else {
      showToast('Combined mode was not enabled. Your previous permission mode remains active.');
    }
  } catch (error) {
    resetCombinedUnlockDialog();
    applyState(await window.arenaLocal.getState().catch(() => appState));
    showToast(error.message || 'The combined-mode safety unlock failed.', true);
  }
}

async function changePermission() {
  const mode = els.permissionMode.value;
  if (mode === 'no-ask' && appState?.fullComputerAccess && appState?.permissionMode !== 'no-ask') {
    els.permissionMode.value = appState.permissionMode || 'ask';
    updatePermissionCopy();
    await beginCombinedUnlock();
    return;
  }
  updatePermissionCopy();
  try {
    const state = await window.arenaLocal.setPermissionMode(mode);
    applyState(state);
    if (state.permissionMode !== mode) {
      const currentMode = state.permissionMode === 'read-only' ? 'Read only mode' : 'Ask mode';
      showToast(`No-ask mode was not enabled. ${currentMode} remains active.`);
    } else if (mode === 'no-ask') {
      showToast('VERY DANGEROUS: changes will run without approval until you stop the link, rotate the key, choose another folder, or close the app.', true);
    } else if (mode === 'read-only') {
      showToast('Read only mode enabled; pending changes were denied.');
    } else {
      showToast('Changes now require desktop approval.');
    }
  } catch (error) {
    els.permissionMode.value = appState?.permissionMode || 'ask';
    updatePermissionCopy();
    showToast(error.message, true);
  }
}

async function toggleFullComputerAccess() {
  const enable = !Boolean(appState?.fullComputerAccess);
  els.fullComputerAccessBtn.disabled = true;
  try {
    const state = await window.arenaLocal.setFullComputerAccess(enable);
    applyState(state);
    if (enable && state.fullComputerAccess) {
      showToast('EXTREMELY DANGEROUS full-computer access enabled. The pairing key was rotated; start the link and copy a fresh prompt.', true);
    } else if (enable) {
      showToast('Full-computer access was not enabled. Workspace confinement remains active.');
    } else {
      showToast('Full-computer access disabled and pairing key rotated.');
    }
  } catch (error) {
    showToast(error.message || 'Could not change file-access scope.', true);
  } finally {
    updateScopePanel();
  }
}

async function chooseWorkspace() {
  const previousRoot = appState?.workspaceRoot;
  const hadFullComputerAccess = Boolean(appState?.fullComputerAccess);
  const result = await runUiAction(() => window.arenaLocal.chooseWorkspace());
  if (result && result.workspaceRoot !== previousRoot) {
    browserPath = '.';
    await loadFiles('.');
    showToast(hadFullComputerAccess ? 'Workspace updated; full-computer access was disabled and the pairing key rotated.' : 'Workspace folder updated.');
  }
}

$('#saveNgrokTokenBtn').addEventListener('click', saveNgrokToken);
$('#startTunnelBtn').addEventListener('click', startTunnel);
$('#cancelTunnelBtn').addEventListener('click', cancelTunnelStart);
$('#stopTunnelBtn').addEventListener('click', stopTunnel);
els.connectRobloxMcpBtn.addEventListener('click', connectRobloxMcp);
els.disconnectRobloxMcpBtn.addEventListener('click', disconnectRobloxMcp);
$('#copyArenaPromptBtn').addEventListener('click', copyArenaInstructions);
$('#copyUrlBtn').addEventListener('click', copyTunnelUrl);
$('#rotatePairingBtn').addEventListener('click', rotatePairingKey);
$('#rotatePairingTopBtn').addEventListener('click', rotatePairingKey);
$('#forgetNgrokTokenBtn').addEventListener('click', forgetNgrokToken);
$('#chooseWorkspaceBtn').addEventListener('click', chooseWorkspace);
$('#fullComputerAccessBtn').addEventListener('click', toggleFullComputerAccess);
$('#refreshFilesBtn').addEventListener('click', () => loadFiles(browserPath));
els.fileFilter.addEventListener('input', () => renderFileList({ entries: currentFileEntries, truncated: currentFileTruncated }));
$('#permissionMode').addEventListener('change', changePermission);
$('#closeFileBtn').addEventListener('click', () => els.fileDialog.close());
els.cancelFullNoAskUnlock.addEventListener('click', () => { void cancelCombinedUnlock(); });
els.fullNoAskSlider.addEventListener('input', updateCombinedUnlockSlider);
els.fullNoAskSlider.addEventListener('change', updateCombinedUnlockSlider);
els.continueFullNoAskUnlock.addEventListener('click', () => { void completeCombinedUnlock(); });
els.fullNoAskUnlockDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void cancelCombinedUnlock();
});

const navigationItems = [...document.querySelectorAll('.nav-item')];
for (const link of navigationItems) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = link.getAttribute('href');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (target) document.querySelector(target)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    for (const item of navigationItems) {
      const active = item === link;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
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
