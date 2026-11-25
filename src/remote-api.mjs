import http from 'node:http';
import crypto from 'node:crypto';
import {
  actionFingerprint,
  CHANGE_TOOLS,
  executeMutationTool,
  executeReadTool,
  previewWorkspaceWrite,
} from './workspace.mjs';

const MAX_BODY_BYTES = 300_000;
const MAX_ACTIVE_TASKS = 20;
const MAX_RETAINED_TASKS = 120;
const TASK_TTL_MS = 30 * 60 * 1_000;
const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const RATE_LIMIT_PER_MINUTE = 240;
const ACTIONS = new Set(['list_files', 'read_file', 'search_text', 'write_file', 'run_command']);
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,100}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object.');
  return value;
}

function constantTimeEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function authorize(req, getPairingToken) {
  const header = req.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(header);
  const expected = getPairingToken();
  if (!match || !constantTimeEqual(match[1], expected)) throw new HttpError(401, 'Unauthorized. Check the desktop app pairing token.');
}

function boundedString(value, name, maxLength, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, `${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function validateTaskBody(body) {
  const extra = Object.keys(body).filter((key) => !['requestId', 'action', 'args'].includes(key));
  if (extra.length) throw new HttpError(400, `Unknown request field: ${extra[0]}`);
  const requestId = boundedString(body.requestId, 'requestId', 100);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new HttpError(400, 'requestId must use letters, numbers, dots, underscores, colons, or hyphens.');
  if (!ACTIONS.has(body.action)) throw new HttpError(400, `Unsupported action. Allowed actions: ${[...ACTIONS].join(', ')}.`);
  const input = body.args === undefined ? {} : body.args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'args must be a JSON object.');
  let args;
  let allowedKeys;
  switch (body.action) {
    case 'list_files':
      allowedKeys = ['path'];
      args = { path: boundedString(input.path ?? '.', 'path', 1_000) };
      break;
    case 'read_file':
      allowedKeys = ['path'];
      args = { path: boundedString(input.path, 'path', 1_000) };
      break;
    case 'search_text':
      allowedKeys = ['query', 'path'];
      args = {
        query: boundedString(input.query, 'query', 300),
        path: boundedString(input.path ?? '.', 'path', 1_000),
      };
      break;
    case 'write_file':
      allowedKeys = ['path', 'content'];
      args = {
        path: boundedString(input.path, 'path', 1_000),
        content: typeof input.content === 'string' ? input.content : null,
      };
      if (args.content === null) throw new HttpError(400, 'content must be a string.');
      if (Buffer.byteLength(args.content, 'utf8') > 256 * 1024) throw new HttpError(413, 'File content is limited to 256 KB.');
      break;
    case 'run_command':
      allowedKeys = ['command'];
      args = { command: boundedString(input.command, 'command', 2_000) };
      if (args.command.includes('\0')) throw new HttpError(400, 'command cannot contain null characters.');
      break;
    default:
      throw new HttpError(400, 'Unsupported action.');
  }
  const unknownArg = Object.keys(input).find((key) => !allowedKeys.includes(key));
  if (unknownArg) throw new HttpError(400, `Unknown argument for ${body.action}: ${unknownArg}`);
  return { requestId, action: body.action, args };
}

function safeDesktopTask(task) {
  const args = task.action === 'write_file' ? { path: task.args.path } : task.args;
  return {
    taskId: task.taskId,
    requestId: task.requestId,
    action: task.action,
    args,
    fullComputerAccess: task.fullComputerAccess === true,
    preview: task.status === 'awaiting_approval' ? task.preview : null,
    status: task.status,
    message: task.message,
    resultSummary: task.resultSummary,
    error: task.error,
    autoApproved: task.autoApproved === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function summarizeResult(action, result) {
  if (!result) return '';
  if (result.error) return result.error;
  if (result.denied) return result.message || 'Denied.';
  if (action === 'list_files') return `${result.entries?.length ?? 0} entries${result.truncated ? ' (truncated)' : ''}`;
  if (action === 'read_file') return `Read ${result.bytes ?? 0} bytes from ${result.path}.`;
  if (action === 'search_text') return `${result.matches?.length ?? 0} matches across ${result.filesScanned ?? 0} files.`;
  if (action === 'write_file') return `Wrote ${result.bytes ?? 0} bytes to ${result.path}.`;
  if (action === 'run_command') return `Command exited with ${result.exitCode ?? 'an error'}${result.timedOut ? ' (timed out)' : ''}.`;
  return 'Complete.';
}

function arenaTaskResponse(task) {
  const result = {
    taskId: task.taskId,
    requestId: task.requestId,
    action: task.action,
    fullComputerAccess: task.fullComputerAccess === true,
    status: task.status,
    autoApproved: task.autoApproved === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.status === 'preparing') result.message = 'Preparing a local approval preview.';
  if (task.status === 'awaiting_approval') result.message = 'Waiting for approval in the Arena Local desktop app.';
  if (task.status === 'denied' || task.status === 'expired' || task.status === 'cancelled') result.message = task.message || 'The request was not run.';
  if (task.status === 'error') result.error = task.error || 'The local action failed.';
  if (task.status === 'completed') result.result = task.result;
  return result;
}

function sortNewest(tasks) {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createRemoteApi({ getWorkspaceRoot, getPairingToken, getPermissionMode, getFullComputerAccess = () => false, getFullComputerNoAskAuthorized = () => false, onUpdate = () => {} }) {
  const tasks = new Map();
  const requestIndex = new Map();
  const approvedActions = new Map();
  let approvalEpoch = 0;
  let rateWindowStart = Date.now();
  let rateCount = 0;

  function changed() {
    try { onUpdate(); } catch { /* UI may not be ready during startup/shutdown. */ }
  }

  function trimTasks() {
    const now = Date.now();
    for (const [id, task] of tasks) {
      if (now - Date.parse(task.createdAt) > TASK_TTL_MS && !['running', 'preparing', 'awaiting_approval'].includes(task.status)) {
        tasks.delete(id);
        requestIndex.delete(task.requestId);
      }
    }
    const finished = sortNewest([...tasks.values()].filter((task) => !['running', 'preparing', 'awaiting_approval'].includes(task.status)));
    for (const task of finished.slice(MAX_RETAINED_TASKS)) {
      tasks.delete(task.taskId);
      requestIndex.delete(task.requestId);
    }
  }

  function consumeRateLimit() {
    const now = Date.now();
    if (now - rateWindowStart >= 60_000) {
      rateWindowStart = now;
      rateCount = 0;
    }
    rateCount += 1;
    if (rateCount > RATE_LIMIT_PER_MINUTE) throw new HttpError(429, 'Rate limit reached. Wait a minute and retry.');
  }

  function setStatus(task, status, fields = {}) {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    Object.assign(task, fields);
    changed();
  }

  async function executeTask(task, expectedWriteState = null) {
    try {
      const root = getWorkspaceRoot();
      const result = CHANGE_TOOLS.has(task.action)
        ? await executeMutationTool(root, task.action, task.args, {
          expectedWriteState,
          fullComputerAccess: task.fullComputerAccess,
        })
        : await executeReadTool(root, task.action, task.args, { fullComputerAccess: task.fullComputerAccess });
      const summary = summarizeResult(task.action, result);
      setStatus(task, 'completed', {
        result,
        resultSummary: task.autoApproved ? `AUTO-APPROVED · ${summary}` : summary,
        message: undefined,
        error: undefined,
      });
    } catch (error) {
      const message = error.message || 'Local action failed.';
      setStatus(task, 'error', { error: message, resultSummary: task.autoApproved ? `AUTO-APPROVED · ${message}` : message });
    }
  }

  function clearApprovedActions() {
    approvalEpoch += 1;
    approvedActions.clear();
  }

  function clearApprovalTimeout(task) {
    if (task.approvalTimeout) clearTimeout(task.approvalTimeout);
    task.approvalTimeout = null;
  }

  function denyTask(task, message, status = 'denied') {
    clearApprovalTimeout(task);
    task.preview = null;
    setStatus(task, status, { message, resultSummary: message });
  }

  async function approveTask(taskId, decision) {
    const task = tasks.get(taskId);
    if (!task || task.status !== 'awaiting_approval') throw new Error('This request is no longer waiting for approval.');
    if (!['approve', 'approve_session', 'deny'].includes(decision)) throw new Error('Choose approve, allow exact action for this session, or deny.');
    clearApprovalTimeout(task);
    if (decision === 'deny') {
      denyTask(task, 'Denied by the user on this computer.');
      return safeDesktopTask(task);
    }
    if (getPermissionMode() === 'read-only') {
      denyTask(task, 'Blocked because Read only mode is enabled.');
      return safeDesktopTask(task);
    }
    const rememberForSession = decision === 'approve_session';
    const approvalEpochAtStart = approvalEpoch;
    const expectedWriteState = task.action === 'write_file' && task.preview
      ? { exists: task.preview.exists, before: task.preview.before }
      : null;
    task.preview = null;
    setStatus(task, 'running', { message: undefined });
    await executeTask(task, expectedWriteState);
    if (rememberForSession && task.status === 'completed' && approvalEpoch === approvalEpochAtStart && getPermissionMode() === 'ask') {
      const trustedState = task.action === 'write_file' ? { exists: true, before: task.args.content } : null;
      approvedActions.set(task.fingerprint, trustedState);
    }
    return safeDesktopTask(task);
  }

  async function createTask(request) {
    trimTasks();
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({ action: request.action, args: request.args })).digest('hex');
    const existingId = requestIndex.get(request.requestId);
    if (existingId) {
      const existing = tasks.get(existingId);
      if (existing && existing.requestFingerprint !== requestFingerprint) throw new HttpError(409, 'requestId was already used for a different action.');
      if (existing) return existing;
    }
    const activeCount = [...tasks.values()].filter((task) => ['running', 'preparing', 'awaiting_approval'].includes(task.status)).length;
    if (activeCount >= MAX_ACTIVE_TASKS) throw new HttpError(429, 'Too many active requests are waiting on this desktop.');

    const task = {
      taskId: crypto.randomUUID(),
      requestId: request.requestId,
      requestFingerprint,
      fingerprint: actionFingerprint(request.action, request.args),
      action: request.action,
      args: request.args,
      fullComputerAccess: Boolean(getFullComputerAccess()),
      fullComputerNoAskAuthorized: Boolean(getFullComputerNoAskAuthorized()),
      status: CHANGE_TOOLS.has(request.action) ? 'preparing' : 'running',
      result: null,
      resultSummary: '',
      autoApproved: false,
      error: undefined,
      message: undefined,
      preview: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvalTimeout: null,
    };
    tasks.set(task.taskId, task);
    requestIndex.set(task.requestId, task.taskId);
    changed();

    if (task.fullComputerAccess && getPermissionMode() === 'no-ask' && !task.fullComputerNoAskAuthorized) {
      denyTask(task, 'Full-computer No-Ask mode requires the local 30-second safety unlock.');
      return task;
    }

    if (!CHANGE_TOOLS.has(task.action)) {
      void executeTask(task);
      return task;
    }

    if (getPermissionMode() === 'read-only') {
      denyTask(task, 'Blocked by Read only mode.');
      return task;
    }

    if (getPermissionMode() === 'no-ask') {
      task.autoApproved = true;
      setStatus(task, 'running', { message: 'Auto-approved without a prompt in Very dangerous no-ask mode.' });
      void executeTask(task);
      return task;
    }

    const wasApprovedForSession = approvedActions.has(task.fingerprint);
    const approvedState = approvedActions.get(task.fingerprint);
    if (wasApprovedForSession && task.action !== 'write_file') {
      setStatus(task, 'running', { message: undefined });
      void executeTask(task);
      return task;
    }

    if (task.action === 'write_file') {
      try {
        const preview = await previewWorkspaceWrite(getWorkspaceRoot(), task.args.path, task.args.content, {
          fullComputerAccess: task.fullComputerAccess,
        });
        if (task.status !== 'preparing') return task;
        if (wasApprovedForSession && approvedState && preview.exists === approvedState.exists && preview.before === approvedState.before) {
          setStatus(task, 'running', { message: undefined });
          void executeTask(task, { exists: preview.exists, before: preview.before });
          return task;
        }
        task.preview = preview;
      } catch (error) {
        if (task.status !== 'preparing') return task;
        setStatus(task, 'error', { error: error.message || 'Could not prepare a safe file preview.', resultSummary: error.message || 'Could not prepare a safe file preview.' });
        return task;
      }
    }
    if (task.status !== 'preparing') return task;
    setStatus(task, 'awaiting_approval', { message: 'Waiting for approval in the Arena Local desktop app.' });
    task.approvalTimeout = setTimeout(() => {
      if (task.status === 'awaiting_approval') denyTask(task, 'Approval expired after 10 minutes.', 'expired');
    }, APPROVAL_TTL_MS);
    task.approvalTimeout.unref?.();
    changed();
    return task;
  }

  function cancelPendingChanges(reason = 'Remote connection stopped.') {
    for (const task of tasks.values()) {
      if (task.status === 'awaiting_approval' || task.status === 'preparing') denyTask(task, reason, 'cancelled');
    }
    clearApprovedActions();
    changed();
  }

  function getDesktopTasks() {
    trimTasks();
    return sortNewest([...tasks.values()]).slice(0, 30).map(safeDesktopTask);
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Not found.');
    authorize(req, getPairingToken);
    consumeRateLimit();

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return sendJson(res, 200, {
        ok: true,
        workspace: 'connected',
        permissionMode: getPermissionMode(),
        fullComputerAccess: Boolean(getFullComputerAccess()),
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/tasks') {
      const request = validateTaskBody(await readJson(req));
      const task = await createTask(request);
      return sendJson(res, 202, arenaTaskResponse(task));
    }
    const match = /^\/v1\/tasks\/([a-f0-9-]{36})$/i.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const task = tasks.get(match[1]);
      if (!task) throw new HttpError(404, 'Task not found or expired.');
      return sendJson(res, 200, arenaTaskResponse(task));
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      const status = Number.isInteger(error.status) ? error.status : 500;
      sendJson(res, status, { error: status >= 500 ? 'Local bridge error.' : error.message });
    });
  });

  return {
    server,
    getTasks: getDesktopTasks,
    approveTask,
    cancelPendingChanges,
    clearApprovedActions,
  };
}
