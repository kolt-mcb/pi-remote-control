# Pi Remote Control — Implementation Plan

## Phase 0: Clean up debug code (blocking)

Remove auto-connect + debug logging added for headless testing. The app should launch to the Connect screen for user input.

| File | Change |
|------|--------|
| `MainActivity.kt` | Remove `autoConnect`, `autoSendPrompt` calls, all `Log.d(TAG,...)` calls, `LaunchedEffect(Unit)` block |
| `ChatViewModel.kt` | Remove `autoConnect()`, `autoSendPrompt()` |
| `PiWebSocket.kt` | Remove `Log.d` / `Log.e` calls (optional — keep for production debug) |

---

## Phase 1: Stability & correctness (must-have)

### 1a. Fix `MsgId` thread safety

`MsgId` uses a plain `var n = 0` but `PiWebSocket.onMessage()` runs on the OkHttp dispatcher thread while `ChatViewModel` methods run on the main thread. Concurrent calls to `MsgId.next()` can race.

**Fix:** `ChatViewModel.kt` → use `AtomicInteger`
```kotlin
import java.util.concurrent.atomic.AtomicInteger
object MsgId { private val counter = AtomicInteger(0); fun next(): String = counter.incrementAndGet().toString() }
```

### 1b. `thinking_end` drops thinking messages

The `thinking_end` handler does:
```kotlin
_m.value = _m.value.filterNot { it.type == MessageToolType.Streaming && it.content.isBlank() }
```
This removes blank streaming placeholders, but if thinking produced visible text it stays as a `Streaming` message forever instead of being converted to a visible "Thinking" message type.

**Fix:** Add `Thinking` to `MessageToolType` enum, show thinking as a collapsible gray block in the chat UI, convert thinking content to `Thinking` type on `thinking_end` instead of dropping it.

### 1c. Custom JSON parser is fragile

The hand-rolled `PS` parser doesn't handle:
- Numeric values (returns string, not `Double`/`Int`)
- Nested arrays
- Edge cases like `\"` in numbers

**Fix:** Use `kotlinx.serialization` (Gson-style) or the built-in `kotlinx.serialization.json.Json` from the Kotlin stdlib. Add dependency:
```kotlin
implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
```
Replace `JP` / `PS` / `Js` objects with typed data classes:
```kotlin
@Serializable
data class WsMessage(val type: String, val message: MessageDto?, ...)
```

---

## Phase 2: New protocol commands (steer, follow_up)

Extension supports `steer` and `follow_up` but Android app only sends `prompt`.

### 2a. Add `sendSteer()` and `sendFollowUp()` to PiWebSocket

```kotlin
fun sendSteer(txt: String) { sock?.send("{\"type\":\"steer\",\"message\":\"${Js.e(txt)}\"}") }
fun sendFollowUp(txt: String) { sock?.send("{\"type\":\"follow_up\",\"message\":\"${Js.e(txt)}\"}") }
```

### 2b. Add controls in ChatScreen

Two small buttons in the input area:
- **Steer** (⇧ icon) — disabled while agent is idle, sends a steering hint
- **Follow-up** (↩ icon) — shown after agent_end, sends a follow_up

The main send button sends `prompt`. When agent is busy, send is disabled, "Steer" appears. When agent is idle, send is enabled, "Follow-up" appears after a turn completes.

### 2c. UI state for agent busy/idle

Track `agentBusy: MutableStateFlow<Boolean>` — set true on `agent_start`, false on `agent_end`. Show spinning indicator in header when busy.

---

## Phase 3: Chat persistence

### 3a. Add Room Database

Add dependencies (`build.gradle.kts`):
```kotlin
implementation("androidx.room:room-runtime:2.6.1")
implementation("androidx.room:room-ktx:2.6.1")
kapt("androidx.room:room-compiler:2.6.1")
```

### 3b. ChatMessage entity + DAO

