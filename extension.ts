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
 *   /remote-qr        — display the QR code for the phone app (works anytime)
 *   /remote-stop      — stops it
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import os from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
// Local fork of pi-tui exposes selectListEvents/respondToSelectList so we can
// surface any SelectList-based selector (built-in or extension) to the phone.
// These are NOT in upstream pi; provide no-op stubs so the extension loads everywhere.
let selectListEvents: {
  on(event: "mount" | "dismiss", handler: (...args: any[]) => void): void;
} | null = null;
let respondToSelectList: ((id: string, value: any) => void) | null = null;
try {
  // @ts-ignore — only available in a local fork of pi-tui
  const tui = require("@earendil-works/pi-tui");
  if (tui.selectListEvents) selectListEvents = tui.selectListEvents;
  if (tui.respondToSelectList) respondToSelectList = tui.respondToSelectList;
} catch {}
if (!selectListEvents) {
  // No-op emitter — the mount/dismiss listeners below become no-ops
  selectListEvents = { on: () => {} };
}
if (!respondToSelectList) {
  respondToSelectList = () => {};
}
// BUILTIN_SLASH_COMMANDS used to match supported remote commands (/compact, /quit).
// The message/tool components are pi's own interactive-mode renderers — we
// re-render them headless at the phone's width so the app shows *exactly*
// what the terminal shows (markdown, syntax highlighting, diffs, theming).
import {
  AssistantMessageComponent,
  BUILTIN_SLASH_COMMANDS,
  SessionManager,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import qrcodeTerminal from "qrcode-terminal";

// ── Config ──────────────────────────────────────────────────────────────

// Override with PI_REMOTE_PORT (isolated test hosts, multiple hosts per box).
const DEFAULT_PORT = Number(process.env.PI_REMOTE_PORT) || 8765;

// Shared-secret auth. Every WS connection must carry `?token=...`; mismatches
// are closed with code 4001. Token resolution, in order:
//   1. PI_REMOTE_TOKEN env var (explicit override).
//   2. ~/.pi/agent/pi-remote-control.token if it exists (persistent).
//   3. Auto-generate a fresh 32-hex-char token, write it to (2) for the next
//      launch, and use it now.
//   4. Disabled only if PI_REMOTE_CONTROL_NO_AUTH=1 — opt-out for users who
//      explicitly want the old LAN-trust behaviour and accept the risk.
//
// Sets `AUTH_TOKEN_SOURCE` to label what happened so the startup banner can
// be honest about it.
type TokenSource = "env" | "file" | "generated" | "disabled";
function resolveToken(): { token: string; source: TokenSource; tokenFile: string } {
  const tokenFile = path.join(
    process.env.HOME || ".",
    ".pi", "agent", "pi-remote-control.token",
  );
  if (process.env.PI_REMOTE_CONTROL_NO_AUTH === "1") {
    return { token: "", source: "disabled", tokenFile };
  }
  const fromEnv = process.env.PI_REMOTE_TOKEN ?? "";
  if (fromEnv) return { token: fromEnv, source: "env", tokenFile };
  try {
    if (fs.existsSync(tokenFile)) {
      const t = fs.readFileSync(tokenFile, "utf8").trim();
      if (t) return { token: t, source: "file", tokenFile };
    }
  } catch (e: any) {
    console.warn(`pi-remote-control: failed to read ${tokenFile}: ${e?.message ?? e}`);
  }
  // Generate a fresh token and try to persist it. 32 hex chars = 128 bits.
  const t = randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, t + "\n", { mode: 0o600 });
  } catch (e: any) {
    console.warn(`pi-remote-control: couldn't persist token to ${tokenFile}: ${e?.message ?? e} — will regenerate next launch`);
  }
  return { token: t, source: "generated", tokenFile };
}
const { token: AUTH_TOKEN, source: AUTH_TOKEN_SOURCE, tokenFile: AUTH_TOKEN_FILE } = resolveToken();

// TLS cert + key. The WS server runs as `wss://` with a self-signed cert that's
// generated on first launch and persisted alongside the token. The cert's
// SHA-256 fingerprint is embedded in the printed URL + QR; the phone pins that
// fingerprint at scan time and refuses any other cert. TOFU-style — no public
// CA, no hostname matching needed (we connect by IP). Rotate by deleting the
// .crt and .key files and restarting pi: a fresh cert is minted and the next
// QR carries its new fingerprint.
const CERT_FILE = path.join(process.env.HOME || ".", ".pi", "agent", "pi-remote-control.crt");
const KEY_FILE  = path.join(process.env.HOME || ".", ".pi", "agent", "pi-remote-control.key");

type TlsSource = "loaded" | "generated";
// `selfsigned.generate` is async in v5+ (returns a Promise) — must await.
async function resolveTlsCert(): Promise<{ cert: string; key: string; source: TlsSource }> {
  try {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      const cert = fs.readFileSync(CERT_FILE, "utf8");
      const key  = fs.readFileSync(KEY_FILE, "utf8");
      if (cert.includes("BEGIN CERTIFICATE") && key.includes("BEGIN")) {
        return { cert, key, source: "loaded" };
      }
    }
  } catch (e: any) {
    console.warn(`pi-remote-control: failed to read TLS cert/key (${e?.message ?? e}) — regenerating`);
  }
  // Long-dated self-signed cert. Expiry is mostly cosmetic for a TOFU
  // fingerprint-pinned cert; if it ever does expire, deleting the files and
  // restarting pi mints a new one.
  const pems: any = await selfsigned.generate(
    [{ name: "commonName", value: "pi-remote-control" }],
    { keySize: 2048, days: 36500, algorithm: "sha256" },
  );
  // selfsigned v5 returns { cert, private, public, fingerprint } — match either name
  // for `key` defensively in case minor versions wobble.
  const certPem: string | undefined = pems?.cert;
  const keyPem:  string | undefined = pems?.private ?? pems?.key;
  if (!certPem || !keyPem) {
    throw new Error(`selfsigned.generate returned an unexpected shape: keys=${Object.keys(pems ?? {}).join(",")}`);
  }
  try {
    fs.mkdirSync(path.dirname(CERT_FILE), { recursive: true });
    fs.writeFileSync(CERT_FILE, certPem, { mode: 0o600 });
    fs.writeFileSync(KEY_FILE,  keyPem,  { mode: 0o600 });
  } catch (e: any) {
    console.warn(`pi-remote-control: couldn't persist TLS cert/key to ${path.dirname(CERT_FILE)}: ${e?.message ?? e}`);
  }
  return { cert: certPem, key: keyPem, source: "generated" };
}

// Top-level await: pi loads extensions as ESM (package.json type=module), so
// blocking module init on cert generation is fine and keeps every downstream
// call (urlWithToken, startHost, etc.) plain synchronous.
const TLS = await resolveTlsCert();
// SHA-256 of the DER (binary) form of the cert. Hex, lowercase, 64 chars.
const TLS_FINGERPRINT = createHash("sha256")
  .update(Buffer.from(
    TLS.cert
      .replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\s+/g, ""),
    "base64",
  ))
  .digest("hex");

function authOk(provided: string): boolean {
  if (!AUTH_TOKEN) return true;
  // Length mismatch can't be timing-safe and isn't a meaningful secret; bail early.
  if (provided.length !== AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(AUTH_TOKEN));
}

