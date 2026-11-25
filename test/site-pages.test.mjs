import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site');
const pages = [
  'index.html',
  'features.html',
  'getting-started.html',
  'safety.html',
  'faq.html',
  'download.html',
  'changelog.html',
  '404.html',
];

test('all public pages have a shared accessible shell and page-specific title', async () => {
  for (const page of pages) {
    const html = await readFile(path.join(siteRoot, page), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/, `${page} needs a title`);
    assert.match(html, /<main\b[^>]*id="main"/, `${page} needs a main landmark`);
    assert.match(html, /<h1\b/, `${page} needs a page heading`);
    assert.match(html, /href="\.\/style\.css"/, `${page} should use the shared styles`);
    assert.match(html, /src="\.\/site\.js"/, `${page} should use the shared script`);
    assert.match(html, /id="navToggle"[^>]+aria-expanded="false"/, `${page} needs the accessible mobile menu toggle`);
    assert.match(html, /id="primaryNav"[^>]*aria-label="Main navigation"/, `${page} needs labeled primary navigation`);
  }
});

test('local links on public pages point to published files', async () => {
  for (const page of pages) {
    const html = await readFile(path.join(siteRoot, page), 'utf8');
    for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
      if (!href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      const pathname = href.split(/[?#]/, 1)[0];
      if (!pathname) continue;
      const target = path.resolve(siteRoot, pathname);
      const relative = path.relative(siteRoot, target);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${page} links outside the site: ${href}`);
      let targetPath = target;
      try {
        const info = await stat(targetPath);
        if (info.isDirectory()) targetPath = path.join(targetPath, 'index.html');
      } catch {}
      await stat(targetPath).catch(() => assert.fail(`${page} links to missing local file: ${href}`));
    }
  }
});
