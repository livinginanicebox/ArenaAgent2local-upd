# Arena Local

**Arena Local is a desktop companion for prompting Arena.ai and letting Arena Bash request scoped actions on your computer.** The desktop app runs a small authenticated task API on loopback, and can expose only that API through an ngrok HTTPS tunnel. Arena's Bash tool calls the tunnel with `curl`; this app shows file writes and shell commands in a local approval queue before running them.

The Arena prompt/chat stays on Arena.ai. This repository does not embed a chat website or try to imitate Arena's UI.

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

The app binds its task server to `127.0.0.1` on an ephemeral port. The public ngrok link forwards to that task API only; the Electron desktop UI is loaded locally and is not served through the tunnel. Stop the link or rotate the pairing key to revoke Arena's access. Closing the app also closes the tunnel and invalidates its ephemeral key. Stopping or rotating cancels requests still awaiting approval, but does not undo or interrupt an action already approved and running.

To build a platform installer for the current OS:

```bash
npm run dist
```

Build output is written to the ignored `release/` folder.

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

Read actions run automatically within the chosen workspace. `write_file` and `run_command` return `awaiting_approval` until the desktop user approves or denies them. Tasks expire; the API rejects arbitrary action names, extra arguments, path traversal, oversized requests, unauthenticated calls, and excessive request rates. There is no endpoint for arbitrary HTTP proxying or unrestricted shell execution.

## Permission and privacy model

- **Ask before changes** is the default. The desktop UI shows the complete proposed file diff or exact shell command. You can approve once, allow that exact action for the current connection, or deny it. Before an approved write is applied, the app checks that the file has not changed since the diff was shown; if it has, it refuses the stale approval and requires a fresh review.
- **Read only** blocks file writes and terminal commands. Switching modes denies pending requests and clears session approvals.
- Workspace file operations reject absolute paths, `..`, and symbolic links. Common credential files and sensitive/build directories are blocked from file tools.
- The pairing key is an ephemeral 256-bit bearer capability. Keep the copied Arena setup prompt private; anyone with the key can read allowed workspace files. Rotate the key or stop the tunnel to revoke it.
- File contents requested by Arena travel through the ngrok HTTPS tunnel and are returned to Arena's Bash tool. Do not expose a workspace whose contents you do not want to send to Arena.
- An approved shell command runs as your normal OS user. The approval prompt is a safety gate, **not an operating-system sandbox**; a shell command can read or change files outside the selected workspace. Review commands carefully.
- ngrok's authtoken is separate from the pairing key and is never included in the Arena setup prompt.

This is an early prototype, not a security boundary for untrusted users or a replacement for OS-level sandboxing. Use it only on a device and workspace you control.

## Development

```bash
npm test
```

The tests exercise bearer authentication, request idempotency, workspace boundaries, read-only mode, and explicit mutation approvals without requiring Electron or an ngrok account.
