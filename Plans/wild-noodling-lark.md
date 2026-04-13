# Altimeter VS Code Extension — UI/UX Overhaul

## Context

The current Altimeter extension ships as a single `WebviewView` docked in the sidebar. Sessions live in a tree view that only shows raw JSONL files, there is no tab-per-session workflow, slash commands are limited to file references, model reasoning is not surfaced, and file paths in agent output are plain markdown links that cannot open in the editor. The goal is to bring the chat experience closer to native VS Code conventions: multi-tab sessions, a cleaner session list, collapsible thinking, clickable file links, and a richer slash-command palette — all while reusing the existing markdown renderer, streaming pipeline, and JSONL persistence.

This plan covers P0 and P1 items from the spec. P2/P3 items are tracked as follow-up work at the end.

## Current Architecture (what we reuse)

- Webview UI: [vscode-extension/media/chat.js](vscode-extension/media/chat.js) — already has markdown renderer, streaming accumulator, tool-call `<details>`, file autocomplete on `/`.
- Chat host: [vscode-extension/src/chat-provider.ts](vscode-extension/src/chat-provider.ts) — `AltimeterChatProvider` implements `WebviewViewProvider`, owns `_sessionId`, handles message passing, parses stderr for tool events.
- Sessions: [vscode-extension/src/sessions-provider.ts](vscode-extension/src/sessions-provider.ts) — reads `<altimeter>/sessions/*.jsonl`, derives titles from first user message, sorts by `created_at`.
- Commands/contributions: [vscode-extension/package.json](vscode-extension/package.json) — registers views, commands, keybindings (Ctrl+Shift+A, Ctrl+Shift+R).
- Agent streaming: [src/core/agent-loop.ts](src/core/agent-loop.ts) emits `onChunk`/`onStdout`/`onStderr`; extension forwards chunks as `streamChunk` messages.

## Changes

### 1. Tab-based sessions (P0)

Introduce a `SessionPanelManager` that owns a `Map<sessionId, WebviewPanel>` and opens each session as a `WebviewPanel` (tab) instead of only in the sidebar.

- New file: [vscode-extension/src/session-panel-manager.ts](vscode-extension/src/session-panel-manager.ts)
  - `openSession(id)`: if panel exists → `panel.reveal()`; else create new `WebviewPanel` with `viewType: 'altimeter.sessionPanel'`, wire disposal to remove from map.
  - Reuses the same HTML/JS bundle as `AltimeterChatProvider` (extract `getHtmlForWebview` into a shared helper in [vscode-extension/src/webview-html.ts](vscode-extension/src/webview-html.ts)).
  - Each panel has its own `AgentRunner` invocation bound to its `sessionId`.
