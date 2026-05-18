/**
 * Pi Remote Control Extension
 *
 * Starts a WebSocket server inside pi so you can connect from your phone.
 * No separate server process needed.
 *
 * Usage:
 *   pi -e ~/pi-remote-control/extension.ts
 *
 * Then in pi:
 *   /remote-control   — starts the WS server
 *   /remote-stop      — stops it
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import os from "node:os";

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8765;

// ── State ───────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

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

function bcast(obj: Record<string, unknown>): void {
  const text = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === 1) c.send(text);
  }
}

// ── Server lifecycle ────────────────────────────────────────────────────

function start(pi: ExtensionAPI): void {
  if (wss) return;
  const ip = localIP();
  const url = `ws://${ip}:${DEFAULT_PORT}`;

  wss = new WebSocketServer({ port: DEFAULT_PORT, host: "0.0.0.0" });

  console.log(`\n┌─ Pi Remote Control ─────────────────────────┐`);
  console.log(`│  ${url}  │`);
  console.log(`└─────────────────────────────────────────────┘\n`);

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    console.log(`  [+] ${clients.size} clinet(s)`);
    bcast({ type: "connected", clients: clients.size });

    ws.on("message", (data: RawData) => {
      const text = data.toString();
      try {
        const cmd = JSON.parse(text) as Record<string, unknown>;
        handleCmd(cmd, pi);
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Bad JSON" }));
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`  [-] ${clients.size} client(s)`);
    });

    ws.on("error", () => clients.delete(ws));
  });

  pi.sendMessage({
    customType: "remote",
    content: `active: ${url}  (${clients.size} clients)`,
    display: true,
  });
}

function stop(pi: ExtensionAPI): void {
  if (!wss) return;
  wss.close();
  wss = null;
  pi.sendMessage({
    customType: "remote",
    content: "stopped",
    display: true,
  });
}

// ── Inbound commands from phone ─────────────────────────────────────────

function handleCmd(cmd: Record<string, unknown>, pi: ExtensionAPI): void {
  switch (cmd.type as string) {
    case "prompt": {
      const msg = cmd.message as string;
      if (msg) pi.sendUserMessage(msg);
      break;
    }
    case "steer": {
      const msg = cmd.message as string;
      if (msg) pi.sendUserMessage(msg, { deliverAs: "steer" });
      break;
    }
    case "follow_up": {
      const msg = cmd.message as string;
      if (msg) pi.sendUserMessage(msg, { deliverAs: "followUp" });
      break;
    }
    case "get_state": {
      bcast({
        type: "response",
        command: "get_state",
        success: true,
        data: { clients: clients.size, connected: clients.size > 0 },
      });
      break;
    }
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
    bcast({ type: "agent_start" });
  });

  pi.on("agent_end", async (e) => {
    bcast({
      type: "agent_end",
      messageCount: (e.messages ?? []).length,
    });
  });

  pi.on("turn_start", async (e) => {
    bcast({ type: "turn_start", turnIndex: e.turnIndex });
  });

  pi.on("turn_end", async (e) => {
    bcast({ type: "turn_end", turnIndex: e.turnIndex });
  });

  // ── Message events ────────────────────────────────────────────────────

  pi.on("message_start", async (e) => {
    const m = e.message;
    bcast({ type: "message_start", message: m });
  });

  pi.on("message_end", async (e) => {
    bcast({ type: "message_end", message: e.message });
  });

  // Need to grab the event type more carefully
  pi.on("message_update", async (e: any) => {
    const evt = e.assistantMessageEvent;
    if (!evt) return;
    switch (evt.type) {
      case "text_start":
        bcast({ type: "message_update", eventType: "text_start" });
        break;
      case "text_delta":
        bcast({
          type: "message_update",
          eventType: "text_delta",
          delta: evt.delta ?? "",
        });
        break;
      case "text_end":
        bcast({ type: "message_update", eventType: "text_end" });
        break;
      case "thinking_start":
        bcast({ type: "message_update", eventType: "thinking_start" });
        break;
      case "thinking_delta":
        bcast({
          type: "message_update",
          eventType: "thinking_delta",
          delta: evt.delta ?? "",
        });
        break;
      case "thinking_end":
        bcast({ type: "message_update", eventType: "thinking_end" });
        break;
      case "done":
        bcast({
          type: "message_update",
          eventType: "done",
          reason: (evt as any).reason ?? "",
        });
        break;
      case "error":
        bcast({
          type: "message_update",
          eventType: "error",
          message: (evt as any).message ?? "",
        });
        break;
    }
  });

  // ── Tool events ───────────────────────────────────────────────────────

  pi.on("tool_execution_start", async (e) => {
    bcast({
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
      bcast({
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
    bcast({
      type: "tool_end",
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? "",
      content,
      isError: e.isError ?? false,
    });
  });

  // ── Status ────────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    wss = null; // ensures stop() is safe on reload
  });

  pi.on("session_shutdown", async () => {
    wss?.close();
    wss = null;
  });
}