```kotlin
@Entity(tableName = "messages")
data class ChatMessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val url: String,       // which server this message belongs to
    val index: Int,        // order within the session
    val type: String,
    val toolCallId: String,
    val toolName: String,
    val content: String,
    val isError: Boolean,
    val timestamp: Long = System.currentTimeMillis()
)
```

### 3c. Persist on insert, load on connect

- On `connect()` → load messages from DB for this URL
- On each message insert → insert into DB on IO dispatcher
- On `disconnect()` → DB already has everything (no flush needed)
- Show "Last X messages" or all on reconnect

---

## Phase 4: Connection memory + UX

### 4a. Remember last server URL

Use `DataStore` (or SharedPreferences) to persist the last used URL. Auto-fill it on app launch.

```kotlin
// Proto or preferences key
private val PREF_URL = "last_server_url"
```

### 4b. URL history

Store last 5 connected URLs in a list. Show as chips below the URL input field on the Connect screen. Tap to fill + connect.

### 4c. Auto-reconnect with backoff

On `onFailure`, attempt reconnection:
- 1st retry: 2s
- 2nd: 4s
- 3rd: 8s
- cap at 30s, max 10 retries
Show "Reconnecting..." status

### 4d. QR code scan to connect

CameraX or ZXing barcode scanner. Detect `piremote://192.168.1.128:8765` → auto-connect.

Dependency:
```kotlin
implementation("com.google.mlkit:barcode-scanning:17.3.0")
```

---

## Phase 5: UI polish

### 5a. Thinking messages display

Show thought process as a gray italic block between user message and response:
```
> thought: Analyzing the user's request...
```

Collapsible with tap.

### 5b. Tool results collapsible

Long tool output (>200 chars) → show first 3 lines + "Show more" chevron.

### 5c. Copy button on tool output

IconButton (clipboard icon) that copies `msg.content` to system clipboard with toast confirmation.

### 5d. System dark/light theme

Currently hardcoded `darkColorScheme`. Add light scheme:
```kotlin
private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF1F6FEB),
    surface = Color(0xFFFFFFFF),
    // ...
)
val isDark = LocalInspectionMode.current || isSystemInDarkTheme()
```

### 5e. Enter = Send, Shift+Enter = newline

In the input `OutlinedTextField`, handle `ImeAction`:
```kotlin
keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send)
```
For multiline, show keyboard with shift-enter support.

### 5f. Timestamps on messages

Small timestamp (12h/24h) in the top-right of each message bubble.

---

## Phase 6: Background & notifications

### 6a. Foreground service

When connected, run a foreground service with a "Connected to Pi" notification. Prevents the OS from killing the connection.

### 6b. Push notification on agent_end

When agent finishes work while app is in background, show:
> "Pi completed: read 3 files, ran 2 tests"

Uses `NotificationManager` or WorkManager.

### 6c. WSS (TLS) support

Allow `wss://` URLs. OkHttp handles TLS automatically — just allow the scheme.

---

## Priority ordering

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| 🔴 Now | 0 (cleanup) | 15 min | Required for testing |
| 🔴 Now | 1a (MsgId fix) | 5 min | Prevents crashes |
| 🟡 Soon | 1b (thinking) | 30 min | Better UX |
| 🟡 Soon | 2 (steer/follow_up) | 1 hr | Core feature gap |
| 🟡 Soon | 4a (remember URL) | 30 min | Quality of life |
| 🟢 Next | 3 (Room DB) | 2 hr | Chat history |
| 🟢 Next | 4d (QR scan) | 2 hr | Easy connect |
| 🟢 Next | 5a-5f (UI polish) | 2-3 hr | Professional feel |
| 🔵 Later | 1c (JSON rewrite) | 3 hr | Robustness |
| 🔵 Later | 6 (background) | 3 hr | Advanced |
| 🔵 Later | 5d (light theme) | 1 hr | Nice to have |


---

## Completed (2026-05-17)

