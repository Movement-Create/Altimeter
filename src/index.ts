#!/usr/bin/env node
/**
 * Altimeter — Entry point + CLI
 *
 * Commands:
 *   altimeter chat              Interactive REPL
 *   altimeter run <prompt>      One-shot agent run
 *   altimeter serve             Start webhook server + cron scheduler
 *   altimeter session list      List all sessions
 *   altimeter session resume    Resume a session
 *   altimeter tools             List all available tools
 *   altimeter skills            List all loaded skills
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   Claude API key
 *   OPENAI_API_KEY      OpenAI API key
 *   GOOGLE_API_KEY      Gemini API key
 *   OLLAMA_BASE_URL     Ollama server URL (default: http://localhost:11434)
 *   ALTIMETER_MODEL     Default model
 *   ALTIMETER_PROVIDER  Default provider
 */

import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { loadConfig } from "./config/loader.js";
import { sessionManager } from "./core/session.js";
import { runAgent } from "./core/agent-loop.js";
import { registry } from "./tools/registry.js";
import { skillLoader } from "./skills/loader.js";
import { memoryManager } from "./memory/manager.js";
import { cronScheduler } from "./scheduler/cron.js";
import { webhookServer } from "./scheduler/webhook.js";
import { createInteractivePermissionCallback } from "./security/permissions.js";
import type { AltimeterConfig, Message } from "./core/types.js";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// CLI setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("altimeter")
  .description("Lightweight, powerful, secure AI agent orchestrator")
  .version(VERSION);

// ---------------------------------------------------------------------------
// altimeter chat — Interactive REPL
// ---------------------------------------------------------------------------

program
  .command("chat")
  .description("Start an interactive chat session")
  .option("-m, --model <model>", "Model to use (e.g. claude-3-5-sonnet-20241022)")
  .option("-p, --provider <provider>", "Provider (anthropic, openai, google, ollama)")
  .option("--effort <level>", "Effort level: low|medium|high|max", "medium")
  .option("--max-turns <n>", "Max turns per message", "50")
  .option("--max-budget <usd>", "Max USD budget per session", "5.0")
  .option("--auto", "Auto-approve all tool permissions")
  .option("--plan", "Plan mode: describe tools without executing")
  .option("--resume <session-id>", "Resume an existing session")
  .action(async (opts) => {
    const config = await loadConfig();

    // Apply CLI overrides
    if (opts.model) config.model = opts.model;
    if (opts.provider) config.provider = opts.provider;
    if (opts.effort) config.effort = opts.effort;
    if (opts.maxTurns) config.max_turns = parseInt(opts.maxTurns, 10);
    if (opts.maxBudget) config.max_budget_usd = parseFloat(opts.maxBudget);
    if (opts.auto) config.permission_mode = "auto";
    if (opts.plan) config.permission_mode = "plan";

    await runChatSession(config, opts.resume);
  });

// ---------------------------------------------------------------------------
// altimeter run <prompt> — One-shot run
// ---------------------------------------------------------------------------

