# Altimeter Architecture

This document describes the architecture and design decisions behind Altimeter.

## Design Philosophy

Altimeter is built on three principles:

1. **Lightweight**: Minimal dependencies. Pure TypeScript/Node.js. The agent loop is < 200 lines.
2. **Powerful**: While-loop core, tool system, subagent spawning, multi-provider LLM, skill injection, memory.
3. **Secure**: Per-tool permission levels, session-scoped tool allowlists, hook interception, sandbox execution.

## The Core: A While Loop

```
"A simple while loop combined with disciplined tools delivers
 controllable autonomy." — Claude Code philosophy
```

The entire agent logic reduces to:

```
while true:
  response = llm.complete(messages, tools)
  if response.tool_calls.empty:
    return response.text          ← DONE
  for each tool_call:
    result = execute(tool_call)
    messages.append(result)
```

This pattern has exactly two states:
- **Thinking** (text-only response) → done
- **Acting** (tool calls present) → loop

The simplicity makes it debuggable, testable, and auditable.

## Module Graph

```
src/index.ts (CLI)
    │
    ├── core/agent-loop.ts     ← THE LOOP
    │       │
    │       ├── providers/router.ts     → provider selection
    │       │       └── anthropic/openai/google/ollama.ts
    │       │
    │       ├── tools/registry.ts      → tool dispatch + permissions
    │       │       └── bash/file-read/file-write/...
    │       │
    │       ├── hooks/engine.ts        → PreToolUse/PostToolUse/Stop
    │       │
    │       └── core/context.ts        → system prompt assembly + compression
    │               ├── skills/loader.ts   → selective skill injection
    │               └── memory/manager.ts  → facts.md
    │
    ├── core/session.ts        → JSONL session store
    │
    ├── security/
    │   ├── permissions.ts     → permission classifier
    │   ├── sandbox.ts         → Docker sandbox
    │   └── audit.ts           → audit trail logger
    │
    ├── scheduler/
    │   ├── cron.ts            → heartbeat jobs
    │   └── webhook.ts         → HTTP trigger server
    │
    └── config/loader.ts       → config resolution
```

## Provider Layer

Each provider implements `BaseProvider`:

```typescript
abstract class BaseProvider {
  abstract complete(options: CompletionOptions): Promise<LLMResponse>;
  async *stream(options: CompletionOptions): AsyncIterable<string>;
  abstract listModels(): Promise<string[]>;
  abstract validate(): Promise<boolean>;
  estimateCost(model, inputTokens, outputTokens): number;
}
```

The `ModelRouter` resolves provider+model strings:
- `"claude-3-5-sonnet-20241022"` → `AnthropicProvider`
- `"openai:gpt-4o"` → `OpenAIProvider`
- `"ollama:llama3.1"` → `OllamaProvider`

All providers normalize to the same `LLMResponse`:
```typescript
interface LLMResponse {
  text: string | null;
  tool_calls: ToolCall[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}
```

## Tool System

Tools are self-contained modules:

```typescript
interface Tool<TInput> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  permission_level: PermissionLevel;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecuteResult>;
}
```

The `ToolRegistry` handles:
1. **Registration** — all built-in tools registered at import time
2. **Definition export** — converts Zod schemas to JSON Schema for LLM
3. **Permission checking** — before each execute() call
4. **Input validation** — Zod parse before calling execute()

### Permission Model

```
Permission Levels (ascending risk):
  read < write < network < execute < agent

Permission Modes:
  default  : ask before execute/agent
  auto     : never ask
  plan     : dry-run (execute returns description, not result)
  bypassPermissions : skip all checks
```

### Hook System

Hooks run synchronously in the agent process (not a subprocess). This is intentional — subprocesses add latency and complexity that isn't worth it for hooks.

```
LLM response
    │
    ↓
PreToolUse hooks
    │ action=block → inject error result
    │ action=modify → replace tool input
    ↓
Tool execution
    │
    ↓
PostToolUse hooks
    │ action=modify → replace tool output
    ↓
Tool result injected into messages
```

## Message Format

All messages use a unified format internally (Anthropic-style), converted per-provider:

```typescript
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent | MessageContent[];
  timestamp?: string;
}

type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: ... }
```

Each provider's `convertMessages()` transforms this into its own wire format.

## Context Assembly

The system prompt is assembled fresh on each agent loop iteration:

```
1. Base system prompt (from config or CLI)
2. ALTIMETER.md content (project-level config, injected every turn)
3. Relevant skills (matched by trigger_patterns in SKILL.md frontmatter)
4. Memory facts (from memory/facts.md)
5. Default agent instructions
```

ALTIMETER.md is re-read from disk on every session start. This means it survives context window compaction — even if the middle of the conversation is summarized away, ALTIMETER.md always stays in context.

## Context Compression

Three-layer strategy (applied automatically):

```
Context usage < 70%  → No compression
Context usage 70-85% → MicroCompact: truncate old tool outputs to 500 chars
Context usage 85-95% → Truncate: keep first 2 + last 30 messages
Context usage > 95%  → Hard truncate: keep first 2 + last 30 messages
```

A "Summarize" layer (LLM-generated summary of removed messages) is architecturally defined but left for future implementation — it requires a second LLM call and adds complexity that isn't always worth it.

