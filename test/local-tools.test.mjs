import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  executeGitCommit,
  executeLocalReadTool,
  getGitRepositoryConfig,
  initializeGitRepository,
  parsePosixProcessListForTest,
  saveGitRepositoryConfig,
  saveRepositoryInstructions,
  stageGitFiles,
  unstageGitFiles,
  parseWindowsTasklist,
  prepareGitCommitPreview,
} from '../src/local-tools.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function makeGitRepository(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-local-git-tools-'));
  t.after(async () => fs.rm(temporary, { recursive: true, force: true }));
  await git(temporary, ['init', '--quiet']);
  await git(temporary, ['config', 'user.name', 'Arena Local Test']);
  await git(temporary, ['config', 'user.email', 'arena-local-test@example.invalid']);
  await fs.writeFile(path.join(temporary, 'README.md'), 'initial content\n');
  await git(temporary, ['add', 'README.md']);
  await git(temporary, ['commit', '--quiet', '-m', 'initial commit']);
  return temporary;
}

test('Git inspection stays at the workspace repository root and hides protected paths', async (t) => {
  const root = await makeGitRepository(t);
  await fs.writeFile(path.join(root, 'README.md'), 'initial content\nvisible staged edit\n');
  await git(root, ['add', 'README.md']);
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=do-not-return-this-value\n');
  await git(root, ['add', '--force', '.env']);
  await fs.mkdir(path.join(root, 'untracked-folder'));
  await fs.writeFile(path.join(root, 'untracked-folder', 'visible.txt'), 'untracked local content');

  const status = await executeLocalReadTool(root, 'git_status');
  assert.ok(status.branch);
  assert.ok(status.changes.some((change) => change.path === 'README.md'));
  assert.equal(status.omittedProtectedCount, 1);
  assert.doesNotMatch(JSON.stringify(status), /\.env|do-not-return-this-value/);
  assert.ok(status.changes.some((change) => ['untracked-folder', 'untracked-folder/'].includes(change.path)));
  assert.equal(status.changes.some((change) => change.path === 'untracked-folder/visible.txt'), false);
  const detailedLocalStatus = await executeLocalReadTool(root, 'git_status', { includeUntrackedFiles: true });
  assert.ok(detailedLocalStatus.changes.some((change) => change.path === 'untracked-folder/visible.txt'));

  const diff = await executeLocalReadTool(root, 'git_diff');
  assert.equal(diff.staged, true);
  assert.deepEqual(diff.files, ['README.md']);
  assert.match(diff.diff, /visible staged edit/);
  assert.doesNotMatch(diff.diff, /API_KEY|do-not-return-this-value|\.env/);

  const log = await executeLocalReadTool(root, 'git_log', { limit: 5 });
  assert.match(log.output, /initial commit/);

  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(executeLocalReadTool(nested, 'git_status'), /root is the selected workspace/i);
});