### Phase 0 ✅ — Clean up debug code
- Removed auto-connect, autoSendPrompt, all Log.d TAG debugging
- App now launches to Connect screen

### Phase 1a ✅ — MsgId thread safety  
- `private var n = 0` → `AtomicInteger(0)` via `counter.incrementAndGet()`

### Phase 1b ✅ — Thinking messages
- Added `Thinking` to `MessageToolType` enum
- `msgUpd` converts thinking text to `Thinking` ChatMessage on `thinking_end`
- UI shows collapsible "🤔 Thought" bubble with tap to expand

### Phase 2 ✅ — Steer / Follow-up
- `sendSteer()`, `sendFollowUp()` in PiWebSocket + ChatViewModel
- `busy` state: `agent_start` → `agent_end`
- Header shows purple "thinking..." when busy
- Filter chips for Steer (when busy) and Follow-up (when idle + messages)
- Send button adapts: prompt → steer → follow-up

### Phase 4a ✅ — Remember last URL  
- DataStore preferences `last_server_url`
- Auto-fills on app launch via `LaunchedEffect`

### Phase 4b ✅ — URL history
- DataStore `url_history` (Set<String>, max 10)
- Chips on Connect screen with ShortChip component

### Phase 4c ✅ — Auto-reconnect  
- Up to 10 retries with 2s → 4s → 8s → 16s → 32s backoff
- Stops reconnecting when user disconnects explicitly

### UI Pick ✅
- Copy button on ⚡ ToolBubble results
- Collapsible long tool output at 200+ chars
- Collapsible thinking bubbles  
- Error display on ConnectScreen


---

### Code Display ✅
Tool outputs containing source code now render with syntax highlighting, line numbers, and file path extraction.

**Protocol:** `tool_start` → `tool_end` → `message_start(role:toolResult)` → `ChatMessage(type=ToolResult)` → `ToolBubble()` → `CodeBlock()`

**Detection** (`Color.kt` → `CodeUtils`):
- `isCodeContent()` — matches patterns: `package`, `import`, `class`, `fun`, `val`, `var`, `//`, `function`, `const`, `file://`, etc.
- `extractFilePath()` — extracts full paths from `file://...` or `C:\...` or `home/...` with `.kt/.java/.ts/.js/.xml/.json/.py/.sh` extensions
- `countLines()` — counts message lines

**UI** (`Screens.kt` → `CodeBlock` + `AnnotatedDirectedLine`):
- 📄 Code icon (vs ⚡ for non-code tools)
- File path shown in header (blue accent)
- Line count badge
- Numbered code lines (up to 50, "… N more lines" for overflow)
- Syntax colors: keywords (red), strings (blue), comments (gray), numbers (blue)

**Tested:** ✅ Full flow verified with mock server Kotlin tool output, no crashes

### Phase 4d ✅ — QR scan to connect  
- CameraX (`camera-core`, `camera2`, `camera-lifecycle`, `camera-view`) + ML Kit barcode scanning
- `QrScanner.kt`: CameraX PreviewView + ImageAnalysis → ML Kit BarcodeScanner → detects `piremote://` or `ws://`
- Full-screen scanner with header bar, back button, camera permission check
- If camera unavailable: shows "Grant camera permission" + manual URL fallback
- Parses URLs: `piremote://IP:port` → `ws://IP:port`, bare `ws://` accepted as-is
- "⊡ Scan QR" button on ConnectScreen below Connect

### Code Display ✅
- `CodeUtils.isCodeContent()` detects `package`, `import`, `class`, `fun`, `val`, `//`, `file://`, etc.
- `CodeUtils.extractFilePath()` extracts `file://...` or `C:\...` or `home/...` paths
- `CodeBlock()` — numbered lines (up to 50), monospace font
- `AnnotatedDirectedLine()` — lightweight syntax coloring: keywords (red), strings (blue), comments (gray)
- ToolBubble shows 📄 icon, file path, line count for code
