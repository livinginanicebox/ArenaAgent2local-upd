const repository = 'lumifaye/ArenaAgent2local';
const installerName = 'Arena-Local-Setup.exe';
const installerUrl = `https://github.com/${repository}/releases/latest/download/${installerName}`;
const releasesUrl = `https://github.com/${repository}/releases`;
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

const downloadButtons = [...document.querySelectorAll('.download-button')];
const downloadTitle = document.querySelector('#downloadTitle');
const downloadSubtitle = document.querySelector('#downloadSubtitle');
const downloadTitleFooter = document.querySelector('#downloadTitleFooter');
const downloadSubtitleFooter = document.querySelector('#downloadSubtitleFooter');
const releaseStatus = document.querySelector('#releaseStatus');
const year = document.querySelector('#year');

if (year) year.textContent = String(new Date().getFullYear());
for (const button of downloadButtons) button.href = installerUrl;

function setDownloadLinks(url, pending = false, label = '') {
  for (const button of downloadButtons) {
    button.href = url;
    button.classList.toggle('download-pending', pending);
    if (label) button.setAttribute('aria-label', label);
  }
}

async function showLatestRelease() {
  if (!downloadButtons.length || !releaseStatus) return;

  try {
    const response = await fetch(latestReleaseApi, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });

    if (response.status === 404) {
      setDownloadLinks(releasesUrl, true, 'View Arena Local releases; the first Windows installer is not published yet');
      downloadTitle.textContent = 'First build coming soon';
      downloadSubtitle.textContent = 'No Windows release yet';
      downloadTitleFooter.textContent = 'First build coming soon';
      downloadSubtitleFooter.textContent = 'No Windows release yet';
      releaseStatus.textContent = 'The download button will activate when the first tagged Windows release is published.';
      return;
    }
    if (!response.ok) throw new Error(`GitHub release lookup returned ${response.status}.`);

    const release = await response.json();
    const installer = (release.assets || []).find((asset) => asset.name === installerName);
    if (!installer) {
      setDownloadLinks(release.html_url || releasesUrl, true, 'View the latest Arena Local release');
      downloadTitle.textContent = 'View latest release';
      downloadSubtitle.textContent = `${release.tag_name || 'Latest'} · installer not attached`;
      downloadTitleFooter.textContent = 'View latest release';
      downloadSubtitleFooter.textContent = 'Installer not attached';
      releaseStatus.textContent = 'The latest release does not include the Windows installer yet.';
      return;
    }

    setDownloadLinks(installer.browser_download_url || installerUrl, false, `Download Arena Local Windows x64 installer ${release.tag_name || ''}`.trim());
    downloadTitle.textContent = 'Download for Windows';
    downloadSubtitle.textContent = `${release.tag_name || 'Latest stable'} · 64-bit .EXE`;
    downloadTitleFooter.textContent = 'Get Arena Local';
    downloadSubtitleFooter.textContent = `${release.tag_name || 'Latest stable'} · Windows x64`;
    const published = release.published_at
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(release.published_at))
      : 'latest stable release';
    const sizeMb = installer.size ? `${(installer.size / (1024 * 1024)).toFixed(1)} MB` : '';
    releaseStatus.textContent = `Latest stable build: ${release.tag_name || 'Arena Local'} · ${published}${sizeMb ? ` · ${sizeMb}` : ''}`;
  } catch (error) {
    // Keep the predictable /latest/download URL as a no-JavaScript/API fallback.
    releaseStatus.textContent = 'Latest Windows installer · release lookup unavailable right now.';
    console.warn('[Arena Local site] Could not check the latest release:', error);
  }
}

showLatestRelease();