test('Git status, staged diff, and commit suppress repository-configured content filters', async (t) => {
  if (process.platform === 'win32') t.skip('This fixture uses POSIX filter commands.');
  const root = await makeGitRepository(t);
  const markerPath = path.join(root, 'CONTENT_FILTER_RAN');
  const newline = String.fromCharCode(10);
  await git(root, ['config', 'filter.safetytest.clean', 'sh -c "touch CONTENT_FILTER_RAN; cat"']);
  await git(root, ['config', 'filter.safetytest.required', 'true']);
  await fs.writeFile(path.join(root, '.gitattributes'), ['README.md filter=safetytest', ''].join(newline));
  await git(root, ['add', '.gitattributes', 'README.md']);
  assert.equal((await fs.stat(markerPath)).isFile(), true);
  await fs.rm(markerPath, { force: true });
  await git(root, [
    '-c', 'filter.safetytest.clean=',
    '-c', 'filter.safetytest.process=',
    '-c', 'filter.safetytest.required=false',
    'commit', '--quiet', '-m', 'configure clean filter',
  ]);

  await fs.writeFile(path.join(root, 'README.md'), ['filtered staged change', ''].join(newline));
  await git(root, ['add', 'README.md']);
  await fs.rm(markerPath, { force: true });

  const diff = await executeLocalReadTool(root, 'git_diff');
  assert.equal(diff.staged, true);
  assert.match(diff.diff, /filtered staged change/);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  const filterSafePreview = await prepareGitCommitPreview(root, 'filter-safe preview');
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  await fs.writeFile(path.join(root, 'README.md'), ['changed in working tree', ''].join(newline));
  const status = await executeLocalReadTool(root, 'git_status');
  assert.equal(status.contentFiltersDisabled, true);
  assert.ok(status.changes.some((change) => change.path === 'README.md'));
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  await git(root, ['config', 'filter.safetytest.process', 'sh -c "touch CONTENT_FILTER_RAN; exit 0"']);
  await executeLocalReadTool(root, 'git_status');
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  const committed = await executeGitCommit(root, 'filter-safe preview', filterSafePreview.fingerprint);
  assert.equal(committed.message, 'filter-safe preview');
  assert.equal((await git(root, ['log', '-1', '--format=%s'])).stdout.trim(), 'filter-safe preview');
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
});

test('Git initialization creates a repository at the selected root with no remote or template hooks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-local-git-init-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README.md'), ['new project', ''].join(String.fromCharCode(10)));
  const result = await initializeGitRepository(root);
  assert.deepEqual(result, { initialized: true, branch: 'main' });
  const config = await getGitRepositoryConfig(root);
  assert.equal(config.branch, 'main');
  assert.deepEqual(config.remotes, []);
  assert.deepEqual(await executeLocalReadTool(root, 'git_log'), { output: '', count: 0, truncated: false });
  assert.equal((await executeLocalReadTool(root, 'git_diff')).diff, '');
  await assert.rejects(fs.access(path.join(root, '.git', 'hooks')), { code: 'ENOENT' });
  assert.equal((await initializeGitRepository(root)).initialized, false);
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(initializeGitRepository(nested), /different Git repository/i);
});

test('repository configuration stays local, redacts existing remote credentials, and accepts only safe HTTPS remotes', async (t) => {
  const root = await makeGitRepository(t);
  await git(root, ['remote', 'add', 'origin', 'https://arena-user:github_pat_do-not-leak@github.com/acme/project.git']);

  const current = await getGitRepositoryConfig(root);
  assert.ok(current.branch);
  assert.equal(current.userName, 'Arena Local Test');
  assert.equal(current.userEmail, 'arena-local-test@example.invalid');
  assert.equal(current.remotes[0].fetchUrl, 'https://github.com/acme/project.git');
  assert.doesNotMatch(JSON.stringify(current), /github_pat_do-not-leak|arena-user/);

  const saved = await saveGitRepositoryConfig(root, {
    userName: 'Local Author',
    userEmail: 'local-author@example.com',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/acme/updated.git',
  });
  assert.equal(saved.permission, 'local_only');
  assert.equal(saved.configured.remote.updated, true);
  assert.equal((await git(root, ['config', '--local', '--get', 'user.name'])).stdout.trim(), 'Local Author');
  assert.equal((await git(root, ['config', '--local', '--get', 'user.email'])).stdout.trim(), 'local-author@example.com');
  assert.equal((await git(root, ['remote', 'get-url', 'origin'])).stdout.trim(), 'https://github.com/acme/updated.git');
  await assert.rejects(saveGitRepositoryConfig(root, { remoteName: 'origin', remoteUrl: 'https://user:secret@github.com/acme/private.git' }), /embedded credentials/i);
  await assert.rejects(saveGitRepositoryConfig(root, { remoteName: 'origin', remoteUrl: 'ssh://git@github.com/acme/private.git' }), /must use HTTPS/i);
  await assert.rejects(saveGitRepositoryConfig(root, { userEmail: 'not-an-email' }), /valid email/i);

  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(saveGitRepositoryConfig(nested, { userName: 'Outside' }), /root is the selected workspace/i);
});

