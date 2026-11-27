import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOW_ERROR = 'This action is available only from the Arena Local desktop window.';
const INTERFACE_ERROR = 'This action is available only from the trusted Arena Local interface.';

function isDestroyed(target) {
  return typeof target?.isDestroyed === 'function' && target.isDestroyed();
}

function samePath(actualPath, expectedPath) {
  const actual = path.resolve(actualPath);
  const expected = path.resolve(expectedPath);
  return process.platform === 'win32'
    ? actual.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
    : actual === expected;
}

/**
 * Validate that an IPC request came from the current local app window and its
 * packaged UI entry point. Electron can expose a different JS wrapper for a
 * WebContents object in an invoke event, so compare the stable WebContents id
 * as well as object identity. Some Electron versions can also omit senderFrame
 * for a frame that has just navigated; in that case, validate the window's
 * current main-frame URL instead of rejecting a legitimate local action.
 */
export function assertTrustedUiEvent(event, mainWindow, expectedUiPath) {
  const contents = mainWindow?.webContents;
  const sender = event?.sender;
  const senderMatches = Boolean(contents && sender && (
    sender === contents
    || (Number.isInteger(sender.id) && Number.isInteger(contents.id) && sender.id === contents.id)
  ));

  if (!mainWindow || isDestroyed(mainWindow) || !contents || isDestroyed(contents) || !senderMatches) {
    throw new Error(WINDOW_ERROR);
  }

  const frame = event?.senderFrame;
  const mainFrame = contents.mainFrame;
  if (frame?.isMainFrame === false || (frame && mainFrame && frame !== mainFrame && frame.isMainFrame !== true)) {
    throw new Error(INTERFACE_ERROR);
  }

  let senderPath;
  try {
    const frameUrl = frame?.url || mainFrame?.url || contents.getURL?.();
    if (typeof frameUrl !== 'string') throw new Error('Missing renderer URL.');
    const senderUrl = new URL(frameUrl);
    if (senderUrl.protocol !== 'file:') throw new Error('Unexpected renderer origin.');
    senderPath = fileURLToPath(senderUrl);
  } catch {
    throw new Error(INTERFACE_ERROR);
  }

  if (!samePath(senderPath, expectedUiPath)) throw new Error(INTERFACE_ERROR);
  return true;
}