## Session Storage

Sessions are JSONL files (one event per line):

```jsonl
{"type":"session_start","timestamp":"2024-01-15T09:00:00Z","data":{"config":{...}}}
{"type":"user_message","timestamp":"2024-01-15T09:00:01Z","data":{"content":"..."}}
{"type":"assistant_message","timestamp":"2024-01-15T09:00:05Z","data":{"content":"..."}}
{"type":"tool_call","timestamp":"...","data":{"name":"bash","input":{...}}}
{"type":"tool_result","timestamp":"...","data":{"content":"...","is_error":false}}
{"type":"session_end","timestamp":"...","data":{"turns":4,"cost_usd":0.04}}
```

JSONL is append-only = O(1) writes. Sessions can be tailed in real-time:
```bash
tail -f sessions/<id>.jsonl | jq
```

## Memory Architecture

```
memory/
├── facts.md        ← Curated persistent facts (manually added or LLM-extracted)
├── index.md        ← Auto-generated index of all conversations
├── 2024-01-15.md   ← Daily log (appended by every session)
└── 2024-01-16.md
```

Philosophy: Plain text is searchable, readable, git-trackable, and portable. An LLM can read and reason over 50KB of Markdown facts far better than we can engineer a retrieval system.

For projects needing semantic search over large knowledge bases, an embeddings layer can be added on top of the Markdown store without changing the core architecture.

## Skill System

```
skills/
├── my-skill/
│   └── SKILL.md    ← frontmatter + content
└── another-skill/
    └── SKILL.md
```

SKILL.md structure:
```markdown
---
name: my-skill
description: Short description
tools_required: [bash, file_read]
trigger_patterns: [keyword1, keyword2]
always_inject: false
---

# Skill Content

Instructions the LLM should follow when working on this topic...
```

The `SkillLoader` rescans the skills directory every 30 seconds. Skills are matched against the user's prompt using substring matching on `trigger_patterns`. `always_inject: true` skills are always included regardless of prompt.

## Multi-Agent Architecture

```
Parent Session
    │
    ├── agent("Research X")
    │       │
    │       └── Sub-Session (fresh context)
    │               → Returns: final_text only
    │
    └── Continue with research results
```

The `agent` tool spawns a new session via `runAgent()` (recursive call). The parent sees only `result.text` — never the full sub-session transcript. This keeps the parent context bounded regardless of how much work the subagent does.

For coordination between agents, use the mailbox pattern (recommended for complex multi-agent systems):
```
agents write to: mailbox/<agent-id>.jsonl
agents read from: their own mailbox file
```

## Security Architecture

```
Tool Permission Check Flow:
┌────────────────────────────────────────────────────────┐
│ Is tool in disallowed_tools?      → BLOCK              │
│ Is allowed_tools non-empty and tool not in it? → BLOCK │
│ permission_mode = bypassPermissions? → ALLOW           │
│ permission_mode = plan?           → ALLOW (dry-run)    │
│ permission_rank < threshold?      → ALLOW              │
│ permission_mode = auto?           → ALLOW              │
│ Has TTY + permission callback?    → PROMPT USER        │
│ Headless mode (no callback)       → ALLOW              │
└────────────────────────────────────────────────────────┘
```

The sandbox manager provides Docker-based isolation for untrusted sessions. When `sandbox.enabled = true`, all `bash` tool calls execute inside a Docker container rather than on the host.

## Cron / Webhooks

```
altimeter serve
    │
    ├── WebhookServer (port 7331)
    │       POST /trigger → runAgent()
    │
    └── CronScheduler
            node-cron → runAgent() → memory log
```

Both are independently enabled/disabled. The webhook server uses Bearer token auth (`ALTIMETER_WEBHOOK_SECRET`). Cron jobs log their output to `memory/<date>.md`.

## Performance Characteristics

| Operation | Complexity | Notes |
|---|---|---|
| Session append | O(1) | JSONL append |
| Session resume | O(n) | Read + parse n lines |
| Skill scan | O(d) | d = number of skill dirs |
| Memory search | O(f) | f = total file sizes |
| Context check | O(m) | m = message count |
| Tool execution | Varies | I/O or compute bound |

The hot path (agent loop turn) is:
1. Assemble context: O(m) string concat
2. LLM call: network I/O (dominant)
3. Tool execution: depends on tool
4. Session append: O(1)

## Trade-offs and Non-Decisions

**Why Anthropic message format internally?**
Anthropic's format is the most expressive (handles tool_use, tool_result, images natively). Converting from it to OpenAI/Gemini is simpler than the reverse.

**Why JSONL instead of SQLite?**
JSONL has zero dependencies, is grep-friendly, and doesn't require schema migrations. For production use with thousands of sessions, SQLite would be better.

**Why not vector embeddings for memory?**
Adding an embeddings model creates an infrastructure dependency. For most personal use cases, keyword search on Markdown is "good enough". The architecture supports adding embeddings as an optional enhancement without changing the memory interface.

**Why < 200 lines for agent-loop.ts?**
The agent loop must be readable at a glance. If it's too long, it becomes opaque. Complexity belongs in the tools and providers, not the loop.