program
  .command("run <prompt>")
  .description("Run a single agent prompt and exit")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --provider <provider>", "Provider")
  .option("--effort <level>", "Effort level: low|medium|high|max", "medium")
  .option("--max-turns <n>", "Max turns", "20")
  .option("--max-budget <usd>", "Max USD budget", "1.0")
  .option("--auto", "Auto-approve tool permissions")
  .option("--json", "Output result as JSON")
  .option("--system <prompt>", "System prompt override")
  .action(async (prompt: string, opts) => {
    const config = await loadConfig();

    if (opts.model) config.model = opts.model;
    if (opts.provider) config.provider = opts.provider;
    if (opts.effort) config.effort = opts.effort;
    if (opts.maxTurns) config.max_turns = parseInt(opts.maxTurns, 10);
    if (opts.maxBudget) config.max_budget_usd = parseFloat(opts.maxBudget);
    if (opts.auto) config.permission_mode = "auto";

    const session = await sessionManager.createSession(config);

    if (!opts.json) {
      console.log(chalk.dim(`Session: ${session.id}`));
      console.log(chalk.dim(`Model: ${config.model} (${config.provider})\n`));
    }

    // Set up interactive permission callback
    if (config.permission_mode === "default" && process.stdin.isTTY) {
      registry.setPermissionCallback(createInteractivePermissionCallback());
    }

    let textWasStreamed = false;

    try {
      const result = await runAgent({
        prompt,
        session,
        system_prompt: opts.system,
        onText: opts.json ? undefined : (chunk) => {
          process.stdout.write(chunk);
          textWasStreamed = true;
        },
        onToolCall: opts.json
          ? undefined
          : (call) => {
              console.log(chalk.cyan(`\n[Tool] ${call.name}`));
              const inputStr = JSON.stringify(call.input, null, 2);
              if (inputStr.length < 200) console.log(chalk.dim(inputStr));
            },
        onToolResult: opts.json
          ? undefined
          : (result) => {
              if (result.is_error) {
                console.log(chalk.red(`[Error] ${result.content.slice(0, 100)}`));
              }
            },
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (textWasStreamed) {
          console.log(); // newline after streamed text
        } else {
          console.log(result.text);
        }
        printStats(result.turns, result.usage, result.cost_usd);
      }

      process.exit(result.stop_reason === "error" ? 1 : 0);
    } catch (e) {
      console.error(chalk.red("Error:"), e);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// altimeter serve — Webhook + cron server
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Start webhook server and cron scheduler")
  .option("--port <n>", "Webhook port", "7331")
  .option("--no-cron", "Disable cron scheduler")
  .option("--no-webhook", "Disable webhook server")
  .action(async (opts) => {
    const config = await loadConfig();

    console.log(chalk.bold("Altimeter Server"));
    console.log(chalk.dim(`Model: ${config.model} (${config.provider})`));

    if (opts.webhook !== false) {
      webhookServer.configure(config);
      webhookServer.start();
    }

    if (opts.cron !== false) {
      cronScheduler.configure(config);
      cronScheduler.start();
    }

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n[Shutdown] Stopping services...");
      cronScheduler.stop();
      webhookServer.stop();
      process.exit(0);
    });

    // Keep alive
    console.log(chalk.green("\nServer running. Press Ctrl+C to stop."));
  });

// ---------------------------------------------------------------------------
// altimeter session — Session management
// ---------------------------------------------------------------------------

const sessionCmd = program.command("session").description("Session management");

sessionCmd
  .command("list")
  .description("List all sessions")
  .action(async () => {
    const sessions = await sessionManager.listSessions();
    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log(chalk.bold("\nSessions:\n"));
    for (const s of sessions) {
      console.log(`  ${chalk.cyan(s.id.slice(0, 8))}  ${s.title ?? "(untitled)"}  ${chalk.dim(s.created_at)}`);
    }
  });

sessionCmd
  .command("resume <session-id>")
  .description("Resume a session in interactive chat")
  .action(async (sessionId: string) => {
    const config = await loadConfig();
    await runChatSession(config, sessionId);
  });

sessionCmd
  .command("delete <session-id>")
  .description("Delete a session")
  .action(async (sessionId: string) => {
    const deleted = await sessionManager.deleteSession(sessionId);
    if (deleted) {
      console.log(chalk.green(`Session ${sessionId} deleted.`));
    } else {
      console.error(chalk.red(`Session ${sessionId} not found.`));
    }
  });

// ---------------------------------------------------------------------------
// altimeter tools — List tools
// ---------------------------------------------------------------------------

program
  .command("tools")
  .description("List all available tools")
  .action(() => {
    const tools = registry.listTools();
    console.log(chalk.bold("\nAvailable tools:\n"));
    for (const name of tools) {
      console.log(`  ${chalk.cyan(name)}`);
    }
  });

// ---------------------------------------------------------------------------
// altimeter skills — List skills
// ---------------------------------------------------------------------------

program
  .command("skills")
  .description("List all loaded skills")
  .action(async () => {
    const skills = await skillLoader.getAllSkills();
    if (skills.length === 0) {
      console.log("No skills found. Add skills to the ./skills directory.");
      return;
    }

    console.log(chalk.bold("\nAvailable skills:\n"));
    for (const skill of skills) {
      console.log(`  ${chalk.cyan(skill.name)}`);
      console.log(`    ${chalk.dim(skill.description)}`);
      if (skill.trigger_patterns.length > 0) {
        console.log(`    Triggers: ${skill.trigger_patterns.join(", ")}`);
      }
    }
  });

// ---------------------------------------------------------------------------
// altimeter memory — Memory commands
// ---------------------------------------------------------------------------

const memoryCmd = program.command("memory").description("Memory management");

memoryCmd
  .command("add <fact>")
  .description("Add a fact to persistent memory")
  .action(async (fact: string) => {
    await memoryManager.appendFact(fact);
    console.log(chalk.green("Fact saved to memory."));
  });

memoryCmd
  .command("search <query>")
  .description("Search memory for a keyword")
  .action(async (query: string) => {
    const results = await memoryManager.search(query);
    console.log(results);
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);

if (process.argv.length <= 2) {
  program.help();
}

// ---------------------------------------------------------------------------
// Interactive chat session
// ---------------------------------------------------------------------------

async function runChatSession(
  config: AltimeterConfig,
  resumeId?: string
): Promise<void> {
  let session;
  let history: Message[];

  if (resumeId) {
    const resumed = await sessionManager.resumeSession(resumeId);
    if (!resumed) {
      console.error(chalk.red(`Session not found: ${resumeId}`));
      process.exit(1);
    }
    session = resumed.session;
    history = resumed.messages;
    console.log(chalk.green(`Resumed session: ${resumeId}`));
  } else {
    session = await sessionManager.createSession(config);
    history = [];
  }

  // Set up permission callback
  if (config.permission_mode === "default") {
    registry.setPermissionCallback(createInteractivePermissionCallback());
  }

  printBanner(config, session.id);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Conversation loop
  let running = true;
  while (running) {
    const prompt = await question(rl, chalk.green("\n> "));

    if (!prompt.trim()) continue;

    // Handle special commands
    if (prompt.startsWith("/")) {
      const handled = await handleCommand(prompt, session, rl);
      if (handled === "exit") {
        running = false;
        break;
      }
      continue;
    }

    try {
      console.log(); // newline before response
      const result = await runAgent({
        prompt,
        session,
        history,
        onText: (chunk) => process.stdout.write(chalk.white(chunk)),
        onToolCall: (call) => {
          console.log(chalk.cyan(`\n⚙ ${call.name}`));
        },
        onToolResult: (result) => {
          if (result.is_error) {
            console.log(chalk.red(`✗ ${result.content.slice(0, 100)}`));
          }
        },
      });

      console.log("\n");
      printStats(result.turns, result.usage, result.cost_usd);

      // Update history for next turn
      history = result.messages;
    } catch (e) {
      console.error(chalk.red("\nError:"), e);
    }
  }

  rl.close();
  console.log(chalk.dim("\nSession ended."));
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function printBanner(config: AltimeterConfig, sessionId: string): void {
  console.log(chalk.bold.blue("\n⌀ Altimeter") + chalk.dim(` v${VERSION}`));
  console.log(chalk.dim(`Model: ${config.model} | Provider: ${config.provider}`));
  console.log(chalk.dim(`Session: ${sessionId.slice(0, 8)}`));
  console.log(chalk.dim(`Type /help for commands, /exit to quit\n`));
}

function printStats(
  turns: number,
  usage: { input: number; output: number },
  cost: number
): void {
  console.log(
    chalk.dim(
      `[${turns} turn${turns !== 1 ? "s" : ""} · ${usage.input + usage.output} tokens · $${cost.toFixed(4)}]`
    )
  );
}

async function handleCommand(
  cmd: string,
  session: { id: string },
  rl: ReturnType<typeof createInterface>
): Promise<"exit" | "handled"> {
  const parts = cmd.slice(1).split(" ");
  const name = parts[0].toLowerCase();

  switch (name) {
    case "exit":
    case "quit":
    case "q":
      return "exit";

    case "help":
      console.log(chalk.bold("\nCommands:"));
      console.log("  /help          Show this help");
      console.log("  /exit          Exit chat");
      console.log("  /tools         List available tools");
      console.log("  /session       Show current session ID");
      console.log("  /memory <fact> Save a fact to memory");
      return "handled";

    case "tools":
      console.log(chalk.bold("\nTools:"), registry.listTools().join(", "));
      return "handled";

    case "session":
      console.log(chalk.bold("Session ID:"), session.id);
      return "handled";

    case "memory":
      const fact = parts.slice(1).join(" ");
      if (fact) {
        await memoryManager.appendFact(fact);
        console.log(chalk.green("Fact saved."));
      } else {
        console.log("Usage: /memory <fact to remember>");
      }
      return "handled";

    default:
      console.log(chalk.yellow(`Unknown command: /${name}. Type /help for help.`));
      return "handled";
  }
}
