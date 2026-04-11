# ⌀ Altimeter

**Lightweight. Powerful. Secure. AI Agent Orchestrator.**

Altimeter is a TypeScript/Node.js AI agent orchestrator inspired by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenClaw](https://github.com/openclaw). It implements the simplest possible while-loop agent core, a provider-agnostic LLM layer, a composable tool system, and a pure-Markdown memory store.

```
┌─────────────────────────────────────┐
│           altimeter chat            │
│  > help me refactor this codebase   │
│                                     │
│  ⚙ glob                             │
│  ⚙ file_read                        │
│  ⚙ file_edit                        │
│  ⚙ bash (run tests)                 │
│                                     │
│  Done. Refactored 12 files.         │
│  [4 turns · 8,203 tokens · $0.04]  │
└─────────────────────────────────────┘
```

## Features

| Feature | Description |
|---|---|
| **While-loop agent core** | `while(tool_use)` — the simplest debuggable pattern |
| **Multi-provider LLM** | Anthropic, OpenAI, Google Gemini, Ollama (local), any OpenAI-compatible endpoint |
| **10 built-in tools** | bash, file_read, file_write, file_edit, glob, grep, web_fetch, web_search, agent, todo_write |
| **Skill system** | Markdown playbooks injected selectively into context |
| **Pure Markdown memory** | No vector DB needed. facts.md + daily logs + index |
| **Context compression** | MicroCompact → Summarize → Truncate (3-layer strategy) |
| **Subagent spawning** | Agent tool: fresh context, role isolation, parallel work |
| **Hook system** | PreToolUse, PostToolUse, Stop — intercept/block/modify |
| **Permission model** | Per-tool levels, per-session modes, interactive prompts |
| **Sessions (JSONL)** | Append-only O(1) writes, resume, fork |
| **Cron / Webhooks** | Scheduled agent runs, HTTP trigger endpoint |

## Installation

```bash
git clone https://github.com/you/altimeter
cd altimeter
npm install
npm run build
npm link   # makes `altimeter` available globally
```

Or run directly:
```bash
npx tsx src/index.ts chat
```

## Quick Start

### Interactive chat
```bash
export ANTHROPIC_API_KEY=sk-ant-...
altimeter chat
```

### One-shot run
```bash
altimeter run "List all TypeScript files with more than 100 lines"
```

### Auto-approve tools (no permission prompts)
```bash
altimeter run --auto "Write a Python script that generates a fractal"
```

### Use a local Ollama model
```bash
OLLAMA_BASE_URL=http://localhost:11434 altimeter chat --provider ollama --model llama3.1
```

### Start webhook + cron server
```bash
altimeter serve --port 7331
```

## Configuration

Create `altimeter.json5` in your project root:

```json5
{
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  effort: "medium",        // low | medium | high | max
  max_turns: 50,
  max_budget_usd: 1.0,
  permission_mode: "default",  // default | auto | plan | bypassPermissions

  // Restrict available tools
  allowed_tools: ["bash", "file_read", "file_write", "glob"],
  disallowed_tools: ["agent"],

  // System prompt
  system_prompt: "You are a senior TypeScript developer.",

  // Cron jobs
  cron: [
    {
      name: "daily-summary",
      schedule: "0 9 * * 1-5",  // 9am Mon-Fri
      prompt: "Summarize recent git commits and open issues",
      enabled: true
    }
  ]
}
```

Or use environment variables:
```bash
ALTIMETER_MODEL=gpt-4o
ALTIMETER_PROVIDER=openai
ALTIMETER_MAX_TURNS=30
ALTIMETER_PERMISSION_MODE=auto
```

## Project Configuration (ALTIMETER.md)

Create `ALTIMETER.md` in your project root. It's injected into every session's system prompt (survives context compaction, like `CLAUDE.md`):

```markdown
# My Project

This is a Node.js web API using Express + PostgreSQL.

## Code Style
- Use TypeScript strict mode
- Prefer `async/await` over callbacks
- Write JSDoc comments for all public functions

## Architecture
- `src/routes/` — Express route handlers
- `src/models/` — Database models
- `src/services/` — Business logic

## Testing
- Run tests: `npm test`
- Test framework: Jest + Supertest
```

## Skills

Skills are Markdown playbooks that are injected selectively based on trigger keywords.

Create `skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Instructions for working with the payments module
tools_required: [bash, file_read]
trigger_patterns: [payment, stripe, invoice, billing]
always_inject: false
---

# Payment System Guide

When working with payments:
1. Always validate amounts server-side
2. Use idempotency keys for Stripe API calls
3. Log all payment events to the audit table
4. Test with Stripe test keys (sk_test_...)
```

## Tools

| Tool | Permission | Description |
|---|---|---|
| `bash` | execute | Run shell commands |
| `file_read` | read | Read files + directories |
| `file_write` | write | Write/create files |
| `file_edit` | write | Surgical string replacement |
| `glob` | read | Find files by pattern |
| `grep` | read | Search file contents with regex |
| `web_fetch` | network | HTTP fetch + HTML→text |
| `web_search` | network | Web search (Brave/Serp/DDG) |
| `agent` | agent | Spawn subagent with fresh context |
| `todo_write` | write | Manage task list |

### Permission Modes

| Mode | Behavior |
|---|---|
| `default` | Ask before `execute`/`agent` tools |
| `auto` | Never ask. Allow all tools. |
| `plan` | Describe tool actions, don't execute |
| `bypassPermissions` | Skip all permission checks |

## Memory

Altimeter uses plain Markdown files for memory — no database required:

```
memory/
├── facts.md        # Curated persistent facts
├── index.md        # Auto-generated searchable index
├── 2024-01-15.md   # Daily conversation log
└── 2024-01-16.md
```

```bash
# Add a fact
altimeter memory add "The production database is PostgreSQL 15 on RDS"

# Search memory
altimeter memory search "database"
```

Facts are also automatically accessible to the agent during conversations.

## Hooks

Intercept and control tool execution programmatically:

```typescript
import { hookEngine } from "./src/hooks/engine.js";

// Block dangerous commands
hookEngine.register({
  id: "no-rm-rf",
  event: "PreToolUse",
  tool_filter: ["bash"],
  handler: async (ctx) => {
    const cmd = ctx.tool_call?.input?.command as string;
    if (cmd?.includes("rm -rf")) {
      return { action: "block", reason: "rm -rf is not allowed" };
    }
    return { action: "allow" };
  },
});

// Log all tool calls
hookEngine.register({
  id: "audit",
  event: "PreToolUse",
  handler: async (ctx) => {
    console.log(`[Audit] ${ctx.tool_call?.name}:`, ctx.tool_call?.input);
    return { action: "allow" };
  },
});
```

## Multi-Agent

Spawn specialized subagents from a parent:

```
Parent Agent
│
├── agent("Research X") → Researcher subagent
│   Returns: summarized findings
│
├── agent("Write code for Y") → Coder subagent
│   Returns: complete implementation
│
└── Final synthesis
```

The parent sees only the final text output of each subagent — not the full transcript. This keeps parent context small.

## Sessions

```bash
# List all sessions
altimeter session list

# Resume a session
altimeter session resume <session-id>

# Delete a session
altimeter session delete <session-id>
```

Sessions are stored as JSONL files in `./sessions/`:
- Append-only: O(1) writes, crash-safe
- One event per line: easy to grep/tail

## Webhook API

```bash
# Trigger an agent run via HTTP
curl -X POST http://localhost:7331/trigger \
  -H "Authorization: Bearer $ALTIMETER_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Check disk usage and alert if > 80%"}'
```

## Adding a Provider

Implement `BaseProvider` (~50 lines):

```typescript
export class MyProvider extends BaseProvider {
  constructor() { super("myprovider", "My LLM"); }

  async complete(options: CompletionOptions): Promise<LLMResponse> {
    // Call your API, return normalized LLMResponse
  }

  async listModels(): Promise<string[]> { return ["my-model"]; }
  async validate(): Promise<boolean> { return true; }
}

// Register
router.registerProvider("myprovider", () => new MyProvider());
```

## Adding a Tool

```typescript
import { z } from "zod";
import { registry } from "./src/tools/registry.js";

const myTool = {
  name: "my_tool",
  description: "Does something useful",
  schema: z.object({
    input: z.string().describe("The input"),
  }),
  permission_level: "read" as const,
  async execute(input, context) {
    return { output: `Result: ${input.input}`, is_error: false };
  },
};

registry.register(myTool);
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## License

MIT
