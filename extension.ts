/**
 * Pi Remote Control Extension
 *
 * Starts a WebSocket server inside pi so you can connect from your phone.
 * No separate server process needed.
 *
 * If port is already in use by another pi on this host, switches to peer
 * mode: connects to the running pi as a client and registers itself as an
 * additional agent session. The Android app can then route prompts to
 * either pi via the SessionSelector.
 *
 * Usage:
 *   pi -e ~/pi-remote-control/extension.ts
 *
 * Then in pi:
 *   /remote-control   — starts the WS server (or peer mode if port busy)
 *   /remote-stop      — stops it
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
// Local fork of pi-tui exposes selectListEvents/respondToSelectList so we can
// surface any SelectList-based selector (built-in or extension) to the phone.
import { selectListEvents, respondToSelectList } from "@earendil-works/pi-tui";
// Local fork of pi-coding-agent re-exports BUILTIN_SLASH_COMMANDS so the phone
// can offer the full catalogue (/resume, /model, /theme, …) instead of just the
// extension/skill/template subset that pi.getCommands() returns.
import { BUILTIN_SLASH_COMMANDS, SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionInfo } from "@mariozechner/pi-coding-agent";
import qrcodeTerminal from "qrcode-terminal";

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8765;

// Optional shared-secret auth. If PI_REMOTE_TOKEN is set, every WS connection
// must carry `?token=...` matching the env var; otherwise the connection is
// closed with code 4001. Unset → no auth (preserves the original LAN-trust
// behaviour for users who explicitly want it).
const AUTH_TOKEN = process.env.PI_REMOTE_TOKEN ?? "";

function authOk(provided: string): boolean {
  if (!AUTH_TOKEN) return true;
  // Length mismatch can't be timing-safe and isn't a meaningful secret; bail early.
  if (provided.length !== AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(AUTH_TOKEN));
}

function urlWithToken(base: string): string {
  if (!AUTH_TOKEN) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

function tokenFromReqUrl(reqUrl: string | undefined): string {
  if (!reqUrl) return "";
  try { return new URL(reqUrl, "ws://x").searchParams.get("token") ?? ""; }
  catch { return ""; }
}

// ── Session types ───────────────────────────────────────────────────────

type SessionKind = "self" | "peer";

interface AgentSession {
  id: string;
  name: string;
  kind: SessionKind;
  status: "idle" | "busy" | "error";
  connectedAt: number;
  lastActivity: number;
  messageCount: number;
  turnIndex: number;
}

// ── State ───────────────────────────────────────────────────────────────

// This pi's stable identity for its lifetime.
const SELF_AGENT_ID = randomUUID().slice(0, 8);
const SELF_AGENT_NAME = `Pi-${SELF_AGENT_ID.slice(0, 4)}`;

type Mode = "stopped" | "host" | "peer";
let mode: Mode = "stopped";

// Host-mode state
let wss: WebSocketServer | null = null;
const clientConns = new Set<WebSocket>(); // Android viewers only
const peerConns = new Map<string, WebSocket>(); // peer agentId -> ws
const wsToPeerId = new WeakMap<WebSocket, string>();
const agents = new Map<string, AgentSession>(); // includes self + peers

// Peer-mode state
let peerSock: WebSocket | null = null;
let peerReconnectTimer: NodeJS.Timeout | null = null;

// Cross-extension bridge (globalThis): ANY extension can push TUI frames
// to connected Android clients and register for remote input. Usage:
//
//   // In your extension's ctx.ui.custom callback:
//   const piRemote = (globalThis as any).__piRemote;
//   if (piRemote) {
//     piRemote.render({ id: "myTui", lines: [...], inputMode: "keys", title: "My Game" });
//   }
//   // To handle remote input:
//   const unsub = piRemote.onInput((id, value) => { ... });
//   // When done:
//   piRemote.render({ id: "myTui", lines: [], dismiss: true });
//   unsub();
(globalThis as any).__piRemote = {
  /**
   * Push a TUI render frame to all connected Android clients.
   * Call every frame from your game/render loop.
   * @param frame  { id, lines: string[], inputMode: "keys"|"text"|"none", title?: string }
   *               Use `lines: []` or `dismiss: true` to clear the frame on Android.
   */
  render: (frame: { id: string; lines: string[]; inputMode?: string; title?: string; dismiss?: boolean }) => {
    hostBcastClients(JSON.stringify({
      type: "render",
      id: frame.id,
      lines: frame.lines,
      inputMode: frame.inputMode ?? "none",
      title: frame.title ?? "",
      dismiss: frame.dismiss || frame.lines.length === 0,
    }));
  },
  /**
   * Register a callback for remote TUI input (e.g., D-pad taps from Android).
   * Returns an unsubscribe function.
   */
  onInput: (cb: (id: string, value: string) => void) => {
    inputListeners.push(cb);
    return () => { const i = inputListeners.indexOf(cb); if (i !== -1) inputListeners.splice(i, 1); };
  },
  /** Get connected Android client count */
  get clientCount() { return clientConns.size; },
  /** Is the remote-control server running? */
  get isRunning() { return mode === "host"; },
};

// Collects callbacks registered via onInput()
const inputListeners: Array<(id: string, value: string) => void> = [];

