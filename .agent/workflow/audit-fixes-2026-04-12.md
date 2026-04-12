# Audit Fixes — VS Code Chat Webview

**Date:** 2026-04-12
**Scope:** `vscode-extension/src/chat-provider.ts`, `vscode-extension/media/chat.css`, `vscode-extension/media/chat.js`
**Trigger:** Full audit of Altimeter chat webview UI, filtered for VS Code validity

---

## Summary

21 issues identified in initial audit. 5 removed as invalid for VS Code context (touch targets match VS Code convention, static innerHTML is safe, landmark roles not applicable to embedded panels, hidden spinner optimization handled by Chromium, deprecated execCommand is dead code in Electron). **14 valid findings fixed.**

---

## Changes by File

### chat-provider.ts

#### C1+H1: Trash icon and accessible label
- **Before:** `$(trash)` rendered as literal text — VS Code codicon shorthand only works in API-driven UI (TreeView, StatusBar), not raw webview HTML.
- **After:** Replaced with inline SVG trash icon. Added `aria-label="Clear chat"` for screen readers.

#### H2: Dropdown arrow theme compliance
- **Before:** `<select>` elements used `appearance: none` with a hardcoded `fill='%23888'` SVG data URI for the dropdown arrow. Invisible in VS Code high-contrast themes.
- **After:** Wrapped each `<select>` in a `.select-wrap` div. Arrow is now a CSS border-triangle `::after` pseudo-element colored with `var(--vscode-icon-foreground)`, adapting to all themes.

#### M6: File path regex tightened
- **Before:** Pattern `/([\w./-]+\.\w+)/g` matched too broadly — any text with a dot and slash could trigger false positive file lookups.
- **After:** Restricted to recognized code file extensions (ts, js, py, rs, go, java, css, html, md, json, yaml, sql, sh, etc.). Prevents matching prose, URLs, or code snippets as file references.

---

### chat.css

#### C2: Keyboard focus indicators
- **Before:** No `:focus-visible` styles on any interactive element. Keyboard users could not see which element was focused.
- **After:** Added `:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }` to `.icon-btn`, `.copy-btn`, `.cancel-btn`, and `#sendBtn`.

#### L2/L3: Muted text contrast
- **Before:** `.message-meta` used `opacity: 0.55` and `.stats` used `opacity: 0.5`. Opacity halves whatever the theme provides, risking contrast failures in low-contrast themes.
- **After:** Both now use `color: var(--vscode-descriptionForeground)`, which lets the theme author control the muted text color directly.

#### M8: Error message fallback colors
- **Before:** Error message background/border fell back to hardcoded `rgba(244,67,54,...)` — wrong in high-contrast themes.
- **After:** Fallback chain uses `var(--vscode-editorError-background)` and `var(--vscode-editorError-foreground)` before any hardcoded value.

#### M1: Streaming cursor position
- **Before:** Cursor `::after` was on `.message-content` (a block container), causing it to render on a new line below the last block element.
- **After:** Selector changed to `.message-content > *:last-child::after`, placing the cursor inline with the last text element.

#### M2: Reduced motion support
- **Before:** No `prefers-reduced-motion` media query. Smooth scroll and animations ran regardless of OS accessibility settings.
- **After:** Added `@media (prefers-reduced-motion: reduce)` that sets `animation-duration: 0.01ms` globally and `scroll-behavior: auto` on the messages container.

#### H2 (CSS portion): Select wrapper and arrow styles
- Added `.select-wrap` positioning styles and `::after` arrow indicator.
- Select element updated: removed inline `background-image`, added `appearance: none` / `-webkit-appearance: none`, `width: 100%` to fill wrapper.

#### Autocomplete hint styling
- Added `.autocomplete-hint` class using `var(--vscode-descriptionForeground)` instead of inline `style` attribute (CSP compliance).

---

### chat.js

#### H5: File autocomplete ARIA roles
- **Before:** Autocomplete dropdown used plain `<div>` elements with no semantic roles. Invisible to screen readers.
- **After:** Container gets `role="listbox"`, items get `role="option"` with `id` and `aria-selected`. Input textarea gets `aria-expanded`, `aria-controls`, and `aria-activedescendant` when autocomplete is open. All attributes cleaned up on hide.

#### H6: Webview state persistence
- **Before:** No use of `vscode.getState()` / `vscode.setState()`. Conversation was destroyed whenever user switched sidebar tabs.
- **After:** Added `chatHistory` array tracking all messages. `saveState()` persists to VS Code on every message append, stream end, and chat clear. `restoreState()` replays history on init. `appendMessage()` accepts `skipSave` parameter to avoid double-saving during restore.

#### M5: Nested list support in markdown renderer
- **Before:** List parser only handled single-line flat items (`- item`). Indented sub-items or continuation lines broke rendering.
- **After:** New `parseList()` function collects items with indent levels, then recursively builds nested `<ul>`/`<ol>` HTML. Handles continuation lines (indented non-bullet text appended to previous item).

#### M7: Tool call container grouping
- **Before:** `appendToolCall` found the `:last-child` `.tool-calls-container`. If any message was appended between tool calls, a new container was created, fragmenting the display.
- **After:** Containers are keyed by `data-turn` attribute tied to `currentTurnId` (incremented on each loading start). All tool calls within the same agent run group together regardless of interleaved messages.

#### M4: AutoResize layout optimization
- **Before:** `autoResize()` did synchronous height reset + scrollHeight read + height write on every keystroke — classic layout thrashing.
- **After:** Wrapped in `requestAnimationFrame` to batch layout reads and writes in a single frame.

---

## Findings Removed (Invalid for VS Code)

| Original ID | Finding | Reason Removed |
|-------------|---------|----------------|
| H4 | Touch targets under 44px | VS Code is desktop UI; 28px matches VS Code's own sidebar button convention |
| M3 | Empty state uses innerHTML | Content is hardcoded static HTML, no user data flows through |
| L1 | `document.execCommand('copy')` deprecated | Dead code in Electron — `navigator.clipboard.writeText` always works |
| L4 | No landmark roles in webview | VS Code's own webviews don't use landmarks; panels are single-purpose |
| L5 | Spinner animation while hidden | Chromium skips paint/animation for `display: none` elements |
