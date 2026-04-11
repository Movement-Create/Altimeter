# Altimeter Project Configuration

This file is automatically injected into every agent session's system prompt.
Edit it to customize agent behavior for your project.

## Project Overview

This is the Altimeter project itself — a TypeScript AI agent orchestrator.

## Stack

- **Language**: TypeScript (ES2022, NodeNext modules)
- **Runtime**: Node.js 18+
- **Key deps**: zod, commander, chalk, node-cron
- **Build**: `tsc` (output to `dist/`)
- **Entry**: `src/index.ts` → `dist/index.js`

## File Structure

```
src/
├── index.ts             # CLI entry point
├── core/
│   ├── agent-loop.ts    # THE LOOP — keep < 200 lines
│   ├── context.ts       # System prompt assembly + compression
│   ├── session.ts       # JSONL session management
│   └── types.ts         # All type definitions
├── providers/           # LLM provider implementations
├── tools/               # Tool implementations
├── skills/              # Skill loader
├── memory/              # Memory manager
├── hooks/               # Hook engine
├── security/            # Permissions, sandbox, audit
├── scheduler/           # Cron + webhook
└── config/              # Config loading
```

## Code Style

- Use `async/await`, never `.then()` chains
- All exported functions should have JSDoc comments
- Error handling: catch specific errors, always log context
- Zod schemas are the source of truth for input types
- Prefer `const` over `let`, never `var`

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (no build needed)
npm test         # Run tests
npm run lint     # Type-check without emit
```

## Architecture Rules

1. The agent loop must stay < 200 lines
2. Each tool must be a self-contained module
3. Providers must implement exactly the `BaseProvider` interface
4. No circular imports at module load time (use lazy imports for agent runner)
5. All user-facing strings go through chalk for formatting

## Testing

Run tests with:
```bash
npm test
```

Test files are in `tests/`. Use Jest with ts-jest transformer.
