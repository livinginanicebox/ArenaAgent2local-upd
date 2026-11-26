import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isProtectedWorkspacePath } from './workspace.mjs';

const execFileAsync = promisify(execFile);
const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_EXEC_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_GIT_STATUS_ENTRIES = 200;
const MAX_GIT_DIFF_FILES = 200;
const MAX_GIT_COMMIT_PREVIEW_BYTES = 128 * 1024;
const MAX_PROCESS_ENTRIES = 500;
const GIT_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_GIT_FILTER_DRIVERS = 128;
const GIT_FILTER_DRIVER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT',
];

export const LOCAL_READ_TOOLS = new Set([
  'git_status',
  'git_diff',
  'git_log',
  'list_processes',
]);

export const LOCAL_MUTATION_TOOLS = new Set(['git_commit']);

function safeEnvironment() {
  const env = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  return env;
}

function limitText(value, maxBytes = MAX_TOOL_OUTPUT_BYTES) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  const suffix = '\n… output truncated by Arena Local …';
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  return { text: `${buffer.subarray(0, room).toString('utf8')}${suffix}`, truncated: true };
}

function processError(error, executable) {
  if (error?.killed) return `${executable} timed out.`;
  if (error?.code === 'ENOENT') return `${executable} is not installed or is not available in PATH.`;
  return error?.message || `${executable} failed.`;
}

async function runExecutable(executable, args, { cwd, timeout = GIT_TIMEOUT_MS, maxBuffer = MAX_EXEC_BUFFER_BYTES } = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env: safeEnvironment(),
      encoding: 'utf8',
      timeout,
      maxBuffer,
      windowsHide: true,
    });
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), exitCode: 0, error: '' };
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      exitCode: Number.isInteger(error.code) ? error.code : null,
      error: processError(error, executable),
    };
  }
}

function gitFailure(result) {
  const detail = String(result.stderr || result.error || '').trim();
  return detail ? `Git operation failed: ${detail.slice(0, 1_000)}` : 'Git operation failed.';
}

async function configuredGitFilterDrivers(root) {
  const result = await runExecutable('git', [
    '-C', root,
    '-c', 'core.fsmonitor=false',
    'config', '--null', '--name-only', '--get-regexp', '^filter[.].*[.](clean|process)$',
  ], { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_EXEC_BUFFER_BYTES });
  if (result.exitCode === 1 && !result.stdout && !result.stderr.trim()) return [];
  if (result.exitCode !== 0) throw new Error(gitFailure(result));

  const drivers = new Set();
  for (const key of result.stdout.split('\0').filter(Boolean)) {
    const lowerKey = key.toLowerCase();
    const suffixLength = lowerKey.endsWith('.clean') ? '.clean'.length
      : lowerKey.endsWith('.process') ? '.process'.length : 0;
    const separator = key.indexOf('.');
    const driver = suffixLength && separator >= 0
      ? key.slice(separator + 1, -suffixLength)
      : '';
    if (!GIT_FILTER_DRIVER_PATTERN.test(driver)) {
      throw new Error('Git filter configuration contains an unsupported driver name; refusing to inspect repository safely.');
    }
    drivers.add(driver);
    if (drivers.size > MAX_GIT_FILTER_DRIVERS) {
      throw new Error('Too many Git filter drivers are configured; refusing to inspect repository safely.');
    }
  }
  return [...drivers];
}

async function runGit(root, args, options = {}) {
  const filterOverrides = options.disableContentFilters
    ? (await configuredGitFilterDrivers(root)).flatMap((driver) => [
      '-c', `filter.${driver}.clean=`,
      '-c', `filter.${driver}.process=`,
      '-c', `filter.${driver}.required=false`,
    ])
    : [];
  return runExecutable('git', [
    '-C', root,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    ...filterOverrides,
    ...args,
  ], { cwd: root, timeout: options.timeout || GIT_TIMEOUT_MS, maxBuffer: options.maxBuffer || MAX_EXEC_BUFFER_BYTES });
}

async function requireGitSuccess(root, args, options) {
  const result = await runGit(root, args, options);
  if (result.exitCode !== 0) throw new Error(gitFailure(result));
  return result;
}

