<h1 align="center">Pi Remote Control</h1>

<p align="center"><b>Your <a href="https://github.com/earendil-works/pi">pi</a> session, live on your phone.</b><br>
The full terminal — streamed, interactive, end-to-end encrypted, LAN-only.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/pi-package-8A2BE2" alt="pi package">
  <a href="https://github.com/kolt-mcb/pi-remote-control-app"><img src="https://img.shields.io/badge/client-Android-3DDC84" alt="Android client"></a>
</p>

<p align="center">
  <img src="docs/mirror-demo.gif" width="360"
       alt="A live pi session mirrored on a phone: streaming agent output, session tabs, terminal keyboard">
</p>

Pi Remote Control shows your live pi terminal on your phone and lets you
type back. Everything works exactly like it does at your desk — menus,
pickers, slash commands — resized to fit your phone's screen. Setup is one
install command and one QR scan. The phone app is
[pi-remote-control-app](https://github.com/kolt-mcb/pi-remote-control-app);
under the hood it's plain WebSocket + JSON, so other clients can connect
too.

## Features

- **Your real terminal, live** — everything that shows in your terminal
  shows on the phone: messages, menus, spinners, colors.
- **Type from anywhere** — a terminal keyboard on the phone; typing `/`
  opens pi's own command menu, just like at the desk.
- **Every session, one screen** — all the pi instances on your machine
  appear as tabs. Switch, drive, or start new ones in any folder.
- **Never miss context** — connecting mid-conversation shows the whole
  conversation, not just what happens next.
- **Files and images** — the agent can send files straight to your phone
  and show images right in the mirror, even when your terminal can't
  display them.
- **Matches your theme** — the phone picks up your pi color scheme.
- **Light on data** — about 1 KB/s while the agent streams; stays smooth
  even on a weak cell connection.
- **Private by design** — your phone talks only to your machine, on your
  network. Encrypted end to end, no cloud, no accounts, no telemetry.

## Yes, it runs DOOM

<p align="center">
  <img src="docs/doom-demo.gif" width="320"
       alt="DOOM running inside a pi session, mirrored to and played from a phone">
</p>

The mirror is a real terminal, not a chat view — anything pi renders, the
phone renders. Here that's [pi-doom](https://github.com/badlogic/pi-doom)
running in a session tab, played from the phone's terminal keyboard.

## Quick start

**1 — Install the extension** on the machine running pi:

```bash
pi install git:github.com/kolt-mcb/pi-remote-control
```

**2 — Launch `pi`.** The server starts with the session and prints its URL
and a pairing QR code (re-show it anytime with `/remote-qr`, stop the server
with `/remote-stop`):

```
┌─ Pi Remote Control (host) ───────────────────────────────────────────┐
│  wss://192.168.1.42:8765/?token=…32hex…&fp=…64hex…                   │
└──────────────────────────────────────────────────────────────────────┘
  auth: shared-secret token from /home/you/.pi/agent/pi-remote-control.token
  tls:  /home/you/.pi/agent/pi-remote-control.crt
  fingerprint: sha256:abcd1234…ef905678 (full value pinned in the QR)
```

**3 — Pair your phone.** Install the
[Android app](https://github.com/kolt-mcb/pi-remote-control-app/releases)
and scan the QR. The QR carries the address, the auth token, and the TLS
fingerprint the app pins — one scan does the whole setup.

To update later: `pi update git:github.com/kolt-mcb/pi-remote-control`, then
restart pi.

## Configuration

Works out of the box; environment variables on the host tweak it:

| Variable | Default | Effect |
|---|---|---|
| `PI_REMOTE_PORT` | `8765` | The port the phone connects to. A second pi that finds the port busy joins the first as an extra session. |
| `PI_REMOTE_TOKEN` | — | Use your own access token instead of the generated one. |
| `PI_REMOTE_CONTROL_NO_AUTH` | — | `1` turns off token auth. **Only on networks you fully trust.** |
| `PI_REMOTE_CONTROL_NO_AUTOSTART` | — | `1` stops the server from starting automatically; run `/remote-control` when you want it. |

<details>
<summary><b>Advanced</b></summary>

| Variable | Default | Effect |
|---|---|---|
| `PI_REMOTE_WIDTH_CACHE` | — | `1` enables a width-keyed render cache on pi-tui's text components. The mirror renders each frame a second time at the phone's width; the cache stops the two widths from evicting each other's single cache slot. Roughly halves render cost on long sessions. |
| `PI_REMOTE_DEBUG` | — | `1` prints per-second mirror render/throughput counters. |

</details>

## Security

- **Pinned TLS.** The extension mints a self-signed 2048-bit RSA cert on
  first launch (`~/.pi/agent/pi-remote-control.{crt,key}`, mode 0600) and
  serves `wss://`. The cert's SHA-256 fingerprint travels in the QR
  (`?fp=…`), and the client pins it — a MITM can't substitute a cert, and
  same-LAN sniffers see only TLS records. No CA involved, nothing to trust
  but the QR itself.
- **Token auth.** A shared-secret token is generated on first launch and
  persisted (`~/.pi/agent/pi-remote-control.token`, mode 0600), so a QR
  scanned today keeps working tomorrow. Connections without the token are
  closed with WS code `4001`.
- **Rotation.** Delete the token and/or cert files and restart pi — fresh
  values are generated and all previously scanned QRs stop working.
- **Surface.** The server binds `0.0.0.0` (required for another device to
  reach it), so the port is reachable on every interface that's up. There is
  no daemon outside pi's process; killing pi takes the server down.
- **Remote use.** WAN access isn't built in — for internet access, tunnel
  through Tailscale, WireGuard, or SSH; TLS + token still apply inside.
- **Treat the QR like a password.** Anyone holding it can drive your coding
  agent, and your coding agent can run shell commands.
- **Privacy.** No analytics, no remote logging, no third-party services.
  The only network traffic is the WebSocket between your devices.

## Protocol

Plain JSON over WebSocket; payloads over 512 B are zlib-deflated as binary
frames when the client opts in. The authoritative reference is
`extension.ts` (`handleHostCmd` for client→host, the `send`/`bcast` helpers
for host→client).

<details>
<summary><b>Message reference</b></summary>

| Client → host | Meaning |
|---|---|
| `{type:"client_hello", mirrorOnly?, diff?, deflate?, mirrorImages?}` | capability handshake; send first |
| `{type:"mirror", on, agentId?}` | subscribe/unsubscribe to the screen mirror (optionally of a peer session) |
| `{type:"mirror_input", data, agentId?}` | inject raw keystrokes into the mirrored session |
| `{type:"viewport", cols}` | report the client's column width; frames re-render to fit |
| `{type:"prompt" / "steer" / "follow_up", message, images?, targetAgentId?}` | send a user message / interrupt / queued follow-up |
| `{type:"slash_command", command, args?, targetAgentId?}` | run a `/command` |
| `{type:"spawn_peer", sessionPath?, cwd?}` | spawn a new pi as a peer session (optionally resuming a saved session) |
| `{type:"get_sessions"}` / `{type:"get_saved_sessions"}` | request the connected-agent / saved-session lists |
| `{type:"list_host_dirs", path?}` | browse host directories (for the spawn-peer folder picker) |
| `{type:"input", id, value}` / `{type:"extension_ui_response", id, value?, cancelled?}` | answer a render-frame menu or dialog |

| Host → client | Meaning |
|---|---|
| `{type:"connected", agentId, ...}` | handshake result; identifies the host session |
| `{type:"mirror_frame", agentId, seq, lines, cursor, width, height}` | full mirror keyframe (ANSI lines) |
| `{type:"mirror_diff", agentId, seq, lineCount, rows:[{i,t}], cursor}` | row-level diff against the previous frame |
| `{type:"history", messages}` | conversation replay on connect |
| `{type:"agent_start"/"agent_end"/"turn_start"/"turn_end", agentId}` | turn lifecycle |
| `{type:"message_*" / "tool_*", agentId, ...}` | per-message / per-tool streaming events |
| `{type:"session_list"}` / `{type:"saved_sessions"}` | session inventories |
| `{type:"file", name, mimeType, data, agentId?}` | file pushed by `send_file_to_phone` |
| `{type:"render", id, lines, inputMode, ...}` | ANSI render frame for an in-extension menu |
| `{type:"extension_ui_request", method, id, ...}` | dialogs and notifications (`select`, `notify`, …) |
| `{type:"theme_info", theme}` | pi's active theme palette |

</details>

## Development

```bash
git clone https://github.com/kolt-mcb/pi-remote-control
cd pi-remote-control
npm install
pi -e ./extension.ts   # load the extension directly for this run
```

Issues and pull requests are welcome. The project is under active
development; interfaces may change between releases.

## License

[MIT](LICENSE) · Built on [pi](https://github.com/earendil-works/pi) by
Mario Zechner.
