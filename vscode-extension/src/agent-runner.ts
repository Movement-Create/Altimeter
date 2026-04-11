import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface RunResult {
  text: string;
  turns: number;
  usage: { input: number; output: number };
  cost_usd: number;
  stop_reason: string;
  messages: unknown[];
}

export interface AgentRunOptions {
  prompt: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  auto?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export class AgentRunner {
  private outputChannel: vscode.OutputChannel;
  private currentProcess: ChildProcess | null = null;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  private getConfig() {
    const config = vscode.workspace.getConfiguration('altimeter');
    return {
      provider: config.get<string>('provider', 'google'),
      model: config.get<string>('model', 'gemini-2.5-flash'),
      maxTurns: config.get<number>('maxTurns', 10),
      maxBudget: config.get<number>('maxBudget', 1.0),
      autoApprove: config.get<boolean>('autoApprove', true),
      googleApiKey: config.get<string>('googleApiKey', ''),
      anthropicApiKey: config.get<string>('anthropicApiKey', ''),
      openaiApiKey: config.get<string>('openaiApiKey', ''),
      altimeterPath: config.get<string>('altimeterPath', ''),
    };
  }

  private getAltimeterPath(): string {
    const config = this.getConfig();
    if (config.altimeterPath && fs.existsSync(config.altimeterPath)) {
      return config.altimeterPath;
    }

    // Try to find altimeter relative to workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const candidate = path.join(folder.uri.fsPath, 'dist', 'index.js');
        if (fs.existsSync(candidate)) {
          return folder.uri.fsPath;
        }
      }
    }

