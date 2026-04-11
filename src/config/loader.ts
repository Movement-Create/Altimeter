/**
 * Config loader.
 *
 * Loads configuration from (in order of priority):
 * 1. Environment variables (ALTIMETER_*)
 * 2. altimeter.json5 or altimeter.json in cwd
 * 3. ~/.altimeter/config.json5
 * 4. Defaults (from Zod schema)
 *
 * Config is merged (later sources win), then validated with Zod.
 *
 * JSON5 support: we use a simple subset parser (no external dep needed).
 * We strip comments and trailing commas, then parse as JSON.
 */

import { readFile, stat } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import { AltimeterConfigSchema } from "./schema.js";
import type { AltimeterConfig } from "./schema.js";

const CONFIG_FILE_NAMES = [
  "altimeter.json5",
  "altimeter.json",
  ".altimeter.json5",
  ".altimeter.json",
];

export async function loadConfig(cwd?: string): Promise<AltimeterConfig> {
  const base = cwd ?? process.cwd();

  // Start with empty config (Zod will apply defaults)
  let rawConfig: Record<string, unknown> = {};

  // 1. Load from global ~/.altimeter/config.json5
  const globalConfig = await loadConfigFile(
    join(homedir(), ".altimeter", "config.json5")
  );
  if (globalConfig) {
    rawConfig = { ...rawConfig, ...globalConfig };
  }

  // 2. Load from cwd
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = join(base, name);
    const fileConfig = await loadConfigFile(filePath);
    if (fileConfig) {
      rawConfig = { ...rawConfig, ...fileConfig };
      break;
    }
  }

  // 3. Override with environment variables
  const envConfig = loadFromEnv();
  rawConfig = { ...rawConfig, ...envConfig };

  // 4. Validate and apply defaults
  const result = AltimeterConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    console.error("[Config] Validation errors:", result.error.format());
    // Still apply defaults for invalid fields
    return AltimeterConfigSchema.parse({});
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Load a config file (JSON5 or JSON)
// ---------------------------------------------------------------------------

async function loadConfigFile(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    await stat(filePath);
  } catch {
    return null;
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return parseJson5(content);
  } catch (e) {
    console.error(`[Config] Failed to load ${filePath}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simple JSON5-compatible parser (strip comments + trailing commas)
// ---------------------------------------------------------------------------

function parseJson5(input: string): Record<string, unknown> {
  // Remove single-line comments (// ...)
  let json = input.replace(/\/\/[^\n]*/g, "");

  // Remove multi-line comments (/* ... */)
  json = json.replace(/\/\*[\s\S]*?\*\//g, "");

  // Remove trailing commas before } or ]
  json = json.replace(/,\s*([\]}])/g, "$1");

  // Parse as standard JSON
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Load config from environment variables
// ---------------------------------------------------------------------------

function loadFromEnv(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (process.env.ALTIMETER_MODEL) config.model = process.env.ALTIMETER_MODEL;
  if (process.env.ALTIMETER_PROVIDER)
    config.provider = process.env.ALTIMETER_PROVIDER;
  if (process.env.ALTIMETER_EFFORT) config.effort = process.env.ALTIMETER_EFFORT;
  if (process.env.ALTIMETER_MAX_TURNS)
    config.max_turns = parseInt(process.env.ALTIMETER_MAX_TURNS, 10);
  if (process.env.ALTIMETER_MAX_BUDGET)
    config.max_budget_usd = parseFloat(process.env.ALTIMETER_MAX_BUDGET);
  if (process.env.ALTIMETER_PERMISSION_MODE)
    config.permission_mode = process.env.ALTIMETER_PERMISSION_MODE;
  if (process.env.ALTIMETER_SYSTEM_PROMPT)
    config.system_prompt = process.env.ALTIMETER_SYSTEM_PROMPT;

  return config;
}

/**
 * Get the default config (useful for testing).
 */
export function getDefaultConfig(): AltimeterConfig {
  return AltimeterConfigSchema.parse({});
}
