const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'Arena-Local-Desktop';
const MAX_GITHUB_TOKEN_LENGTH = 512;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeGithubToken(value) {
  if (typeof value !== 'string') throw new Error('Enter a GitHub personal access token.');
  const token = value.trim();
  if (token.length < 20 || token.length > MAX_GITHUB_TOKEN_LENGTH || /[\u0000-\u001f\u007f]|\s/u.test(token)) {
    throw new Error('GitHub tokens must be 20–512 characters and contain no whitespace or control characters.');
  }
  return token;
}

async function githubRequest(tokenValue, path, fetchImpl = globalThis.fetch) {
  const token = normalizeGithubToken(tokenValue);
  if (typeof fetchImpl !== 'function') throw new Error('This runtime does not support secure GitHub API requests.');

  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    throw new Error('Could not reach the GitHub API. The saved token was not sent to Arena or written to Git configuration.');
  }

  if (!response?.ok) {
    if (response?.status === 401) throw new Error('GitHub rejected the saved token (HTTP 401). Check the token and save it again if needed.');
    if (response?.status === 403) throw new Error('GitHub refused this request (HTTP 403). Check token permissions or GitHub rate limits.');
    throw new Error(`GitHub API request failed (HTTP ${Number(response?.status) || 'unknown'}).`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error('GitHub returned an unreadable API response.');
  }
}

export async function verifyGithubToken(token, fetchImpl) {
  const data = await githubRequest(token, '/user', fetchImpl);
  if (!data || typeof data.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(data.login)) {
    throw new Error('GitHub did not return a valid account name for this token.');
  }
  return { login: data.login };
}

export async function listGithubRepositories(token, fetchImpl) {
  const data = await githubRequest(token, '/user/repos?per_page=100&sort=updated&type=all', fetchImpl);
  if (!Array.isArray(data)) throw new Error('GitHub returned an unexpected repository list.');
  const repositories = [];
  for (const repo of data.slice(0, 100)) {
    if (!repo || typeof repo.full_name !== 'string' || !REPOSITORY_NAME_PATTERN.test(repo.full_name)) continue;
    const [owner, name] = repo.full_name.split('/');
    if (owner === '.' || owner === '..' || name === '.' || name === '..') continue;
    repositories.push({
      fullName: repo.full_name,
      owner,
      name,
      private: repo.private === true,
      defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch.slice(0, 255) : '',
      webUrl: `https://github.com/${repo.full_name}`,
      cloneUrl: `https://github.com/${repo.full_name}.git`,
    });
  }
  return { repositories, truncated: data.length >= 100 };
}