// Bridge pi-tui SelectList lifecycle to the phone. Any selector that uses
// SelectList under the hood (themes, thinking levels, settings, show-images,
// plus anything an extension builds with it) shows up as a native dialog on
// the phone via the existing extension_ui_request protocol.
// Map labels back to values when the phone sends a string response.
const liveSelectListLabels = new Map<string, Map<string, string>>();
selectListEvents.on("mount", (e: { id: string; items: Array<{ value: string; label: string; description?: string }> }) => {
  const labelToValue = new Map<string, string>();
  for (const it of e.items) labelToValue.set(it.label || it.value, it.value);
  liveSelectListLabels.set(e.id, labelToValue);
  hostBcastClients(JSON.stringify({
    type: "extension_ui_request",
    method: "select",
    id: e.id,
    title: "Select",
    options: e.items.map((it) => it.label || it.value),
  }));
});
selectListEvents.on("dismiss", (e: { id: string }) => {
  liveSelectListLabels.delete(e.id);
  hostBcastClients(JSON.stringify({ type: "extension_ui_dismiss", id: e.id }));
});

// ── Remote-only select dialogs ─────────────────────────────────────────
// For built-in slash commands like /resume that have rich local TUI selectors
// we can't cleanly remote, the extension synthesises a flat select-from-list
// dialog on the phone using extension_ui_request. Each pending dialog is
// tracked here so the response can be routed back to the right handler.
// Ids use the "rmt_" prefix to distinguish from SelectList-bridged "sl_" ids.
type RemoteSelectPending = {
  labelToValue: Map<string, string>;
  onPick: (value: string) => void;
  onCancel: () => void;
};
const remoteSelects = new Map<string, RemoteSelectPending>();
let remoteSelectIdCounter = 0;

function showRemoteSelect(opts: {
  title: string;
  options: Array<{ label: string; value: string }>;
  onPick: (value: string) => void;
  onCancel?: () => void;
}): void {
  if (opts.options.length === 0) {
    opts.onCancel?.();
    return;
  }
  remoteSelectIdCounter++;
  const id = `rmt_${Date.now().toString(36)}_${remoteSelectIdCounter.toString(36)}`;
  const labelToValue = new Map<string, string>();
  for (const o of opts.options) labelToValue.set(o.label, o.value);
  remoteSelects.set(id, {
    labelToValue,
    onPick: opts.onPick,
    onCancel: opts.onCancel ?? (() => { /* noop */ }),
  });
  hostBcastClients(JSON.stringify({
    type: "extension_ui_request",
    method: "select",
    id,
    title: opts.title,
    options: opts.options.map((o) => o.label),
  }));
}

// Local agent state (this pi's own agent — applies in both host and peer mode)
let localBusy = false;
let localMessageCount = 0;
let localTurnIndex = 0;

// ── Helpers ─────────────────────────────────────────────────────────────

function localIP(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]!) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function nowSelfStatus(): AgentSession["status"] {
  return localBusy ? "busy" : "idle";
}

function upsertSelfAgent(): void {
  const existing = agents.get(SELF_AGENT_ID);
  const now = Date.now();
  agents.set(SELF_AGENT_ID, {
    id: SELF_AGENT_ID,
    name: SELF_AGENT_NAME,
    kind: "self",
    status: nowSelfStatus(),
    connectedAt: existing?.connectedAt ?? now,
    lastActivity: now,
    messageCount: localMessageCount,
    turnIndex: localTurnIndex,
  });
}

function buildSessionList(): AgentSession[] {
  return Array.from(agents.values());
}

function hostBcastClients(text: string): void {
  for (const c of clientConns) {
    if (c.readyState === 1) c.send(text);
  }
}

function hostBcastSessionList(only?: WebSocket): void {
  const list = buildSessionList();
  const text = JSON.stringify({ type: "session_list", sessions: list });
  if (only) {
    if (only.readyState === 1) only.send(text);
  } else {
    hostBcastClients(text);
  }
}

// ── Remote slash-command support ────────────────────────────────────────
// Commands the phone can execute remotely via `withCommandContext`.
// Commands NOT listed here are either UI-heavy (settings menus, model
// selectors, file pickers, clipboard) and can't be proxied through the
// extension API, OR they replace the session and so permanently invalidate
// our extension runtime (see below).
const REMOTE_SUPPORTED_COMMANDS = new Set([
  "compact",    // ctx.compact()  — safe, no session replacement
  "quit",       // ctx.shutdown() — pi exits anyway
]);

// Built-ins that look supported in principle but break the extension's pi
// reference. Pi's runtime sets state.staleMessage on ctx.newSession() /
// switchSession() / fork() / reload() and never clears it, so after one
// of these any subsequent pi.withCommandContext throws. We surface this
// as the safeCtx warning banner — better than a crash but still confusing
// from the user's perspective. Hide them from the phone's autocomplete
// entirely; the equivalent UX is reachable elsewhere:
//
//   /new     → spawn a new pi peer via the [+ New session] button (PR #20)
//   /resume  → host's pi TUI (or revisit once we wire up an in-app browser)
//   /reload  → same — host's pi TUI
//
// Keep this in REMOTE_UNSUPPORTED_BUILTINS so buildCommandList omits them.
const REMOTE_STALES = new Set(["new", "resume", "reload"]);

// Built-ins to hide from the phone's autocomplete. Anything not in
// REMOTE_SUPPORTED_COMMANDS gets hidden, plus the session-replacing
// commands that would invalidate the extension.
const REMOTE_UNSUPPORTED_BUILTINS = new Set(BUILTIN_SLASH_COMMANDS
  .filter(b => !REMOTE_SUPPORTED_COMMANDS.has(b.name))
  .map(b => b.name),
);

