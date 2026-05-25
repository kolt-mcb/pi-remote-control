# Pi Remote Control — Extension

LAN-only remote control from your Android phone to pi running on your computer.

**Runs entirely as a pi extension** — no separate server process.

## Setup

```bash
# Install extension dependencies
cd ~/pi-remote-control
npm install

# Run pi with the extension
pi -e ~/pi-remote-control/extension.ts
```

## Usage

Inside pi:

```
/remote-control       # Start the WebSocket server
/remote-stop          # Stop it
```

The terminal prints your LAN IP and WebSocket URL, e.g.:
```
┌─ Pi Remote Control ─────────────────────────┐
│  ws://192.168.1.42:8765                     │
└─────────────────────────────────────────────┘
```

Open the app on your phone, enter that URL, connect — and chat with pi from your couch.

## Auth

The WS server requires a shared-secret token. On first launch, the extension
generates one and persists it to `~/.pi/agent/pi-remote-control.token`
(mode 0600). Subsequent launches reuse it, so the QR code your phone scanned
stays valid across pi restarts.

The token is included in the printed URL/QR:

```
ws://192.168.1.42:8765/?token=<32 hex chars>
```

Direct connections without the matching `?token=…` are closed with WS code `4001`.

**Overrides**:
- `PI_REMOTE_TOKEN=<your-token> pi` — provide your own token (e.g., from a
  password manager). Wins over the persisted file.
- `PI_REMOTE_CONTROL_NO_AUTH=1 pi` — disable auth entirely. Anyone who can
  reach the port can drive the agent. **Only safe on networks you fully
  trust** — for example, a single-user laptop on a home LAN with no port
  forwarding. The startup banner prints a loud warning when this is set.

To rotate the token, delete `~/.pi/agent/pi-remote-control.token` and restart
pi — a fresh one will be generated.

## Events forwarded to phone

| Pi Event            | Phone Event       |
|----------------------|--------------------|
| agent_start          | agent_start        |
| agent_end            | agent_end          |
| message_start        | message_start      |
| message_update       | message_update     |
| message_end          | message_end        |
| tool_execution_start | tool_start         |
| tool_execution_update| tool_update        |
| tool_execution_end   | tool_end           |

## Phone → pi

| Phone Command      | Effect                     |
|--------------------|----------------------------|
| `{prompt, msg}`    | Inject user message        |
| `{steer, msg}`     | Queue steering message     |
| `{follow_up, msg}` | Queue follow-up message    |

## Android App

Open `android/pi-remote-control-app/` in Android Studio → Build → Run.
