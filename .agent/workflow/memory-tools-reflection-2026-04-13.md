# Memory Tools + Lessons + Reflection (2026-04-13)

## Why

Memory was underused. It was dumped into the system prompt at session start and the model forgot it existed by turn 10. Tools were also a fixed set with no way for the agent to write down what it learned. The goal was not a self-evolving agent — just **an executor with judgment**: one that can recall prior knowledge, write down lessons after errors, and consult those lessons before acting.

## What changed

Three surgical additions, all additive, agent-loop untouched.

### 1. Memory as registered tools

- [src/tools/memory-recall.ts](../../src/tools/memory-recall.ts) — `read` permission, wraps `MemoryManager.search`.
- [src/tools/memory-note.ts](../../src/tools/memory-note.ts) — `write` permission, appends to `lessons.md` (default) or `facts.md` (`kind="fact"`).
- Registered in [src/tools/registry.ts](../../src/tools/registry.ts) alongside the other built-ins.

### 2. Lessons file + relevance scoring

- New file: `memory/lessons.md`. Format: `## YYYY-MM-DD [tags]` header followed by the body.
- [src/memory/manager.ts](../../src/memory/manager.ts) gained `loadLessons`, `appendLesson`, `writeLessons` (atomic, creates `.bak`), a `Lesson` type, and a parser. `search()` now also scans `lessons.md`.
- [src/core/context.ts](../../src/core/context.ts) scores each lesson against the current user prompt (tag match weight 3, content word overlap weight 1) and injects the top 5 with score > 0 under `# Lessons (relevant to this turn)`. No matches → section omitted.

### 3. Triggered reflection wrapper

- New file: [src/core/reflection.ts](../../src/core/reflection.ts) exports `runAgentWithReflection`.
- Trigger conditions: task completed normally (`stop_reason === "text"`) AND (`turns >= 5` OR any tool result had `is_error: true`).
- Behavior: exactly one extra `runAgent` call with a reflection prompt asking the agent to call `memory_note` if anything is worth remembering.
- The CLI's `run` and `chat` paths in [src/index.ts](../../src/index.ts) now call `runAgentWithReflection` instead of `runAgent` directly.
- Agent-loop budget: **unchanged**. Reflection is a wrapper, not a loop modification.

### 4. Prune command

- New subcommand: `altimeter memory prune` in [src/index.ts](../../src/index.ts).
- Reads `lessons.md`, runs one auto-mode LLM turn asking it to dedupe/merge/drop, writes the result back with `lessons.md.bak` as rollback.
- Built day-one to prevent lesson sprawl (predictable failure mode).

## What it is NOT

Explicit non-goals — **do not add**:

- Dynamic tool creation / tool synthesis
- Vector embeddings or semantic retrieval
- Continuous reflection loops
- Self-modifying code paths
- Memory CLI changes that bypass the tool path (the agent should call tools, not shell out)

## Files touched

| File | Kind |
|---|---|
| [src/memory/manager.ts](../../src/memory/manager.ts) | modified — lessons API + parser |
| [src/core/context.ts](../../src/core/context.ts) | modified — lesson relevance injection |
| [src/core/reflection.ts](../../src/core/reflection.ts) | new — `runAgentWithReflection` |
| [src/tools/memory-recall.ts](../../src/tools/memory-recall.ts) | new — recall tool |
| [src/tools/memory-note.ts](../../src/tools/memory-note.ts) | new — note tool |
| [src/tools/registry.ts](../../src/tools/registry.ts) | modified — register new tools |
| [src/index.ts](../../src/index.ts) | modified — use reflection wrapper + `memory prune` command |
| [tests/memory.test.ts](../../tests/memory.test.ts) | new — 9 tests, all passing |
| [ALTIMETER.md](../../ALTIMETER.md), [ARCHITECTURE.md](../../ARCHITECTURE.md) | updated |

## Verified

- `npm run lint` — clean
- `tests/memory.test.ts` — 9/9
- Full suite — 137/138 (one pre-existing python env failure in `code-run.test.ts`, unrelated)
- End-to-end with Gemini 2.5 Flash: agent called `memory_note`, then `memory_recall`, then a new session retrieved the lesson via relevance injection and referenced it in its answer — confirming the loop works across sessions.

## Plan of record

[Plans/generic-waddling-starfish.md](../../Plans/generic-waddling-starfish.md)
