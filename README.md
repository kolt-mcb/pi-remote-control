# pi-remote-control

A [pi](https://github.com/badlogic/pi-mono) extension that exposes a live pi
session over a LAN WebSocket so a remote client can drive it. The reference
client is the Android app at
[`kolt-mcb/pi-remote-control-app`](https://github.com/kolt-mcb/pi-remote-control-app);
the protocol is plain WS + JSON, so anything that can speak it works.

LAN-only by design — no cloud relay, no telemetry, no third-party SDKs. The
phone (or other client) talks directly to your pi over `ws://`, and a
[shared-secret token](#auth) gates every connection.

| | |
|---|---|
| **Status** | Early. Solo-author project. APIs and storage formats may change between commits. |
| **License** | MIT — see [LICENSE](LICENSE). |
| **Privacy** | No analytics, no remote logging, no SDK callbacks. Network traffic is exactly: the pi WS server the client connects to. |

## Install

Pi installs the extension from this repo's git URL:

```bash
pi install git:github.com/kolt-mcb/pi-remote-control
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

Update later:
```bash
pi update git:github.com/kolt-mcb/pi-remote-control
```

Then restart pi.

## Phone client

Side-load the Android app from its
[Releases](https://github.com/kolt-mcb/pi-remote-control-app/releases) and
scan the QR the extension prints. Setup details, features, and build
instructions live in the
[`pi-remote-control-app`](https://github.com/kolt-mcb/pi-remote-control-app)
repo. The connect screen also lets you paste the WS URL manually if you can
read it off the host.

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
    client to connect with `wss://...`.
- The extension is the only attack surface on the host side. There's no
  daemon outside pi's process; killing pi takes the server down.

## Build from source

```bash
git clone https://github.com/kolt-mcb/pi-remote-control
cd pi-remote-control
npm install
# Run pi with the extension loaded directly (won't survive pi restarts):
pi -e ./extension.ts
# Or `pi install` it once, then plain `pi`.
```

## Protocol

If you want to write your own client, the WS messages are documented in
`extension.ts` — search for `emitAgentEvent` (host→client) and `handleHostCmd`
(client→host). It's plain JSON. Key shapes:

| client → host | meaning |
|---|---|
| `{type:"prompt", message, images?, targetAgentId?}` | send a user message |
| `{type:"steer", message, ...}` | interrupt current turn with a steer |
| `{type:"follow_up", message, ...}` | queue a follow-up for next turn |
| `{type:"slash_command", command, args?, targetAgentId?}` | run a `/command` |
| `{type:"spawn_peer", sessionPath?}` | spawn a new pi as peer (optionally resuming a saved session) |
| `{type:"get_saved_sessions"}` | request the saved-session list |
| `{type:"get_sessions"}` | request the connected-agent list |
| `{type:"get_commands"}` | request the slash-command list |
| `{type:"input", id, value}` | answer a render-frame menu (see `piRemote.render`) |

| host → client | meaning |
|---|---|
| `{type:"agent_start" / "agent_end" / "turn_start" / "turn_end", agentId}` | turn lifecycle |
| `{type:"message_start" / "message_end" / "message_update", agentId, ...}` | per-message streaming events |
| `{type:"tool_start" / "tool_update" / "tool_end", agentId, ...}` | tool-call streaming events |
| `{type:"session_list", sessions:[...]}` | connected agents |
| `{type:"saved_sessions", sessions:[...]}` | response to `get_saved_sessions` |
| `{type:"command_list", commands:[...]}` | response to `get_commands` |
| `{type:"render", id, lines, inputMode, tapValues?, title?, dismiss?}` | ANSI render frame for a TUI component or in-extension menu |
| `{type:"extension_ui_request", method, id, ...}` | dialogs/notifications driven by an extension's `pi.ui` API |
| `{type:"theme_info", theme}` | the active pi theme palette so the client can mirror colors |

## Contributing

Issues and PRs welcome. This is hobby-scale software; expect the code to be
opinionated about pi's specific conventions and to lag behind upstream pi
changes by a few days.

## Acknowledgements

- [pi-coding-agent](https://github.com/badlogic/pi-mono) by Mario Zechner —
  the CLI agent this extension hooks into.
- [pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui) —
  the TUI framework whose `SelectList` lifecycle hooks make the phone-side
  selector mirroring possible.
