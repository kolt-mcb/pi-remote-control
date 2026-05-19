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
import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8765;

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
  const url = `ws://${ip}:${DEFAULT_PORT}`;

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
    pi.sendMessage({
      customType: "remote",
      content: `active: ${url}  (host: ${SELF_AGENT_NAME})`,
      display: true,
    });
  });

  server.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Default new connection to client; promoted to peer on peer_hello.
    clientConns.add(ws);
    const inferredName = parseNameFromUrl(req.url, "viewer");
    console.log(`  [+] client connected (${clientConns.size} viewers, ${peerConns.size} peers) ${inferredName}`);

    hostBcastClients(JSON.stringify({ type: "connected", clients: clientConns.size }));
    hostBcastSessionList();

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
  const url = `ws://127.0.0.1:${DEFAULT_PORT}`;
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
      content: `already running: ws://${localIP()}:${DEFAULT_PORT}  (${clientConns.size} viewers, ${peerConns.size} peers)`,
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
      if (!msg) break;
      const target = (cmd.targetAgentId as string) || SELF_AGENT_ID;
      const deliverAs =
        cmd.type === "steer" ? "steer" : cmd.type === "follow_up" ? "followUp" : undefined;
      if (target === SELF_AGENT_ID) {
        if (deliverAs) pi.sendUserMessage(msg, { deliverAs });
        else pi.sendUserMessage(msg);
      } else {
        const peerWs = peerConns.get(target);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: "route_prompt", message: msg, deliverAs }));
        }
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
  }
}

// ── Peer: inbound from host ─────────────────────────────────────────────

function handlePeerInbound(msg: Record<string, unknown>, pi: ExtensionAPI): void {
  switch (msg.type as string) {
    case "route_prompt": {
      const text = msg.message as string;
      if (!text) break;
      const deliverAs = msg.deliverAs as "steer" | "followUp" | undefined;
      if (deliverAs) pi.sendUserMessage(text, { deliverAs });
      else pi.sendUserMessage(text);
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
    const content = Array.isArray(cr?.content)
      ? cr.content.map((c: any) => c.text ?? "").join("")
      : "";
    emitAgentEvent({
      type: "tool_end",
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? "",
      content,
      isError: e.isError ?? false,
    });
  });

  // ── Status ────────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    // ensures stop() is safe on reload
    wss = null;
    peerSock = null;
    mode = "stopped";
  });

  pi.on("session_shutdown", async () => {
    if (wss) { try { wss.close(); } catch { /* ignore */ } }
    if (peerSock) { try { peerSock.close(); } catch { /* ignore */ } }
    wss = null;
    peerSock = null;
    mode = "stopped";
  });
}