- Refactor [vscode-extension/src/chat-provider.ts](vscode-extension/src/chat-provider.ts) so message handling (`_handleUserMessage`, `_runAgent`, `_parseStderrForTools`, `loadSession`) is extracted into a `ChatSessionController` class that both the sidebar `WebviewView` and the new `WebviewPanel` instances delegate to.
- Tab title: use session title (first user message, truncated to 30 chars) — already computed in [sessions-provider.ts#L77](vscode-extension/src/sessions-provider.ts#L77). Update via `panel.title = ...` after the first user message lands.
- Update `altimeter.openSession` command in [commands.ts](vscode-extension/src/commands.ts) to call `SessionPanelManager.openSession(id)` instead of `chatProvider.loadSession(id)`.

### 2. Session list cleanup (P0)

Modify [vscode-extension/src/sessions-provider.ts](vscode-extension/src/sessions-provider.ts):

- Add `_showAll: boolean` state (default `false`).
- In `getChildren()`, when `!_showAll`, slice sessions to the first 5 after sort; append a synthetic `TreeItem` "Show all (N)" whose command flips `_showAll` and fires `_onDidChangeTreeData`.
- Session label: keep derived title; description field = relative time (`3h ago`, `yesterday`) via a small `formatRelative(ts)` helper in the same file.
- Status badge: use `TreeItem.iconPath` with `new ThemeIcon('check'|'error'|'sync~spin')` based on last event type in the JSONL (`assistant_message` → done, presence of `error` event → errored).

### 3. Collapsible thinking block (P0)

Agent side ([src/core/agent-loop.ts](src/core/agent-loop.ts) / [src/core/reflection.ts](src/core/reflection.ts)): when the LLM returns a thinking/reasoning segment (Anthropic `thinking` blocks or `<thinking>` tags depending on provider), emit a new stderr event `[Thinking] <text>` and `[ThinkingDone] <ms>`. Parse in [chat-provider.ts#L337](vscode-extension/src/chat-provider.ts#L337) alongside the existing `[Tool]` parser, post `{ type: 'thinking', text, durationMs }` to the webview.

Webview ([chat.js](vscode-extension/media/chat.js)):

- Extend message model to `{ role, content, thinking?: { text, durationMs } }`.
- In `renderMessage`, render a `<details class="thinking-block">` block at the top of assistant messages (collapsed by default) with summary `Thought for {X}s` and muted styling (new `.thinking-block` rules in [chat.css](vscode-extension/media/chat.css): `opacity: 0.7`, `border-left: 2px solid var(--vscode-editorHint-border)`, smaller font).

### 4. Clickable file links (P0)

Webview: add a post-markdown pass in `renderMarkdown()` at [chat.js#L641](vscode-extension/media/chat.js#L641). After HTML generation, walk anchors whose `href` looks like a relative workspace path (regex: `^(?!https?:)[\w./\-]+\.\w+(#L\d+(-L?\d+)?)?$`) and rewrite to `<a class="file-link" data-path="..." data-line="...">` with a file icon span.

Add a click handler: on `.file-link` click, `postMessage({ type: 'openFile', path, line })`.

Extension side in [chat-provider.ts](vscode-extension/src/chat-provider.ts) message handler: resolve `path` against `workspace.workspaceFolders[0]`, then `await vscode.window.showTextDocument(uri, { selection: lineRange })`.

### 5. Slash command palette (P0)

Extend the existing `/` handler in [chat.js#L162](vscode-extension/media/chat.js#L162):

- When input begins with `/` and no space yet, show a command dropdown (reuse existing file-picker dropdown component) with entries: `/file`, `/model`, `/clear`, `/new`, `/help`.
- Selecting `/file` switches the dropdown to the existing file autocomplete (do not send on Enter — insert path and keep focus in input).
- `/model` posts `{ type: 'pickModel' }` to extension → extension shows `vscode.window.showQuickPick` of configured models and replies with `{ type: 'setModel', id }`.
- `/clear` and `/new` map to existing commands `altimeter.clearSession` / `altimeter.newSession`.
- `/help` renders a local (non-agent) system message listing commands.
- Keyboard: ArrowUp/ArrowDown to navigate, Enter to select, Escape to dismiss — mostly already implemented for the file picker, extract into a `renderDropdown(items, onSelect)` helper.

### 6. Streaming & markdown polish (P1)

Streaming already works. Add:

- Copy button on code blocks: already rendered per the explore report — verify and ensure it uses `navigator.clipboard.writeText` and a transient "Copied" label.
- Max-height on code blocks: `.message pre { max-height: 360px; overflow: auto; }` in [chat.css](vscode-extension/media/chat.css).
- User vs agent distinction: confirm existing theme-token usage; add `.message.user { background: var(--vscode-editor-selectionBackground); }` if missing.

### 7. Auto-generated session names + rename (P1)

- Title derivation already exists in [sessions-provider.ts#L77](vscode-extension/src/sessions-provider.ts#L77). Persist the derived title back into the JSONL `session_start` event on first user message so it survives reloads without re-derivation.
- Add command `altimeter.renameSession` wired to tree item context menu (`"view/item/context"` contribution in [package.json](vscode-extension/package.json)) → `vscode.window.showInputBox` → rewrites the `session_start` line in-place.

### 8. Keyboard shortcuts (P1)

Add to `contributes.keybindings` in [package.json](vscode-extension/package.json):

| Command | Key |
|---|---|
| `altimeter.openChat` | `ctrl+shift+a` (already present) |
| `altimeter.newSession` | `ctrl+shift+n` |
| `altimeter.focusInput` | `ctrl+l` (new command → posts `{ type: 'focusInput' }` to active panel/view) |
| `altimeter.toggleThinking` | `ctrl+shift+t` (new command → webview toggles all `.thinking-block[open]`) |
| `altimeter.clearSession` | `ctrl+shift+k` |

### 9. Error handling with retry (P1)

In [chat-provider.ts](vscode-extension/src/chat-provider.ts), when `_runAgent` throws or emits `[Error]`, post `{ type: 'error', message, canRetry: true, lastPrompt }`. Webview renders a red error message with a Retry button that re-sends `lastPrompt`.

## Critical files to modify

- [vscode-extension/src/chat-provider.ts](vscode-extension/src/chat-provider.ts) — extract controller, thinking parser, error/retry, file open handler.
- [vscode-extension/src/sessions-provider.ts](vscode-extension/src/sessions-provider.ts) — 5-recent + show-all, relative time, status icons.
- [vscode-extension/src/commands.ts](vscode-extension/src/commands.ts) — openSession → panel manager; new rename/focus/toggle commands.
- [vscode-extension/src/extension.ts](vscode-extension/src/extension.ts) — wire `SessionPanelManager`.
- [vscode-extension/package.json](vscode-extension/package.json) — view types, commands, keybindings, context menus.
- [vscode-extension/media/chat.js](vscode-extension/media/chat.js) — slash palette, thinking block rendering, file-link rewrite, dropdown helper.
- [vscode-extension/media/chat.css](vscode-extension/media/chat.css) — thinking block, code block max-height, file-link chip, user/agent distinction.
- New: [vscode-extension/src/session-panel-manager.ts](vscode-extension/src/session-panel-manager.ts), [vscode-extension/src/webview-html.ts](vscode-extension/src/webview-html.ts).
- [src/core/agent-loop.ts](src/core/agent-loop.ts) / [src/core/reflection.ts](src/core/reflection.ts) — emit `[Thinking]` events.

## Out of scope (P2/P3 follow-ups)

`@file` autocomplete, diff view for edits, token/cost per-message indicator, files-created summary section, session search/filter, context panel, resizable sections, character count.

## Verification

1. **Build**: `cd vscode-extension && npm run compile` (or `npm run watch`). No TS errors.
2. **Launch**: F5 in VS Code to open Extension Development Host.
3. **Tab sessions**: open sidebar, start a chat, click a session in the list → opens as a tab. Open a second session → second tab. Click first again → focuses existing tab (no duplicate).
4. **Session list**: with >5 sessions on disk, confirm only 5 shown; click "Show all" → rest appear. Verify relative times and status icons.
5. **Thinking block**: run a prompt that elicits reasoning; confirm `Thought for Xs` collapsed block appears above the answer; expand/collapse works; Ctrl+Shift+T toggles all.
6. **File links**: ask the agent to "list files in src/core"; agent output paths should render as file chips; click one → opens the file in an editor tab.
7. **Slash commands**: type `/` → palette appears with 5 commands; Arrow keys navigate; `/file` drills into file picker without sending; `/new` starts new session; `/help` prints command list inline.
8. **Streaming**: confirm tokens appear incrementally.
9. **Error/retry**: kill the agent process mid-run → red error message with Retry button; click Retry → re-runs last prompt.
10. **Keybindings**: each shortcut performs the documented action in a fresh window.
11. **Theme**: switch between Default Dark+, Default Light+, and High Contrast — no hardcoded colors, chat remains legible.
