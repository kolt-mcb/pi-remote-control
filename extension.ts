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

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
import { BUILTIN_SLASH_COMMANDS, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import qrcodeTerminal from "qrcode-terminal";

// ── Config ──────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8765;

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
  clientConns: Set<WebSocket>;
  peerConns: Map<string, WebSocket>;
  wsToPeerId: WeakMap<WebSocket, string>;
  peerPids: Map<string, number>;
  agents: Map<string, AgentSession>;
  currentPi: ExtensionAPI | null;
}
const RC: RCTransport = ((globalThis as any).__piRemoteTransport ??= {
  wss: null,
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
// The exceptions below REPLACE the session and would invalidate this
// extension's runtime, so they're routed to safe alternatives instead.
const REMOTE_STALES = new Set(["resume", "reload"]);

// All built-ins are offered to the phone so the menu mirrors pi's own.
function buildCommandList(): { name: string; description: string }[] {
  return BUILTIN_SLASH_COMMANDS.map((b) => ({ name: b.name, description: b.description }));
}

function sendCommandList(ws: WebSocket): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "command_list", commands: buildCommandList() }));
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
  RC.wss = server;

  let bound = false;
  let bindFailed = false;

  // ws emits EADDRINUSE asynchronously — before we can finish setup
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      bindFailed = true;
      RC.wss = null;
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
  refreshRemoteStatus(); // "remote · connecting…" in the footer (peerSock still null)

  const sock = new WebSocket(url);
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

// Run a slash command against THIS pi's own session. Used both for commands
// the phone targets at our self agent and for ones forwarded to us as a peer
// (route_slash_command). /compact and /quit use dedicated context actions;
// /resume and /reload are routed to notices; everything else (incl. /new) goes
// through pi's editor submit path via ctx.executeInputLine.
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
  } else if (REMOTE_STALES.has(commandName)) {
    // The phone is expected to intercept /resume locally and open its
    // in-place picker (which sends `resume_to` with the chosen path). If
    // we get here, the app didn't intercept — likely an older build, or
    // /resume was typed in an input that bypassed the slash menu. Point
    // the user at the right path.
    const hint =
      commandName === "resume" ? "use the slash menu (your app should open an in-place picker), or run /resume in the pi terminal"
      : /* reload */ "run /reload in the pi terminal";
    hostBcastClients(JSON.stringify({
      type: "extension_ui_request",
      method: "notify",
      id: `notify_stale_path_${Date.now()}`,
      message: `/${commandName} from the app — ${hint}.`,
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
    case "viewport": {
      // App reports its width in monospace columns so we re-render extension
      // components to fit the device. Clamp to a sane range.
      const cols = Number(cmd.cols);
      if (Number.isFinite(cols)) clientCols = Math.max(20, Math.min(400, Math.floor(cols)));
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
    // ── In-place /resume from the phone ────────────────────────────
    // The phone's slash menu intercepts /resume locally, opens an in-place
    // picker fed by get_saved_sessions, and sends `resume_to` with the path
    // the user chose. We call ctx.switchSession on the host: pi tears down
    // and rebinds for the new session; session_shutdown closes the WS, and
    // the phone reconnects to the freshly-loaded session.
    //
    // Deferred via setImmediate for the same reason as executeInputLine —
    // awaiting switchSession inside the command-context invalidates the
    // very context the call runs in.
    case "resume_to": {
      const path = typeof cmd.path === "string" ? cmd.path.trim() : "";
      if (!path) break;
      hostBcastClients(JSON.stringify({
        type: "extension_ui_request",
        method: "notify",
        id: `notify_resume_${Date.now()}`,
        message: "Switching session…",
        notifyType: "info",
      }));
      setImmediate(() => {
        void safeCtx(pi, "/resume", async (ctx) => {
          await ctx.switchSession(path);
        });
      });
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

  pi.on("message_start", async (e) => {
    emitAgentEvent({ type: "message_start", message: e.message });
  });

  pi.on("message_end", async (e, ctx) => {
    // For custom-message entries, mirror the extension's own rendering: re-render
    // its Component at the phone's width and attach the ANSI lines to the message.
    const theme = ctx?.hasUI ? ctx.ui.theme : undefined;
    const ansiLines = renderCustomMessageLines(e.message, theme);
    emitAgentEvent({
      type: "message_end",
      message: ansiLines ? { ...e.message, ansiLines } : e.message,
    });
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
    if (Array.isArray(cr?.content)) {
      content = cr.content.map((c: any) => c.text ?? c.content ?? "").join("\n");
    } else if (typeof cr?.content === "string") {
      content = cr.content;
    }
    // Also try flat text fields on the result
    if (!content && typeof cr === "object") {
      content = (cr.text as string) ?? (cr.output as string) ?? "";
    }
    // Mirror the tool's own result renderer (e.g. pi-subagents' per-step cards)
    // by re-rendering it at the phone's width; falls back to `content` text.
    const theme = ctx?.hasUI ? ctx.ui.theme : undefined;
    const ansiLines = renderToolResultLines(e.toolName ?? "", cr, theme);
    emitAgentEvent({
      type: "tool_end",
      toolCallId: e.toolCallId,
      toolName: e.toolName ?? "",
      content,
      isError: e.isError ?? false,
      ...(ansiLines ? { ansiLines } : {}),
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
