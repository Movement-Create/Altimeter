# Chat UI Fixes & Improvements

**Date:** 2026-04-12
**Scope:** `src/index.ts`, `src/providers/google.ts`, `vscode-extension/src/chat-provider.ts`, `vscode-extension/src/agent-runner.ts`, `vscode-extension/media/chat.js`
**Trigger:** Multiple bugs in the VS Code extension chat panel — installation detection, schema errors, duplicate messages, missing tool logs, file reference autocomplete

---

## Summary

Fixed a chain of issues preventing the Altimeter VS Code extension from working correctly: build/installation detection, Gemini API compatibility, chat display bugs (duplicates, metadata leaking, missing tool steps), and file reference autocomplete.

---

## Changes by Area

### 1. Build & Installation Detection

**Problem:** Extension error — `Altimeter installation not found. no dist/index.js`
**Root cause:** TypeScript had never been compiled; `node_modules/` and `dist/` were missing.
**Fix:**
- Ran `npm install` (435 packages)
- Ran `npm run build` (tsc) to compile `src/` → `dist/index.js`

**Files:** None changed — build artifacts created.

---

### 2. Gemini API Schema Compatibility

**Problem:** Gemini API 400 error — `Unknown name "additionalProperties"` in tool function declarations.
**Root cause:** `convertTools()` in the Google provider passed `input_schema` directly to Gemini without stripping unsupported JSON Schema fields. The registry's `zodToJsonSchema()` only stripped `additionalProperties` at the top level, not recursively in nested `items`.
**Fix:** Added `sanitizeSchema()` method to `GoogleProvider` that recursively strips unsupported fields (`additionalProperties`, `$schema`, `$ref`, `$defs`, `allOf`, `anyOf`, `oneOf`, `not`, `default`, `examples`) from the full schema tree before sending to Gemini.

**Files:**
- `src/providers/google.ts` — Added `sanitizeSchema()`, called in `convertTools()`

---

### 3. Raw JSON / Metadata Leaking into Chat

**Problem:** Chat responses showed raw `[Tool] doc_create { ... }` JSON, `Session: xxx`, `Model: xxx`, and `[1 turn · N tokens]` stats as visible text.
**Root cause:** The CLI's `run` command wrote tool calls, session info, and stats to **stdout** via `console.log`. The extension's streaming filter only caught `[tool:` (lowercase) and top-level `{` lines, missing `[Tool]` (capital), multi-line JSON properties, and metadata lines.
**Fix:**
- **`src/index.ts`** — Moved all non-text output to `process.stderr.write`:
  - `Session: ...` and `Model: ...` lines
  - `[Tool] name` + JSON input
  - `[Error] ...` tool errors
  - `[N turns · tokens · $cost]` stats
- **`vscode-extension/src/agent-runner.ts`** — Added defense-in-depth filters in stdout streaming: `[Tool]`, `Session:`, `Model:`, stats regex

**Files:**
- `src/index.ts` — `console.log` → `process.stderr.write` for tool/meta/stats output
- `vscode-extension/src/agent-runner.ts` — Additional stdout filters

---

### 4. Duplicate Messages in Chat

**Problem:** Every response appeared twice — once from streaming, once from the full `addMessage` post.
**Root cause:** `_streamingMessageStarted` was never set to `true` when `onChunk` fired. After streaming ended, the code at line 127 saw `!_streamingMessageStarted` and posted the full response again.
**Fix:** Set `this._streamingMessageStarted = true` in the `onChunk` callback.

**Files:**
- `vscode-extension/src/chat-provider.ts` — Added flag set in `onChunk`

---

### 5. Tool Call Visibility in Chat UI

**Problem:** Tool call badges showed `TOOL bash` with `running...` but never displayed the actual command or updated to `done`.
**Root cause:**
- Tool output was on stderr but the extension only parsed stdout (and only for `[tool:]` lowercase pattern)
- No `[ToolDone]` signal existed — successful results were silently dropped
**Fix:**
- **`src/index.ts`** — Added `[ToolDone] preview` stderr output for successful tool results
- **`vscode-extension/src/chat-provider.ts`** — Added `_parseStderrForTools()`:
  - Parses `[Tool] name`, `[ToolDone] result`, `[Error] message` from stderr
  - Tracks `_lastToolName` and accumulates input JSON between events
  - Sends `toolCall`, `toolInput`, `toolResult` messages to webview
- **`vscode-extension/src/agent-runner.ts`** — Strips ANSI escape codes from stderr before passing to `onStderr` consumers (abstraction boundary fix from /simplify review)
- **`vscode-extension/media/chat.js`** — Added:
  - `findRunningToolCall()` — finds tool badge by name with fallback to any running badge
  - `updateToolInput()` — shows command details inside expandable tool badge
  - `toolInput` message handler in the event listener

**Files:**
- `src/index.ts` — `[ToolDone]` output
- `vscode-extension/src/chat-provider.ts` — `_parseStderrForTools()`, `_lastToolName`, `_lastToolInput`
- `vscode-extension/src/agent-runner.ts` — ANSI stripping in stderr callback
- `vscode-extension/media/chat.js` — `updateToolInput()`, `findRunningToolCall()`

---

### 6. File Reference Autocomplete (@ → /)

**Problem:** `@` file reference autocomplete was not working; user requested switching to `/`.
**Root cause:** No workspace folder was open (required for `vscode.workspace.findFiles`). Also changed trigger character from `@` to `/` per user preference.
**Fix:**
- **`vscode-extension/media/chat.js`** — Renamed `handleAtMention` → `handleSlashMention`, `atStartPos` → `slashStartPos`, `@` → `/` in `insertFileRef`. Added guard: `/` only triggers when at start of input or preceded by a space.
- **`vscode-extension/src/chat-provider.ts`** — Updated `_expandPromptReferences` to match `/path/to/file.ext` instead of `@path/to/file.ext`. Updated placeholder and hint text.
- **No-workspace hint:** When no folder is open, autocomplete now shows "Open a folder to reference files" instead of silently failing.

**Files:**
- `vscode-extension/media/chat.js` — Slash autocomplete logic
- `vscode-extension/src/chat-provider.ts` — Prompt expansion, placeholder, hint, `_handleRequestFiles` workspace check

---

## Code Quality (from /simplify review)

Three parallel review agents (reuse, quality, efficiency) identified one actionable issue:
- **ANSI stripping moved to agent-runner** — `_parseStderrForTools` originally stripped ANSI codes itself; moved to `agent-runner.ts` stderr handler so the chat-provider receives clean strings (proper abstraction boundary).

All other findings (shared constants, `_streamingMessageStarted` redundancy) were evaluated and skipped as over-engineering for the current scale.