test('repository-specific ARENA.md is bounded text and never follows a symbolic link', async (t) => {
  const root = await makeGitRepository(t);
  const initial = await getGitRepositoryConfig(root);
  assert.equal(initial.instructionsExists, false);
  const text = ['# Project instructions', '', 'Use npm test before local commits.', ''].join(String.fromCharCode(10));
  const saved = await saveRepositoryInstructions(root, text);
  assert.equal(saved.path, 'ARENA.md');
  assert.equal(saved.bytes, Buffer.byteLength(text));
  assert.equal(await fs.readFile(path.join(root, 'ARENA.md'), 'utf8'), text);
  const current = await getGitRepositoryConfig(root);
  assert.equal(current.instructions, text);
  assert.equal(current.instructionsExists, true);
  await assert.rejects(saveRepositoryInstructions(root, 'x'.repeat(24 * 1024 + 1)), /24 KB/i);
  await assert.rejects(saveRepositoryInstructions(root, ['contains', 'null'].join(String.fromCharCode(0))), /null characters/i);
  const instructionsPath = path.join(root, 'ARENA.md');
  await fs.writeFile(instructionsPath, 'x'.repeat(24 * 1024 + 1));
  const oversizedConfig = await getGitRepositoryConfig(root);
  assert.match(oversizedConfig.instructionsIssue, /larger than the 24 KB editor limit/i);
  await fs.writeFile(instructionsPath, text);
  if (process.platform === 'win32') return;
  assert.equal((await fs.stat(instructionsPath)).mode & 0o777, 0o600);

  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside-instructions.txt`);
  t.after(async () => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, 'keep this unchanged');
  await fs.rm(instructionsPath);
  await fs.symlink(outside, instructionsPath);
  const linkedConfig = await getGitRepositoryConfig(root);
  assert.match(linkedConfig.instructionsIssue, /not a regular file/i);
  assert.equal(linkedConfig.instructions, '');
  await assert.rejects(saveRepositoryInstructions(root, 'must not follow'), /not a regular file/i);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep this unchanged');
});

test('staging is exact-path, protects secrets, and disables configured content filters', async (t) => {
  if (process.platform === 'win32') t.skip('This fixture uses a POSIX Git filter command.');
  const root = await makeGitRepository(t);
  const markerPath = path.join(root, 'CONTENT_FILTER_RAN');
  const newline = String.fromCharCode(10);
  await git(root, ['config', 'filter.safetytest.clean', 'sh -c "touch CONTENT_FILTER_RAN; cat"']);
  await git(root, ['config', 'filter.safetytest.required', 'true']);
  await fs.writeFile(path.join(root, '.gitattributes'), `README.md filter=safetytest${newline}`);
  await git(root, ['add', '.gitattributes']);
  await git(root, ['commit', '--quiet', '-m', 'configure test filter']);
  await fs.rm(markerPath, { force: true });

  await fs.writeFile(path.join(root, 'README.md'), `initial content${newline}staged without filters${newline}`);
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=private');
  const status = await executeLocalReadTool(root, 'git_status');
  assert.equal(status.contentFiltersDisabled, true);
  assert.ok(status.changes.some((change) => change.path === 'README.md'));
  assert.doesNotMatch(JSON.stringify(status), /\.env|TOKEN=private/);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });

  const staged = await stageGitFiles(root, ['README.md']);
  assert.equal(staged.stagedCount, 1);
  assert.equal(staged.contentFiltersDisabled, true);
  assert.match((await executeLocalReadTool(root, 'git_diff')).diff, /staged without filters/);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
  await assert.rejects(stageGitFiles(root, ['.env']), /invalid or protected|current changed files/i);
  await assert.rejects(stageGitFiles(root, ['../outside.txt']), /invalid or protected/i);

  const unstaged = await unstageGitFiles(root, ['README.md']);
  assert.equal(unstaged.unstagedCount, 1);
  assert.equal((await executeLocalReadTool(root, 'git_diff')).diff, '');
  assert.match((await fs.readFile(path.join(root, 'README.md'), 'utf8')), /staged without filters/);
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
});

test('unstaging works for a repository with no initial commit and leaves working files untouched', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-local-unborn-git-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--quiet']);
  const fileContent = ['first commit content', ''].join(String.fromCharCode(10));
  await fs.writeFile(path.join(root, 'first.txt'), fileContent);
  await git(root, ['add', 'first.txt']);
  const result = await unstageGitFiles(root, ['first.txt']);
  assert.equal(result.unstagedCount, 1);
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).stdout, '');
  assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), fileContent);
});

test('Git commit previews staged changes, rejects stale or protected content, and skips hooks', async (t) => {
  const root = await makeGitRepository(t);
  const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
  const markerPath = path.join(root, 'hook-ran.txt');
  await fs.writeFile(hookPath, `#!/bin/sh\nprintf 'hook ran' > '${markerPath.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });

  await fs.writeFile(path.join(root, 'README.md'), 'initial content\nstaged change\n');
  await git(root, ['add', 'README.md']);
  const preview = await prepareGitCommitPreview(root, 'approved commit');
  assert.equal(preview.fileCount, 1);
  assert.match(preview.diff, /staged change/);
  assert.equal(preview.message, 'approved commit');

  await fs.writeFile(path.join(root, 'README.md'), 'initial content\nchanged after review\n');
  await git(root, ['add', 'README.md']);
  await assert.rejects(
    executeGitCommit(root, 'approved commit', preview.fingerprint),
    /changed after you reviewed/i,
  );
  assert.equal((await git(root, ['log', '-1', '--format=%s'])).stdout.trim(), 'initial commit');

  await fs.writeFile(path.join(root, '.env'), 'API_KEY=private\n');
  await git(root, ['add', '--force', '.env']);
  await assert.rejects(prepareGitCommitPreview(root, 'should not commit secrets'), /protected path/i);
  await git(root, ['reset', '--quiet', '--', '.env']);

  const finalPreview = await prepareGitCommitPreview(root, 'approved commit');
  await assert.rejects(
    executeGitCommit(root, 'different commit message', finalPreview.fingerprint),
    /commit message changed after you reviewed/i,
  );
  const committed = await executeGitCommit(root, 'approved commit', finalPreview.fingerprint);
  assert.match(committed.commit, /^[0-9a-f]+$/i);
  assert.equal(committed.fileCount, 1);
  assert.equal(committed.hooksDisabled, true);
  assert.equal(committed.signingDisabled, true);
  assert.equal((await git(root, ['log', '-1', '--format=%s'])).stdout.trim(), 'approved commit');
  await assert.rejects(fs.access(markerPath), { code: 'ENOENT' });
});

test('process-list parsers return only executable names and numeric PIDs', () => {
  assert.deepEqual(parseWindowsTasklist([
    '"System Idle Process","0","Services","0","8 K"',
    '"agent, helper.exe","4321","Console","1","42,000 K"',
    '"quoted ""app"".exe","77","Console","1","4,000 K"',
  ].join('\r\n')), [
    { pid: 0, name: 'System Idle Process' },
    { pid: 4321, name: 'agent, helper.exe' },
    { pid: 77, name: 'quoted "app".exe' },
  ]);
  assert.deepEqual(parsePosixProcessListForTest('  10 /usr/bin/node\n  22 chrome\n'), [
    { pid: 10, name: 'node' },
    { pid: 22, name: 'chrome' },
  ]);
});

test('process listing returns only names and PIDs', async () => {
  const result = await executeLocalReadTool('', 'list_processes');
  assert.ok(result.processes.length > 0);
  assert.ok(result.processes.every((entry) => Number.isSafeInteger(entry.pid) && typeof entry.name === 'string'));
  assert.ok(result.processes.every((entry) => Object.keys(entry).sort().join(',') === 'name,pid'));
  assert.ok(result.processes.length <= 500);
});