// Build the connect URL: appends ?token=... (when auth is on) and the cert
// fingerprint ?fp=<sha256>. The phone pins by fp; the token gates connection
// auth on top. With NO_AUTH=1, fp is still attached so the channel can be
// encrypted even without authn.
function urlWithToken(base: string): string {
  const params: string[] = [];
  if (AUTH_TOKEN) params.push(`token=${encodeURIComponent(AUTH_TOKEN)}`);
  params.push(`fp=${TLS_FINGERPRINT}`);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${params.join("&")}`;
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
  pid?: number;
  // pi session file id; changes when the session is replaced (/new, /resume),
  // so the phone can tell "fresh session" from "reconnected to the same one".
  sessionId?: string;
}

// ── State ───────────────────────────────────────────────────────────────

// This pi's stable identity for the lifetime of the PROCESS — stored on
// globalThis so it survives extension reloads (e.g. /new replaces the session
// and re-imports this module). Without this, every /new would mint a new id,
// the phone's selected-session would go stale, and its commands would be
// dropped by the `target !== SELF_AGENT_ID` guard.
const SELF_AGENT_ID: string =
  ((globalThis as any).__piRemoteSelfId ??= randomUUID().slice(0, 8));
const SELF_AGENT_NAME = `Pi-${SELF_AGENT_ID.slice(0, 4)}`;

type Mode = "stopped" | "host" | "peer";
let mode: Mode = "stopped";

// Host-mode state. The transport — WebSocket server + live connections + agent
// registry — lives on globalThis so it SURVIVES extension reloads. A session
// replacement (/new, /resume) re-imports this module with a fresh instance; by
// keeping the same server and sockets, the phone stays connected instead of
// disconnecting and racing a reconnect through the rebind gap. Client message
// handlers route to `currentPi`, which each freshly-loaded instance updates.
interface RCTransport {
  wss: WebSocketServer | null;
  httpsServer: https.Server | null;
  clientConns: Set<WebSocket>;
  peerConns: Map<string, WebSocket>;
  wsToPeerId: WeakMap<WebSocket, string>;
  peerPids: Map<string, number>;
  agents: Map<string, AgentSession>;
  currentPi: ExtensionAPI | null;
}
const RC: RCTransport = ((globalThis as any).__piRemoteTransport ??= {
  wss: null,
  httpsServer: null,
  clientConns: new Set<WebSocket>(),
  peerConns: new Map<string, WebSocket>(),
  wsToPeerId: new WeakMap<WebSocket, string>(),
  peerPids: new Map<string, number>(),
  agents: new Map<string, AgentSession>(),
  currentPi: null,
});
// Module-level aliases into the persistent collections (only ever mutated, never
// reassigned — so these references stay valid and shared across reloads).
const clientConns = RC.clientConns; // Android viewers only
const peerConns = RC.peerConns; // peer agentId -> ws
const wsToPeerId = RC.wsToPeerId;
const peerPids = RC.peerPids; // peer agentId -> pid (for killing)
const agents = RC.agents; // includes self + peers

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
   * Deliver a downloadable file to all connected Android clients (save/share
   * sheet on the device). Pass base64 `data` directly, or a `path` to read.
   * 20MB cap. Any extension can call this; pair with a small tool to let the
   * model send artifacts to the phone.
   */
  sendFile: (file: { name?: string; mimeType?: string; data?: string; path?: string }) => {
    let data = file.data;
    let name = file.name;
    if (!data && file.path) {
      const buf = fs.readFileSync(file.path);
      if (buf.length > 20 * 1024 * 1024) throw new Error("sendFile: file exceeds 20MB cap");
      data = buf.toString("base64");
      name ||= path.basename(file.path);
    }
    if (!data) throw new Error("sendFile: provide data (base64) or path");
    if (Buffer.byteLength(data, "base64") > 20 * 1024 * 1024) throw new Error("sendFile: file exceeds 20MB cap");
    hostBcastClients(JSON.stringify({
      type: "file",
      name: name || "download.bin",
      mimeType: file.mimeType ?? "application/octet-stream",
      data,
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

// Phone-native /model picker. pi's /model opens ModelSelectorComponent — a
// custom fuzzy-search Container, NOT a SelectList — so the SelectList bridge
// never sees it and the phone gets nothing. Enumerate the registry directly
// and reuse the existing select-dialog protocol instead.
const pendingModelPicks = new Map<string, Map<string, any>>();

function showModelPicker(pi: ExtensionAPI): void {
  void safeCtx(pi, "/model", async (ctx: any) => {
    const models: any[] = ctx.modelRegistry?.getAvailable?.() ?? [];
    if (models.length === 0) {
      hostBcastClients(JSON.stringify({
        type: "extension_ui_request",
        method: "notify",
        id: `notify_model_${Date.now()}`,
        message: "No models with configured auth available.",
        notifyType: "warning",
      }));
      return;
    }
    const current = ctx.model;
    const id = `modelpick_${Date.now()}`;
    const byLabel = new Map<string, any>();
    const options: string[] = [];
    for (const m of models) {
      const isCurrent = current && m.provider === current.provider && m.id === current.id;
      const label = `${isCurrent ? "● " : ""}${m.provider}/${m.id}`;
      byLabel.set(label, m);
      options.push(label);
    }
    pendingModelPicks.set(id, byLabel);
    hostBcastClients(JSON.stringify({
      type: "extension_ui_request",
      method: "select",
      id,
      title: "Select model",
      options,
    }));
  });
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

// Draw a banner box that sizes itself to its content. The old fixed-width
// borders (47 cols) didn't account for the URL+token in the body, so the
// content row's closing `│` floated far past the top/bottom corners and the
// box never closed. Computing the width from the longest line keeps every
// border aligned no matter how long the URL or agent name is.
function box(title: string, lines: string[]): string[] {
  const pad = 2; // inner spaces on each side of the content
  const titleRun = title.length + 3; // "─ " + title + " "
  const inner = Math.max(titleRun, ...lines.map((l) => l.length + pad * 2));
  const top = `┌─ ${title} ${"─".repeat(inner - titleRun)}┐`;
  const body = lines.map((l) => `│${" ".repeat(pad)}${l.padEnd(inner - pad * 2)}${" ".repeat(pad)}│`);
  const bottom = `└${"─".repeat(inner)}┘`;
  return [top, ...body, bottom];
}

// The label the app shows for this session. Mirrors pi's /resume list:
// an explicit /name, else the first user message, else the agent's short id.
let selfTitle = SELF_AGENT_NAME;
// Live session manager, captured from the first ctx we see, so upsertSelfAgent
// can refresh the title on every broadcast (not just after an agent turn).
let selfSm: any = null;
// Interactive UI context (footer/status bar, theme), captured at session_start;
// null when this pi has no TTY (RPC/print mode). We surface host/peer state here
// via setStatus — a footer chip below the chat, like other pi extensions — rather
// than console.log lines, which pi renders into the conversation itself.
let selfUi: any = null;
const REMOTE_STATUS_KEY = "remote-control";
function setRemoteStatus(text: string | undefined): void {
  try { selfUi?.setStatus(REMOTE_STATUS_KEY, text); } catch { /* ignore */ }
}
// Recompute the footer chip from the current mode. Called on every transition
// (and on session_start, so a re-imported session re-shows it on the new footer).
function refreshRemoteStatus(): void {
  let text: string | undefined;
  if (mode === "host") text = "remote · host";
  else if (mode === "peer") text = peerSock ? `remote · peer ${SELF_AGENT_NAME}` : "remote · connecting…";
  setRemoteStatus(text); // undefined when stopped → clears the chip
}

// ── Screen mirror ────────────────────────────────────────────────────────
// Ships the TUI's composed frames (fork hook: tui.onFrame) to subscribed
// clients and routes their keys/taps back via tui.injectInput. Categorical:
// any surface that renders in the terminal renders on the phone, including
// overlays, widgets, and SGR mouse clickables. Host pi only (v1).

// Mirror frame cadence (~15fps). The phone-width render is the expensive part
// (it thrashes pi's width-keyed markdown cache, forcing the desktop to
// re-render), so we CAP it here and decouple it from desktop renders — a fast
// desktop render must never trigger a phone render inline, or scrolling janks.
const MIRROR_FRAME_MS = 66;
// Backpressure ceiling: if a client socket already has this many bytes queued
// (slow link — LTE/VPN), skip its frame this tick instead of piling on. The app
// only renders the latest frame anyway, so a skip just means it gets a newer one
// next tick. Without this, frames queue faster than the link drains and the user
// watches a growing backlog of stale frames.
const MIRROR_MAX_BUFFERED = 256 * 1024;
// The phone-width render (renderMirrorNow) is a second, synchronous full render
// at a DIFFERENT width than the desktop terminal. It both thrashes pi's
// width-keyed markdown cache (so the desktop's next render is a cache miss) and
// blocks Node's single thread for its whole duration. Running it ~15×/s while
// the user scrolls the desktop is what makes desktop scrolling crawl. So: defer
// the phone render while the desktop is actively rendering (scrolling), and only
// render once the desktop has been quiet for DESKTOP_QUIET_MS — unless the mirror
// has gone stale longer than MAX_DEFER_MS, so a continuously-busy desktop (e.g. a
// running spinner) still lets the phone update, just at a lower rate.
//
// QUIET_MS is deliberately BELOW a typical spinner interval (~80ms): a scroll
// fires desktop renders every few ms (gaps < QUIET → deferred), while a spinner
// leaves ~80ms gaps (> QUIET → still renders), so steady agent work isn't throttled
// but active scrolling is.
const MIRROR_DESKTOP_QUIET_MS = 50;
const MIRROR_MAX_DEFER_MS = 500;
// Set PI_REMOTE_DEBUG=1 to log mirror throughput (KiB/s, fps, dropped frames).
const MIRROR_DEBUG = process.env.PI_REMOTE_DEBUG === "1";
let mirrorTui: any = null;          // live TUI instance, captured via widget probe
let lastMirrorFrame: any = null;
let mirrorSeq = 0;
let mirrorDirty = false;            // a desktop render happened; mirror needs refresh
let mirrorPump: NodeJS.Timeout | null = null;
let lastDesktopRenderAt = 0;        // stamp of the most recent desktop doRender
let lastMirrorSentAt = 0;           // stamp of the most recent phone frame sent
// Debug throughput accounting (1s window), only used when MIRROR_DEBUG.
let mirrorDbgBytes = 0, mirrorDbgFrames = 0, mirrorDbgDropped = 0, mirrorDbgAt = 0;
function mirrorDebugAccount(bytes: number): void {
  if (!MIRROR_DEBUG) return;
  mirrorDbgBytes += bytes;
  mirrorDbgFrames++;
  const now = Date.now();
  if (now - mirrorDbgAt >= 1000) {
    console.log(`  [mirror] ${(mirrorDbgBytes / 1024).toFixed(1)} KiB/s · ${mirrorDbgFrames} fps · ${mirrorDbgDropped} dropped(backpressure)`);
    mirrorDbgBytes = 0; mirrorDbgFrames = 0; mirrorDbgDropped = 0; mirrorDbgAt = now;
  }
}
// Peer mode: the host asked us to stream our screen upstream (route_mirror).
let peerMirrorOn = false;

// Per-client mirror target (ws -> agentId). Lives on the persistent transport
// object so a session reload (/new, /resume) keeps phones mirroring seamlessly.
function mirrorTargets(): Map<WebSocket, string> {
  return ((RC as any).mirrorTargets ??= new Map<WebSocket, string>());
}

// Per-client capabilities, learned from the `client_hello` it sends on connect.
// `mirrorOnly` clients (the Android app) render the screen mirror and never the
// message-list scrollback, so we skip the (large, twice-sent) history replay for
// them — it was the bulk of connect latency. Old clients send no hello and keep
// getting history via the fallback timer below.
function clientCaps(): Map<WebSocket, { mirrorOnly: boolean; diff: boolean }> {
  return ((RC as any).clientCaps ??= new Map<WebSocket, { mirrorOnly: boolean; diff: boolean }>());
}
// Pending history-replay timers, so a `client_hello` can cancel the deferred
// send before it fires (and so we can clear it on disconnect).
function pendingHistory(): Map<WebSocket, NodeJS.Timeout> {
  return ((RC as any).pendingHistory ??= new Map<WebSocket, NodeJS.Timeout>());
}

// Last mirror frame actually SENT to each client, for row-level diffing. Stored
// per-client (not globally) because the backpressure gate drops frames for slow
// clients independently, so each client's diff base is whatever it last received.
function mirrorClientState(): Map<WebSocket, { lines: string[]; width: number; height: number }> {
  return ((RC as any).mirrorClientState ??= new Map<WebSocket, { lines: string[]; width: number; height: number }>());
}
// Changed rows between two frames: [{ i, t }] for every index whose text differs
// (including new trailing rows). Removed trailing rows are conveyed by lineCount.
function diffRows(oldLines: string[], newLines: string[]): Array<{ i: number; t: string }> {
  const rows: Array<{ i: number; t: string }> = [];
  for (let i = 0; i < newLines.length; i++) {
    if (oldLines[i] !== newLines[i]) rows.push({ i, t: newLines[i] });
  }
  return rows;
}

// Produce a phone-width frame into lastMirrorFrame. This is the costly call (a
// second full render at a different width); only the pump and the immediate
// on-subscribe snapshot invoke it. Uses runtime-reachable private members
// (render/compositeOverlays/extractCursorPosition/applyLineResets/overlayStack).
function renderMirrorNow(): boolean {
  const tui = mirrorTui;
  if (!tui) return false;
  try {
    const termCols = tui.terminal?.columns ?? 80;
    const height = tui.terminal?.rows ?? 24;
    const width = clientCols > 0 ? clientCols : termCols;
    let lines = tui.render(width);
    if (tui.overlayStack?.length > 0) lines = tui.compositeOverlays(lines, width, height);
    const cursor = tui.extractCursorPosition(lines, height);
    lines = tui.applyLineResets(lines);
    mirrorSeq++;
    lastMirrorFrame = { lines, cursor, width, height };
    return true;
  } catch {
    return false; // never let mirror capture break anything
  }
}

// The pump: at most one phone-width render per MIRROR_FRAME_MS, and only when
// something changed and someone is watching. This is what keeps desktop
// scrolling smooth — doRender just flags dirty and returns.
function ensureMirrorPump(): void {
  if (mirrorPump) return;
  mirrorPump = setInterval(() => {
    if (!mirrorDirty || !selfHasMirrorAudience()) return;
    const now = Date.now();
    // The scroll-pause and desktop-render defer below exist to protect a HUMAN at
    // the host's interactive terminal. A peer process has no interactive terminal,
    // so it must stream every frame without deferring — deferring there was
    // freezing peer mirrors. Only the host applies these.
    if (mode === "host") {
      // While the desktop user is scrolled back into history, skip the phone
      // render ENTIRELY. pi-tui scrolls by shifting a cached slice (cheap); our
      // renderMirrorNow() does a full phone-width re-compose that pi-tui itself
      // flags as O(session length) "would make scrolling crawl" — running it
      // ~15×/s fights the scroll for the event loop and thrashes the cache.
      if (((mirrorTui as any)?.scrollSliceStart ?? -1) >= 0) return;
      // Otherwise, hold off the cache-thrashing phone render while the desktop is
      // actively rendering — unless the mirror has been stale too long. Leave
      // mirrorDirty set so the next tick (after the desktop quiets) picks it up.
      const desktopActive = now - lastDesktopRenderAt < MIRROR_DESKTOP_QUIET_MS;
      const staleFor = now - lastMirrorSentAt;
      if (desktopActive && staleFor < MIRROR_MAX_DEFER_MS) return;
    }
    mirrorDirty = false;
    if (renderMirrorNow()) { sendMirrorFrame(); lastMirrorSentAt = now; }
  }, MIRROR_FRAME_MS);
  mirrorPump.unref?.();
}

// Capture composed frames WITHOUT any fork hook: wrap the TUI's private
// doRender (TS `private` is compile-time only, so it's reachable at runtime).
// The hot path stays cheap — it only marks the mirror dirty; the throttled pump
// does the actual phone-width render off the desktop render path.
function attachMirror(tui: any): void {
  if (!tui || mirrorTui === tui) return;
  mirrorTui = tui;
  ensureMirrorPump();
  if (tui.__rcMirrorPatched) return;
  tui.__rcMirrorPatched = true;

  const origDoRender = tui.doRender?.bind(tui);
  if (typeof origDoRender !== "function") return; // unexpected build; mirror stays off

  tui.doRender = () => {
    origDoRender(); // desktop render exactly as before — no extra work inline
    if (selfHasMirrorAudience()) {
      mirrorDirty = true;
      lastDesktopRenderAt = Date.now(); // so the pump can defer during active scroll
    }
  };
}

// Mark the mirror for a refresh on the next pump tick (width/audience changes).
function requestMirrorFrame(): void {
  mirrorDirty = true;
}

// Inject keys/taps through the TUI's private input path (runtime-reachable).
function injectMirrorInput(data: string): void {
  try { mirrorTui?.handleInput?.(data); } catch { /* never crash on remote input */ }
}

function mirrorFramePayload(): Record<string, unknown> {
  return {
    type: "mirror_frame",
    seq: mirrorSeq,
    lines: lastMirrorFrame.lines,
    cursor: lastMirrorFrame.cursor,
    width: lastMirrorFrame.width,
    height: lastMirrorFrame.height,
  };
}

/** Full-frame (keyframe) payload string for a self-agent client. */
function fullFramePayload(): string {
  return JSON.stringify({ ...mirrorFramePayload(), agentId: SELF_AGENT_ID });
}

/** Send the current frame to one client as a row-diff (when it supports diffs and
 *  we hold a same-geometry base for it) or a full keyframe, then record what it
 *  received so the next diff is computed against exactly that. A frame skipped by
 *  backpressure must NOT call this, so its base stays at the last frame it got. */
function sendFrameToClient(ws: WebSocket): void {
  const f = lastMirrorFrame;
  const caps = clientCaps().get(ws);
  const prev = mirrorClientState().get(ws);
  const canDiff = !!caps?.diff && !!prev && prev.width === f.width && prev.height === f.height;
  const payload = canDiff
    ? JSON.stringify({
        type: "mirror_diff",
        agentId: SELF_AGENT_ID,
        seq: mirrorSeq,
        rows: diffRows(prev!.lines, f.lines),
        lineCount: f.lines.length,
        cursor: f.cursor,
        width: f.width,
        height: f.height,
      })
    : fullFramePayload();
  ws.send(payload);
  // Copy the lines: the stored base must not alias an array the renderer might
  // reuse/mutate next frame, or diffs would come out empty.
  mirrorClientState().set(ws, { lines: f.lines.slice(), width: f.width, height: f.height });
  mirrorDebugAccount(payload.length);
}

/** Send OUR screen: to clients mirroring us (host mode) or upstream (peer mode). */
function sendMirrorFrame(only?: WebSocket): void {
  if (!lastMirrorFrame && !renderMirrorNow()) return; // ensure a frame exists
  if (mode === "peer") {
    if (peerMirrorOn && peerSock?.readyState === 1) {
      peerSock.send(JSON.stringify({ type: "peer_event", agentId: SELF_AGENT_ID, payload: mirrorFramePayload() }));
    }
    return;
  }
  if (only) {
    // On-subscribe snapshot: always a full keyframe so a new viewer isn't blank.
    if (only.readyState === 1) {
      const p = fullFramePayload();
      only.send(p);
      mirrorClientState().set(only, { lines: lastMirrorFrame.lines.slice(), width: lastMirrorFrame.width, height: lastMirrorFrame.height });
      mirrorDebugAccount(p.length);
    }
    return;
  }
  for (const [ws, target] of mirrorTargets()) {
    if (target !== SELF_AGENT_ID || ws.readyState !== 1) continue;
    // Backpressure: skip this client's frame if its send buffer is backed up.
    if (((ws as any).bufferedAmount ?? 0) > MIRROR_MAX_BUFFERED) { mirrorDbgDropped++; continue; }
    sendFrameToClient(ws);
  }
}

function selfHasMirrorAudience(): boolean {
  if (mode === "peer") return peerMirrorOn;
  for (const target of mirrorTargets().values()) {
    if (target === SELF_AGENT_ID) return true;
  }
  return false;
}

/** Host: a client stopped mirroring `agentId` — tell the peer if nobody else watches. */
function maybeStopPeerMirror(agentId: string): void {
  if (agentId === SELF_AGENT_ID) return;
  for (const target of mirrorTargets().values()) {
    if (target === agentId) return;
  }
  const peerWs = peerConns.get(agentId);
  if (peerWs?.readyState === 1) peerWs.send(JSON.stringify({ type: "route_mirror", on: false }));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? (p.text ?? "") : ""))
      .join("")
      .trim();
  }
  return "";
}

// Same precedence pi uses for SessionInfo.name in the /resume selector.
function computeSelfTitle(sm: any): string {
  try {
    const name = sm?.getSessionName?.()?.trim();
    if (name) return name;
    for (const e of sm?.getEntries?.() ?? []) {
      if (e?.type !== "message" || e.message?.role !== "user") continue;
      const text = textFromContent(e.message?.content);
      if (text) return (text.split("\n").find((l: string) => l.trim()) ?? text).trim().slice(0, 60);
    }
  } catch (e: any) {
    console.warn(`pi-remote-control: computeSelfTitle failed: ${e?.message ?? e}`);
  }
  return SELF_AGENT_NAME;
}

function upsertSelfAgent(): void {
  const existing = agents.get(SELF_AGENT_ID);
  const now = Date.now();
  if (selfSm) selfTitle = computeSelfTitle(selfSm);
  agents.set(SELF_AGENT_ID, {
    id: SELF_AGENT_ID,
    name: selfTitle,
    kind: "self",
    status: nowSelfStatus(),
    connectedAt: existing?.connectedAt ?? now,
    lastActivity: now,
    messageCount: localMessageCount,
    turnIndex: localTurnIndex,
    pid: process.pid,
    sessionId: (() => { try { return selfSm?.getSessionId?.(); } catch { return undefined; } })(),
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

// ── Theme sync ────────────────────────────────────────────────────────────
// The phone mirrors the host Pi's active theme. Pi's Theme object only exposes
// per-role colors as ANSI escapes (the page background isn't a theme color —
// the terminal uses its own bg), so we decode those escapes back to hex and let
// the phone pick a light/dark base palette for the surfaces we can't read. Role
// names line up 1:1 with the phone's palette parser, so no key remapping needed.
const THEME_FG_KEYS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "userMessageText", "toolTitle",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
  "mdQuote", "mdQuoteBorder", "mdListBullet",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxNumber",
  "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingLow", "thinkingMedium", "thinkingHigh",
] as const;
const THEME_BG_KEYS = [
  "selectedBg", "userMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

// xterm-256 index → hex (mirrors pi's own ansi256ToHex so 256-color themes match).
function ansi256ToHex(index: number): string {
  const basic = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  if (index < 16) return basic[index];
  if (index < 232) {
    const c = index - 16;
    const conv = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
    return `#${conv(Math.floor(c / 36))}${conv(Math.floor((c % 36) / 6))}${conv(c % 6)}`;
  }
  const g = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${g}${g}${g}`;
}

// Decode an SGR color escape (truecolor or 256) back to hex.
// Returns undefined for the default-color escapes (\x1b[39m / \x1b[49m).
function ansiColorToHex(seq: string): string | undefined {
  if (!seq) return undefined;
  const tc = seq.match(/\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (tc) {
    const hx = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return `#${hx(tc[1])}${hx(tc[2])}${hx(tc[3])}`;
  }
  const c256 = seq.match(/\[(?:38|48);5;(\d+)m/);
  if (c256) return ansi256ToHex(parseInt(c256[1], 10));
  return undefined;
}

