# UI Redesign — Compact Clean Design

**Date:** 2026-04-12
**Scope:** `vscode-extension/src/chat-provider.ts`, `vscode-extension/media/chat.css`, `vscode-extension/media/chat.js`
**Trigger:** User requested a smaller, cleaner design inspired by the Claude Code VS Code extension

---

## Summary

Redesigned the Altimeter VS Code extension chat panel to be more compact and visually clean, drawing inspiration from the Claude Code extension's minimal UI. All spacing, font sizes, and visual elements were reduced while maintaining full functionality and VS Code theme compliance.

---

## Design Principles Applied

- **Compact spacing:** Reduced padding/margins by 30–40% throughout
- **Smaller typography:** Stepped down all font sizes (body 13→12px, tools 12→11px, selects 11→10px, hints 10→9px)
- **Minimal chrome:** Assistant messages render without background/border for a cleaner reading experience
- **SVG icons:** Replaced text-based logo (⌀) with a clean SVG altimeter gauge icon in both the header and empty state
- **Tighter controls:** Smaller send button (28→22px), spinner (14→12px), toolbar selects, and input area
- **Shorter copy:** Placeholder text shortened for narrow panel widths

---

## Changes by File

### chat.css — Full rewrite (compact design system)

| Area | Before | After |
|------|--------|-------|
| CSS variables | `--gap: 12px`, `--radius: 6px` | `--gap: 8px`, `--radius: 4px`, added `--accent` |
| Header | `padding: 10px 14px 8px`, logo 18px font | `padding: 6px 10px`, 16px SVG icon |
| Messages container | `padding: 12px 14px`, `gap: 16px` | `padding: 8px 10px`, `gap: 10px` |
| Empty state | 40px logo, 12px text | 28px SVG icon, 11px text |
| Message bubbles | 13px font, `padding: 10px 12px` | 12px font, `padding: 6px 10px` |
| Assistant messages | Had background + border | Transparent background, no border, minimal padding |
| Tool calls | 12px font, `padding: 7px 10px` summary | 11px font, `padding: 4px 8px` summary |
| Tool badge | 10px, `padding: 1px 6px` | 9px, `padding: 0px 5px` |
| Code blocks | 12px code, `padding: 10px 12px` | 11px code, `padding: 8px 10px` |
| Code block header | `padding: 4px 10px` | `padding: 2px 8px` |
| Stats | 10px font | 9px font, 0.7 opacity |
| Loading bar | `padding: 6px 14px`, 14px spinner | `padding: 4px 10px`, 12px spinner |
| Input area | `padding: 10px 14px 12px` | `padding: 6px 10px 8px` |
| Input wrapper | `padding: 6px 8px`, `gap: 6px` | `padding: 4px 6px`, `gap: 4px` |
| Send button | 28×28px, 16px icon | 22×22px, 14px icon |
| Toolbar selects | 11px font, `padding: 3px 14px 3px 4px` | 10px font, `padding: 2px 12px 2px 4px` |
| Autocomplete | `padding: 4px 8px`, 12px | `padding: 3px 7px`, 11px |
| Input hint | 10px, 0.4 opacity | 9px, 0.35 opacity |
| Animations | `fadeSlideIn` (opacity + translateY) | `fadeIn` (opacity only, lighter) |

### chat-provider.ts — HTML template updates

- **Header logo:** Replaced `<span class="logo">⌀</span>` with inline SVG altimeter gauge icon (circle + needle)
- **Header structure:** Wrapped clear button in `<div class="header-actions">` for layout control
- **Clear icon:** Reduced SVG from 14×14 to 12×12
- **Send button icon:** Replaced with cleaner arrow SVG (stroke-based, 14×14)
- **Placeholder text:** Shortened from `"Ask Altimeter anything... (/ to reference files)"` to `"Ask anything... (/ to ref files)"`
- **Input hint:** Shortened from `"Enter to send · Shift+Enter for newline · / to reference files"` to `"Enter to send · Shift+Enter for newline"`

### chat.js — Empty state update

- **Logo:** Replaced `<div class="logo-large">⌀</div>` with 28×28 SVG altimeter gauge icon
- **Description:** Shortened from `"Start a conversation with Altimeter. Ask anything, or select code in the editor and right-click to explain or fix it."` to `"Ask anything, or select code and right-click to explain or fix it."`

---

## Build Verification

- Webpack production build: **compiled successfully**
- All existing element IDs preserved (no JS breakage)
- All VS Code theme CSS variables maintained
- No functional changes to message handling, streaming, or tool calls
