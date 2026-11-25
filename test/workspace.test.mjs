import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  listWorkspace,
  readForAgent,
  resolveWorkspaceRoot,
  resolveWorkspacePath,
  searchWorkspace,
  writeWorkspaceFile,
} from '../src/workspace.mjs';

async function makeWorkspace(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-local-test-'));
  const rootPath = path.join(parent, 'workspace');
  await fs.mkdir(rootPath);
  const root = await resolveWorkspaceRoot(rootPath);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root };
}

test('workspace listing and reading stay within the selected root', async (t) => {
  const { root } = await makeWorkspace(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=not-for-the-agent');
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'config'), 'private');

  const listing = await listWorkspace(root, '.');
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['.env', 'src']);
  assert.equal(listing.entries.find((entry) => entry.name === '.env').protected, true);
  assert.equal((await readForAgent(root, 'src/app.js')).content, 'export const answer = 42;\n');
  await assert.rejects(readForAgent(root, '.env'), /protected/i);
  await assert.rejects(readForAgent(root, '.git/config'), /protected directory/i);
});

test('parent traversal, absolute paths, and symbolic links are rejected', async (t) => {
  const { parent, root } = await makeWorkspace(t);
  await fs.writeFile(path.join(parent, 'outside.txt'), 'outside');
  await assert.rejects(resolveWorkspacePath(root, '../outside.txt'), /Parent-directory|outside/i);
  await assert.rejects(resolveWorkspacePath(root, path.join(parent, 'outside.txt')), /Absolute paths/i);

  const linkPath = path.join(root, 'escape');
  try {
    await fs.symlink(path.join(parent, 'outside.txt'), linkPath);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlinks are unavailable in this environment.');
    throw error;
  }
  await assert.rejects(readForAgent(root, 'escape'), /Symbolic links/i);
  await assert.rejects(writeWorkspaceFile(root, 'escape', 'overwrite'), /Symbolic links/i);
  await fs.mkdir(path.join(parent, 'outside-dir'));
  await fs.writeFile(path.join(parent, 'outside-dir', 'nested.txt'), 'outside through a directory link');
  await fs.symlink(path.join(parent, 'outside-dir'), path.join(root, 'linked-folder'));
  await assert.rejects(readForAgent(root, 'linked-folder/nested.txt'), /Symbolic links/i);
});

test('writes are workspace-relative and search skips protected directories', async (t) => {
  const { root } = await makeWorkspace(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'find-me here\n');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'secret.txt'), 'find-me hidden\n');

  const result = await writeWorkspaceFile(root, 'src/new.txt', 'hello\n');
  assert.equal(result.written, true);
  assert.equal(await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8'), 'hello\n');
  const matches = await searchWorkspace(root, 'find-me');
  assert.deepEqual(matches.matches.map((item) => item.path), ['src/app.js']);
  await assert.rejects(writeWorkspaceFile(root, '../outside.txt', 'nope'), /Parent-directory|outside/i);
});