function themeToColors(theme: Theme): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of THEME_FG_KEYS) {
    try {
      const hex = ansiColorToHex(theme.getFgAnsi(key));
      if (hex) colors[key] = hex;
    } catch { /* role not defined in this theme */ }
  }
  for (const key of THEME_BG_KEYS) {
    try {
      const hex = ansiColorToHex(theme.getBgAnsi(key));
      if (hex) colors[key] = hex;
    } catch { /* role not defined in this theme */ }
  }
  return colors;
}

// Last theme broadcast, cached so a fresh connection can be told immediately —
// the connection handler has no ExtensionContext to read the live theme from.
let lastThemePayload: string | null = null;
let lastThemeName: string | undefined;

// Perceived luminance (0-255) of a #rrggbb string.
function brightness(hex: string): number {
  const m = hex.replace("#", "");
  if (m.length !== 6) return 0;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Decide light vs dark from the theme's own background tones, not its name —
// names lie: "Twilight" and "Front End Delight" are dark themes that contain
// the substring "light". Pi's page bg isn't a theme role, but the accent
// backgrounds track it. Fall back to a word-boundary name check if none exist.
function themeIsLight(colors: Record<string, string>, name: string): boolean {
  const bgKeys = ["userMessageBg", "selectedBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
  const samples = bgKeys.map((k) => colors[k]).filter((v): v is string => !!v);
  if (samples.length > 0) {
    const avg = samples.reduce((sum, hex) => sum + brightness(hex), 0) / samples.length;
    return avg > 128;
  }
  return /\blight\b/i.test(name) && !/\bdark\b/i.test(name);
}

function buildThemePayload(theme: Theme): string {
  const name = theme.name ?? "";
  const colors = themeToColors(theme);
  return JSON.stringify({
    type: "theme_info",
    theme: { name, isLight: themeIsLight(colors, name), colors },
  });
}

// Capture the live theme from an event context; re-broadcast when it changes.
function syncTheme(theme: Theme | undefined): void {
  if (!theme) return;
  try {
    lastThemePayload = buildThemePayload(theme);
    if (theme.name !== lastThemeName) {
      lastThemeName = theme.name;
      hostBcastClients(lastThemePayload);
    }
  } catch { /* theme sync is best-effort */ }
}

function sendCurrentTheme(ws: WebSocket): void {
  if (ws.readyState === 1 && lastThemePayload) ws.send(lastThemePayload);
}

// ── Remote slash-command support ────────────────────────────────────────
// The phone can run any built-in slash command on the host via the command
// context's executeInputLine() (added by our pi fork): it drives pi's editor
// submit path, so selector commands (/model, /settings, /tree, …) open their
// selectors — which surface on the phone through the SelectList bridge — while
// output commands (/copy, /export, /share) run on the host machine.
//
// /reload would tear down and rebind the extension runtime, which would
// invalidate the command-context the call runs in, so route it to a notice
// for now. /resume gets its own in-extension text render-frame picker (see
// showResumePicker) and is intentionally NOT in this set.
const REMOTE_STALES = new Set(["reload"]);

// All built-ins are offered to the phone so the menu mirrors pi's own.
function buildCommandList(): { name: string; description: string }[] {
  return BUILTIN_SLASH_COMMANDS.map((b) => ({ name: b.name, description: b.description }));
}

function sendCommandList(ws: WebSocket): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "command_list", commands: buildCommandList() }));
}

