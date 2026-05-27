// Throwaway mock pi host to verify on-device rendering of host-supplied
// ansiLines (the rendered-presentation bridge). Sends a custom message whose
// `ansiLines` mimic what an extension's Component.render(width) would produce.
// Run from the repo root: `node mock-pi-server.cjs`
const path = require("path");
const { WebSocketServer } = require(path.join(__dirname, "node_modules", "ws"));
const E = "\x1b";
const fg = (r, g, b, s) => `${E}[38;2;${r};${g};${b}m${s}${E}[39m`;
const bg = (r, g, b, s) => `${E}[48;2;${r};${g};${b}m${s}${E}[49m`;

const ansiLines = [
  fg(138, 190, 183, "─── subagent: scout ──────────────"),
  fg(128, 128, 128, "Task: ") + fg(102, 102, 102, "review the auth module"),
  "",
  bg(40, 50, 40, fg(181, 189, 104, "  ✓ done  ")) + "  " + fg(240, 240, 240, "3 findings, 0 blockers"),
  fg(204, 102, 102, "  ! warning ") + fg(200, 200, 200, "token refresh window too long"),
  fg(102, 102, 102, "  12.4k tokens · 8 tool calls"),
];

const wss = new WebSocketServer({ port: 8799, host: "127.0.0.1" });
wss.on("connection", (ws) => {
  const agentId = "demo-agent";
  console.log("[mock] client connected");
  ws.send(JSON.stringify({ type: "connected", clients: 1 }));
  ws.send(JSON.stringify({ type: "session_list", sessions: [{ id: agentId, name: "pi (demo)", kind: "self", status: "idle" }] }));
  ws.send(JSON.stringify({ type: "theme_info", theme: { name: "dark", isLight: false, colors: {} } }));
  ws.on("message", (m) => console.log("[mock] recv:", m.toString().slice(0, 100)));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "message_start", agentId, message: { role: "user", content: "use a subagent to review auth" } }));
    ws.send(JSON.stringify({ type: "message_end", agentId, message: { role: "custom", customType: "subagent", ansiLines } }));
    console.log("[mock] sent custom message_end with ansiLines");
  }, 500);
});
console.log("[mock] listening on 127.0.0.1:8799");
