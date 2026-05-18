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
