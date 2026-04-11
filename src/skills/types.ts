/**
 * Skill type definitions.
 *
 * Skills are structured markdown playbooks that get injected into the
 * agent's system prompt when relevant. This keeps the context small
 * (only relevant skills loaded) while making the agent more capable.
 *
 * A SKILL.md file has this structure:
 * ---
 * name: my-skill
 * description: One line description
 * tools_required: [bash, file_read]
 * trigger_patterns: [keyword1, keyword2]
 * ---
 *
 * [skill content follows in markdown]
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Tools this skill expects to be available */
  tools_required: string[];
  /** Keywords that trigger this skill's injection */
  trigger_patterns: string[];
  /** Whether this skill is always injected regardless of trigger */
  always_inject?: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  tools_required: string[];
  trigger_patterns: string[];
  always_inject: boolean;
  /** Raw markdown content (excluding frontmatter) */
  content: string;
  /** Absolute path to SKILL.md */
  file_path: string;
}
