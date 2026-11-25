# Arena Local

**Arena Local is a desktop companion for prompting Arena.ai and letting Arena Bash request scoped actions on your computer.** The desktop app runs a small authenticated task API on loopback, and can expose only that API through an ngrok HTTPS tunnel. Arena's Bash tool calls the tunnel with `curl`; this app shows file writes and shell commands in a local approval queue before running them.

The Arena prompt/chat stays on Arena.ai. This repository does not embed a chat website or try to imitate Arena's UI.

**Download page:** [lumifaye.github.io/ArenaAgent2local](https://lumifaye.github.io/ArenaAgent2local/) · **Agent guide:** [agents.md](https://lumifaye.github.io/ArenaAgent2local/agents.md) · **Latest releases:** [GitHub Releases](https://github.com/lumifaye/ArenaAgent2local/releases)

## Run the desktop app

Requirements: Node.js **22.12 or newer** and npm.

```bash
npm install
npm start
```

In Arena Local:

1. Choose the project folder Arena is allowed to work in.
2. Paste your ngrok authtoken and save it. It is encrypted with Electron `safeStorage` when the OS provides secure storage; otherwise it remains in memory until the app closes.
3. Start the remote connection. The app creates a temporary HTTPS ngrok URL.
4. Click **Copy Arena setup prompt** and paste it into the Arena.ai conversation where you want to work. That prompt contains the tunnel URL and an ephemeral bearer key.
5. Ask Arena to inspect or change the selected workspace. Reads are returned to Arena; writes and terminal commands show up in **Waiting for your approval** in this desktop app.
6. **Optional, EXTREMELY DANGEROUS:** with the remote link stopped, use **Enable full-computer access** and accept two native warnings to remove the file-tool workspace boundary for the next connection. The pairing key rotates; copy a fresh prompt after reconnecting. This mode is temporary and resets when the link stops, the key rotates, the workspace changes, or the app closes.

The app binds its task server to `127.0.0.1` on an ephemeral port. The public ngrok link forwards to that task API only; the Electron desktop UI is loaded locally and is not served through the tunnel. Stop the link or rotate the pairing key to revoke Arena's access. Closing the app also closes the tunnel and invalidates its ephemeral key. Stopping or rotating cancels requests still awaiting approval, but does not undo or interrupt an action already approved and running.

**EXTREMELY DANGEROUS full-computer access:** file tools can list, read, search, and propose writes anywhere your signed-in OS account can access, including hidden folders and credential files. Reads do not get per-file approval, and content requested is returned to Arena.ai. Ask mode still requires local write approval; Read only blocks writes. Full-computer access can be combined with No-Ask only through the separate local safety sequence below. This mode does not grant admin/root access or provide OS sandboxing.

To build a platform installer for the current OS:

```bash
npm run dist
```

Build output is written to the ignored `release/` folder.

## Website and Windows releases

The retro-styled multi-page site lives in `site/` and is published to [GitHub Pages](https://lumifaye.github.io/ArenaAgent2local/) by `.github/workflows/pages.yml` when site changes reach `main` or the active `arena/8393bb53-arenaagent2local` branch. It includes feature, getting-started, safety/privacy, FAQ, download, and changelog pages, plus a custom 404 page and sitemap. The download page resolves the Windows installer and SHA-256 sidecar from the latest GitHub Release. The public [`agents.md`](https://lumifaye.github.io/ArenaAgent2local/agents.md) guide covers the bridge, privacy, and safe usage; the copied Arena setup prompt tells Bash to fetch it before making bridge requests.

`.github/workflows/windows-release.yml` builds a Windows x64 NSIS installer and runs the test suite on pushes to the active branch, uploading the installer as a 14-day Actions artifact. Publishing a GitHub Release with a `v*` tag triggers the same workflow to build the installer and attach it to that release. The tag must exactly match the version in `package.json` (currently `0.1.2`, so publish tag `v0.1.2`). The workflow uses the repository's `GITHUB_TOKEN`; no release secret is needed. Published releases include `Arena-Local-Setup.exe` and a SHA-256 checksum sidecar. The installer is not code-signed, so Windows may show an unrecognized-publisher SmartScreen notice. GitHub Pages should use **Settings → Pages → Build and deployment → GitHub Actions**.

## Arena Bash bridge API

The copied Arena setup prompt includes the current URL and bearer key. Bash requests are JSON and must include `Authorization: Bearer <pairing-key>`.

Submit a task:

```bash
curl -sS -X POST "$ARENA_LOCAL_URL/v1/tasks" \
  -H "Authorization: Bearer $ARENA_LOCAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"readme-demo-01","action":"read_file","args":{"path":"README.md"}}'
```

The response includes a `taskId`. Poll it until it reaches a terminal status:

```bash
curl -sS "$ARENA_LOCAL_URL/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $ARENA_LOCAL_TOKEN"
```

`requestId` is an idempotency key: reuse it only to retry the exact same action. A request body is `{ "requestId": "...", "action": "...", "args": { ... } }`.

Supported actions:

- `list_files` — `args.path` optional, defaults to `.`
- `read_file` — `args.path`
- `search_text` — `args.query`, optional `args.path`
- `write_file` — `args.path`, `args.content`
- `run_command` — `args.command`

Read actions run automatically within the chosen workspace, or anywhere the OS account can access when the user has enabled full-computer access. `write_file` and `run_command` return `awaiting_approval` until the desktop user approves or denies them in Ask mode. Tasks expire; the API rejects arbitrary action names, extra arguments, oversized requests, unauthenticated calls, and excessive request rates. Outside absolute paths are rejected unless full-computer access is active.

## Permission and privacy model

- **Ask before changes** is the default. The desktop UI shows the complete proposed file diff or exact shell command. You can approve once, allow that exact action for the current connection, or deny it. Before an approved write is applied, the app checks that the file has not changed since the diff was shown; if it has, it refuses the stale approval and requires a fresh review.
- **Read only** blocks file writes and terminal commands. Switching modes denies pending requests and clears session approvals.
- **No approval — VERY DANGEROUS** is available behind two native warning confirmations. It auto-runs remote file writes and shell commands. Shell commands have the signed-in user's OS permissions and can reach outside the workspace. The mode is not persisted and resets when you stop the tunnel, rotate the pairing key, choose another folder, or close the app. The desktop UI keeps a prominent danger banner and labels these actions as auto-approved.
- **Full-computer access — EXTREMELY DANGEROUS** is a separate, off-by-default scope setting. It requires two native warning confirmations while disconnected, rotates the pairing key, is never persisted, and resets when the connection stops, the key rotates, the workspace changes, or the app closes. It removes workspace confinement and file-tool filters for hidden folders and credential names. Read actions need no per-file approval; writes still follow Ask/Read only unless the user separately arms the combined mode below. The UI warns whenever it is active.
- **Full-computer + No-Ask — EXTREMELY DANGEROUS:** only available while full-computer access is enabled and the remote link is stopped. Choosing No-Ask opens the exact high-risk warning, followed by a 30-second lockout, a slide-to-unlock, and a final native confirmation. The challenge is time-checked with a monotonic clock, expires, is bound to the current workspace and pairing key, and is cleared if the local permission state changes. Enabling the combination rotates the pairing key; starting the link requires another native warning. It is session-only and turns off when the link stops, the key rotates, the workspace changes, the connection fails, or the app closes.
- Only the trusted local Arena Local window can change scope or permission modes. The remote task API accepts no mode-setting action or scope flags; it rejects unknown request fields and denies full-computer No-Ask tasks unless the local unlock authorized them. A remote request cannot initiate or complete the warning flow.
- By default, workspace file operations reject absolute paths, `..`, and symbolic links. Common credential files and sensitive/build directories are blocked from file tools. Full-computer access relaxes those boundaries but retains text/binary and file-size limits.
- The pairing key is a bearer capability. Keep the copied Arena setup prompt private; while full-computer access is on, anyone with the key can request any file your OS account can read. In the combined mode, they can also trigger file writes and shell commands without per-action approval. The key rotates when full access is enabled or disabled and when the combined mode is enabled. Stop the tunnel or rotate the key to revoke a live connection.
- File contents requested by Arena travel through the ngrok HTTPS tunnel and are returned to Arena's Bash tool. Full-computer access can expose credentials and private data; only enable it when you trust the connected Arena session.
- An approved shell command runs as your normal OS user. The approval prompt is a safety gate, **not an operating-system sandbox**; a shell command can read or change files outside the selected workspace. Review commands carefully.
- ngrok's authtoken is separate from the pairing key and is never included in the Arena setup prompt.

This is an early prototype, not a security boundary for untrusted users or a replacement for OS-level sandboxing. Use it only on a device and workspace you control.

## Development

```bash
npm test
```

The tests exercise bearer authentication, request idempotency, workspace boundaries, read-only and no-ask modes, stale-diff refusal, session-approval reset behavior, release assets/checksums, and the static site's shared navigation and local links without requiring Electron or an ngrok account.
