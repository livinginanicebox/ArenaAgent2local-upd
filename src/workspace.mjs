import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execAsync = promisify(exec);
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 1_200;
const MAX_SEARCH_DIRECTORIES = 2_000;
const MAX_SEARCH_RESULTS = 60;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 48 * 1024;
const BLOCKED_DIRECTORIES = new Set([
  '.git', '.arena-local', '.aws', '.ssh', '.gnupg', 'node_modules',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.local',
  'dist', 'build', 'coverage', 'target',
]);
const SENSITIVE_NAMES = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials?(?:\..*)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|kdbx)$/i,
];

export async function resolveWorkspaceRoot(input) {
  const absolute = path.resolve(input);
  const real = await fs.realpath(absolute);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error('Workspace must be a directory.');
  return real;
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathSegments(relativePath) {
  return String(relativePath ?? '').split(/[\\/]+/).filter(Boolean);
}

function isSensitiveName(name) {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

function assertSafeSegments(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('A relative workspace path is required.');
  if (relativePath.length > 1_000) throw new Error('That path is too long.');
  if (path.isAbsolute(relativePath) || /^[a-z]:[\\/]/i.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new Error('Absolute paths are outside the workspace.');
  }
  const segments = pathSegments(relativePath);
  if (segments.some((segment) => segment === '..')) throw new Error('Parent-directory paths are not allowed.');
  if (segments.some((segment) => BLOCKED_DIRECTORIES.has(segment.toLowerCase()))) {
    throw new Error('This protected directory is not available to the agent.');
  }
  if (segments.some(isSensitiveName)) throw new Error('This file is protected because it may contain credentials.');
}

export function isProtectedWorkspacePath(relativePath) {
  try { assertSafeSegments(relativePath); return false; }
  catch { return true; }
}

async function lstatWorkspacePath(root, target, allowMissingFinal) {
  const relative = path.relative(root, target);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  let info = await fs.lstat(root);
  if (info.isSymbolicLink()) throw new Error('Symbolic links are not followed by the local agent.');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    info = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT' && allowMissingFinal && index === segments.length - 1) return null;
      if (error.code === 'ENOENT') throw new Error('That file or folder does not exist.');
      throw error;
    });
    if (!info) return null;
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not followed by the local agent.');
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error('A parent path is not a folder.');
  }
  return info;
}

export async function resolveWorkspacePath(root, relativePath = '.', { allowMissing = false } = {}) {
  assertSafeSegments(relativePath);
  const target = path.resolve(root, relativePath || '.');
  if (!insideRoot(root, target)) throw new Error('That path is outside the workspace.');
  const stat = await lstatWorkspacePath(root, target, allowMissing);
  if (!stat && allowMissing) {
    const parent = path.dirname(target);
    const parentStat = await lstatWorkspacePath(root, parent, false);
    if (!parentStat.isDirectory()) throw new Error('The parent path is not a directory.');
    return target;
  }
  const real = await fs.realpath(target);
  if (!insideRoot(root, real)) throw new Error('That path is outside the workspace.');
  return real;
}

async function resolveComputerPath(root, filePath, { allowMissing = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');
  if (filePath.length > 1_000) throw new Error('That path is too long.');
  if (filePath.includes('\0')) throw new Error('File paths cannot contain null characters.');
  const target = path.resolve(root, filePath);
  if (!path.isAbsolute(filePath) && !insideRoot(root, target)) {
    throw new Error('Use an absolute path to access a location outside the selected workspace.');
  }
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') {
      if (error.code === 'ENOENT') throw new Error('That file or folder does not exist.');
      throw error;
    }
    const parent = await fs.realpath(path.dirname(target)).catch((parentError) => {
      if (parentError.code === 'ENOENT') throw new Error('The parent folder does not exist.');
      throw parentError;
    });
    const parentInfo = await fs.stat(parent);
    if (!parentInfo.isDirectory()) throw new Error('The parent path is not a folder.');
    return path.join(parent, path.basename(target));
  }
}

async function resolveAgentPath(root, filePath, options = {}) {
  return options.fullComputerAccess
    ? resolveComputerPath(root, filePath, options)
    : resolveWorkspacePath(root, filePath, options);
}

