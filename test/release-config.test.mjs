import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseWorkflow = await readFile(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
const pagesWorkflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const siteHtml = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const siteScript = await readFile(new URL('../site/site.js', import.meta.url), 'utf8');
const legacyPagesRedirect = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('Windows installer artifact name matches the release and Pages download links', () => {
  const expectedInstaller = 'Arena-Local-Setup.exe';
  assert.equal(packageJson.build.win.artifactName, 'Arena-Local-Setup.${ext}');
  assert.ok(releaseWorkflow.includes(`release/${expectedInstaller}`));
  assert.ok(siteHtml.includes(`releases/latest/download/${expectedInstaller}`));
  assert.ok(siteScript.includes(`const installerName = '${expectedInstaller}'`));
});

test('legacy branch-based Pages root redirects to the styled product page', () => {
  assert.match(legacyPagesRedirect, /url=\.\/site\//);
  assert.match(legacyPagesRedirect, /href="\.\/site\/"/);
});

test('Pages deploys the static product site from the main branch', () => {
  assert.match(pagesWorkflow, /branches:\s*\n\s+- main/);
  assert.match(pagesWorkflow, /path: site/);
  assert.match(pagesWorkflow, /actions\/deploy-pages@v4/);
});