/** Send a notify banner to the phone explaining a command needs the host TUI */
function notifyUnsupportedCommand(name: string): void {
  hostBcastClients(JSON.stringify({
    type: "extension_ui_request",
    method: "notify",
    id: "notify_unsupported_" + Date.now(),
    message: `⚠ /${name} requires the host TUI. Type it directly in the Pi terminal.`,
    notifyType: "warning",
  }));
}

function buildCommandList(pi: ExtensionAPI): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  // Built-ins first — but filter out ones that need TUI-only UI.
  for (const b of BUILTIN_SLASH_COMMANDS) {
    if (!REMOTE_UNSUPPORTED_BUILTINS.has(b.name)) {
      out.push({ name: b.name, description: b.description });
    }
  }
  // Extension/skill/template commands are fine — they expand via executeSlashCommands.
  try {
    const cmds = (pi as { getCommands?: () => Array<{ name: string; description?: string }> }).getCommands?.() ?? [];
    for (const c of cmds) out.push({ name: c.name, description: c.description ?? "" });
  } catch { /* ignore */ }
  return out;
}

// ── Remote handlers for built-in slash commands ────────────────────────
//
// These run when the phone sends "/foo" through `prompt` and the command is
// a built-in that needs a UI selector (e.g., /resume). The handler returns
// `true` if it claimed the command (extension already responded), `false` to
// let the normal sendUserMessage path proceed (which would just ship the text
// to the LLM — usually wrong for built-ins, hence the interception).

function formatSessionLabel(s: SessionInfo): string {
  const name = s.name?.trim() || s.firstMessage?.trim() || s.id;
  const trimmed = name.length > 40 ? name.slice(0, 39) + "…" : name;
  const date = new Date(s.modified).toISOString().slice(0, 10);
  return `${trimmed} · ${s.messageCount} msgs · ${date}`;
}

function handleRemoteResume(pi: ExtensionAPI): boolean {
  void (async () => {
    let sessions: SessionInfo[] = [];
    try {
      sessions = await SessionManager.listAll();
    } catch (e) {
      console.error("[remote-control] list sessions failed:", e);
      return;
    }
    // Show most-recent first; cap at a reasonable number for the dialog.
    sessions.sort((a, b) => +new Date(b.modified) - +new Date(a.modified));
    const truncated = sessions.slice(0, 100);
    showRemoteSelect({
      title: "Resume session",
      options: truncated.map((s) => ({ label: formatSessionLabel(s), value: s.path })),
      onPick: (sessionPath) => {
        void safeCtx(pi, "/resume", async (ctx) => {
          await ctx.switchSession(sessionPath);
        });
      },
    });
  })();
  return true;
}

function sendCommandList(pi: ExtensionAPI, ws: WebSocket): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "command_list", commands: buildCommandList(pi) }));
}

/**
 * Wrap a pi.withCommandContext call so a stale-extension-runtime exception
 * doesn't crash pi. The extension's captured `pi` reference goes permanently
 * stale after ctx.newSession()/fork()/switchSession()/reload(); subsequent
 * pi.withCommandContext calls throw synchronously and (because they run inside
 * a `void (async () => …)()`) become unhandled rejections that exit pi.
 *
 * On stale, we send a notify banner telling the user to restart pi to recover.
 * Returns false on error so the caller can choose to abort follow-up work.
 */
async function safeCtx(
  pi: ExtensionAPI,
  label: string,
  fn: (ctx: any) => Promise<void> | void,
): Promise<boolean> {
  try {
    await pi.withCommandContext(fn);
    return true;
  } catch (e: any) {
    const stale = typeof e?.message === "string" && e.message.includes("stale after session replacement");
    if (stale) {
      console.warn(`safeCtx[${label}]: extension is stale, restart pi to recover`);
      hostBcastClients(JSON.stringify({
        type: "extension_ui_request",
        method: "notify",
        id: `notify_stale_${Date.now()}`,
        message: `Session was replaced earlier — restart pi to use ${label} again.`,
        notifyType: "warning",
      }));
    } else {
      console.warn(`safeCtx[${label}] error:`, e?.message ?? e);
    }
    return false;
  }
}

/**
 * Emit an agent event:
 *  - host mode: stamp with SELF_AGENT_ID and broadcast to all Android clients
 *  - peer mode: wrap as peer_event and send to host (host re-broadcasts with our id)
 */
function emitAgentEvent(obj: Record<string, unknown>): void {
  if (mode === "host") {
    hostBcastClients(JSON.stringify({ ...obj, agentId: SELF_AGENT_ID }));
  } else if (mode === "peer" && peerSock?.readyState === 1) {
    peerSock.send(JSON.stringify({ type: "peer_event", agentId: SELF_AGENT_ID, payload: obj }));
  }
}

function parseNameFromUrl(reqUrl: string | undefined, fallback: string): string {
  if (!reqUrl) return fallback;
  try {
    return new URL(reqUrl, "ws://x").searchParams.get("name") || fallback;
  } catch {
    return fallback;
  }
}

// ── Server (host) lifecycle ─────────────────────────────────────────────

