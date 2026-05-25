# Pi Remote Control

An unofficial Android companion app for [pi](https://github.com/badlogic/pi-mono),
a CLI coding agent. Drives your pi from your phone over LAN. Two parts:

- **A pi extension** that runs inside your pi process, exposes a WebSocket
  server on `0.0.0.0:8765`, and forwards agent events to connected clients.
- **An Android app** that connects to that WS, renders the chat in a
  pi-terminal-styled UI, and lets you prompt / steer / follow-up just like
  you would in the terminal.

LAN-only by design — there's no cloud relay, no telemetry, no third-party
SDKs. The phone talks directly to your pi over `ws://`. A
[shared-secret token](#auth) gates access.

| | |
|---|---|
| **Status** | Early. Solo-author project. APIs and storage formats may change between commits. |
| **License** | MIT — see [LICENSE](LICENSE). |
| **Privacy** | No analytics, no remote logging, no SDK callbacks. Network traffic is exactly: the pi WS server you connect to, and GitHub Releases (for the in-app updater). |

## Install — host side

Pi installs the extension from this repo's git URL:

```bash
pi install git:github.com/grunt3714-lgtm/pi-remote-control
```

After that, every `pi` launch loads the extension automatically. The WS
server starts on `session_start` and prints its URL + a QR code:

```
┌─ Pi Remote Control (host) ──────────────────┐
│  ws://192.168.1.42:8765/?token=...           │
└─────────────────────────────────────────────┘
  auth: shared-secret token from /home/you/.pi/agent/pi-remote-control.token
█▀▀▀▀▀█  ▄ █ ▄▄ █▀▀▀▀▀█
█ ███ █ ▀ ▄▀█ ▄ █ ███ █
[ ... QR code ... ]
```

Scan the QR from the Android app to connect.

To update later:
```bash
pi update git:github.com/grunt3714-lgtm/pi-remote-control
```
Then restart pi.

## Install — phone side

Side-load the APK from [Releases](../../releases). Versioned APKs are
published from CI on every push to `master`; the rolling `latest` tag
always points at the most recent build.

The first launch will request:
- **Camera** — for the QR scanner on the connect screen.
- **Notifications** — for the foreground-service indicator while connected,
  and one-shot "pi is ready" alerts when a turn finishes in the background.

You can also type the URL manually if you're already on the host and can
read the printed URL.

## Auth

The WS server requires a shared-secret token. On first launch, the extension
generates one and persists it to `~/.pi/agent/pi-remote-control.token`
(mode 0600). Subsequent launches reuse it, so a QR your phone scanned today
keeps working tomorrow.

The token is included in the printed URL/QR:
```
ws://your-host:8765/?token=<32 hex chars>
```
Connections without a matching `?token=…` are closed with WS code `4001`.

**Overrides**:
- `PI_REMOTE_TOKEN=<your-token> pi` — provide your own (e.g., from a
  password manager). Wins over the persisted file.
- `PI_REMOTE_CONTROL_NO_AUTH=1 pi` — disable auth entirely. **Only safe on
  networks you fully trust** (single-user laptop on home LAN with no port
  forwarding, etc.). The startup banner prints a loud warning when set.

To rotate the token: delete `~/.pi/agent/pi-remote-control.token` and
restart pi. A fresh one will be generated and previous QRs/URLs become
invalid.

## What the app can do

- Live chat with pi over the LAN, including streaming text and thinking blocks.
- Inline diff rendering for `edit` / `multiEdit` / `write` tool calls.
- Per-message tool details (args, result excerpts, expand-on-tap full output).
- Image attachments — pick from the gallery, sent inline with your prompt.
- Steer / follow-up — interrupt a running turn or queue a follow-up.
- Multiple connected pis as parallel tabs (peer-mode).
- "New session" button spawns a fresh `pi` process on the host so you can
  have multiple independent conversations in parallel tabs.
- "Saved sessions" browser — resume any previous pi session as a new tab.
- Notifications: a persistent "connected" indicator + one-shot "pi is
  ready" alerts when turns finish while the app is backgrounded.

## What it doesn't do (yet)

- No end-to-end encryption beyond `ws://` (deliberate — see
  [security notes](#security-notes)).
- No remote-over-WAN out of the box. If you want it, terminate TLS at a
  reverse proxy and either tunnel (Tailscale, WireGuard) or front the WS
  with your own auth layer.
- No Play Store / F-Droid distribution. Side-load only.
- No iOS client. (The protocol is plain WS + JSON; a port is welcome.)

## Security notes

- The WS server binds `0.0.0.0` because that's required for the phone to
  reach it from another LAN host. If your machine has multiple interfaces
  (including a hostile one like a coffee-shop wifi), it'll listen on all of
  them.
- Cleartext `ws://` over LAN is the design. The shared-secret token prevents
  unauthorized connections; it doesn't encrypt traffic. Anyone on the same
  LAN sniffing packets sees the prompts and responses in plaintext.
- For untrusted networks, either:
  - Use Tailscale / WireGuard so the LAN becomes a private overlay, or
  - Front the WS with a reverse proxy doing TLS termination and adjust the
    app's connect URL to `wss://...`.
- The extension is the only attack surface on the host side. There's no
  daemon outside pi's process; killing pi takes the server down.
- The Android app's `TestReceiver` (for ADB-driven testing) is `exported=true`
  in debug builds only — release APKs do not register it.

## Build from source

### Extension
```bash
git clone https://github.com/grunt3714-lgtm/pi-remote-control
cd pi-remote-control
npm install
# Run pi with the extension loaded directly (won't survive pi restarts):
pi -e ./extension.ts
# Or `pi install` it once, then plain `pi`.
```

### Android app
Open `android/pi-remote-control-app/` in Android Studio (or run from CLI):
```bash
cd android/pi-remote-control-app
./gradlew :app:assembleDebug   # or :app:assembleRelease
```
Output: `app/build/outputs/apk/{debug,release}/`. Release builds use
versionCode = git-commit-count and versionName = short-SHA.

## Protocol

If you want to write your own client, the WS messages are documented in
`extension.ts` — search for `emitAgentEvent` (host→client) and `handleHostCmd`
(client→host). It's plain JSON. Key shapes:

| client → host | meaning |
|---|---|
| `{type:"prompt", message, images?, targetAgentId?}` | send a user message |
| `{type:"steer", message, ...}` | interrupt current turn with a steer |
| `{type:"follow_up", message, ...}` | queue a follow-up for next turn |
| `{type:"spawn_peer", sessionPath?}` | spawn a new pi as peer (optionally resuming a saved session) |
| `{type:"get_saved_sessions"}` | request the saved-session list |
| `{type:"get_sessions"}` | request the connected-agent list |
| `{type:"get_commands"}` | request the slash-command list |

| host → client | meaning |
|---|---|
| `{type:"agent_start" / "agent_end" / "turn_start" / "turn_end", agentId}` | turn lifecycle |
| `{type:"message_start" / "message_end" / "message_update", agentId, ...}` | per-message streaming events |
| `{type:"tool_start" / "tool_update" / "tool_end", agentId, ...}` | tool-call streaming events |
| `{type:"session_list", sessions:[...]}` | connected agents |
| `{type:"saved_sessions", sessions:[...]}` | response to `get_saved_sessions` |
| `{type:"command_list", commands:[...]}` | response to `get_commands` |

## Contributing

Issues and PRs welcome. This is hobby-scale software; expect the code to be
opinionated about pi's specific conventions and to lag behind upstream pi
changes by a few days.

## Acknowledgements

- [pi-coding-agent](https://github.com/badlogic/pi-mono) by Mario Zechner —
  the CLI agent this extension hooks into.
- [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui) —
  the TUI framework whose terminal aesthetic the Android UI mirrors.
- [dev.snipme:highlights](https://github.com/SnipMeDev/Highlights) — the
  Kotlin syntax highlighter used for fenced code blocks in chat.
