# Remote TTY — how the mirror works, and what a stable upstream surface would look like

Scope: the screen-mirror path only — compose a frame at the remote client's
width, ship it, feed keys back.

## What it does

pi renders its whole UI — messages, widgets, overlays, selectors, images — as an
array of ANSI lines. The mirror renders that array **a second time at the phone's
width** and ships it over WebSocket; keys come back and go into the same input
path a real terminal would use. The remote client is a dumb TTY: it draws lines
and forwards bytes. No per-feature bridging — a new pi surface appears on the
phone the day it lands, with no extension change.

    doRender()  ──patch──►  mark dirty
                              │  (throttled pump, ~15fps, off the desktop path)
                              ▼
                        render(phoneWidth) → composite overlays → cursor
                              │
                              ▼
                   row-diff vs last frame sent → deflate → ws
                              ▲
                        keys ─┘  → split into keystroke events → handleInput

Everything lives in `extension.ts` (`// ── Screen mirror ──`). **Zero pi
changes are required for this path** — it is all runtime reach-in, and it runs
on stock upstream pi.

## The surface it depends on

| What | Where | Status |
|---|---|---|
| The live `TUI` instance | `ctx.ui.setWidget(key, (tui, theme) => Component)` | **Public and documented.** A widget factory is handed the real TUI. The mirror registers a probe widget that renders nothing, purely to capture it. |
| `tui.render(width)` | `Container.render` | Public. |
| `getCapabilities` / `setCapabilities` | `@earendil-works/pi-tui` | Public, but **process-global** — flipped to `images: "kitty"` around the phone render and restored, safe only because pi-tui's image cache is keyed by width. |
| `tui.doRender()` | `protected abstract` | Monkey-patched. |
| `compositeOverlays`, `extractCursorPosition`, `applyLineResets` | `protected` | Called directly. |
| `tui.handleInput(data)` | `private` | Called directly, one keystroke event per call. |

`private`/`protected` are compile-time only, so all of this works — and all of it
can break in a patch release with no deprecation, no type error, and no test
failure. The extension probes for these members at startup and disables the
mirror loudly if any go missing, but a supported surface would make the
breakage a compile error upstream instead of a runtime surprise downstream.

## How this fits upstream's model

- **pi's philosophy is a minimal core**: features belong in extensions, and
  even hook points are added sparingly.
- **The sanctioned remote story is RPC mode and the SDK** (`docs/rpc.md`,
  `docs/sdk.md`): stream structured events, *build your own UI*. The listed use
  case is literally "build a custom UI (web, desktop, mobile)".
- **But pi already forwards UI to non-TUI clients.** RPC mode's *Extension UI
  Protocol* turns `ctx.ui.select/confirm/input/setWidget/...` into wire messages
  for a remote client to render. The precedent exists; it just stops short of the
  composed frame. `docs/rpc.md` even enumerates what's degraded there —
  `custom()`, `setFooter()`, `setHeader()`, `setEditorComponent()` — *"because
  they require direct TUI access."* That list is exactly the gap the mirror fills.
- **pi hands extensions the raw `TUI`** in widget/header/footer/editor factories.
  Deep TUI access from an extension is not a violation of the model; it *is* the
  model. What's missing is only a *stable* way to read the composed output and
  write input.

So the honest positioning is not "let extensions touch the TUI" (already true),
nor "add a remote protocol" (already exists, in two forms). It is: **the composed
frame and the input entry point are the last two things an extension can only
reach through private members.** Two supported methods — observe the composed
frame, inject input — would keep the whole mirror in extension land (where pi
wants features to live) at zero cost when unused, and would answer the
"why not RPC mode?" question directly: RPC gives you events, not pi's
rendering — a client would have to reimplement markdown, diff cards, selectors,
spinners, and images, and re-implement each new surface forever. The mirror is
how you get pi's UI, not a second UI that drifts.

## Open design questions for an upstream ask

- **Width.** Today the mirror re-renders at the client's width, which
  double-renders and thrashes pi-tui's width-keyed caches (see
  `FRAMERATE-ANALYSIS.md` and the `PI_REMOTE_WIDTH_CACHE` patch). The
  alternative — tmux-style "smallest client wins" — is one width setter instead
  of a whole second render path, and is arguably a cleaner ask.
- **Images.** The `setCapabilities` flip is process-global and the one genuinely
  ugly part. A per-render capability override would be a legitimate, tiny,
  separately-justifiable ask.
- **Frames vs. bytes.** Asking for `string[]` + cursor is a smaller commitment
  than a terminal-byte tap, and it's what the extension already consumes.