function isHiddenOrIgnored(name) {
  return BLOCKED_DIRECTORIES.has(name.toLowerCase()) || isSensitiveName(name);
}

function relativeToRoot(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function pathForAgent(root, target) {
  return insideRoot(root, target) ? (relativeToRoot(root, target) || '.') : target;
}

function checkTextFile(buffer) {
  if (buffer.includes(0)) throw new Error('Binary files are not available to the agent.');
  return buffer.toString('utf8');
}

export async function listWorkspace(root, relativePath = '.', options = {}) {
  const fullComputerAccess = options.fullComputerAccess === true;
  const directory = await resolveAgentPath(root, relativePath || '.', { fullComputerAccess });
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error('That path is not a folder.');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || (!fullComputerAccess && BLOCKED_DIRECTORIES.has(entry.name.toLowerCase()))) continue;
    const entryPath = path.join(directory, entry.name);
    const info = await fs.lstat(entryPath).catch(() => null);
    if (!info) continue;
    const sensitive = isSensitiveName(entry.name);
    output.push({
      name: entry.name,
      path: pathForAgent(root, entryPath),
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
      size: info.isFile() ? info.size : null,
      modifiedAt: info.mtime.toISOString(),
      protected: !fullComputerAccess && (sensitive || info.isSymbolicLink()),
    });
  }
  output.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { path: pathForAgent(root, directory), entries: output.slice(0, 300), truncated: output.length > 300 };
}

export async function readWorkspaceFile(root, relativePath) {
  const target = await resolveWorkspacePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('That path is not a regular file.');
  if (stat.size > MAX_READ_BYTES) throw new Error(`Files larger than ${Math.round(MAX_READ_BYTES / 1024)} KB are not opened in the browser.`);
  const content = checkTextFile(await fs.readFile(target));
  return { path: relativeToRoot(root, target), content, bytes: stat.size };
}

export async function readForAgent(root, relativePath, options = {}) {
  const target = await resolveAgentPath(root, relativePath, options);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('That path is not a regular file.');
  if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large to read (limit ${Math.round(MAX_READ_BYTES / 1024)} KB).`);
  const content = checkTextFile(await fs.readFile(target));
  return { path: pathForAgent(root, target), bytes: stat.size, content };
}

export async function searchWorkspace(root, query, relativePath = '.', options = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('A non-empty search query is required.');
  if (query.length > 300) throw new Error('Search queries must be 300 characters or fewer.');
  const fullComputerAccess = options.fullComputerAccess === true;
  const start = await resolveAgentPath(root, relativePath || '.', { fullComputerAccess });
  const startStat = await fs.stat(start);
  const files = [];
  let visited = 0;
  let visitedDirectories = 0;

  async function walk(directory) {
    if (visited >= MAX_SEARCH_FILES || visitedDirectories >= MAX_SEARCH_DIRECTORIES) return;
    visitedDirectories += 1;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= MAX_SEARCH_FILES || visitedDirectories >= MAX_SEARCH_DIRECTORIES) return;
      if (entry.isSymbolicLink() || (!fullComputerAccess && isHiddenOrIgnored(entry.name))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        visited += 1;
        files.push(absolute);
      }
    }
  }

  if (startStat.isDirectory()) await walk(start);
  else if (startStat.isFile()) files.push(start);
  else throw new Error('Search works on regular files and folders only.');

  const needle = query.toLocaleLowerCase();
  const matches = [];
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) continue;
    const buffer = await fs.readFile(file).catch(() => null);
    if (!buffer || buffer.includes(0)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLocaleLowerCase().includes(needle)) {
        const line = lines[index].trim();
        matches.push({ path: pathForAgent(root, file), line: index + 1, snippet: line.slice(0, 220) });
        if (matches.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  return {
    query,
    matches,
    filesScanned: visited,
    truncated: visited >= MAX_SEARCH_FILES || visitedDirectories >= MAX_SEARCH_DIRECTORIES || matches.length >= MAX_SEARCH_RESULTS,
  };
}

export async function writeWorkspaceFile(root, relativePath, content, expectedState = null, options = {}) {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_WRITE_BYTES) throw new Error(`Writes are limited to ${Math.round(MAX_WRITE_BYTES / 1024)} KB.`);
  const fullComputerAccess = options.fullComputerAccess === true;
  const target = await resolveAgentPath(root, relativePath, { allowMissing: true, fullComputerAccess });
  const oldInfo = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (oldInfo?.isDirectory()) throw new Error('A folder cannot be overwritten with a file.');
  if (expectedState) {
    if (Boolean(oldInfo) !== expectedState.exists) throw new Error('The file changed after you reviewed it. Request a fresh diff before approving this write.');
    if (oldInfo && (await readForAgent(root, relativePath, { fullComputerAccess })).content !== expectedState.before) {
      throw new Error('The file changed after you reviewed it. Request a fresh diff before approving this write.');
    }
  }
  const mode = oldInfo?.mode ? oldInfo.mode & 0o777 : (fullComputerAccess && !insideRoot(root, target) ? 0o600 : 0o644);
  const temporary = `${target}.arena-local-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return { path: pathForAgent(root, target), bytes: byteLength, written: true };
}

