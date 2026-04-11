/**
 * Skill loader — discovers and injects skills.
 *
 * Design:
 * - Skills live in <skills_dir>/<name>/SKILL.md
 * - Frontmatter (YAML-like) defines metadata
 * - Skills are injected when prompt matches any trigger_pattern keyword
 * - "always_inject: true" skills are always included
 * - Injection is selective: don't bloat context with irrelevant skills
 *
 * Runtime discovery: skills are rescanned every N seconds to pick up
 * new skills without restart.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import type { SkillDefinition, SkillFrontmatter } from "./types.js";

const RESCAN_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_SKILLS_DIR = "./skills";

export class SkillLoader {
  private skillsDir: string;
  private skills: Map<string, SkillDefinition> = new Map();
  private lastScan = 0;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? DEFAULT_SKILLS_DIR;
  }

  /**
   * Set skills directory.
   */
  setSkillsDir(dir: string): void {
    this.skillsDir = dir;
    this.lastScan = 0; // force rescan
  }

  /**
   * Get skills relevant to a given prompt.
   * Returns always_inject skills + skills matching trigger patterns.
   */
  async getRelevantSkills(prompt: string): Promise<SkillDefinition[]> {
    await this.scanIfStale();

    const lowerPrompt = prompt.toLowerCase();
    const relevant: SkillDefinition[] = [];

    for (const skill of this.skills.values()) {
      if (skill.always_inject) {
        relevant.push(skill);
        continue;
      }

      const matches = skill.trigger_patterns.some((pattern) => {
        // Use word boundary matching to avoid false positives
        const escaped = pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "i");
        return regex.test(lowerPrompt);
      });

      if (matches) {
        relevant.push(skill);
      }
    }

    return relevant;
  }

  /**
   * Get all loaded skills.
   */
  async getAllSkills(): Promise<SkillDefinition[]> {
    await this.scanIfStale();
    return [...this.skills.values()];
  }

  /**
   * Get a skill by name.
   */
  async getSkill(name: string): Promise<SkillDefinition | undefined> {
    await this.scanIfStale();
    return this.skills.get(name);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async scanIfStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastScan < RESCAN_INTERVAL_MS && this.skills.size > 0) {
      return;
    }

    await this.scanSkillsDir();
    this.lastScan = now;
  }

  private async scanSkillsDir(): Promise<void> {
    const baseDir = resolve(this.skillsDir);

    try {
      await stat(baseDir);
    } catch {
      return; // Skills dir doesn't exist
    }

    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = join(baseDir, entry.name, "SKILL.md");
      try {
        await stat(skillFile);
        const skill = await this.loadSkillFile(skillFile, entry.name);
        if (skill) {
          this.skills.set(skill.name, skill);
        }
      } catch {
        // No SKILL.md in this dir
      }
    }
  }

  private async loadSkillFile(
    filePath: string,
    dirName: string
  ): Promise<SkillDefinition | null> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    return {
      name: frontmatter.name ?? dirName,
      description: frontmatter.description ?? "",
      tools_required: frontmatter.tools_required ?? [],
      trigger_patterns: frontmatter.trigger_patterns ?? [],
      always_inject: frontmatter.always_inject ?? false,
      content: body,
      file_path: filePath,
    };
  }
}

// ---------------------------------------------------------------------------
// Simple frontmatter parser (no YAML library needed)
// ---------------------------------------------------------------------------

interface ParsedDoc {
  frontmatter: Partial<SkillFrontmatter>;
  body: string;
}

function parseFrontmatter(content: string): ParsedDoc {
  // Match --- delimited frontmatter
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlSection = match[1];
  const body = match[2];

  const frontmatter: Partial<SkillFrontmatter> = {};

  for (const line of yamlSection.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    // Handle arrays: [item1, item2] or YAML list format
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const items = rawValue
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      (frontmatter as Record<string, unknown>)[key] = items;
    } else if (rawValue === "true" || rawValue === "false") {
      (frontmatter as Record<string, unknown>)[key] = rawValue === "true";
    } else {
      (frontmatter as Record<string, unknown>)[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter, body };
}

// Singleton
export const skillLoader = new SkillLoader();