// ── Conversation history replay ─────────────────────────────────────────────
// On (re)connect the phone only sees events from that point forward — anything
// said before it joined (including a whole conversation started in the
// terminal, or one another device drove) is invisible until the next turn.
// We replay the resolved session here: walk buildSessionContext().messages and
// ship a flat list of already-shaped bubbles the app can render verbatim. The
// app treats this as authoritative and replaces its message list, so a reconnect
// repaints the full thread without duplicating live events.
const HISTORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// Plain-text portion of a pi message's content (array of typed blocks, or a
// legacy plain string). Mirrors the app's extractText / message_end handling.
function historyBlocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => (typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

// Image attachments from a content array, capped like the live forwarding path.
function historyImages(content: unknown): Array<{ data: string; mimeType: string }> {
  const out: Array<{ data: string; mimeType: string }> = [];
  if (!Array.isArray(content)) return out;
  for (const block of content as any[]) {
    if (block?.type === "image" && block?.data) {
      const data = typeof block.data === "string" ? block.data : JSON.stringify(block.data);
      if (Buffer.byteLength(data, "base64") <= HISTORY_IMAGE_MAX_BYTES) {
        out.push({ data, mimeType: block.mimeType || "image/png" });
      }
    }
  }
  return out;
}

// Turn one pi AgentMessage into zero or more renderable history items, pushed
// onto [items] in conversation order. [toolIdx] maps a toolCallId to the index
// of its (already-positioned) tool bubble so a later toolResult fills it in.
function pushHistoryMessage(
  m: any,
  items: Record<string, unknown>[],
  toolIdx: Map<string, number>,
  theme: unknown,
): void {
  const role = m?.role;
  if (role === "user") {
    const text = historyBlocksText(m.content);
    const images = historyImages(m.content);
    if (text || images.length) {
      const item: Record<string, unknown> = { role: "user", content: text };
      const { stream, overflow } = withImageLines(renderUserStream(text), images);
      if (stream) item.stream = stream;
      if (overflow.length) item.images = overflow;
      items.push(item);
    }
  } else if (role === "assistant") {
    const blocks = Array.isArray(m.content) ? m.content : [];
    let textAcc = "";
    const flushText = () => {
      if (textAcc.trim()) {
        const item: Record<string, unknown> = { role: "assistant", content: textAcc };
        const stream = renderAssistantStream(textAcc);
        if (stream) item.stream = stream;
        items.push(item);
      }
      textAcc = "";
    };
    for (const b of blocks as any[]) {
      if (b?.type === "text") {
        textAcc += typeof b.text === "string" ? b.text : "";
      } else if (b?.type === "thinking") {
        flushText();
        const t = typeof b.thinking === "string" ? b.thinking : "";
        if (t.trim()) {
          const item: Record<string, unknown> = { role: "thinking", content: t };
          const stream = renderThinkingStream(t);
          if (stream) item.stream = stream;
          items.push(item);
        }
      } else if (b?.type === "toolCall") {
        flushText();
        const toolName = typeof b.name === "string" ? b.name : "?";
        let toolArgs = "";
        try { toolArgs = JSON.stringify(b.arguments ?? {}); } catch { toolArgs = "{}"; }
        if (typeof b.id === "string") toolIdx.set(b.id, items.length);
        const item: Record<string, unknown> = {
          role: "tool",
          toolCallId: typeof b.id === "string" ? b.id : "",
          toolName,
          toolArgs,
          content: "",
          isError: false,
          // Raw args stashed for the toolResult patch to re-render with the
          // result attached; stripped by sendHistory before the frame ships.
          __args: b.arguments ?? {},
        };
        const { stream, streamExpanded } = renderToolStreams(toolName, item.toolCallId as string, b.arguments ?? {});
        if (stream) item.stream = stream;
        if (streamExpanded) item.streamExpanded = streamExpanded;
        items.push(item);
      }
    }
    flushText();
  } else if (role === "toolResult") {
    const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
    const text = historyBlocksText(m.content);
    const images = historyImages(m.content);
    const idx = id ? toolIdx.get(id) : undefined;
    const prior = idx !== undefined ? items[idx] : undefined;
    const toolName = (prior?.toolName as string) ?? (m.toolName ?? "?");
    const resultContent = Array.isArray(m.content)
      ? m.content
      : text ? [{ type: "text", text }] : [];
    let { stream, streamExpanded } = renderToolStreams(
      toolName, id, (prior as any)?.__args ?? {},
      { content: resultContent, isError: m.isError === true },
    );
    if (!stream) {
      stream = linesToStream(renderToolResultLines(toolName, m.content, theme));
      streamExpanded = undefined;
    }
    const withImgs = withImageLines(stream, images);
    const patch: Record<string, unknown> = { content: text, isError: m.isError === true };
    if (withImgs.stream) patch.stream = withImgs.stream;
    if (streamExpanded) {
      patch.streamExpanded = withImageLines(streamExpanded, images).stream;
    }
    const leftoverImages = withImgs.stream ? withImgs.overflow : images;
    if (leftoverImages.length) patch.images = leftoverImages;
    if (idx !== undefined) {
      items[idx] = { ...items[idx], ...patch };
    } else {
      // Orphan result (its toolCall isn't on this branch): show it standalone.
      items.push({ role: "tool", toolCallId: id, toolName: m.toolName ?? "?", toolArgs: "", ...patch });
    }
  } else if (role === "bashExecution") {
    if (m.excludeFromContext) return; // !! prefix — hidden from the conversation
    const cmd = typeof m.command === "string" ? m.command : "";
    const output = typeof m.output === "string" ? m.output : "";
    const isError = typeof m.exitCode === "number" && m.exitCode !== 0;
    const item: Record<string, unknown> = {
      role: "tool",
      toolCallId: "",
      toolName: "bash",
      toolArgs: cmd ? JSON.stringify({ command: cmd }) : "",
      content: output,
      isError,
    };
    const { stream, streamExpanded } = renderToolStreams(
      "bash", "", { command: cmd },
      { content: output ? [{ type: "text", text: output }] : [], isError },
    );
    if (stream) item.stream = stream;
    if (streamExpanded) item.streamExpanded = streamExpanded;
    items.push(item);
  } else if (role === "custom") {
    if (m.display === false) return;
    const stream = linesToStream(renderCustomMessageLines(m, theme));
    if (stream) {
      items.push({ role: "custom", customType: m.customType ?? "", stream });
    } else {
      const text = historyBlocksText(m.content);
      if (text.trim()) {
        const item: Record<string, unknown> = { role: "assistant", content: text };
        const md = renderAssistantStream(text);
        if (md) item.stream = md;
        items.push(item);
      }
    }
  }
}

function sendHistory(ws: WebSocket): void {
  if (ws.readyState !== 1 || mode !== "host" || !selfSm) return;
  // Walk the current branch root→leaf. getBranch() keeps pre-compaction message
  // entries (a compaction only inserts a summary marker in the chain), so this
  // is the full scrollback — unlike buildSessionContext(), which collapses
  // everything before a compaction into the summary.
  let entries: any[] = [];
  try {
    entries = (selfSm.getBranch?.() as any[]) ?? [];
  } catch (e: any) {
    console.warn(`sendHistory: getBranch failed: ${e?.message ?? e}`);
    return;
  }
  const theme = selfUi?.theme;
  const items: Record<string, unknown>[] = [];
  // toolCallId → index in items, so a later toolResult fills in its tool bubble.
  const toolIdx = new Map<string, number>();

  for (const entry of entries) {
    if (entry?.type === "message" && entry.message) {
      pushHistoryMessage(entry.message, items, toolIdx, theme);
    } else if (entry?.type === "custom_message" && entry.display !== false) {
      // Extension-injected message that participates in context (e.g. notes).
      pushHistoryMessage(
        { role: "custom", customType: entry.customType, content: entry.content, display: entry.display },
        items, toolIdx, theme,
      );
    }
    // model_change / thinking_level_change / compaction / branch_summary /
    // label / session_info / custom entries carry no chat bubble — skip them.
  }

  // Strip the raw-args stash (only needed while patching tool results above).
  for (const it of items) delete it.__args;

  let sessionId: string | undefined;
  try { sessionId = selfSm.getSessionId?.(); } catch { /* ignore */ }
  ws.send(JSON.stringify({
    type: "history",
    agentId: SELF_AGENT_ID,
    sessionId,
    messages: items,
  }));
}

/**
 * Catch stale-extension-runtime exceptions that would crash pi.
 * Sends a notify banner and returns false on error.
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

// ── Rendered-presentation bridge ────────────────────────────────────────────
// Mirror another extension's *actual* presentation to the phone: re-render its
// custom Component (message renderer / tool renderResult) to ANSI lines at the
// device's column width and ship those lines. The app renders them verbatim, so
// colors, backgrounds, and layout match — reflowed to the phone, not the desktop.
//
// Requires the patched pi build that exposes getMessageRenderer/getToolDefinition
// on the extension API (they exist on the runner; stock builds don't forward
// them). Everything here degrades to undefined → the app falls back to plain text.
let clientCols = 60;                       // device width in columns; set by {type:"viewport"}
let piApi: ExtensionAPI | null = null;     // captured in the default export for module-level use

function componentToLines(component: any): string[] | undefined {
  try {
    const lines = component?.render?.(clientCols);
    return Array.isArray(lines) && lines.length > 0 ? lines.map(String) : undefined;
  } catch { return undefined; }
}

function renderCustomMessageLines(message: any, theme: any): string[] | undefined {
  try {
    const customType = message?.customType;
    // Skip entries with no custom presentation, and our own "[Remote]" messages.
    if (!customType || customType === "remote" || !theme) return undefined;
    const getRenderer = (piApi as any)?.getMessageRenderer;
    if (typeof getRenderer !== "function") return undefined;
    const renderer = getRenderer.call(piApi, customType);
    if (typeof renderer !== "function") return undefined;
    return componentToLines(renderer(message, { expanded: true }, theme));
  } catch { return undefined; }
}

function renderToolResultLines(toolName: string, result: any, theme: any): string[] | undefined {
  try {
    if (!toolName || !theme) return undefined;
    const getDef = (piApi as any)?.getToolDefinition;
    if (typeof getDef !== "function") return undefined;
    const renderResult = getDef.call(piApi, toolName)?.renderResult;
    if (typeof renderResult !== "function") return undefined;
    // Some tools take a 4th render-context (e.g. pi-subagents reads
    // context.state for animation timers). We produce a one-shot static
    // snapshot, so pass a permissive stub so they don't throw on the missing
    // live context; the no-op redraw means no terminal-side animation.
    const renderContext = { state: {}, requestRedraw: () => {}, expanded: true };
    return componentToLines(renderResult(result, { expanded: true }, theme, renderContext));
  } catch { return undefined; }
}

// ── Phone-native message rendering (host-side ANSI, PROTOCOL.md) ────────────
// The app is a dumb TTY: every message ships as a single pre-rendered ANSI+OSC
// `stream` string (lines joined with \n) that the phone feeds through its
// terminal parser verbatim. We reuse pi's OWN interactive components so the
// phone shows exactly what the terminal shows. Tool results also carry
// `streamExpanded` so the phone's tap-to-expand keeps working.
//
// Everything degrades gracefully: any renderer failure returns undefined and
// the app falls back to client-side plain-text rendering of the structured
// fields (which still ride along unchanged).

// Components only use the TUI handle to request repaints; for one-shot
// snapshot renders a no-op is fine.
const headlessUi: any = { requestRender: () => {} };

function linesToStream(lines: string[] | undefined): string | undefined {
  return lines && lines.length > 0 ? lines.join("\n") : undefined;
}

function renderUserStream(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    return linesToStream(new UserMessageComponent(text).render(clientCols));
  } catch { return undefined; }
}

function renderAssistantStream(markdown: string): string | undefined {
  if (!markdown.trim()) return undefined;
  try {
    const msg: any = { role: "assistant", content: [{ type: "text", text: markdown }], stopReason: "stop" };
    return linesToStream(new AssistantMessageComponent(msg).render(clientCols));
  } catch { return undefined; }
}

function renderThinkingStream(thinking: string): string | undefined {
  if (!thinking.trim()) return undefined;
  try {
    const msg: any = { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" };
    return linesToStream(new AssistantMessageComponent(msg).render(clientCols));
  } catch { return undefined; }
}

// Full tool display — header, args, edit diffs, result — exactly as pi's
// terminal renders it, in collapsed and expanded variants.
function renderToolStreams(
  toolName: string,
  toolCallId: string,
  args: any,
  result?: { content: any[]; isError: boolean; details?: any },
): { stream?: string; streamExpanded?: string } {
  try {
    let def: any;
    const getDef = (piApi as any)?.getToolDefinition;
    if (typeof getDef === "function") def = getDef.call(piApi, toolName);
    let cwd = process.cwd();
    try { cwd = selfSm?.getCwd?.() ?? cwd; } catch { /* keep process.cwd */ }
    const comp = new ToolExecutionComponent(
      toolName,
      toolCallId,
      args ?? {},
      { showImages: false }, // images ship as OSC 1337 lines instead (below)
      typeof def === "object" && def !== null ? def : undefined,
      headlessUi,
      cwd,
    );
    comp.markExecutionStarted();
    comp.setArgsComplete();
    if (result) {
      comp.updateResult({
        content: Array.isArray(result.content) ? result.content : [],
        isError: result.isError === true,
        details: result.details,
      });
    }
    const stream = linesToStream(comp.render(clientCols));
    comp.setExpanded(true);
    const expanded = linesToStream(comp.render(clientCols));
    return { stream, streamExpanded: expanded !== stream ? expanded : undefined };
  } catch {
    return {};
  }
}

