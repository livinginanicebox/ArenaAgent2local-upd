import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseWorkflow = await readFile(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
const pagesWorkflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const siteHtml = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const siteScript = await readFile(new URL('../site/site.js', import.meta.url), 'utf8');
const legacyPagesRedirect = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const agentGuide = await readFile(new URL('../site/agents.md', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

test('Windows installer artifact name matches the release and Pages download links', () => {
  const expectedInstaller = 'Arena-Local-Setup.exe';
  assert.equal(packageJson.build.win.artifactName, 'Arena-Local-Setup.${ext}');
  assert.ok(releaseWorkflow.includes(`release/${expectedInstaller}`));
  assert.ok(siteHtml.includes(`releases/latest/download/${expectedInstaller}`));
  assert.ok(siteScript.includes(`const installerName = '${expectedInstaller}'`));
});

test('copied Arena prompt fetches the public guide without exposing the pairing key', () => {
  const guideUrl = 'https://lumifaye.github.io/ArenaAgent2local/agents.md';
  assert.ok(desktopMain.includes(`const guideUrl = '${guideUrl}'`));
  assert.ok(desktopMain.includes("curl -fsSL '${guideUrl}'"));
  assert.ok(desktopMain.includes('Never send the bearer key to the guide URL.'));
  assert.ok(siteHtml.includes('href="./agents.md"'));
  for (const section of ['API workflow', 'Privacy and safety', 'Quality-of-life tips']) {
    assert.ok(agentGuide.includes(`## ${section}`), `Agent guide should document ${section}.`);
  }
});

test('legacy branch-based Pages root redirects to the styled product page', () => {
  assert.match(legacyPagesRedirect, /url=\.\/site\//);
  assert.match(legacyPagesRedirect, /href="\.\/site\/"/);
});

test('Pages deploys from the main branch and this active branch', () => {
  assert.match(pagesWorkflow, /branches:\s*\n\s+- main/);
  assert.ok(pagesWorkflow.includes("- 'arena/8393bb53-arenaagent2local'"));
  assert.match(pagesWorkflow, /path: site/);
  assert.ok(pagesWorkflow.includes('test -s site/agents.md'));
  assert.match(pagesWorkflow, /actions\/deploy-pages@v5/);
});

test('active branch pushes build installer artifacts; published releases receive the exe', () => {
  assert.ok(releaseWorkflow.includes("- 'arena/8393bb53-arenaagent2local'"));
  assert.match(releaseWorkflow, /actions\/upload-artifact@v7/);
  assert.match(releaseWorkflow, /release:\s*\n\s+types:\s*\n\s+- published/);
  assert.match(releaseWorkflow, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release@v3/);
});
