# Mirror framerate — measured analysis and fix plan

> **STATUS (2026-08-03): P1–P3 implemented and A/B-verified** (commit on
> `stock-pi-compat`). Every number in the table below was re-measured on a
> fixed harness that asserts which build owns the port before measuring — an
> earlier harness bug let stale hosts survive between runs, which had produced
> a contaminated "old" echo p95 (365 ms) and slow-link fps (3.69); the
> corrected baseline numbers are in the A/B table at the end.
>
> | verified A/B (2.2 MB session, 45 cols) | old | new (P1–P3) |
> |---|---|---|
> | streaming fps, WC=1 | 1.69 | **6.38** (3.8×) |
> | streaming fps, WC=0 | 1.88 | **3.63** |
> | streaming fps, WC=1, 30 KB/s link | 1.94 | **6.19** |
> | peer tab, 22.5 s of streaming | 2,437 KB (104 keyframes) | **37 KB** (103 diffs, 66×) |
> | idle typing echo p50/p95 | 104/120 ms | 106/128 ms (unchanged, as expected) |
>
> P2's threshold change showed no effect on idle typing (the contaminated run
> had suggested otherwise); it matters only when a human is at the desk while
> renders cost 40–100 ms, which the A/B doesn't isolate. Kept on mechanism.

Measured 2026-08-03 against stock pi 0.83.0, 2.2 MB session (~2000 buffer lines),
phone width 45 cols, instrumented extension (server timestamps in every frame,
per-tick pump counters). Client negotiates `diff` + `deflate` exactly like the
app. "WC" = `PI_REMOTE_WIDTH_CACHE`.

## Numbers

| scenario | fps | render ms | echo p50/p95 | wire, 16 s | staleness p50 |
|---|---|---|---|---|---|
| streaming, WC=0 | 1.88 | 108–124 | — | 12 KB | 1 ms |
| streaming, WC=1 | 1.63 | 59–85 | — | 10 KB | 1 ms |
| typing, WC=0 | — | — | 144 / 269 ms | 6 KB | 0 ms |
| typing, WC=1 | — | — | 130 / 365 ms | 6 KB | 0 ms |
| streaming, WC=1, **30 KB/s link** | 1.94 | 59–85 | — | 12 KB | **1 ms** |

Connect keyframe: 237 KB raw → **23.1 KB wire** (10.3× deflate) — ~0.8 s once at
30 KB/s. Steady-state diffs: ~400 B/frame (p50 20 rows during streaming, 1 row
while typing).

## Findings, ranked

**1. The scheduler, not the network and not the render, sets the framerate.**
During streaming the pump counters read `quiet_defer=11–12` of 16 ticks/s: the
desktop renders continuously while the agent streams, so the "desktop quiet for
50 ms" test never passes and every frame waits for the 500 ms `MAX_DEFER`
fallback. Frame period ≈ 500 + render ≈ 560–620 ms → the observed 1.6–1.9 fps.
Turning the width cache on made renders 2× cheaper and fps did not move.
The deferral exists to protect a human at the host terminal — but it fires
hardest exactly when the phone user is watching (agent streaming), and it fires
whether or not anyone is at the desk. `lastDesktopRenderAt` conflates "desktop
is rendering" with "a human is at the desktop".

**2. The wire is a non-problem for the phone's own tab.** Diff+deflate reduce
16 s of streaming to ~12 KB; at a bad-cell 30 KB/s the numbers are identical to
an unthrottled link, staleness 1 ms. Row indices live in buffer space, so
appends don't shift earlier rows and diffs stay tail-sized. This part of the
design is right and needs nothing.

**3. Peer tabs are broken by design on slow links.** The host relay
(`case "peer_event"`, extension.ts) forwards every peer frame as a **full
keyframe** — `sendMirrorPayload` directly, with none of the self-path machinery:
no row-diffing, no `MIRROR_MAX_BUFFERED` gate, no adaptive cadence. That is
~23 KB × ~2 fps ≈ 46 KB/s *sustained* per watched peer tab. Over a 30 KB/s cell
VPN the socket queue grows without bound and the viewer watches an ever-staler
screen until the connection dies. (LAN hides this — 46 KB/s is nothing on WiFi.)

**4. The typing bypass threshold straddles reality.** The echo fast-path only
engages when the last render cost ≤ `MIRROR_CHEAP_RENDER_MS` = 40 ms. Cached
renders on a long session run 59–85 ms, uncached 108–124 ms — so on exactly the
sessions that need it, the bypass engages rarely (hence echo p95 269–365 ms
while p50 sits at ~130–145 ms).

**5. Render cost is the second-order term.** WC=1 halves it (108–124 → 59–85 ms
during streaming; 39–52 ms in pure alternation). The residual is pi-tui
re-rendering the *churning tail* (the streaming message re-wraps every token) —
no cache can help that; only the deferral fix converts the savings into fps.

**6. `bufferedAmount` under-reports queueing on real links.** It sees Node's
userspace queue only; kernel socket buffers and VPN bufferbloat hold seconds of
data invisibly. The 256 KB hard gate + 32 KB soft-step barely engage before the
user already perceives lag. The loopback throttle test *overstates* how well
backpressure works — on a real cell VPN the gates engage later. Only an
application-level ack can see the true in-flight depth.

Not measured: phone-side decode/render cost (no device profiling in this pass).
The app renders only the latest frame, so host fps is the ceiling either way.

## Fix plan

**P1 — presence-aware deferral (host-only, the framerate fix).**
Stamp `lastLocalInputAt` on any TUI input that did *not* come from
`injectMirrorInput` (wrap `handleInput` in `attachMirror`; set a flag during
injection). If no local input for ~10 s, nobody is at the desk: skip the
quiet/defer test entirely and run at pump cadence. Expected: 1.9 → ~7 fps on
the 2.2 MB session with WC=1 (render-bound), ~15 fps on typical sessions.
The desktop keeps today's exact protection whenever someone is actually typing
or scrolling there — including the scrolled-back hard skip, unchanged.

**P2 — fix the bypass threshold (host-only, one constant).**
`MIRROR_CHEAP_RENDER_MS` 40 → 100 (or `MIRROR_MAX_DEFER_MS / 5`). With P1 this
matters only while someone *is* at the desk and the phone types anyway; it
flattens the echo tail (p95 → ≈ p50 + one render).

**P3 — give peer tabs the self-path machinery (host-only).**
At the relay, keep per-(client, agent) last-sent lines and reuse the existing
diff/backpressure/cadence path instead of blind `sendMirrorPayload`. The app
already handles `mirror_diff` (verify its diff state is keyed per agentId — if
not, that's a small app fix). Turns 46 KB/s per peer tab into the same ~1 KB/s
the self tab costs, and stops the unbounded queue.

**P4 — ack-based flow control (host + app, protocol addition).**
App echoes `{type:"mirror_ack", seq}`; host keeps at most ~2 unacked frames per
client, dropping intermediate frames (the app only shows the newest anyway).
Backward-compatible: no acks seen → today's behavior. This is the only real
answer to finding 6 on high-RTT links; do it after P1–P3, which may already be
good enough in practice.

**P5 — upstream the width cache** (`~/pi-fork` branch `feat/tui-width-cache`,
measured 2× on renders). Independent of the above; the deferral fix is what
converts it into visible fps.

Rough sizing: P1+P2 ≈ 30 lines in extension.ts; P3 ≈ 60; P4 ≈ 40 host + app
change. P1 is where the user-visible improvement lives.
