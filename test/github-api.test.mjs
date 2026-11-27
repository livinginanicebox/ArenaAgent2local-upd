import test from 'node:test';
import assert from 'node:assert/strict';
import { listGithubRepositories, normalizeGithubToken, verifyGithubToken } from '../src/github-api.mjs';

const TOKEN = `github_pat_${'x'.repeat(45)}`;

function fakeResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test('GitHub token validation accepts classic and fine-grained tokens without exposing or persisting them', () => {
  assert.equal(normalizeGithubToken(`  ${TOKEN}  `), TOKEN);
  const classicToken = `ghp_${'c'.repeat(36)}`;
  assert.equal(normalizeGithubToken(classicToken), classicToken);
  for (const invalid of ['', 'too-short', 'github_pat_has spaces and a secret', `x${'x'.repeat(512)}`, null]) {
    assert.throws(() => normalizeGithubToken(invalid), /GitHub personal access token|GitHub tokens/);
  }
});

test('GitHub token verification uses only the fixed HTTPS API endpoint and returns the account name', async () => {
  const requests = [];
  const result = await verifyGithubToken(TOKEN, async (url, options) => {
    requests.push({ url, options });
    return fakeResponse({ login: 'arena-user', id: 123 });
  });
  assert.deepEqual(result, { login: 'arena-user' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/user');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('GitHub API failures use safe messages and never echo the token', async () => {
  await assert.rejects(
    verifyGithubToken(TOKEN, async () => fakeResponse({ message: TOKEN }, { ok: false, status: 401 })),
    (error) => {
      assert.match(error.message, /rejected the saved token/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    },
  );
  await assert.rejects(
    verifyGithubToken(TOKEN, async () => { throw new Error(`network failure ${TOKEN}`); }),
    (error) => {
      assert.match(error.message, /Could not reach the GitHub API/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    },
  );
});

test('GitHub repository listing returns safe HTTPS remotes and ignores malformed repository names', async () => {
  const result = await listGithubRepositories(TOKEN, async (url, options) => {
    assert.equal(url, 'https://api.github.com/user/repos?per_page=100&sort=updated&type=all');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return fakeResponse([
      { full_name: 'arena-user/desktop-app', private: true, default_branch: 'main' },
      { full_name: 'org/shared-repo', private: false, default_branch: 'trunk' },
      { full_name: 'attacker/repo?token=secret', private: false },
      { full_name: '../outside', private: false },
    ]);
  });
  assert.deepEqual(result, {
    repositories: [
      { fullName: 'arena-user/desktop-app', owner: 'arena-user', name: 'desktop-app', private: true, defaultBranch: 'main', webUrl: 'https://github.com/arena-user/desktop-app', cloneUrl: 'https://github.com/arena-user/desktop-app.git' },
      { fullName: 'org/shared-repo', owner: 'org', name: 'shared-repo', private: false, defaultBranch: 'trunk', webUrl: 'https://github.com/org/shared-repo', cloneUrl: 'https://github.com/org/shared-repo.git' },
    ],
    truncated: false,
  });
});