function trimLineEnding(value) {
  return String(value ?? '').replace(/\r?\n$/, '');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

async function assertWorkspaceRepositoryRoot(root) {
  const result = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) throw new Error('The selected workspace is not a Git repository.');
  const discoveredRoot = trimLineEnding(result.stdout);
  let realDiscoveredRoot;
  let realWorkspaceRoot;
  try {
    [realDiscoveredRoot, realWorkspaceRoot] = await Promise.all([
      fs.realpath(path.isAbsolute(discoveredRoot) ? discoveredRoot : path.resolve(root, discoveredRoot)),
      fs.realpath(root),
    ]);
  } catch {
    throw new Error('Could not safely resolve the Git repository root.');
  }
  if (!samePath(realDiscoveredRoot, realWorkspaceRoot)) {
    throw new Error('Git actions are limited to a repository whose root is the selected workspace.');
  }
}

function nulSeparatedValues(value) {
  return String(value ?? '').split('\0').filter((item) => item.length > 0);
}

function parseGitStatus(value) {
  const records = nulSeparatedValues(value);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') continue;
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

async function readGitHead(root) {
  const branchResult = await requireGitSuccess(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headResult = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  return {
    branch: trimLineEnding(branchResult.stdout) || 'HEAD',
    head: headResult.exitCode === 0 ? trimLineEnding(headResult.stdout) : '',
  };
}

async function gitChangedPaths(root, staged = false) {
  await assertWorkspaceRepositoryRoot(root);
  const options = staged ? ['--cached'] : [];
  const result = await requireGitSuccess(root, [
    'diff', ...options, '--name-only', '-z', '--no-renames', '--',
  ]);
  const paths = nulSeparatedValues(result.stdout);
  const safePaths = [];
  let omittedProtectedCount = 0;
  for (const filePath of paths) {
    if (isProtectedWorkspacePath(filePath)) omittedProtectedCount += 1;
    else safePaths.push(filePath);
  }
  return { safePaths, omittedProtectedCount };
}

async function getGitDiff(root, paths, staged = false, maxBytes = MAX_TOOL_OUTPUT_BYTES) {
  if (!paths.length) return { diff: '', truncated: false };
  const options = staged ? ['--cached'] : [];
  const result = await requireGitSuccess(root, [
    'diff', ...options,
    '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--',
    ...paths.map((filePath) => `:(literal)${filePath}`),
  ]);
  const limited = limitText(result.stdout, maxBytes);
  return { diff: limited.text, truncated: limited.truncated };
}

function parsePosixProcessList(value) {
  const processes = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const name = path.basename(match[2]).slice(0, 256);
    if (Number.isSafeInteger(pid) && name) processes.push({ pid, name });
  }
  return processes;
}

function parseCsvRow(line) {
  const fields = [];
  let index = 0;
  while (index < line.length) {
    let value = '';
    if (line[index] === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === '"' && line[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (line[index] === '"') {
          index += 1;
          break;
        } else {
          value += line[index];
          index += 1;
        }
      }
      while (index < line.length && line[index] !== ',') index += 1;
    } else {
      while (index < line.length && line[index] !== ',') {
        value += line[index];
        index += 1;
      }
    }
    fields.push(value);
    if (line[index] === ',') index += 1;
  }
  return fields;
}

export function parseWindowsTasklist(value) {
  const processes = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, rawPid] = parseCsvRow(line);
    const pid = Number(rawPid);
    if (name && Number.isSafeInteger(pid)) processes.push({ pid, name: name.slice(0, 256) });
  }
  return processes;
}

async function listProcesses() {
  const windows = process.platform === 'win32';
  const result = await runExecutable(
    windows ? 'tasklist' : 'ps',
    windows ? ['/FO', 'CSV', '/NH'] : ['-eo', 'pid=,comm='],
    { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_EXEC_BUFFER_BYTES },
  );
  if (result.exitCode !== 0) throw new Error(result.error || `${windows ? 'tasklist' : 'ps'} could not list processes.`);
  const processes = windows ? parseWindowsTasklist(result.stdout) : parsePosixProcessList(result.stdout);
  return {
    processes: processes.slice(0, MAX_PROCESS_ENTRIES),
    count: processes.length,
    truncated: processes.length > MAX_PROCESS_ENTRIES,
  };
}