    // Try common locations
    const commonPaths = [
      path.join(process.env.HOME || '', 'Altimeter'),
      path.join(process.env.HOME || '', 'altimeter'),
      '/home/user/workspace/Altimeter',
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, 'dist', 'index.js'))) {
        return p;
      }
    }

    return '';
  }

  private buildEnv(provider: string): NodeJS.ProcessEnv {
    const config = this.getConfig();
    const env = { ...process.env };

    if (config.googleApiKey) {
      env['GOOGLE_API_KEY'] = config.googleApiKey;
      env['GEMINI_API_KEY'] = config.googleApiKey;
    }
    if (config.anthropicApiKey) {
      env['ANTHROPIC_API_KEY'] = config.anthropicApiKey;
    }
    if (config.openaiApiKey) {
      env['OPENAI_API_KEY'] = config.openaiApiKey;
    }

    return env;
  }

  async run(options: AgentRunOptions): Promise<RunResult> {
    const config = this.getConfig();
    const altimeterDir = this.getAltimeterPath();

    if (!altimeterDir) {
      throw new Error(
        'Altimeter installation not found. Set altimeter.altimeterPath in settings.'
      );
    }

    const indexPath = path.join(altimeterDir, 'dist', 'index.js');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Altimeter index.js not found at: ${indexPath}`);
    }

    const provider = options.provider || config.provider;
    const model = options.model || config.model;
    const maxTurns = options.maxTurns || config.maxTurns;
    const auto = options.auto !== undefined ? options.auto : config.autoApprove;

    const args = [
      indexPath,
      'run',
      options.prompt,
      '--provider', provider,
      '--model', model,
      '--max-turns', String(maxTurns),
      '--json',
    ];

    if (auto) {
      args.push('--auto');
    }

    if (options.maxBudget !== undefined) {
      args.push('--max-budget', String(options.maxBudget));
    }

    const env = this.buildEnv(provider);

    this.outputChannel.appendLine(`\n[Altimeter] Running: node ${args.join(' ')}`);
    this.outputChannel.appendLine(`[Altimeter] Working dir: ${altimeterDir}`);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn('node', args, {
        cwd: altimeterDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentProcess = proc;

      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.outputChannel.append(chunk);
        if (options.onStdout) {
          options.onStdout(chunk);
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.outputChannel.append(`[stderr] ${chunk}`);
        if (options.onStderr) {
          options.onStderr(chunk);
        }
      });

      proc.on('close', (code) => {
        this.currentProcess = null;
        this.outputChannel.appendLine(`\n[Altimeter] Process exited with code ${code}`);

        if (code !== 0) {
          reject(new Error(`Altimeter exited with code ${code}. Stderr: ${stderr.slice(0, 500)}`));
          return;
        }

        // Parse JSON output — it may have other text before/after the JSON
        const jsonMatch = stdout.match(/\{[\s\S]*"text"[\s\S]*\}/);
        if (!jsonMatch) {
          // Return a best-effort result with the raw text
          resolve({
            text: stdout.trim() || '(no output)',
            turns: 0,
            usage: { input: 0, output: 0 },
            cost_usd: 0,
            stop_reason: 'unknown',
            messages: [],
          });
          return;
        }

        try {
          const result = JSON.parse(jsonMatch[0]) as RunResult;
          resolve(result);
        } catch (e) {
          // Try parsing the entire stdout as JSON
          try {
            const result = JSON.parse(stdout.trim()) as RunResult;
            resolve(result);
          } catch {
            resolve({
              text: stdout.trim(),
              turns: 0,
              usage: { input: 0, output: 0 },
              cost_usd: 0,
              stop_reason: 'parse_error',
              messages: [],
            });
          }
        }
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        reject(new Error(`Failed to start Altimeter: ${err.message}`));
      });
    });
  }

  async listTools(): Promise<string[]> {
    const altimeterDir = this.getAltimeterPath();
    if (!altimeterDir) {
      throw new Error('Altimeter installation not found.');
    }

    const indexPath = path.join(altimeterDir, 'dist', 'index.js');
    const config = this.getConfig();
    const env = this.buildEnv(config.provider);

    return new Promise((resolve, reject) => {
      let stdout = '';
      const proc = spawn('node', [indexPath, 'tools'], {
        cwd: altimeterDir,
        env,
      });

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', () => {
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(lines);
      });
      proc.on('error', reject);
    });
  }

  async listSessions(): Promise<string[]> {
    const altimeterDir = this.getAltimeterPath();
    if (!altimeterDir) {
      throw new Error('Altimeter installation not found.');
    }

    const indexPath = path.join(altimeterDir, 'dist', 'index.js');
    const config = this.getConfig();
    const env = this.buildEnv(config.provider);

    return new Promise((resolve, reject) => {
      let stdout = '';
      const proc = spawn('node', [indexPath, 'session', 'list'], {
        cwd: altimeterDir,
        env,
      });

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', () => {
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(lines);
      });
      proc.on('error', reject);
    });
  }

  async addMemory(fact: string): Promise<string> {
    const altimeterDir = this.getAltimeterPath();
    if (!altimeterDir) {
      throw new Error('Altimeter installation not found.');
    }

    const indexPath = path.join(altimeterDir, 'dist', 'index.js');
    const config = this.getConfig();
    const env = this.buildEnv(config.provider);

    return new Promise((resolve, reject) => {
      let stdout = '';
      const proc = spawn('node', [indexPath, 'memory', 'add', fact], {
        cwd: altimeterDir,
        env,
      });

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', () => resolve(stdout.trim()));
      proc.on('error', reject);
    });
  }

  async searchMemory(query: string): Promise<string[]> {
    const altimeterDir = this.getAltimeterPath();
    if (!altimeterDir) {
      throw new Error('Altimeter installation not found.');
    }

    const indexPath = path.join(altimeterDir, 'dist', 'index.js');
    const config = this.getConfig();
    const env = this.buildEnv(config.provider);

    return new Promise((resolve, reject) => {
      let stdout = '';
      const proc = spawn('node', [indexPath, 'memory', 'search', query], {
        cwd: altimeterDir,
        env,
      });

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.on('close', () => {
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve(lines);
      });
      proc.on('error', reject);
    });
  }

  cancel() {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }
}
