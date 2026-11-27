import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const desktopUi = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const desktopAppJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const desktopPreload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
const agentGuide = (await readFile(new URL('../site/agents.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('loading screen shows the lowercase "arena local :3" wordmark and live AI ask summary', () => {
  assert.ok(desktopUi.includes('id="splash"'), 'Desktop UI should render a splash overlay.');
  assert.ok(desktopUi.includes('arena local <span class="splash-face">:3</span>'), 'Splash wordmark must read "arena local :3" in lowercase.');
  assert.ok(!/ARENA\s*LOCAL\s*:3<\//.test(desktopUi), 'Splash wordmark must not shout the name back.');
  assert.ok(desktopUi.includes('what the ai is asking to do'), 'Splash should show what the AI is asking to do.');
  assert.ok(desktopUi.includes('files it’s touching'), 'Splash should list the files it is touching.');
  assert.ok(desktopUi.includes('id="splashSkipBtn"'), 'Splash should be skippable.');
  assert.match(desktopAppJs, /function renderSplashActivity\(/);
  assert.match(desktopAppJs, /function startSplashBoot\(/);
  assert.match(desktopAppJs, /function completeSplashBoot\(/);
});

test('control center pins a live "what the ai is asking to do" banner with file chips', () => {
  assert.ok(desktopUi.includes('id="liveAskBanner"'), 'Desktop UI should include the live ask banner.');
  assert.ok(desktopUi.includes('id="liveAskList"'), 'Live ask banner should list the requested actions.');
  assert.ok(desktopUi.includes('id="liveAskFiles"'), 'Live ask banner should list the files in play.');
  assert.match(desktopAppJs, /function renderLiveAsk\(/);
  assert.match(desktopAppJs, /taskFileTargets/);
  assert.match(desktopAppJs, /renderLiveAsk\(state\);/);
});

test('embedded arena.ai chat panel exists but loads only on demand', () => {
  assert.ok(desktopUi.includes('id="chat"'), 'Desktop UI should expose a chat section.');
  assert.ok(desktopUi.includes('id="loadArenaChatBtn"'), 'Chat panel should start behind an explicit load action.');
  assert.match(desktopAppJs, /document\.createElement\('webview'\)/);
  assert.match(desktopAppJs, /persist:arena-chat/);
  assert.match(desktopAppJs, /https:\/\/arena\.ai\//);
  assert.match(desktopAppJs, /function loadArenaChat\(/);
  assert.ok(desktopUi.includes('id="chatFallback"'), 'Chat panel should degrade gracefully when arena.ai cannot load.');
  assert.match(desktopPreload, /openArenaChat: invoke\('arena:open-arena-chat'\)/);
  assert.match(desktopPreload, /resetArenaChat: invoke\('arena:reset-arena-chat'\)/);
  assert.match(desktopMain, /webviewTag: true/);
  assert.match(desktopMain, /arena:open-arena-chat/);
  assert.match(desktopMain, /arena:reset-arena-chat/);
  assert.match(desktopMain, /web-contents-created/);
  assert.match(desktopMain, /will-navigate/);
  assert.match(desktopMain, /isArenaChatUrlAllowed/);
});

test('agent instructions require explaining intended changes and listing touched files', () => {
  assert.match(desktopMain, /HOW YOU MUST TALK WHILE YOU WORK/);
  assert.match(desktopMain, /files you intend to touch/);
  assert.match(desktopMain, /Never make silent changes/);
  assert.ok(agentGuide.includes('## Explain before you touch — REQUIRED on every task'));
  assert.ok(agentGuide.includes('Never make a silent change'));
  assert.ok(agentGuide.includes('exact files you intend to touch'));
});