export async function executeLocalReadTool(root, name, args = {}) {
  switch (name) {
    case 'git_status': {
      await assertWorkspaceRepositoryRoot(root);
      const [{ branch }, statusResult] = await Promise.all([
        readGitHead(root),
        requireGitSuccess(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames'], { disableContentFilters: true }),
      ]);
      const changes = [];
      let omittedProtectedCount = 0;
      let truncated = false;
      for (const entry of parseGitStatus(statusResult.stdout)) {
        if (isProtectedWorkspacePath(entry.path)) {
          omittedProtectedCount += 1;
          continue;
        }
        if (changes.length >= MAX_GIT_STATUS_ENTRIES) {
          truncated = true;
          continue;
        }
        changes.push(entry);
      }
      return { branch, changes, count: changes.length, omittedProtectedCount, truncated, contentFiltersDisabled: true };
    }
    case 'git_diff': {
      await assertWorkspaceRepositoryRoot(root);
      const { safePaths, omittedProtectedCount } = await gitChangedPaths(root, true);
      const selectedPaths = safePaths.slice(0, MAX_GIT_DIFF_FILES);
      const result = await getGitDiff(root, selectedPaths, true);
      return {
        staged: true,
        files: selectedPaths,
        fileCount: safePaths.length,
        omittedProtectedCount,
        diff: result.diff,
        truncated: result.truncated || safePaths.length > selectedPaths.length,
      };
    }
    case 'git_log': {
      await assertWorkspaceRepositoryRoot(root);
      const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 20;
      const result = await requireGitSuccess(root, [
        'log', '-n', String(limit), '--date=short', '--no-color', '--no-decorate',
        '--format=%h%x09%ad%x09%s',
      ]);
      const output = limitText(result.stdout);
      return { output: output.text, count: result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean).length : 0, truncated: output.truncated };
    }
    case 'list_processes':
      return listProcesses();
    default:
      throw new Error(`Unknown local read-only tool: ${name}`);
  }
}

async function prepareStagedGitChanges(root, message) {
  await assertWorkspaceRepositoryRoot(root);
  const [{ branch, head }, pathsResult] = await Promise.all([
    readGitHead(root),
    requireGitSuccess(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--']),
  ]);
  const paths = nulSeparatedValues(pathsResult.stdout);
  if (!paths.length) throw new Error('There are no staged Git changes to commit. Stage the intended changes locally, then retry.');
  const protectedPaths = paths.filter((filePath) => isProtectedWorkspacePath(filePath));
  if (protectedPaths.length) {
    throw new Error(`Staged Git changes include ${protectedPaths.length} protected path(s). Unstage protected files before using git_commit.`);
  }
  if (paths.length > MAX_GIT_DIFF_FILES) {
    throw new Error(`Staged changes include more than ${MAX_GIT_DIFF_FILES} files. Split the commit into smaller staged groups.`);
  }
  const diffResult = await getGitDiff(root, paths, true, MAX_GIT_COMMIT_PREVIEW_BYTES + 1);
  if (diffResult.truncated || Buffer.byteLength(diffResult.diff, 'utf8') > MAX_GIT_COMMIT_PREVIEW_BYTES) {
    throw new Error('The staged diff is too large for a complete local approval preview. Split the changes into smaller commits.');
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ branch, head, message, paths, diff: diffResult.diff })).digest('hex');
  return {
    branch,
    head,
    message,
    files: paths,
    fileCount: paths.length,
    diff: diffResult.diff,
    fingerprint,
  };
}

export async function prepareGitCommitPreview(root, message) {
  return prepareStagedGitChanges(root, message);
}

export async function executeGitCommit(root, message, expectedFingerprint = null) {
  const preview = await prepareStagedGitChanges(root, message);
  if (expectedFingerprint && preview.fingerprint !== expectedFingerprint) {
    throw new Error('Staged Git changes, branch, or commit message changed after you reviewed the commit. Nothing was committed; submit a new request and review it again.');
  }
  const disabledHooksPath = path.join(os.tmpdir(), `arena-local-disabled-hooks-${crypto.randomUUID()}`);
  const result = await runGit(root, [
    '-c', `core.hooksPath=${disabledHooksPath}`,
    '-c', 'commit.gpgSign=false',
    '-c', 'gc.auto=0',
    'commit', '--no-verify', '--no-gpg-sign', '-m', message,
  ], { disableContentFilters: true });
  if (result.exitCode !== 0) throw new Error(gitFailure(result));
  const headResult = await requireGitSuccess(root, ['rev-parse', '--short', 'HEAD']);
  const stdout = limitText(result.stdout);
  const stderr = limitText(result.stderr);
  return {
    branch: preview.branch,
    commit: trimLineEnding(headResult.stdout),
    message,
    fileCount: preview.fileCount,
    stdout: stdout.text,
    stderr: stderr.text,
    hooksDisabled: true,
    signingDisabled: true,
  };
}

export function parsePosixProcessListForTest(value) {
  return parsePosixProcessList(value);
}
