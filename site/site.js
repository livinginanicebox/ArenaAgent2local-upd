const repository = 'lumifaye/ArenaAgent2local';
const installerName = 'Arena-Local-Setup.exe';
const checksumName = `${installerName}.sha256`;
const installerUrl = `https://github.com/${repository}/releases/latest/download/${installerName}`;
const checksumUrl = `https://github.com/${repository}/releases/latest/download/${checksumName}`;
const releasesUrl = `https://github.com/${repository}/releases`;
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

const downloadButtons = [...document.querySelectorAll('.download-button')];
const releaseStatus = document.querySelector('#releaseStatus');
const releaseTag = document.querySelector('#releaseTag');
const releaseDate = document.querySelector('#releaseDate');
const installerSize = document.querySelector('#installerSize');
const checksumLink = document.querySelector('#checksumLink');
const year = document.querySelector('#year');

function setText(element, value) {
  if (element) element.textContent = value;
}

if (year) year.textContent = String(new Date().getFullYear());
for (const button of downloadButtons) button.href = installerUrl;

const navToggle = document.querySelector('#navToggle');
const primaryNav = document.querySelector('#primaryNav');
if (navToggle && primaryNav) {
  const closeMenu = (restoreFocus = false) => {
    navToggle.setAttribute('aria-expanded', 'false');
    primaryNav.classList.remove('is-open');
    if (restoreFocus) navToggle.focus();
  };
  navToggle.addEventListener('click', () => {
    const open = navToggle.getAttribute('aria-expanded') !== 'true';
    navToggle.setAttribute('aria-expanded', String(open));
    primaryNav.classList.toggle('is-open', open);
    if (open) primaryNav.querySelector('a')?.focus();
  });
  primaryNav.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') closeMenu(true);
  });
  document.addEventListener('click', (event) => {
    if (navToggle.getAttribute('aria-expanded') === 'true' && !primaryNav.contains(event.target) && !navToggle.contains(event.target)) closeMenu();
  });
}

function setDownloadLinks(url, pending = false, label = '') {
  for (const button of downloadButtons) {
    button.href = url;
    button.classList.toggle('download-pending', pending);
    if (label) button.setAttribute('aria-label', label);
  }
}

function setUnavailable(message) {
  setDownloadLinks(releasesUrl, true, 'View Arena Local releases on GitHub');
  setText(releaseTag, 'No published build');
  setText(releaseDate, '—');
  setText(installerSize, '—');
  if (checksumLink) checksumLink.hidden = true;
  for (const selector of ['#downloadTitle', '#downloadTitleFooter']) setText(document.querySelector(selector), 'View releases');
  for (const selector of ['#downloadSubtitle', '#downloadSubtitleFooter']) setText(document.querySelector(selector), 'Installer not available yet');
  setText(releaseStatus, message);
}

async function showLatestRelease() {
  const hasReleaseSurface = Boolean(downloadButtons.length || releaseStatus || releaseTag || releaseDate || installerSize || checksumLink);
  if (!hasReleaseSurface) return;

  try {
    const response = await fetch(latestReleaseApi, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });

    if (response.status === 404) {
      setUnavailable('No stable installer has been published yet. Check back on the releases page.');
      return;
    }
    if (!response.ok) throw new Error(`GitHub release lookup returned ${response.status}.`);

    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = assets.find((asset) => asset.name === installerName);
    const checksum = assets.find((asset) => asset.name === checksumName);
    setText(releaseTag, release.tag_name || 'Latest stable');
    if (release.published_at) {
      const published = new Date(release.published_at);
      setText(releaseDate, Number.isNaN(published.getTime()) ? 'Published' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(published));
    } else {
      setText(releaseDate, 'Published');
    }

    if (!installer) {
      setDownloadLinks(release.html_url || releasesUrl, true, 'View the latest Arena Local release');
      setText(releaseStatus, 'The latest release does not include the Windows installer yet.');
      setText(installerSize, 'Not attached');
      if (checksumLink) checksumLink.hidden = true;
      for (const selector of ['#downloadTitle', '#downloadTitleFooter']) setText(document.querySelector(selector), 'View latest release');
      for (const selector of ['#downloadSubtitle', '#downloadSubtitleFooter']) setText(document.querySelector(selector), 'Installer not attached');
      return;
    }

    setDownloadLinks(installer.browser_download_url || installerUrl, false, `Download Arena Local Windows x64 installer ${release.tag_name || ''}`.trim());
    setText(document.querySelector('#downloadTitle'), 'Download for Windows');
    setText(document.querySelector('#downloadSubtitle'), `${release.tag_name || 'Latest stable'} · 64-bit .EXE`);
    setText(document.querySelector('#downloadTitleFooter'), 'Get Arena Local');
    setText(document.querySelector('#downloadSubtitleFooter'), `${release.tag_name || 'Latest stable'} · Windows x64`);
    const sizeMb = installer.size ? `${(installer.size / (1024 * 1024)).toFixed(1)} MB` : 'Available';
    setText(installerSize, sizeMb);
    if (checksumLink) {
      checksumLink.href = checksum?.browser_download_url || checksumUrl;
      checksumLink.hidden = !checksum;
    }
    setText(releaseStatus, checksum
      ? `Latest stable build: ${release.tag_name || 'Arena Local'} · SHA-256 checksum included.`
      : `Latest stable build: ${release.tag_name || 'Arena Local'} · checksum not attached to this release.`);
  } catch (error) {
    setText(releaseStatus, 'Latest Windows installer · release lookup unavailable right now.');
    setText(releaseTag, 'Lookup unavailable');
    setText(releaseDate, '—');
    setText(installerSize, 'Use GitHub release page');
    console.warn('[Arena Local site] Could not check the latest release:', error);
  }
}

showLatestRelease();
