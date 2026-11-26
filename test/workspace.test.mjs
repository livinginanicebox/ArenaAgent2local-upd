import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  listWorkspace,
  previewWorkspaceWrite,
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

test('atomic ARENA.md save leftovers remain protected from file reads and search', async (t) => {
  const { root } = await makeWorkspace(t);
  const temporaryName = '.arena-local-instructions-01234567-89ab-cdef-0123-456789abcdef.tmp';
  await fs.writeFile(path.join(root, temporaryName), 'private repository-instructions draft');
  const listing = await listWorkspace(root, '.');
  assert.equal(listing.entries.find((entry) => entry.name === temporaryName).protected, true);
  await assert.rejects(readForAgent(root, temporaryName), /protected/i);
  const results = await searchWorkspace(root, 'private repository-instructions');
  assert.deepEqual(results.matches, []);
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

test('full-computer access permits absolute paths outside the workspace when explicitly enabled', async (t) => {
  const { parent, root } = await makeWorkspace(t);
  const privateDirectoryInput = path.join(parent, 'private');
  await fs.mkdir(privateDirectoryInput);
  const privateDirectory = await fs.realpath(privateDirectoryInput);
  const privateFile = path.join(privateDirectory, '.env');
  const newFile = path.join(privateDirectory, 'notes.txt');
  await fs.writeFile(privateFile, 'TEST_TOKEN=fixture-only\n');

  await assert.rejects(readForAgent(root, privateFile), /Absolute paths/i);
  await assert.rejects(listWorkspace(root, privateDirectory), /Absolute paths/i);
  await assert.rejects(writeWorkspaceFile(root, newFile, 'outside'), /Absolute paths/i);

  const listed = await listWorkspace(root, privateDirectory, { fullComputerAccess: true });
  assert.equal(listed.path, privateDirectory);
  assert.equal(listed.entries.find((entry) => entry.name === '.env').protected, false);
  const read = await readForAgent(root, privateFile, { fullComputerAccess: true });
  assert.equal(read.path, privateFile);
  assert.equal(read.content, 'TEST_TOKEN=fixture-only\n');
  await assert.rejects(readForAgent(null, 'notes.txt', { fullComputerAccess: true }), /no selected workspace.*absolute path/i);
  const noWorkspaceRead = await readForAgent(null, privateFile, { fullComputerAccess: true });
  assert.equal(noWorkspaceRead.path, privateFile);
  assert.equal(noWorkspaceRead.content, 'TEST_TOKEN=fixture-only\n');
  const noWorkspaceList = await listWorkspace(null, privateDirectory, { fullComputerAccess: true });
  assert.equal(noWorkspaceList.path, privateDirectory);

  const preview = await previewWorkspaceWrite(root, newFile, 'approved outside write\n', { fullComputerAccess: true });
  assert.equal(preview.outsideWorkspace, true);
  assert.equal(preview.path, newFile);
  const written = await writeWorkspaceFile(root, newFile, 'approved outside write\n', null, { fullComputerAccess: true });
  assert.equal(written.path, newFile);
  assert.equal(await fs.readFile(newFile, 'utf8'), 'approved outside write\n');
  const noWorkspaceNewFile = path.join(privateDirectory, 'no-workspace.txt');
  const noWorkspacePreview = await previewWorkspaceWrite(null, noWorkspaceNewFile, 'explicit path write\n', { fullComputerAccess: true });
  assert.equal(noWorkspacePreview.path, noWorkspaceNewFile);
  const noWorkspaceWritten = await writeWorkspaceFile(null, noWorkspaceNewFile, 'explicit path write\n', null, { fullComputerAccess: true });
  assert.equal(noWorkspaceWritten.path, noWorkspaceNewFile);
  assert.equal(await fs.readFile(noWorkspaceNewFile, 'utf8'), 'explicit path write\n');
});
