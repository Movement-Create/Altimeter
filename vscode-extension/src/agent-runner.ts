import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
    const searched: string[] = [];

    // 1. Check explicit setting
    if (config.altimeterPath) {
      if (fs.existsSync(config.altimeterPath)) {
        return config.altimeterPath;
      }
      searched.push(`altimeter.altimeterPath setting: ${config.altimeterPath} (not found)`);
    } else {
      searched.push('altimeter.altimeterPath setting (not set)');
    }

    // 2. Try to find altimeter relative to workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const candidate = path.join(folder.uri.fsPath, 'dist', 'index.js');
        if (fs.existsSync(candidate)) {
          return folder.uri.fsPath;
        }
        searched.push(`Workspace: ${folder.uri.fsPath} (no dist/index.js)`);
      }
    } else {
      searched.push('Workspace folders (none open)');
    }

    // 3. Check parent directory of the extension itself (repo root)
    const extensionRoot = path.resolve(__dirname, '..', '..');
    if (fs.existsSync(path.join(extensionRoot, 'dist', 'index.js'))) {
      return extensionRoot;
    }
    searched.push(`Extension parent: ${extensionRoot} (no dist/index.js)`);

    // 4. Try common locations using os.homedir() for cross-platform support
    const home = os.homedir();
    const commonPaths = [
      path.join(home, 'Altimeter'),
      path.join(home, 'altimeter'),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, 'dist', 'index.js'))) {
        return p;
      }
      searched.push(`${p} (not found)`);
    }

    // Store searched paths for the error message
    this._lastSearchedPaths = searched;
    return '';
  }

  private _lastSearchedPaths: string[] = [];

  private buildEnv(provider: string): NodeJS.ProcessEnv {
    const config = this.getConfig();
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // VS Code settings override env vars
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
      const paths = this._lastSearchedPaths.map(p => `  - ${p}`).join('\n');
      throw new Error(
        `Altimeter installation not found. Searched:\n${paths}\nSet altimeter.altimeterPath in VS Code settings to your Altimeter install directory.`
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
          let friendlyHint = '';
          if (/API error 403|PERMISSION_DENIED/i.test(stderr)) {
            friendlyHint = 'API key is missing or invalid. Check your Altimeter settings.';
          } else if (/ENOENT|not found/i.test(stderr)) {
            friendlyHint = 'Altimeter CLI not found. Check altimeter.altimeterPath setting.';
          } else if (/ECONNREFUSED|ETIMEDOUT/i.test(stderr)) {
            friendlyHint = 'Network error. Check your internet connection.';
          }

          const stderrSnippet = stderr.slice(0, 2000);
          const hint = friendlyHint ? `\n\n${friendlyHint}` : '';
          reject(new Error(
            `Altimeter exited with code ${code}. Stderr: ${stderrSnippet}${hint}\n\nSee full details: View → Output → Altimeter`
          ));
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