// Inline images ride inside the stream as OSC 1337 sequences (the app's
// primary image channel). The app's parser drops base64 payloads over 8 MiB,
// so anything bigger falls back to the structured images[] array — the app
// appends those after the stream.
const OSC_IMAGE_MAX_B64 = 8 * 1024 * 1024;

function osc1337ImageLine(img: { data: string; mimeType: string }): string | undefined {
  if (!img.data || img.data.length > OSC_IMAGE_MAX_B64) return undefined;
  const size = Buffer.byteLength(img.data, "base64");
  return `\x1b]1337;File=inline=1;size=${size};mime=${img.mimeType || "image/png"};width=auto:${img.data}\x1b\\`;
}

// Append embeddable images to [stream] as OSC lines; return the leftovers
// that must still travel as a structured images[] array.
function withImageLines(
  stream: string | undefined,
  images: Array<{ data: string; mimeType: string }>,
): { stream?: string; overflow: Array<{ data: string; mimeType: string }> } {
  const lines: string[] = [];
  const overflow: Array<{ data: string; mimeType: string }> = [];
  for (const img of images) {
    const line = osc1337ImageLine(img);
    if (line) lines.push(line);
    else overflow.push(img);
  }
  if (lines.length === 0) return { stream, overflow };
  const joined = lines.join("\n");
  return { stream: stream ? `${stream}\n${joined}` : joined, overflow };
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
  const url = urlWithToken(`wss://${ip}:${DEFAULT_PORT}`);

  // TLS terminates here. The WebSocketServer hooks into the https server's
  // 'upgrade' event for us; events that used to come from WebSocketServer
  // (error / listening) now come from the underlying https server.
  const httpsServer = https.createServer({ cert: TLS.cert, key: TLS.key });
  const server = new WebSocketServer({ server: httpsServer });
  RC.wss = server;
  RC.httpsServer = httpsServer;

  let bound = false;
  let bindFailed = false;

  // ws v8 attaches its own listener to `httpsServer.on("error")` that
  // re-emits on the WebSocketServer instance. If WSS has no listener, that
  // re-emit throws synchronously (default EventEmitter behaviour) BEFORE my
  // httpsServer listener gets a turn — so the EADDRINUSE escapes as an
  // uncaughtException and the second-pi-on-the-same-port falls flat instead
  // of switching to peer mode. Handler must be on `server` (the WSS) to
  // catch the re-emit; mirror on httpsServer for completeness.
  const onServerError = (err: any) => {
    if (err?.code === "EADDRINUSE" && !bindFailed) {
      bindFailed = true;
      RC.wss = null;
      RC.httpsServer = null;
      try { httpsServer.close(); } catch { /* ignore */ }
      onBindFail();
    }
    // any other error — ignore; 'connection' handles per-client errors
  };
  server.on("error", onServerError);
  httpsServer.on("error", onServerError);

  httpsServer.on("listening", () => {
    if (bindFailed) return;
    bound = true;
    mode = "host";
    upsertSelfAgent();
    refreshRemoteStatus(); // "remote · host" chip in the footer
    console.log("\n" + box("Pi Remote Control (host)", [url]).join("\n"));
    // Honest one-line summary of the auth state so the user knows what's
    // protecting (or not protecting) their pi.
    switch (AUTH_TOKEN_SOURCE) {
      case "env":
        console.log(`  auth: shared-secret token from PI_REMOTE_TOKEN`);
        break;
      case "file":
        console.log(`  auth: shared-secret token from ${AUTH_TOKEN_FILE}`);
        break;
      case "generated":
        console.log(`  auth: NEW shared-secret token generated and stored at ${AUTH_TOKEN_FILE}`);
        break;
      case "disabled":
        console.log(`  auth: DISABLED (PI_REMOTE_CONTROL_NO_AUTH=1). Anyone who can reach this port can drive the agent.`);
        break;
    }
    // Channel encryption: self-signed TLS, pinned by SHA-256 fingerprint in the QR.
    // Show a short prefix so the user can eyeball-compare with the phone if needed;
    // the full fingerprint is in the URL.
    const fpShort = `${TLS_FINGERPRINT.slice(0, 8)}…${TLS_FINGERPRINT.slice(-8)}`;
    const certSrc = TLS.source === "loaded" ? CERT_FILE : `NEW self-signed cert generated and stored at ${CERT_FILE}`;
    console.log(`  tls:  ${certSrc}`);
    console.log(`  fingerprint: sha256:${fpShort} (full value pinned in the QR)`);
    console.log();
    // Render a QR code the Android app can scan. The Android scanner accepts
    // ws://, wss://, piremote://, and bare host:port; we use ws:// so a
    // generic QR scanner (camera app) also recognises it as a URL.
    // Print the QR/URL to the TERMINAL only. We deliberately do NOT inject this
    // (or any [Remote] status) into the pi conversation — it clutters the chat
    // and, in peer/subagent pis, floods it with noise. The host's terminal is
    // where you scan the code.
    qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
      console.log(qr);
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
    sendCommandList(ws);
    // Send the current Pi theme palette so the phone UI mirrors the terminal
    sendCurrentTheme(ws);
    // Replay the full conversation so a fresh connect (or reconnect) shows the
    // whole thread. Deferred briefly: a `client_hello` arriving in the next few
    // hundred ms can cancel this (mirror-only clients don't render history, and
    // shipping it ahead of the first mirror frame was the bulk of connect lag).
    // No hello (old client) → the timer fires and history ships as before.
    const histTimer = setTimeout(() => {
      pendingHistory().delete(ws);
      sendHistory(ws);
    }, 300);
    histTimer.unref?.();
    pendingHistory().set(ws, histTimer);

    ws.on("message", (data: RawData) => {
      const text = data.toString();
      try {
        const cmd = JSON.parse(text) as Record<string, unknown>;
        // Route to the current instance, not the one that bound the server —
        // after a session replacement this socket outlives the old instance.
        handleHostCmd(cmd, RC.currentPi ?? pi, ws);
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Bad JSON" }));
      }
    });

    const drop = () => {
      const peerId = wsToPeerId.get(ws);
      if (peerId) {
        peerConns.delete(peerId);
        agents.delete(peerId);
        peerPids.delete(peerId);
        wsToPeerId.delete(ws);
        console.log(`  [-] peer ${peerId} disconnected`);
      } else {
        clientConns.delete(ws);
        const target = mirrorTargets().get(ws);
        mirrorTargets().delete(ws);
        clientCaps().delete(ws);
        mirrorClientState().delete(ws);
        const ht = pendingHistory().get(ws);
        if (ht) { clearTimeout(ht); pendingHistory().delete(ws); }
        if (target) maybeStopPeerMirror(target);
        requestMirrorFrame(); // last mirror gone → next render reverts to desktop width
        console.log(`  [-] client disconnected (${clientConns.size} viewers)`);
      }
      hostBcastSessionList();
    };

    ws.on("close", drop);
    // A 'ws' socket is an EventEmitter: an 'error' with no listener throws an
    // uncaught exception that crashes pi. 'close' fires after 'error', so drop()
    // still runs the cleanup — this listener just keeps the error from killing us.
    ws.on("error", () => { try { drop(); } catch { /* already dropping */ } });
  });

  // Safety net in case neither 'listening' nor 'error' fires (shouldn't happen).
  setTimeout(() => {
    if (!bound && !bindFailed) {
      bindFailed = true;
      RC.wss = null;
      RC.httpsServer = null;
      try { httpsServer.close(); } catch { /* ignore */ }
      onBindFail();
    }
  }, 1500);

  // Now actually start listening. With `new WebSocketServer({ server })` the
  // listen call must come from the underlying http(s) server, not the WS lib.
  httpsServer.listen(DEFAULT_PORT, "0.0.0.0");
}

