# Altimeter Project Configuration

This file is auto-injected into every agent session's system prompt. Keep it accurate and concise — every byte here costs tokens on every run.

## Project Overview

Altimeter is a lightweight, multi-provider TypeScript AI agent orchestrator. It ships a Commander-based CLI, a webhook server, and a cron scheduler, along with skills, memory, hooks, permissions, sessions (resumable), context compression, and subagents.

## Stack

- **Language**: TypeScript (target ES2022, NodeNext modules, `"type": "module"`)
- **Runtime**: Node.js >= 18
- **Build**: `tsc` → `dist/` (no bundler)
- **Test**: Jest + `ts-jest` ESM preset (requires `--experimental-vm-modules`)
- **Entry**: [src/index.ts](src/index.ts) → `dist/index.js` (bin: `altimeter`)
- **Dependencies**:
  - Core: `zod`, `zod-to-json-schema`, `commander`, `chalk`
  - Scheduling: `node-cron`
  - Document tools: `exceljs`, `pdfkit`
  - Dev: `tsx`, `typescript`, `jest`, `ts-jest`, `@jest/globals`

## CLI Surface

[src/index.ts](src/index.ts) is a Commander CLI exposing 7 command groups:

- `chat` — interactive REPL. Flags: `--model`, `--provider`, `--effort`, `--max-turns`, `--max-budget`, `--auto`, `--plan`, `--resume <id>`
- `run <prompt>` — one-shot agent execution
- `serve` — webhook server + cron scheduler (default port 7331)
- `session {list|resume|delete}` — JSONL session management
- `tools` — list available tools
- `skills` — list loaded skills
- `memory {add|search|prune}` — memory operations (`prune` asks the LLM to dedupe `lessons.md`)

## File Structure

```
src/
├── index.ts             # CLI entry (Commander)
├── core/
│   ├── agent-loop.ts    # THE LOOP — keep < 200 lines
│   ├── context.ts       # System prompt assembly + compression + lesson relevance
│   ├── reflection.ts    # runAgentWithReflection — bounded post-task reflection
│   ├── session.ts       # JSONL session management
│   └── types.ts         # Shared type definitions
├── providers/           # LLM provider implementations (see below)
├── tools/               # Tool implementations (see below)
├── skills/              # Skill loader
├── memory/              # Memory manager
├── hooks/               # Hook engine
├── security/            # Permissions, sandbox, audit
├── scheduler/           # Cron + webhook server
└── config/              # Config loading (altimeter.json5)
tests/                   # Jest tests (see Testing)
```

## Providers

Under [src/providers/](src/providers/):

- `anthropic.ts`, `openai.ts`, `google.ts`, `ollama.ts` — concrete implementations
- `base.ts` — `BaseProvider` interface all providers must implement exactly
- `router.ts` — provider selection / routing

## Tools

17 built-in tools under [src/tools/](src/tools/), registered via `registry.ts`:

`agent`, `bash`, `code-run`, `csv-write`, `doc-create`, `file-edit`, `file-read`, `file-write`, `glob`, `grep`, `memory-note`, `memory-recall`, `spreadsheet-create`, `todo`, `web-fetch`, `web-search` (+ `base.ts` and `registry.ts`).

See [TOOLS.md](TOOLS.md) for the full reference.

## Development

```bash
npm run build       # tsc → dist/
npm run dev         # tsx src/index.ts (no build)
npm start           # node dist/index.js
npm test            # jest (ESM mode, --passWithNoTests)
npm run test:watch  # jest --watch
npm run lint        # tsc --noEmit (type-check only)
npm run clean       # rm -rf dist
```

## Testing

- Runner: Jest with `ts-jest/presets/default-esm`
- Config: [jest.config.mjs](jest.config.mjs) — `testMatch: **/tests/**/*.test.ts`, 30s timeout
- Existing coverage: `agent-loop`, `context`, `providers`, `permissions`, `sandbox`, `retry`, `cost-tracker`, `skill-loader`, `webhook`, `tools`, and each document tool (`code-run`, `doc-create`, `spreadsheet-create`, `csv-write`)
- When touching any of the above, update or add tests alongside the change.

## Code Style

- Use `async/await`, never `.then()` chains
- All exported functions should have JSDoc comments
- Catch specific errors; always log context
- Zod schemas are the source of truth for input types
- Prefer `const` over `let`; never `var`
- All user-facing strings go through `chalk` for formatting

## Architecture Rules

1. [src/core/agent-loop.ts](src/core/agent-loop.ts) must stay **< 200 lines**.
2. Each tool is a self-contained module and must declare its permission requirements in the registry.
3. Providers must implement the `BaseProvider` interface exactly ([src/providers/base.ts](src/providers/base.ts)).
4. No circular imports at module load time — use lazy imports for the agent runner.
5. Sessions are JSONL; `chat --resume <id>` and `session resume` depend on that format — don't break it.
6. `serve` runs the webhook listener and the cron scheduler on the same process; tool handlers must not block the event loop.
7. Permissions are enforced in [src/security/](src/security/); context compression lives in [src/core/context.ts](src/core/context.ts) — don't bypass either.
8. The agent is an **executor with judgment**, not a self-evolving system. Memory (`memory_recall`/`memory_note`) and reflection ([src/core/reflection.ts](src/core/reflection.ts)) give it the ability to learn from prior mistakes — but tools are fixed, not synthesized at runtime. Don't add dynamic tool creation.

## Memory Model

Memory is first-class and tool-driven, not a passive store:

- `memory_recall(query)` — `read` permission, searches `facts.md`, `lessons.md`, and recent daily logs.
- `memory_note(content, tags?, kind?)` — `write` permission, `kind="lesson"` (default) appends to `memory/lessons.md`, `kind="fact"` appends to `memory/facts.md`.
- `memory/lessons.md` — short, dated, tag-indexed entries the agent writes after mistakes or non-obvious wins. Format: `## YYYY-MM-DD [tags]` followed by the body.
- **Relevance injection**: on every turn, [src/core/context.ts](src/core/context.ts) scores all lessons against the current user prompt (tag match weight 3, content word overlap weight 1) and injects the top 5 above zero under `# Lessons (relevant to this turn)`. Lessons are cheap when irrelevant and salient when they matter.
- **Reflection**: [src/core/reflection.ts](src/core/reflection.ts) wraps `runAgent`. After a task completes, if `turns >= 5` OR any tool result errored, it fires exactly one additional turn with the reflection prompt asking the agent to call `memory_note` if anything is worth remembering. Bounded by design — no background loops.
- **Pruning**: `altimeter memory prune` reads `lessons.md`, asks the LLM to dedupe in a single auto-mode turn, and writes the result back with a `.bak` of the original. Run it manually when the file gets noisy.

## Related Docs

- [README.md](README.md) — user-facing install / quick start / config
- [ARCHITECTURE.md](ARCHITECTURE.md) — detailed architecture
- [TOOLS.md](TOOLS.md) — tool reference
