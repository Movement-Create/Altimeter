/**
 * Heartbeat / cron system.
 *
 * Enables scheduled agent actions defined in ALTIMETER.md or altimeter.json5:
 *
 * cron:
 *   - name: "daily-standup"
 *     schedule: "0 9 * * 1-5"  # 9am weekdays
 *     prompt: "Summarize open GitHub issues and create a standup report"
 *     enabled: true
 *
 * Uses node-cron for scheduling. Each job spawns a fresh agent session.
 *
 * Design: Cron jobs are stateless — each run gets a fresh context.
 * Output is logged to memory/<date>.md.
 */

import cron from "node-cron";
import type { AltimeterConfig } from "../core/types.js";
import { sessionManager } from "../core/session.js";
import { runAgent } from "../core/agent-loop.js";
import { memoryManager } from "../memory/manager.js";

interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  task?: cron.ScheduledTask;
}

export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map();
  private config?: AltimeterConfig;
  private running = false;

  /**
   * Configure from AltimeterConfig.
   */
  configure(config: AltimeterConfig): void {
    this.config = config;
  }

  /**
   * Start all enabled cron jobs.
   */
  start(): void {
    if (this.running || !this.config) return;
    this.running = true;

    for (const jobConfig of this.config.cron ?? []) {
      if (!jobConfig.enabled) continue;
      this.scheduleJob(jobConfig);
    }

    console.log(`[Cron] Started ${this.jobs.size} job(s)`);
  }

  /**
   * Stop all cron jobs.
   */
  stop(): void {
    for (const job of this.jobs.values()) {
      job.task?.stop();
    }
    this.jobs.clear();
    this.running = false;
    console.log("[Cron] All jobs stopped");
  }

  /**
   * Add a job dynamically (at runtime, not from config).
   */
  addJob(name: string, schedule: string, prompt: string): void {
    this.scheduleJob({ name, schedule, prompt, enabled: true });
  }

  /**
   * Remove a job by name.
   */
  removeJob(name: string): void {
    const job = this.jobs.get(name);
    if (job) {
      job.task?.stop();
      this.jobs.delete(name);
    }
  }

  /**
   * List all jobs and their status.
   */
  listJobs(): Array<{ name: string; schedule: string; enabled: boolean }> {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      schedule: j.schedule,
      enabled: j.enabled,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private scheduleJob(jobConfig: {
    name: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
  }): void {
    if (!cron.validate(jobConfig.schedule)) {
      console.error(
        `[Cron] Invalid schedule for "${jobConfig.name}": ${jobConfig.schedule}`
      );
      return;
    }

    const task = cron.schedule(jobConfig.schedule, async () => {
      console.log(`[Cron] Running job: ${jobConfig.name}`);
      await this.runJob(jobConfig.name, jobConfig.prompt);
    });

    this.jobs.set(jobConfig.name, {
      ...jobConfig,
      task,
    });
  }

  private async runJob(name: string, prompt: string): Promise<void> {
    if (!this.config) return;

    const session = await sessionManager.createSession(this.config, {
      title: `Cron: ${name}`,
    });

    try {
      const result = await runAgent({ prompt, session });

      // Log output to memory
      await memoryManager.logConversation(
        `[CRON:${name}] ${prompt}`,
        result.text,
        session.id
      );

      console.log(`[Cron] Job "${name}" completed in ${result.turns} turns`);
    } catch (e) {
      console.error(`[Cron] Job "${name}" failed:`, e);
    }
  }
}

export const cronScheduler = new CronScheduler();
