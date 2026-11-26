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
  parsePosixProcessListForTest,
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

  const status = await executeLocalReadTool(root, 'git_status');
  assert.ok(status.branch);
  assert.ok(status.changes.some((change) => change.path === 'README.md'));
  assert.equal(status.omittedProtectedCount, 1);
  assert.doesNotMatch(JSON.stringify(status), /\.env|do-not-return-this-value/);

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
