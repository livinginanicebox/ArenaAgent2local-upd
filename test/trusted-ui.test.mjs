import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertTrustedUiEvent } from '../desktop/trusted-ui.mjs';

const uiPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
const uiUrl = pathToFileURL(uiPath).href;

function makeTrustedWindow(url = uiUrl) {
  const mainFrame = { url, isMainFrame: true };
  const webContents = {
    id: 41,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  };
  const window = { webContents, isDestroyed: () => false };
  return { window, webContents, mainFrame };
}

function invokeEvent(webContents, senderFrame = webContents.mainFrame) {
  return {
    sender: { id: webContents.id },
    senderFrame,
  };
}

test('trusted local main-frame actions tolerate Electron WebContents wrapper identity changes', () => {
  const fixture = makeTrustedWindow();
  assert.doesNotThrow(() => assertTrustedUiEvent(invokeEvent(fixture.webContents), fixture.window, uiPath));
});

test('trusted local actions can verify the main frame when Electron omits senderFrame', () => {
  const fixture = makeTrustedWindow();
  const event = { sender: { id: fixture.webContents.id } };
  assert.doesNotThrow(() => assertTrustedUiEvent(event, fixture.window, uiPath));
});

test('untrusted WebContents cannot use desktop IPC actions', () => {
  const fixture = makeTrustedWindow();
  assert.throws(
    () => assertTrustedUiEvent({ sender: { id: fixture.webContents.id + 1 } }, fixture.window, uiPath),
    /only from the Arena Local desktop window/i,
  );
});

test('subframes, remote origins, and other local files are rejected', () => {
  const fixture = makeTrustedWindow();
  assert.throws(
    () => assertTrustedUiEvent(invokeEvent(fixture.webContents, { url: uiUrl, isMainFrame: false }), fixture.window, uiPath),
    /trusted Arena Local interface/i,
  );

  const remote = makeTrustedWindow('https://example.com/');
  assert.throws(
    () => assertTrustedUiEvent(invokeEvent(remote.webContents), remote.window, uiPath),
    /trusted Arena Local interface/i,
  );

  const otherFile = makeTrustedWindow(pathToFileURL(path.join(path.dirname(uiPath), 'other.html')).href);
  assert.throws(
    () => assertTrustedUiEvent(invokeEvent(otherFile.webContents), otherFile.window, uiPath),
    /trusted Arena Local interface/i,
  );
});