function startHost(pi: ExtensionAPI, onBindFail: () => void): void {
  const ip = localIP();
  const url = urlWithToken(`ws://${ip}:${DEFAULT_PORT}`);

  const server = new WebSocketServer({ port: DEFAULT_PORT, host: "0.0.0.0" });
  wss = server;

  let bound = false;
  let bindFailed = false;

  // ws emits EADDRINUSE asynchronously — before we can finish setup
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      bindFailed = true;
      wss = null;
      try { server.close(); } catch { /* ignore */ }
      onBindFail();
    }
    // any other ws error — ignore, 'connection' handles per-client errors
  });

  server.on("listening", () => {
    if (bindFailed) return;
    bound = true;
    mode = "host";
    upsertSelfAgent();
    console.log(`\n┌─ Pi Remote Control (host) ──────────────────┐`);
    console.log(`│  ${url}  │`);
    console.log(`└─────────────────────────────────────────────┘\n`);
    // Render a QR code the Android app can scan. The Android scanner accepts
    // ws://, wss://, piremote://, and bare host:port; we use ws:// so a
    // generic QR scanner (camera app) also recognises it as a URL.
    qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
      console.log(qr);
      pi.sendMessage({
        customType: "remote",
        content: `active: ${url}  (host: ${SELF_AGENT_NAME})\nScan with the Pi Remote app:\n${qr}`,
        display: true,
      });
    });
  });

  server.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Auth gate: when PI_REMOTE_TOKEN is set, reject connections that don't
    // carry the matching `?token=...`. Peer connections use the same URL
    // (with the token) so they pass this check too.
    if (!authOk(tokenFromReqUrl(req.url))) {
      const remote = req.socket?.remoteAddress ?? "?";
      console.log(`  [!] rejected unauthorized connection from ${remote}`);
      try { ws.close(4001, "unauthorized"); } catch { /* ignore */ }
      return;
    }
    // Default new connection to client; promoted to peer on peer_hello.
    clientConns.add(ws);
    const inferredName = parseNameFromUrl(req.url, "viewer");
    console.log(`  [+] client connected (${clientConns.size} viewers, ${peerConns.size} peers) ${inferredName}`);

    hostBcastClients(JSON.stringify({ type: "connected", clients: clientConns.size }));
    hostBcastSessionList();
    sendCommandList(pi, ws);

    ws.on("message", (data: RawData) => {
      const text = data.toString();
      try {
        const cmd = JSON.parse(text) as Record<string, unknown>;
        handleHostCmd(cmd, pi, ws);
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Bad JSON" }));
      }
    });

    const drop = () => {
      const peerId = wsToPeerId.get(ws);
      if (peerId) {
        peerConns.delete(peerId);
        agents.delete(peerId);
        wsToPeerId.delete(ws);
        console.log(`  [-] peer ${peerId} disconnected`);
      } else {
        clientConns.delete(ws);
        console.log(`  [-] client disconnected (${clientConns.size} viewers)`);
      }
      hostBcastSessionList();
    };

    ws.on("close", drop);
    ws.on("error", drop);
  });

  // Safety net in case neither 'listening' nor 'error' fires (shouldn't happen).
  setTimeout(() => {
    if (!bound && !bindFailed) {
      bindFailed = true;
      wss = null;
      try { server.close(); } catch { /* ignore */ }
      onBindFail();
    }
  }, 1500);
}

// ── Peer-mode lifecycle ─────────────────────────────────────────────────

function startPeer(pi: ExtensionAPI): void {
  if (peerSock || mode === "peer") return;
  mode = "peer";
  // Same shared secret applies for host↔peer on the loopback. If PI_REMOTE_TOKEN
  // is set, the peer dials with the token so the host's auth gate accepts it.
  const url = urlWithToken(`ws://127.0.0.1:${DEFAULT_PORT}`);
  console.log(`\n┌─ Pi Remote Control (peer) ──────────────────┐`);
  console.log(`│  joining ${url} as ${SELF_AGENT_NAME}        │`);
  console.log(`└─────────────────────────────────────────────┘\n`);

  const sock = new WebSocket(url);
  peerSock = sock;

  sock.on("open", () => {
    sock.send(JSON.stringify({
      type: "peer_hello",
      agentId: SELF_AGENT_ID,
      name: SELF_AGENT_NAME,
    }));
    pi.sendMessage({
      customType: "remote",
      content: `peer mode: joined as ${SELF_AGENT_NAME}`,
      display: true,
    });
  });

  sock.on("message", (data: RawData) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text) as Record<string, unknown>;
      handlePeerInbound(msg, pi);
    } catch {
      /* ignore malformed */
    }
  });

  const cleanup = () => {
    if (peerSock === sock) peerSock = null;
    if (mode !== "peer") return;
    if (peerReconnectTimer) return;
    // Host may have died. Try to reclaim the port; if still busy, retry as peer.
    peerReconnectTimer = setTimeout(() => {
      peerReconnectTimer = null;
      if (mode !== "peer") return;
      mode = "stopped";
      start(pi);
    }, 2000);
  };

  sock.on("close", cleanup);
  sock.on("error", cleanup);
}

function stopPeer(): void {
  if (peerReconnectTimer) {
    clearTimeout(peerReconnectTimer);
    peerReconnectTimer = null;
  }
  if (peerSock) {
    try { peerSock.close(); } catch { /* ignore */ }
    peerSock = null;
  }
}

// ── Unified start/stop ──────────────────────────────────────────────────