export async function previewWorkspaceWrite(root, relativePath, content, options = {}) {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error(`Writes are limited to ${Math.round(MAX_WRITE_BYTES / 1024)} KB.`);
  const fullComputerAccess = options.fullComputerAccess === true;
  const target = await resolveAgentPath(root, relativePath, { allowMissing: true, fullComputerAccess });
  const info = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isDirectory()) throw new Error('A folder cannot be overwritten with a file.');
  const before = info ? (await readForAgent(root, relativePath, { fullComputerAccess })).content : '';
  return {
    path: pathForAgent(root, target),
    outsideWorkspace: !insideRoot(root, target),
    before,
    after: content,
    exists: Boolean(info),
    truncated: false,
  };
}

export async function runWorkspaceCommand(root, command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('A non-empty command is required.');
  if (command.length > 2_000) throw new Error('Commands are limited to 2,000 characters.');
  if (command.includes('\0')) throw new Error('Commands cannot contain null characters.');

  // Keep unrelated application secrets out of child-process environments. This is not a sandbox:
  // an approved shell command still runs as the current OS user and can access that user's files.
  const safeEnvironment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) {
    if (process.env[key] !== undefined) safeEnvironment[key] = process.env[key];
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      env: safeEnvironment,
      timeout: 30_000,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { command, cwd: '.', exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      command,
      cwd: '.',
      exitCode: Number.isInteger(error.code) ? error.code : null,
      stdout: String(error.stdout ?? '').slice(0, MAX_COMMAND_OUTPUT_BYTES / 2),
      stderr: String(error.stderr ?? '').slice(0, MAX_COMMAND_OUTPUT_BYTES / 2),
      timedOut: error.killed === true,
      error: error.killed ? 'Command timed out after 30 seconds.' : (error.message || 'Command failed.'),
    };
  }
}

export async function executeReadTool(root, name, args, options = {}) {
  const scopeOptions = { fullComputerAccess: options.fullComputerAccess === true };
  switch (name) {
    case 'list_files':
      return listWorkspace(root, args.path || '.', scopeOptions);
    case 'read_file':
      return readForAgent(root, args.path, scopeOptions);
    case 'search_text':
      return searchWorkspace(root, args.query, args.path || '.', scopeOptions);
    default:
      throw new Error(`Unknown read-only tool: ${name}`);
  }
}

export async function executeMutationTool(root, name, args, options = {}) {
  switch (name) {
    case 'write_file':
      return writeWorkspaceFile(root, args.path, args.content, options.expectedWriteState || null, {
        fullComputerAccess: options.fullComputerAccess === true,
      });
    case 'run_command':
      return runWorkspaceCommand(root, args.command);
    default:
      throw new Error(`Unknown change tool: ${name}`);
  }
}

export function actionFingerprint(name, args) {
  return crypto.createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
}

export const READ_TOOLS = new Set(['list_files', 'read_file', 'search_text']);
export const CHANGE_TOOLS = new Set(['write_file', 'run_command']);