// ── Peer-mode lifecycle ─────────────────────────────────────────────────

function startPeer(pi: ExtensionAPI): void {
  if (peerSock || mode === "peer") return;
  mode = "peer";
  // Same shared secret applies for host↔peer on the loopback. If PI_REMOTE_TOKEN
  // is set, the peer dials with the token so the host's auth gate accepts it.
  // wss:// with the local self-signed cert: we pass our cert as the trusted CA
  // and disable hostname verification (we're connecting to 127.0.0.1 with a
  // cert whose CN is "pi-remote-control", not an IP/hostname match). This is
  // equivalent to fingerprint-pinning since the cert is *the* local file.
  const url = urlWithToken(`wss://127.0.0.1:${DEFAULT_PORT}`);
  refreshRemoteStatus(); // "remote · connecting…" in the footer (peerSock still null)

  const sock = new WebSocket(url, {
    ca: TLS.cert,
    checkServerIdentity: () => undefined,
  });
  peerSock = sock;

  sock.on("open", () => {
    sock.send(JSON.stringify({
      type: "peer_hello",
      agentId: SELF_AGENT_ID,
      name: SELF_AGENT_NAME,
      pid: process.pid,
    }));
    // Show the joined peer name as a footer chip — never inject it into the chat.
    refreshRemoteStatus();
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
    refreshRemoteStatus(); // peerSock now null → "remote · connecting…"
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
  // Route the persistent server's client message handlers to THIS instance.
  // Essential after a session replacement: the same sockets keep delivering,
  // but commands must execute against the new session's pi, not the stale one.
  RC.currentPi = pi;

  if (RC.wss) {
    // Server survived from an earlier load — either we're already host, or a
    // session replacement (/new, /resume) just re-imported this module. Adopt
    // the live server instead of rebinding (the phone stays connected) and push
    // the current session to clients so they refresh (and clear on a new id).
    mode = "host";
    upsertSelfAgent();
    refreshRemoteStatus();
    hostBcastSessionList();
    return;
  }
  if (mode === "peer" && peerSock) {
    refreshRemoteStatus();
    return; // already a peer — nothing to do, and don't spam the conversation
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

  if (wasMode === "host" && RC.wss) {
    RC.wss.close();
    // Close the underlying https listener too, otherwise the port stays bound.
    try { RC.httpsServer?.close(); } catch { /* ignore */ }
    RC.httpsServer = null;
    for (const ws of clientConns) {
      try { ws.close(); } catch { /* ignore */ }
    }
    for (const ws of peerConns.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    clientConns.clear();
    peerConns.clear();
    peerPids.clear();
    RC.wss = null;
  }

  if (wasMode === "peer") {
    stopPeer();
  }

  agents.clear();
  localBusy = false;
  localMessageCount = 0;
  localTurnIndex = 0;
  refreshRemoteStatus(); // mode is "stopped" → clears the footer chip
  console.log("[pi-remote-control] stopped");
}

// ── /resume picker (text render-frame) ──────────────────────────────
// Pi's /resume opens a custom SessionSelectorComponent which we can't mirror
// via the SelectList bridge. Instead, render our own numbered list as an ANSI
// text frame and read the user's choice back through the existing render/input
// wire protocol. The phone already handles `inputMode: "text"` (it shows the
// frame and a text input), so this works with no Android changes.
function formatAgo(modified: unknown): string {
  const ts = typeof modified === "number"
    ? modified
    : (Date.parse(String(modified)) || Date.now());
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d`;
  const months = days / 30;
  return `${Math.floor(months)}mo`;
}

function showResumePicker(pi: ExtensionAPI): void {
  const renderId = `resume_${Date.now().toString(36)}`;
  let sessions: SessionInfo[] = [];
  let unsub: (() => void) | null = null;

  // `tapValues` is a parallel array to `lines`: any non-empty entry marks
  // that line as tappable on the phone, and the entry is the string sent
  // back via sendInput. Older app builds ignore the field — they still see
  // the same numbered list and can type the number.
  const push = (lines: string[], tapValues: string[], dismiss = false): void => {
    hostBcastClients(JSON.stringify({
      type: "render",
      id: renderId,
      lines,
      tapValues,
      inputMode: "text",
      title: "Resume session",
      dismiss: dismiss || lines.length === 0,
    }));
  };

  const dismiss = (): void => {
    push([], [], true);
    if (unsub) { unsub(); unsub = null; }
  };

  const rerender = (footer?: string): void => {
    const lines: string[] = [];
    const tapValues: string[] = [];
    const add = (line: string, tap = ""): void => { lines.push(line); tapValues.push(tap); };

    add("");
    if (sessions.length === 0) {
      add("  Loading saved sessions…");
    } else {
      sessions.forEach((s, i) => {
        const idx = String(i + 1).padStart(2, " ");
        const name = (s.name?.trim() || s.firstMessage?.trim() || s.id || "session")
          .replace(/\s+/g, " ").slice(0, 38);
        const ago = formatAgo(s.modified);
        add(`  ${idx}. ${name.padEnd(40)} ${ago}`, String(i + 1));
      });
    }
    add("");
    add(footer ?? "  Tap a row to resume, or type a number. `q` to cancel.");
    push(lines, tapValues);
  };

  // First frame goes out immediately so the picker appears on the phone
  // as soon as the user taps /resume, even before the listAll completes.
  rerender();

  // Filter incoming inputs by renderId; the inputListeners bus is shared
  // with anything else using the render protocol (e.g. a future extension).
  const handler = (id: string, value: string): void => {
    if (id !== renderId) return;
    const v = value.trim().toLowerCase();
    if (!v || v === "q" || v === "cancel" || v === "esc") { dismiss(); return; }
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > sessions.length) {
      const max = sessions.length || 0;
      rerender(`  ✗ no session #${value.trim()}. Type 1–${max}, or 'q' to cancel.`);
      return;
    }
    const path = sessions[n - 1].path;
    dismiss();
    // Defer like ctx.executeInputLine — switchSession tears down and rebinds
    // the runtime, which would invalidate the command-context we're inside.
    // session_shutdown fires, the WS closes, the phone reconnects.
    setImmediate(() => {
      void safeCtx(pi, "/resume", async (ctx) => {
        await ctx.switchSession(path);
      });
    });
  };
  inputListeners.push(handler);
  unsub = () => {
    const i = inputListeners.indexOf(handler);
    if (i !== -1) inputListeners.splice(i, 1);
  };

  void (async () => {
    try {
      const list = await SessionManager.listAll();
      list.sort((a, b) => +new Date(b.modified) - +new Date(a.modified));
      sessions = list.slice(0, 100);
      rerender();
    } catch (e: any) {
      rerender(`  failed to load saved sessions: ${e?.message ?? e}`);
    }
  })();
}

// Run a slash command against THIS pi's own session. Used both for commands
// the phone targets at our self agent and for ones forwarded to us as a peer
// (route_slash_command). /compact and /quit use dedicated context actions;
// /resume opens the in-extension text render-frame picker (above); /reload is
// routed to a notice; everything else (incl. /new) goes through pi's editor
// submit path via ctx.executeInputLine.
function executeSlashLocally(pi: ExtensionAPI, commandName: string, args: string): void {
  if (commandName === "compact") {
    const instructions = args.trim();
    void (async () => {
      const ok = await safeCtx(pi, "/compact", async (ctx) => {
        ctx.compact(instructions ? { instructions } : undefined);
      });
      if (!ok) return;
      hostBcastClients(JSON.stringify({
        type: "extension_ui_request",
        method: "notify",
        id: `notify_compact_${Date.now()}`,
        message: instructions ? `Compacting with custom instructions...` : `Compacting session context...`,
        notifyType: "info",
      }));
    })();
  } else if (commandName === "quit") {
    void safeCtx(pi, "/quit", async (ctx) => { void ctx.shutdown(); });
  } else if (commandName === "resume") {
    showResumePicker(pi);
  } else if (commandName === "model" && !args.trim()) {
    showModelPicker(pi);
  } else if (REMOTE_STALES.has(commandName)) {
    // /reload only — would tear down + rebind the runtime mid-call; punt to a
    // notice so the user knows to run it from the terminal.
    hostBcastClients(JSON.stringify({
      type: "extension_ui_request",
      method: "notify",
      id: `notify_stale_path_${Date.now()}`,
      message: `/${commandName} can't run from the app — run /${commandName} in the pi terminal.`,
      notifyType: "warning",
    }));
  } else {
    const a = args.trim();
    const line = a ? `/${commandName} ${a}` : `/${commandName}`;
    void safeCtx(pi, `/${commandName}`, async (ctx) => { await ctx.executeInputLine(line); });
  }
}

// ── Host: inbound commands ──────────────────────────────────────────────

function handleHostCmd(cmd: Record<string, unknown>, pi: ExtensionAPI, ws: WebSocket): void {
  switch (cmd.type as string) {
    case "client_hello": {
      // Capability handshake. Cancel the deferred history replay; only send it
      // now if this client actually renders history (mirror-only clients don't).
      const mirrorOnly = cmd.mirrorOnly === true;
      clientCaps().set(ws, { mirrorOnly, diff: cmd.diff === true });
      const t = pendingHistory().get(ws);
      if (t) { clearTimeout(t); pendingHistory().delete(ws); }
      if (!mirrorOnly) sendHistory(ws);
      break;
    }
    case "mirror": {
      // Subscribe/unsubscribe this client to composed-screen frames of one
      // agent: the host itself (default) or any connected peer pi.
      const agentId = (typeof cmd.agentId === "string" && cmd.agentId) || SELF_AGENT_ID;
      const previous = mirrorTargets().get(ws);
      if (cmd.on) {
        mirrorTargets().set(ws, agentId);
        if (previous && previous !== agentId) maybeStopPeerMirror(previous);
        if (agentId === SELF_AGENT_ID) {
          requestMirrorFrame();   // render a phone-width frame for this subscriber
          sendMirrorFrame(ws);  // immediate snapshot so the view isn't blank
        } else {
          const peerWs = peerConns.get(agentId);
          // Send the phone's width with the subscribe so the peer clamps too.
          if (peerWs?.readyState === 1) peerWs.send(JSON.stringify({ type: "route_mirror", on: true, cols: clientCols }));
        }
      } else {
        mirrorTargets().delete(ws);
        if (previous) maybeStopPeerMirror(previous);
        requestMirrorFrame();     // nobody mirroring us
      }
      break;
    }
    case "mirror_input": {
      // Keys and SGR-encoded taps from the mirror view, injected through the
      // target TUI's normal input path (shortcuts, click handlers, editor).
      const data = typeof cmd.data === "string" ? cmd.data : "";
      if (!data) break;
      const agentId = (typeof cmd.agentId === "string" && cmd.agentId) || mirrorTargets().get(ws) || SELF_AGENT_ID;
      if (agentId === SELF_AGENT_ID) {
        injectMirrorInput(data);
      } else {
        const peerWs = peerConns.get(agentId);
        if (peerWs?.readyState === 1) peerWs.send(JSON.stringify({ type: "route_mirror_input", data }));
      }
      break;
    }
    case "viewport": {
      // App reports its width in monospace columns so we re-render pi's
      // components to fit the device. Clamp to a sane range.
      const cols = Number(cmd.cols);
      if (!Number.isFinite(cols)) break;
      const next = Math.max(20, Math.min(400, Math.floor(cols)));
      if (next === clientCols) break;
      clientCols = next;
      requestMirrorFrame(); // re-render at the new phone width if mirroring us
      // Streams are rendered at the width current when each message was sent;
      // a width change re-renders the whole scrollback via a history replay —
      // but skip it for mirror-only clients, who never render that scrollback
      // (this re-send was doubling the connect-time history cost on width report).
      if (!clientCaps().get(ws)?.mirrorOnly) sendHistory(ws);
      // Peers render their own streams but never see viewport messages —
      // forward the width so their output fits the device too.
      for (const peerWs of peerConns.values()) {
        if (peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: "route_viewport", cols: next }));
        }
      }
      break;
    }
    case "peer_hello": {
      const peerId = (cmd.agentId as string) || randomUUID().slice(0, 8);
      const name = (cmd.name as string) || `Pi-${peerId.slice(0, 4)}`;
      const peerPid = typeof cmd.pid === "number" ? cmd.pid : undefined;
      // Promote this ws from client to peer.
      clientConns.delete(ws);
      peerConns.set(peerId, ws);
      wsToPeerId.set(ws, peerId);
      if (peerPid) peerPids.set(peerId, peerPid);
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
        pid: peerPid ?? undefined,
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
      if (payload.type === "mirror_frame") {
        // Screen frames are high-volume and per-viewer: send only to clients
        // mirroring this peer, not the general broadcast.
        const framed = JSON.stringify({ ...payload, agentId: sourceAgentId });
        for (const [clientWs, target] of mirrorTargets()) {
          if (target === sourceAgentId && clientWs.readyState === 1) clientWs.send(framed);
        }
        break;
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
      if (target === SELF_AGENT_ID) {
        const sendOpts: { deliverAs?: "steer" | "followUp" } = {};
        if (deliverAs) sendOpts.deliverAs = deliverAs;
        // Strip data-URI prefix: Pi expects raw base64 data. Full URI chars cause Claude errors.
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
          peerWs.send(JSON.stringify({ type: "route_prompt", message: msg, deliverAs, images }));
        }
      }
      break;
    }
    // ── Remote slash-command execution ───────────────────────────────────
    // /compact and /quit use dedicated context actions (nice phone feedback).
    // /resume, /reload are REMOTE_STALES — routed to notices for now.
    // Everything else (including /new) runs on the host via ctx.executeInputLine().
    // Session-replacing commands like /new fire session_shutdown (which closes
    // client sockets) then rebind a fresh host; the phone auto-reconnects to the
    // new session. safeCtx wraps pi.withCommandContext to catch stale crashes.
    case "slash_command": {
      const commandName = (cmd.command as string)?.trim().toLowerCase();
      if (!commandName) break;
      const args = (cmd.args as string) ?? "";
      const target = (cmd.targetAgentId as string) || SELF_AGENT_ID;
      if (target === SELF_AGENT_ID) {
        executeSlashLocally(pi, commandName, args);
      } else {
        // Targeted at a peer — forward over the peer link so it runs the
        // command on its own session (mirrors route_prompt). Without this,
        // slash commands sent while viewing a peer tab silently do nothing.
        const peerWs = peerConns.get(target);
        if (peerWs && peerWs.readyState === 1) {
          peerWs.send(JSON.stringify({ type: "route_slash_command", command: commandName, args }));
        }
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
    // ── Spawn a second pi process as a peer ────────────────────────
    case "spawn_peer": {
      const sessionPath = typeof cmd.sessionPath === "string" ? cmd.sessionPath : "";
      // setsid+script provides a fake PTY; detached process survives parent pi exit.
      const logPath = `/tmp/pi-peer-${randomUUID().slice(0, 6)}.log`;
      // Shell-escape the sessionPath for script -c command string.
      const escapedPath = sessionPath ? sessionPath.replace(/'/g, "'\\''") : "";
      const piCmd = sessionPath ? `pi --session '${escapedPath}'` : "pi";
      try {
        const child = spawnChild(
          "setsid",
          ["script", "-qfc", piCmd, logPath],
          {
            detached: true,
            stdio: "ignore",
            env: process.env,
            cwd: process.cwd(),
          },
        );
        child.unref();
        const label = sessionPath ? `pi --session ${sessionPath}` : "pi";
        console.log(`  [*] spawned peer (pid=${child.pid}, log=${logPath}): ${label}`);
        hostBcastClients(JSON.stringify({
          type: "extension_ui_request",
          method: "notify",
          id: `notify_peer_${Date.now()}`,
          message: sessionPath
            ? `Resuming saved session as a new peer…`
            : `Launching a new pi peer… it'll join shortly.`,
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
    case "get_saved_sessions": {
      // Stream saved sessions to the requesting client, capped at 100 most recent.
      void (async () => {
        let list: SessionInfo[] = [];
        try {
          list = await SessionManager.listAll();
        } catch (e: any) {
          console.warn(`get_saved_sessions: listAll failed: ${e?.message ?? e}`);
        }
        list.sort((a, b) => +new Date(b.modified) - +new Date(a.modified));
        const out = list.slice(0, 100).map((s) => ({
          path: s.path,
          name: s.name?.trim() || s.firstMessage?.trim() || s.id,
          firstMessage: s.firstMessage ?? "",
          messageCount: s.messageCount ?? 0,
          modified: typeof s.modified === "number" ? s.modified : Date.parse(String(s.modified)) || 0,
        }));
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "saved_sessions", sessions: out }));
        }
      })();
      break;
    }
    case "get_sessions": {
      hostBcastSessionList(ws);
      break;
    }
    case "get_commands": {
      sendCommandList(ws);
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
      } else if (id.startsWith("modelpick_")) {
        const byLabel = pendingModelPicks.get(id);
        pendingModelPicks.delete(id);
        const model = !cancelled ? byLabel?.get(label) : undefined;
        if (model) {
          void (async () => {
            let ok = false;
            try { ok = await pi.setModel(model); } catch { /* keep ok=false */ }
            hostBcastClients(JSON.stringify({
              type: "extension_ui_request",
              method: "notify",
              id: `notify_model_${Date.now()}`,
              message: ok
                ? `Model set to ${model.provider}/${model.id}`
                : `Could not set ${model.provider}/${model.id} (no API key?)`,
              notifyType: ok ? "info" : "warning",
            }));
          })();
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
      // Strip data-URI prefix: Pi expects raw base64 data.
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
    case "route_slash_command": {
      // Host forwarded a slash command targeted at us — run it on our session.
      const commandName = (msg.command as string)?.trim().toLowerCase();
      if (commandName) executeSlashLocally(pi, commandName, (msg.args as string) ?? "");
      break;
    }
    case "route_viewport": {
      // Host forwarded the phone's viewport width so our rendered streams fit.
      const cols = Number(msg.cols);
      if (Number.isFinite(cols)) clientCols = Math.max(20, Math.min(400, Math.floor(cols)));
      requestMirrorFrame(); // re-render at the new phone width if mirroring us
      break;
    }
    case "route_mirror": {
      // A phone is (or stopped) mirroring OUR screen via the host.
      peerMirrorOn = msg.on === true;
      const cols = Number(msg.cols);
      if (peerMirrorOn && Number.isFinite(cols)) clientCols = Math.max(20, Math.min(400, Math.floor(cols)));
      requestMirrorFrame(); // render at the phone width (or revert)
      if (peerMirrorOn) sendMirrorFrame(); // immediate snapshot upstream
      break;
    }
    case "route_mirror_input": {
      const data = typeof msg.data === "string" ? msg.data : "";
      if (data) {
        injectMirrorInput(data);
      }
      break;
    }
    // peer_ack and any other host->peer messages: ignored (no state to update)
  }
}

// ── Extension factory ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // Capture the API so module-level render helpers can reach the renderer
  // registry. Log once if this pi build doesn't expose it (presentation
  // mirroring then degrades to plain text — see the rendered-presentation bridge).
  piApi = pi;
  if (typeof (pi as any).getMessageRenderer !== "function") {
    console.log("[pi-remote-control] note: pi build does not expose getMessageRenderer/getToolDefinition — extension presentation mirroring disabled (text fallback).");
  }

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "send_file_to_phone",
    label: "SendFileToPhone",
    description:
      "Send a file from this machine to the user's connected phone (pi-remote-control app), where it appears " +
      "as a save/share dialog. Use when the user asks to get a file onto their phone, or when delivering an " +
      "artifact (export, report, image, build output) they should have on the device. 20MB cap.",
    promptSnippet: "Deliver a file to the user's connected phone",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file to send" },
        name: { type: "string", description: "Optional display/file name (defaults to the basename)" },
        mime_type: { type: "string", description: "Optional MIME type (defaults to application/octet-stream)" },
      },
      required: ["path"],
      additionalProperties: false,
    } as never,
    async execute(_id: string, params: { path: string; name?: string; mime_type?: string }) {
      if (clientConns.size === 0) {
        return {
          content: [{ type: "text", text: "No phone is connected — the file was not sent. The user can connect via the pi-remote-control app (/remote-qr shows the pairing code)." }],
          isError: true,
        };
      }
      (globalThis as any).__piRemote.sendFile({ path: params.path, name: params.name, mimeType: params.mime_type });
      return {
        content: [{ type: "text", text: `Sent ${params.path} to ${clientConns.size} connected device${clientConns.size === 1 ? "" : "s"} (save/share dialog on the phone).` }],
      };
    },
  } as never);

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("remote-control", {
    description: "Start remote control server",
    handler: async () => start(pi),
  });

  pi.registerCommand("remote-stop", {
    description: "Stop remote control server",
    handler: async () => stop(pi),
  });

  pi.registerCommand("remote-qr", {
    description: "Display QR code to connect the phone app",
    handler: async () => {
      const ip = localIP();
      const url = urlWithToken(`wss://${ip}:${DEFAULT_PORT}`);
      // Print a visible divider + QR so the code isn't lost behind the
      // input line.  The URL is printed AFTER the QR code (phone can
      // tap-and-hold to copy it) as a fallback for scanning.
      const sep = "━".repeat(50);
      console.log();
      console.log(`${sep}`);
      console.log(`  Scan this QR with your phone\n`);
      qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
        console.log(qr);
        console.log();
        // Full URL always visible as backup
        console.log(`  ${url}`);
        console.log(`${sep}\n`);
      });
    },
  });

  // ── Message renderer ──────────────────────────────────────────────────

  pi.registerMessageRenderer("remote", (msg, _opts, theme) => {
    const { Text } = require("@earendil-works/pi-tui") as typeof import("@earendil-works/pi-tui");
    return new Text(theme.fg("accent", `[Remote] ${msg.content}`), 0, 0);
  });

  // ── Agent events ─────────────────────────────────────────────────────

  pi.on("agent_start", async (_e, ctx) => {
    syncTheme(ctx.hasUI ? ctx.ui.theme : undefined);
    localBusy = true;
    selfSm = ctx.sessionManager;
    if (mode === "host") {
      upsertSelfAgent();
      hostBcastSessionList();
    }
    emitAgentEvent({ type: "agent_start" });
  });

  pi.on("agent_end", async (e, ctx) => {
    localBusy = false;
    localMessageCount = (e.messages ?? []).length;
    selfSm = ctx.sessionManager;
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

  // Max bytes for images forwarded to the phone (base64 payload).
  // Bigger than most phone displays — 10 MB is ~3840×2160 PNG uncompressed.
  const TOOL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

  // Attach the phone-rendered presentation of a user message: pi's own
  // UserMessageComponent plus inline OSC 1337 images. Oversize images stay in
  // a structured images[] array the app appends after the stream.
  const decorateUserMessage = (message: any): any => {
    const text = historyBlocksText(message?.content);
    const { stream, overflow } = withImageLines(
      renderUserStream(text),
      historyImages(message?.content),
    );
    if (!stream && overflow.length === 0) return message;
    const payload: any = { ...message };
    if (stream) payload.stream = stream;
    if (overflow.length > 0) payload.images = overflow;
    return payload;
  };

  pi.on("message_start", async (e) => {
    const payload = e.message?.role === "user" ? decorateUserMessage(e.message) : e.message;
    emitAgentEvent({ type: "message_start", message: payload });
  });

  pi.on("message_end", async (e, ctx) => {
    let msgPayload: any = e.message;
    if (e.message?.role === "user") {
      msgPayload = decorateUserMessage(e.message);
    } else {
      // Custom-message entries: mirror the extension's own rendering by
      // re-rendering its Component at the phone's width.
      const theme = ctx?.hasUI ? ctx.ui.theme : undefined;
      const customStream = linesToStream(renderCustomMessageLines(e.message, theme));
      // Extract images from message content (e.g. assistant responses containing
      // images): embeddable ones ride the stream as OSC 1337, the rest go in images[].
      const msgImages: any[] = [];
      const mc = (e.message as any)?.content;
      if (Array.isArray(mc)) {
        for (const block of mc) {
          if (block?.type === "image" && block?.data) {
            const data = typeof block.data === "string" ? block.data : JSON.stringify(block.data);
            if (Buffer.byteLength(data, "base64") <= TOOL_IMAGE_MAX_BYTES) {
              msgImages.push({ data, mimeType: block.mimeType || "image/png" });
            }
          }
        }
      }
      const { stream, overflow } = withImageLines(customStream, msgImages);
      if (stream || overflow.length > 0) {
        msgPayload = { ...e.message };
        if (stream) msgPayload.stream = stream;
        if (overflow.length > 0) msgPayload.images = overflow;
      }
    }
    emitAgentEvent({
      type: "message_end",
      message: msgPayload,
    });
  });

  // Accumulate streaming deltas so text_end / thinking_end can ship the final
  // host-rendered stream, and throttled ansi_snapshot events give the phone
  // styled markdown WHILE the text streams (it re-renders the in-flight
  // bubble from each snapshot). pi can interleave thinking and text streams,
  // so each gets its own accumulator.
  let liveText = "";
  let liveThinking = "";
  let lastSnapshotAt = 0;
  const SNAPSHOT_THROTTLE_MS = 150;

  const maybeSnapshot = (render: () => string | undefined): void => {
    const now = Date.now();
    if (now - lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return;
    lastSnapshotAt = now;
    const stream = render();
    if (stream) {
      emitAgentEvent({ type: "message_update", eventType: "ansi_snapshot", stream });
    }
  };

  pi.on("message_update", async (e: any) => {
    const evt = e.assistantMessageEvent;
    if (!evt) return;
    switch (evt.type) {
      case "text_start":
        liveText = "";
        emitAgentEvent({ type: "message_update", eventType: "text_start" });
        break;
      case "text_delta":
        liveText += evt.delta ?? "";
        emitAgentEvent({ type: "message_update", eventType: "text_delta", delta: evt.delta ?? "" });
        maybeSnapshot(() => renderAssistantStream(liveText));
        break;
      case "text_end": {
        const stream = renderAssistantStream(liveText);
        liveText = "";
        emitAgentEvent({ type: "message_update", eventType: "text_end", ...(stream ? { stream } : {}) });
        break;
      }
      case "thinking_start":
        liveThinking = "";
        emitAgentEvent({ type: "message_update", eventType: "thinking_start" });
        break;
      case "thinking_delta":
        liveThinking += evt.delta ?? "";
        emitAgentEvent({ type: "message_update", eventType: "thinking_delta", delta: evt.delta ?? "" });
        maybeSnapshot(() => renderThinkingStream(liveThinking));
        break;
      case "thinking_end": {
        const stream = renderThinkingStream(liveThinking);
        liveThinking = "";
        emitAgentEvent({ type: "message_update", eventType: "thinking_end", ...(stream ? { stream } : {}) });
        break;
      }
      case "done":
        emitAgentEvent({ type: "message_update", eventType: "done", reason: (evt as any).reason ?? "" });
        break;
      case "error":
        emitAgentEvent({ type: "message_update", eventType: "error", message: (evt as any).message ?? "" });
        break;
    }
  });

  // ── Tool events ───────────────────────────────────────────────────────

  // toolCallId → args, kept from tool_start so tool_end can render the full
  // tool display (header + args + diff + result) without re-parsing anything.
  const liveToolArgs = new Map<string, any>();

  pi.on("tool_execution_start", async (e) => {
    liveToolArgs.set(e.toolCallId, e.args ?? {});
    emitAgentEvent({
      type: "tool_start",
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      args: e.args ?? {},
    });
  });

  pi.on("tool_execution_update", async (e: any) => {
    const content = Array.isArray(e.partialResult?.content)
      ? e.partialResult.content.slice(-1).map((c: any) => c.text ?? "").join("")
      : "";
    if (content) {
      emitAgentEvent({
        type: "tool_update",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        content,
      });
    }
  });

  pi.on("tool_execution_end", async (e: any, ctx: any) => {
    const cr = e.result;
    // Extract content: try .text[] first, then .content[] (file read results)
    let content = "";
    // Extract images from tool results (e.g. `read` on image files returns
    // base64 data in the content array). These are sent to the phone separately
    // so the app can render them inline; they're excluded from `content` text
    // to avoid shipping megabytes of base64 in a text field.
    const extractImages = (obj: any, maxBytes = TOOL_IMAGE_MAX_BYTES): any[] => {
      const imgs: any[] = [];
      if (Array.isArray(obj?.content)) {
        for (const c of obj.content) {
          if (c?.type === "image" && c?.data && typeof c.data === "string") {
            const size = Buffer.byteLength(c.data, "base64");
            if (size <= maxBytes) {
              imgs.push({ data: c.data, mimeType: c.mimeType || "image/png" });
            }
          }
        }
      }
      if (obj?.imageData && typeof obj.imageData === "string" && obj?.imageMimeType) {
        const size = Buffer.byteLength(obj.imageData, "base64");
        if (size <= maxBytes) {
          imgs.push({ data: obj.imageData, mimeType: obj.imageMimeType });
        }
      }
      return imgs;
    };
    const toolImages = extractImages(cr);
    if (Array.isArray(cr?.content)) {
      content = cr.content.map((c: any) => c.type === "image" ? "" : (c.text ?? c.content ?? "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    } else if (typeof cr?.content === "string") {
      content = cr.content;
    }
    // Also try flat text fields on the result
    if (!content && typeof cr === "object") {
      content = (cr.text as string) ?? (cr.output as string) ?? "";
    }
    // Render the complete tool display (header, args, diffs, result) with pi's
    // own ToolExecutionComponent — collapsed + expanded variants. Falls back to
    // the bare result renderer, then to plain `content` text on old pi builds.
    const args = liveToolArgs.get(e.toolCallId);
    liveToolArgs.delete(e.toolCallId);
    const resultContent = Array.isArray(cr?.content)
      ? cr.content
      : content ? [{ type: "text", text: content }] : [];
    let { stream, streamExpanded } = renderToolStreams(
      e.toolName ?? "", e.toolCallId, args,
      { content: resultContent, isError: e.isError === true, details: cr?.details },
    );
    if (!stream) {
      const theme = ctx?.hasUI ? ctx.ui.theme : undefined;
      stream = linesToStream(renderToolResultLines(e.toolName ?? "", cr, theme));
      streamExpanded = undefined;
    }
    // Embeddable images ride the stream as OSC 1337; oversize ones stay in images[].
    const withImgs = withImageLines(stream, toolImages);
    const expandedWithImgs = streamExpanded ? withImageLines(streamExpanded, toolImages).stream : undefined;
    emitAgentEvent({
      type: "tool_end",
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? "",
      content,
      isError: e.isError ?? false,
      ...(withImgs.stream ? { stream: withImgs.stream } : {}),
      ...(expandedWithImgs ? { streamExpanded: expandedWithImgs } : {}),
      ...((withImgs.stream ? withImgs.overflow : toolImages).length > 0
        ? { images: withImgs.stream ? withImgs.overflow : toolImages }
        : {}),
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

  pi.on("session_start", async (_e, ctx) => {
    // Capture the active theme up front so the first phone connection mirrors it.
    syncTheme(ctx.hasUI ? ctx.ui.theme : undefined);
    // Capture the UI context so host/peer state shows as a footer chip, and
    // re-assert it now — a re-imported session (/new, /resume) gets a fresh footer.
    selfUi = ctx.hasUI ? ctx.ui : null;
    refreshRemoteStatus();
    // Capture the live TUI instance for the screen mirror. A widget factory is
    // the only extension-visible path to it; this one renders nothing.
    if (ctx.hasUI) {
      try {
        ctx.ui.setWidget("__remote-mirror-probe", (tui: any) => {
          attachMirror(tui);
          return { render: () => [], invalidate: () => {} };
        }, { placement: "belowEditor" });
      } catch { /* widget API unavailable — mirror stays off */ }
    }
    // Capture the session manager so the session title (first user message /
    // /name) is right the moment the phone connects, before any agent turn.
    selfSm = ctx.sessionManager;
    // Auto-start on session load. Set PI_REMOTE_CONTROL_NO_AUTOSTART=1 to disable.
    if (process.env.PI_REMOTE_CONTROL_NO_AUTOSTART !== "1") {
      try { start(pi); } catch { /* ignore */ }
    }
  });

  pi.on("session_shutdown", async () => {
    // Session replacement (/new, /resume) re-imports this module. KEEP the
    // persistent server + client sockets (on RC) so the phone stays connected
    // and the next instance adopts them — no disconnect, no rebind gap. Only
    // tear down peer-mode state, which is per-instance. A real shutdown (/quit)
    // exits the process, which frees the server regardless.
    if (peerSock) { try { peerSock.close(); } catch { /* ignore */ } }
    peerSock = null;
    mode = "stopped";
  });
}