function start(pi: ExtensionAPI): void {
  if (mode === "host" && wss) {
    pi.sendMessage({
      customType: "remote",
      content: `already running: ${urlWithToken(`ws://${localIP()}:${DEFAULT_PORT}`)}  (${clientConns.size} viewers, ${peerConns.size} peers)`,
      display: true,
    });
    return;
  }
  if (mode === "peer" && peerSock) {
    pi.sendMessage({
      customType: "remote",
      content: `already running in peer mode as ${SELF_AGENT_NAME}`,
      display: true,
    });
    return;
  }

  startHost(pi, () => {
    // Fallback to peer mode on EADDRINUSE
    mode = "stopped";
    startPeer(pi);
  });
}

function stop(pi: ExtensionAPI): void {
  if (mode === "stopped") return;
  const wasMode = mode;
  // Flip mode first so peer-close handlers don't try to auto-reconnect.
  mode = "stopped";

  if (wasMode === "host" && wss) {
    wss.close();
    for (const ws of clientConns) {
      try { ws.close(); } catch { /* ignore */ }
    }
    for (const ws of peerConns.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    clientConns.clear();
    peerConns.clear();
    wss = null;
  }

  if (wasMode === "peer") {
    stopPeer();
  }

  agents.clear();
  localBusy = false;
  localMessageCount = 0;
  localTurnIndex = 0;

  pi.sendMessage({
    customType: "remote",
    content: "stopped",
    display: true,
  });
}

// ── Host: inbound commands ──────────────────────────────────────────────

function handleHostCmd(cmd: Record<string, unknown>, pi: ExtensionAPI, ws: WebSocket): void {
  switch (cmd.type as string) {
    case "peer_hello": {
      const peerId = (cmd.agentId as string) || randomUUID().slice(0, 8);
      const name = (cmd.name as string) || `Pi-${peerId.slice(0, 4)}`;
      // Promote this ws from client to peer.
      clientConns.delete(ws);
      peerConns.set(peerId, ws);
      wsToPeerId.set(ws, peerId);
      const now = Date.now();
      agents.set(peerId, {
        id: peerId,
        name,
        kind: "peer",
        status: "idle",
        connectedAt: now,
        lastActivity: now,
        messageCount: 0,
        turnIndex: 0,
      });
      console.log(`  [*] peer joined: ${peerId} (${name})`);
      ws.send(JSON.stringify({ type: "peer_ack", hostAgentId: SELF_AGENT_ID }));
      hostBcastSessionList();
      break;
    }
    case "peer_event": {
      const sourceAgentId = wsToPeerId.get(ws);
      const payload = cmd.payload as Record<string, unknown> | undefined;
      if (!sourceAgentId || !payload) break;
      const agent = agents.get(sourceAgentId);
      if (agent) {
        agent.lastActivity = Date.now();
        // Track busy/idle from forwarded agent_start/agent_end
        if (payload.type === "agent_start") agent.status = "busy";
        if (payload.type === "agent_end") {
          agent.status = "idle";
          if (typeof payload.messageCount === "number") agent.messageCount = payload.messageCount;
        }
        if (payload.type === "turn_start" && typeof payload.turnIndex === "number") {
          agent.turnIndex = payload.turnIndex;
        }
      }
      hostBcastClients(JSON.stringify({ ...payload, agentId: sourceAgentId }));
      if (payload.type === "agent_start" || payload.type === "agent_end") {
        hostBcastSessionList();
      }
      break;
    }
    case "prompt":
    case "steer":
    case "follow_up": {
      const msg = cmd.message as string;
      const images = (cmd.images as string[]) || [];
      if (!msg && images.length === 0) break;
      const target = (cmd.targetAgentId as string) || SELF_AGENT_ID;
      const deliverAs =
        cmd.type === "steer" ? "steer" : cmd.type === "follow_up" ? "followUp" : undefined;
      // Built-in slash commands need rich UI (session metadata, model scope tabs,
      // tree nav) that ctx.ui.select can't represent without losing data. So for
      // the most common UI-bearing built-ins we synthesise a flat tap-list on
      // the phone and act on the pick ourselves, instead of forwarding the
      // slash text to pi. Targets the local agent only; peer routing untouched.
      if (target === SELF_AGENT_ID && cmd.type === "prompt") {
        const cmdName = msg.split(/\s/)[0].slice(1);
        if (cmdName === "resume" && handleRemoteResume(pi)) break;
      }
      if (target === SELF_AGENT_ID) {
        const sendOpts: { deliverAs?: "steer" | "followUp" } = {};
        if (deliverAs) sendOpts.deliverAs = deliverAs;
        // Pi's ImageContent is { type:"image", data, mimeType } — `data` is raw
        // base64 without the data-URI prefix. Sending the full `data:...;base64,`
        // URI yields "Non-base64 digit found" from Claude because `:`, `/`, `;`, `,`
        // aren't valid base64 characters.
        if (images.length > 0) {
          type TextMsg = { type: "text"; text: string };
          type ImageMsg = { type: "image"; data: string; mimeType: string };
          const contentArr: Array<TextMsg | ImageMsg> = [];
          if (msg) contentArr.push({ type: "text", text: msg });
          for (const dataUri of images) {
            const m = dataUri.match(/^data:([^;]+);base64,(.*)$/);
            const mime = m ? m[1] : "image/jpeg";
            const data = m ? m[2] : dataUri;
            contentArr.push({ type: "image", data, mimeType: mime });
          }
          pi.sendUserMessage(contentArr, sendOpts);
        } else {
          pi.sendUserMessage(msg, sendOpts);
        }
      } else {
        const peerWs = peerConns.get(target);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: "route_prompt", message: msg, deliverAs, executeSlashCommands: msg.startsWith("/"), images }));
        }
      }
      break;
    }
    // ── Remote slash-command execution ───────────────────────────────────
    // Handles /compact, /new, /reload, /quit via withCommandContext.
    // /resume is handled separately above (has a rich session picker UI).
    // Unsupported built-ins get a notify banner telling the user to use the host TUI.
    //
    // KNOWN LIMITATION: ctx.newSession()/fork()/switchSession()/reload()
    // invalidate the extension's captured `pi` reference. The next call to
    // pi.withCommandContext from this WS handler throws synchronously inside
    // the async IIFE, becoming an unhandled rejection that crashes pi.
    // Until we figure out the proper "refresh pi after session replacement"
    // pattern (see #19), each handler is wrapped in safeCtx() which catches
    // the stale error, notifies the user, and returns without taking down pi.
    case "slash_command": {
      const commandName = (cmd.command as string)?.trim().toLowerCase();
      if (!commandName) break;
      const target = (cmd.targetAgentId as string) || SELF_AGENT_ID;
      if (target !== SELF_AGENT_ID) break; // Only handle local agent

      if (commandName === "compact") {
        const instructions = (cmd.args as string)?.trim();
        void (async () => {
          const ok = await safeCtx(pi, "/compact", async (ctx) => {
            ctx.compact(instructions ? { instructions } : undefined);
          });
          if (!ok) return;
          hostBcastClients(JSON.stringify({
            type: "extension_ui_request",
            method: "notify",
            id: `notify_compact_${Date.now()}`,
            message: instructions
              ? `Compacting with custom instructions...`
              : `Compacting session context...`,
            notifyType: "info",
          }));
        })();
      } else if (commandName === "quit") {
        void safeCtx(pi, "/quit", async (ctx) => {
          void ctx.shutdown();
        });
      } else if (REMOTE_STALES.has(commandName)) {
        // /new, /resume, /reload — these would invalidate the extension
        // runtime (see comment on REMOTE_STALES). Route the user to the
        // working alternatives.
        const hint =
          commandName === "new" ? "use the [+ New session] button on the Sessions screen instead" :
          commandName === "resume" ? "run /resume in the pi terminal" :
          /* reload */ "run /reload in the pi terminal";
        hostBcastClients(JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          id: `notify_stale_path_${Date.now()}`,
          message: `/${commandName} can't run from the app — ${hint}.`,
          notifyType: "warning",
        }));
      } else {
        // Unsupported built-in command — notify the phone
        notifyUnsupportedCommand(commandName);
      }
      break;
    }
    case "input": {
      // Forward TUI key input to any listening extension via onInput callback
      const id = (cmd.id as string) || "";
      const value = (cmd.value as string) || "";
      if (value) {
        // Deliver to all registered input listeners (generic — no extension coupling)
        for (const cb of inputListeners) cb(id, value);
      }
      break;
    }
    // ── Spawn a second pi process as a peer ─────────────────────────────
    // Architectural workaround for pi's extension-lifecycle limitation:
    // ctx.newSession() / switchSession() / fork() / reload() permanently
    // invalidate the extension's runtime (state.staleMessage is set and never
    // cleared except by full /reload, which extensions also can't recover
    // from). So we don't change sessions in-process; we just spawn another
    // pi. The new pi auto-loads this same extension (pi-remote-control is
    // installed via pi.extensions), detects the WS port is busy, falls back
    // to peer mode, and joins this host's session_list.
    case "spawn_peer": {
      // Detach so the spawned process survives this pi's exit. Inherit env
      // so PI_REMOTE_TOKEN etc. carry through. setsid+script gives it a
      // fake PTY since pi is a TUI and refuses to start without one.
      const logPath = `/tmp/pi-peer-${randomUUID().slice(0, 6)}.log`;
      try {
        const child = spawnChild(
          "setsid",
          ["script", "-qfc", "pi", logPath],
          {
            detached: true,
            stdio: "ignore",
            env: process.env,
            cwd: process.cwd(),
          },
        );
        child.unref();
        console.log(`  [*] spawned peer pi (pid=${child.pid}, log=${logPath})`);
        hostBcastClients(JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          id: `notify_peer_${Date.now()}`,
          message: `Launching a new pi peer… it'll join shortly.`,
          notifyType: "info",
        }));
      } catch (e: any) {
        console.warn(`  [!] spawn_peer failed: ${e?.message ?? e}`);
        hostBcastClients(JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          id: `notify_peer_fail_${Date.now()}`,
          message: `Couldn't spawn peer: ${e?.message ?? "unknown error"}`,
          notifyType: "error",
        }));
      }
      break;
    }
    case "get_state": {
      hostBcastClients(JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        data: { clients: clientConns.size, connected: clientConns.size > 0 },
      }));
      break;
    }
    case "get_sessions": {
      hostBcastSessionList(ws);
      break;
    }
    case "get_commands": {
      sendCommandList(pi, ws);
      break;
    }
    case "extension_ui_response": {
      const id = (cmd.id as string) || "";
      const cancelled = cmd.cancelled === true;
      const label = (cmd.value as string) ?? "";
      if (id.startsWith("sl_")) {
        // SelectList bridge: forward to pi-tui's responder so the live local
        // TUI selector also dismisses.
        if (cancelled) {
          respondToSelectList(id, null);
        } else {
          // We sent labels to the phone; translate back to the SelectItem value.
          const value = liveSelectListLabels.get(id)?.get(label) ?? label;
          respondToSelectList(id, value);
        }
      } else if (id.startsWith("rmt_")) {
        // Remote-only dialog (built-in command intercept). Route to the
        // pending callback and clear.
        const pending = remoteSelects.get(id);
        if (!pending) break;
        remoteSelects.delete(id);
        if (cancelled) {
          pending.onCancel();
        } else {
          const value = pending.labelToValue.get(label) ?? label;
          pending.onPick(value);
        }
      }
      break;
    }
  }
}

