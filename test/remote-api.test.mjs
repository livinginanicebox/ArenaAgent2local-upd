import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRemoteApi } from '../src/remote-api.mjs';
import { resolveWorkspaceRoot } from '../src/workspace.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function makeFixture(t, initialMode = 'ask') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-local-remote-test-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  await fs.writeFile(path.join(workspacePath, 'README.md'), '# Local bridge test\n');
  const workspaceRoot = await resolveWorkspaceRoot(workspacePath);
  let token = 'A'.repeat(43);
  let mode = initialMode;
  const api = createRemoteApi({
    getWorkspaceRoot: () => workspaceRoot,
    getPairingToken: () => token,
    getPermissionMode: () => mode,
  });
  const port = await listen(api.server);
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  t.after(async () => {
    api.cancelPendingChanges('Test complete.');
    await new Promise((resolve) => api.server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return {
    api,
    base,
    headers,
    workspaceRoot,
    setMode: (value) => { mode = value; },
    setToken: (value) => { token = value; headers.authorization = `Bearer ${value}`; },
  };
}

async function postTask(fixture, body, headers = fixture.headers) {
  return fetch(`${fixture.base}/v1/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readTask(fixture, taskId, headers = fixture.headers) {
  return fetch(`${fixture.base}/v1/tasks/${taskId}`, { headers: { authorization: headers.authorization } });
}

async function waitForTask(fixture, taskId, predicate, timeoutMs = 4_000) {
  const stopAt = Date.now() + timeoutMs;
  let current;
  while (Date.now() < stopAt) {
    const response = await readTask(fixture, taskId);
    assert.equal(response.status, 200);
    current = await response.json();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  assert.fail(`Task did not reach the expected status. Last status: ${current?.status}`);
}

test('remote bridge requires its bearer key and supports scoped read requests', async (t) => {
  const fixture = await makeFixture(t);
  const unauthorized = await fetch(`${fixture.base}/v1/health`);
  assert.equal(unauthorized.status, 401);
  const badToken = await fetch(`${fixture.base}/v1/health`, { headers: { authorization: `Bearer ${'B'.repeat(43)}` } });
  assert.equal(badToken.status, 401);

  const request = { requestId: 'readme-task-01', action: 'read_file', args: { path: 'README.md' } };
  const submitted = await postTask(fixture, request);
  assert.equal(submitted.status, 202);
  const queued = await submitted.json();
  const completed = await waitForTask(fixture, queued.taskId, (task) => task.status === 'completed');
  assert.equal(completed.result.content, '# Local bridge test\n');
  assert.equal(completed.result.path, 'README.md');

  const retry = await (await postTask(fixture, request)).json();
  assert.equal(retry.taskId, queued.taskId, 'the same requestId must not execute twice');
  const conflict = await postTask(fixture, { ...request, args: { path: '.' } });
  assert.equal(conflict.status, 409);

  const health = await fetch(`${fixture.base}/v1/health`, { headers: { authorization: fixture.headers.authorization } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).permissionMode, 'ask');
});

test('writes are visible in the desktop queue and run only after approval', async (t) => {
  const fixture = await makeFixture(t);
  const request = {
    requestId: 'write-task-0001',
    action: 'write_file',
    args: { path: 'notes.txt', content: 'approved from desktop\n' },
  };
  const submitted = await postTask(fixture, request);
  assert.equal(submitted.status, 202);
  const queued = await submitted.json();
  assert.equal(queued.status, 'awaiting_approval');
  assert.equal(await fs.access(path.join(fixture.workspaceRoot, 'notes.txt')).then(() => true, () => false), false);

  const desktopTask = fixture.api.getTasks().find((task) => task.taskId === queued.taskId);
  assert.equal(desktopTask.preview.after, 'approved from desktop\n');
  assert.deepEqual(desktopTask.args, { path: 'notes.txt' });

  await fixture.api.approveTask(queued.taskId, 'approve');
  const completed = await waitForTask(fixture, queued.taskId, (task) => task.status === 'completed');
  assert.equal(completed.result.written, true);
  assert.equal(await fs.readFile(path.join(fixture.workspaceRoot, 'notes.txt'), 'utf8'), 'approved from desktop\n');
});

test('shell commands wait for desktop approval in Ask mode', async (t) => {
  const fixture = await makeFixture(t);
  const submitted = await postTask(fixture, {
    requestId: 'ask-command-0001',
    action: 'run_command',
    args: { command: 'echo held-for-approval' },
  });
  const queued = await submitted.json();
  assert.equal(queued.status, 'awaiting_approval');
  assert.equal(queued.autoApproved, false);
  const desktopTask = fixture.api.getTasks().find((task) => task.taskId === queued.taskId);
  assert.equal(desktopTask.args.command, 'echo held-for-approval');

  await fixture.api.approveTask(queued.taskId, 'approve');
  const completed = await waitForTask(fixture, queued.taskId, (task) => task.status === 'completed');
  assert.match(completed.result.stdout, /held-for-approval/i);
});

test('approval is refused if a file changes after the desktop diff was reviewed', async (t) => {
  const fixture = await makeFixture(t);
  const filePath = path.join(fixture.workspaceRoot, 'README.md');
  const submitted = await postTask(fixture, {
    requestId: 'stale-diff-task-01',
    action: 'write_file',
    args: { path: 'README.md', content: '# Agent version\n' },
  });
  const queued = await submitted.json();
  assert.equal(queued.status, 'awaiting_approval');
  await fs.writeFile(filePath, '# Changed by user while approval was pending\n');

  await fixture.api.approveTask(queued.taskId, 'approve');
  const failed = await waitForTask(fixture, queued.taskId, (task) => task.status === 'error');
  assert.match(failed.error, /changed after you reviewed it/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), '# Changed by user while approval was pending\n');
});

test('no-ask mode auto-runs writes and commands and marks them as dangerous', async (t) => {
  const fixture = await makeFixture(t, 'no-ask');
  const writeResponse = await postTask(fixture, {
    requestId: 'noask-write-0001', action: 'write_file', args: { path: 'automatic.txt', content: 'written without a prompt' },
  });
  const writeTask = await writeResponse.json();
  assert.notEqual(writeTask.status, 'awaiting_approval');
  assert.equal(writeTask.autoApproved, true);
  const written = await waitForTask(fixture, writeTask.taskId, (task) => task.status === 'completed');
  assert.equal(written.autoApproved, true);
  assert.equal(await fs.readFile(path.join(fixture.workspaceRoot, 'automatic.txt'), 'utf8'), 'written without a prompt');

  const commandResponse = await postTask(fixture, {
    requestId: 'noask-command-01', action: 'run_command', args: { command: 'echo no-ask-test' },
  });
  const commandTask = await commandResponse.json();
  assert.equal(commandTask.autoApproved, true);
  const commandResult = await waitForTask(fixture, commandTask.taskId, (task) => task.status === 'completed');
  assert.equal(commandResult.autoApproved, true);
  assert.match(commandResult.result.stdout, /no-ask-test/i);
  assert.equal(fixture.api.getTasks().some((task) => task.status === 'awaiting_approval'), false);
});

test('read-only mode blocks mutations; exact-session approval is scoped to the exact action', async (t) => {
  const fixture = await makeFixture(t, 'read-only');
  const blocked = await postTask(fixture, {
    requestId: 'readonly-write-01', action: 'write_file', args: { path: 'blocked.txt', content: 'no' },
  });
  const blockedTask = await blocked.json();
  assert.equal(blockedTask.status, 'denied');
  assert.equal(await fs.access(path.join(fixture.workspaceRoot, 'blocked.txt')).then(() => true, () => false), false);

  const blockedCommandResponse = await postTask(fixture, {
    requestId: 'readonly-command-01', action: 'run_command', args: { command: 'echo must-not-run' },
  });
  const blockedCommand = await blockedCommandResponse.json();
  assert.equal(blockedCommand.status, 'denied');
  assert.equal(blockedCommand.autoApproved, false);

  fixture.setMode('ask');
  const firstResponse = await postTask(fixture, {
    requestId: 'approved-write-01', action: 'write_file', args: { path: 'allowed.txt', content: 'exact action' },
  });
  const first = await firstResponse.json();
  assert.equal(first.status, 'awaiting_approval');
  await fixture.api.approveTask(first.taskId, 'approve_session');
  await waitForTask(fixture, first.taskId, (task) => task.status === 'completed');

  const secondResponse = await postTask(fixture, {
    requestId: 'approved-write-02', action: 'write_file', args: { path: 'allowed.txt', content: 'exact action' },
  });
  const second = await secondResponse.json();
  await waitForTask(fixture, second.taskId, (task) => task.status === 'completed');
  assert.equal(fixture.api.getTasks().some((task) => task.taskId === second.taskId && task.status === 'awaiting_approval'), false);

  await fs.writeFile(path.join(fixture.workspaceRoot, 'allowed.txt'), 'manual edit after approval');
  const staleSameAction = await postTask(fixture, {
    requestId: 'approved-write-03', action: 'write_file', args: { path: 'allowed.txt', content: 'exact action' },
  });
  assert.equal((await staleSameAction.json()).status, 'awaiting_approval', 'a changed file must be reviewed again');

  const different = await postTask(fixture, {
    requestId: 'new-content-task-01', action: 'write_file', args: { path: 'allowed.txt', content: 'different content' },
  });
  assert.equal((await different.json()).status, 'awaiting_approval');
});

test('invalid actions, traversal, and changed pairing tokens are rejected', async (t) => {
  const fixture = await makeFixture(t);
  const invalid = await postTask(fixture, { requestId: 'invalid-task-01', action: 'shell', args: { command: 'id' } });
  assert.equal(invalid.status, 400);
  const traversalResponse = await postTask(fixture, { requestId: 'traversal-task-01', action: 'read_file', args: { path: '../outside.txt' } });
  assert.equal(traversalResponse.status, 202);
  const traversalTask = await traversalResponse.json();
  const failed = await waitForTask(fixture, traversalTask.taskId, (task) => task.status === 'error');
  assert.match(failed.error, /Parent-directory|outside/i);

  fixture.setToken('C'.repeat(43));
  const oldToken = await fetch(`${fixture.base}/v1/health`, { headers: { authorization: 'Bearer ' + 'A'.repeat(43) } });
  assert.equal(oldToken.status, 401);
  const newToken = await fetch(`${fixture.base}/v1/health`, { headers: { authorization: 'Bearer ' + 'C'.repeat(43) } });
  assert.equal(newToken.status, 200);
});