// ── Peer: inbound from host ─────────────────────────────────────────────

function handlePeerInbound(msg: Record<string, unknown>, pi: ExtensionAPI): void {
  switch (msg.type as string) {
    case "route_prompt": {
      const text = msg.message as string;
      const images = (msg.images as string[]) || [];
      if (!text && images.length === 0) break;
      const deliverAs = msg.deliverAs as "steer" | "followUp" | undefined;
      const executeSlashCommands = (msg.executeSlashCommands as boolean) ?? text.startsWith("/");
      // Pi's ImageContent is { type:"image", data, mimeType } — `data` is raw
      // base64 without the data-URI prefix. See SELF_AGENT_ID branch above.
      const peerSendOpts: { deliverAs?: "steer" | "followUp" } = {};
      if (deliverAs) peerSendOpts.deliverAs = deliverAs;
      if (images.length > 0) {
        type TextMsg = { type: "text"; text: string };
        type ImageMsg = { type: "image"; data: string; mimeType: string };
        const contentArr: Array<TextMsg | ImageMsg> = [];
        if (text) contentArr.push({ type: "text", text });
        for (const dataUri of images) {
          const m = dataUri.match(/^data:([^;]+);base64,(.*)$/);
          const mime = m ? m[1] : "image/jpeg";
          const data = m ? m[2] : dataUri;
          contentArr.push({ type: "image", data, mimeType: mime });
        }
        pi.sendUserMessage(contentArr, peerSendOpts);
      } else {
        pi.sendUserMessage(text, peerSendOpts);
      }
      break;
    }
    // peer_ack and any other host->peer messages: ignored (no state to update)
  }
}

// ── Extension factory ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("remote-control", {
    description: "Start remote control server",
    handler: async () => start(pi),
  });

  pi.registerCommand("remote-stop", {
    description: "Stop remote control server",
    handler: async () => stop(pi),
  });

  // ── Message renderer ──────────────────────────────────────────────────

  pi.registerMessageRenderer("remote", (msg, _opts, theme) => {
    const { Text } = require("@mariozechner/pi-tui") as typeof import("@mariozechner/pi-tui");
    return new Text(theme.fg("accent", `[Remote] ${msg.content}`), 0, 0);
  });

  // ── Agent events ─────────────────────────────────────────────────────

  pi.on("agent_start", async (_e) => {
    localBusy = true;
    if (mode === "host") {
      upsertSelfAgent();
      hostBcastSessionList();
    }
    emitAgentEvent({ type: "agent_start" });
  });

  pi.on("agent_end", async (e) => {
    localBusy = false;
    localMessageCount = (e.messages ?? []).length;
    if (mode === "host") {
      upsertSelfAgent();
      hostBcastSessionList();
    }
    emitAgentEvent({ type: "agent_end", messageCount: localMessageCount });
  });

  pi.on("turn_start", async (e) => {
    localTurnIndex = e.turnIndex;
    emitAgentEvent({ type: "turn_start", turnIndex: e.turnIndex });
  });

  pi.on("turn_end", async (e) => {
    emitAgentEvent({ type: "turn_end", turnIndex: e.turnIndex });
  });

  pi.on("compactionStart", async () => {
    emitAgentEvent({ type: "compaction_start" });
  });

  pi.on("compactionEnd", async () => {
    emitAgentEvent({ type: "compaction_end" });
  });

  pi.on("autoRetryStart", async (e: any) => {
    emitAgentEvent({
      type: "auto_retry_start",
      attempt: e.attempt,
      maxAttempts: e.maxAttempts,
    });
  });

  pi.on("autoRetryEnd", async () => {
    emitAgentEvent({ type: "auto_retry_end" });
  });

  // ── Message events ────────────────────────────────────────────────────

  pi.on("message_start", async (e) => {
    emitAgentEvent({ type: "message_start", message: e.message });
  });

  pi.on("message_end", async (e) => {
    emitAgentEvent({ type: "message_end", message: e.message });
  });

  pi.on("message_update", async (e: any) => {
    const evt = e.assistantMessageEvent;
    if (!evt) return;
    switch (evt.type) {
      case "text_start":
        emitAgentEvent({ type: "message_update", eventType: "text_start" });
        break;
      case "text_delta":
        emitAgentEvent({ type: "message_update", eventType: "text_delta", delta: evt.delta ?? "" });
        break;
      case "text_end":
        emitAgentEvent({ type: "message_update", eventType: "text_end" });
        break;
      case "thinking_start":
        emitAgentEvent({ type: "message_update", eventType: "thinking_start" });
        break;
      case "thinking_delta":
        emitAgentEvent({ type: "message_update", eventType: "thinking_delta", delta: evt.delta ?? "" });
        break;
      case "thinking_end":
        emitAgentEvent({ type: "message_update", eventType: "thinking_end" });
        break;
      case "done":
        emitAgentEvent({ type: "message_update", eventType: "done", reason: (evt as any).reason ?? "" });
        break;
      case "error":
        emitAgentEvent({ type: "message_update", eventType: "error", message: (evt as any).message ?? "" });
        break;
    }
  });

  // ── Tool events ───────────────────────────────────────────────────────

  pi.on("tool_execution_start", async (e) => {
    emitAgentEvent({
      type: "tool_start",
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      args: e.args ?? {},
    });
  });

  pi.on("tool_execution_update", async (e: any) => {
    const cr = e.partialResult;
    const content = Array.isArray(cr?.content)
      ? cr.content.slice(-1).map((c: any) => c.text ?? "").join("")
      : "";
    if (content) {
      const stream = (e as any)._stream || content;
      emitAgentEvent({
        type: "tool_update",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        content: stream,
      });
      (e as any)._stream = (stream as string) + content;
    }
  });

  pi.on("tool_execution_end", async (e: any) => {
    const cr = e.result;
    // Extract content: try .text[] first, then .content[] (file read results)
    let content = "";
    if (Array.isArray(cr?.content)) {
      content = cr.content.map((c: any) => c.text ?? c.content ?? "").join("\n");
    } else if (typeof cr?.content === "string") {
      content = cr.content;
    }
    // Also try flat text fields on the result
    if (!content && typeof cr === "object") {
      content = (cr.text as string) ?? (cr.output as string) ?? "";
    }
    emitAgentEvent({
      type: "tool_end",
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? "",
      content,
      isError: e.isError ?? false,
    });
  });

  // ── Extension UI events ───────────────────────────────────────────────

  pi.on("extensionUiRequested", async (e: any) => {
    emitAgentEvent({
      type: "extension_ui_request",
      method: e.method,
      id: e.id,
      title: e.title,
      message: e.message,
      options: e.options,
      placeholder: e.placeholder,
      prefill: e.prefill,
      timeout: e.timeout,
    });
  });

  pi.on("extensionUiNotify", async (e: any) => {
    emitAgentEvent({
      type: "extension_ui_request",
      method: "notify",
      id: "notify_" + Date.now(),
      message: e.message ?? e.content ?? "",
      notifyType: e.type ?? "info",
    });
  });

  pi.on("extensionUiStatus", async (e: any) => {
    emitAgentEvent({
      type: "extension_ui_request",
      method: "setStatus",
      id: "status",
      statusKey: e.key ?? e.statusKey,
      statusText: e.text ?? e.statusText ?? "",
    });
  });

  pi.on("extensionUiWidget", async (e: any) => {
    emitAgentEvent({
      type: "extension_ui_request",
      method: "setWidget",
      id: "widget",
      widgetKey: e.key ?? e.widgetKey,
      widgetLines: e.lines ?? e.widgetLines ?? [],
    });
  });

  // Game mode: extensionUiGameFrame → raw RGBA pixel data stream
  // Sent as hex-encoded string to avoid binary WS compat issues
  pi.on("extensionUiGameFrame", async (e: any) => {
    if (e.data && e.width && e.height) {
      const frame = e.data as Uint8Array;
      emitAgentEvent({
        type: "game_frame",
        width: e.width,
        height: e.height,
        data: Buffer.from(frame.buffer).toString("hex"),
      });
    }
  });

  // Generic TUI render protocol: extensionUiRender → raw ANSI text
  // Throttled to ~10fps (DOOM game loop runs at 35+ which would flood the WS)
  let lastRenderBroadcast = 0;
  const RENDER_THROTTLE_MS = 100; // throttle to ~10fps
  // Any Pi extension can emit rendered terminal frames. Supports ANY TUI component.
  pi.on("extensionUiRender", async (e: any) => {
    const now = Date.now();
    if (now - lastRenderBroadcast < RENDER_THROTTLE_MS) return;
    lastRenderBroadcast = now;
    emitAgentEvent({
      type: "render",
      id: e.id,
      lines: e.lines,
      inputMode: e.inputMode ?? "none",
      title: e.title ?? "",
    });
  });


  pi.on("extensionUiSetTitle", async (e: any) => {
    emitAgentEvent({
      type: "extension_ui_request",
      method: "setTitle",
      id: "title",
      title: e.title ?? "",
    });
  });

  // ── Status ────────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    // ensures stop() is safe on reload
    wss = null;
    peerSock = null;
    mode = "stopped";
    // Auto-start the WS server. The whole purpose of loading this extension
    // is to expose the agent over LAN; making the user type /remote-control
    // every launch is just friction. If the port is already bound by another
    // pi on this host, start(pi) falls back to peer mode automatically.
    // Set PI_REMOTE_CONTROL_NO_AUTOSTART=1 to skip and use /remote-control manually.
    if (process.env.PI_REMOTE_CONTROL_NO_AUTOSTART !== "1") {
      try { start(pi); } catch { /* ignore */ }
    }
  });

  pi.on("session_shutdown", async () => {
    if (wss) { try { wss.close(); } catch { /* ignore */ } }
    if (peerSock) { try { peerSock.close(); } catch { /* ignore */ } }
    wss = null;
    peerSock = null;
    mode = "stopped";
  });
}
