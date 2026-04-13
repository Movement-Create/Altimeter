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
  mode?: string;
  maxTurns?: number;
  maxBudget?: number;
  auto?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onChunk?: (text: string) => void;
  allowedTools?: string[];
  sessionId?: string;
}

export interface RunnerConfig {
  model?: string;
  provider?: string;
  mode?: string;
  effort?: string;
}

export class AgentRunner {
  private outputChannel: vscode.OutputChannel;
  private currentProcess: ChildProcess | null = null;
  private _config: RunnerConfig = {};
  private _bravePrompted = false;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  setConfig(config: RunnerConfig): void {
    this._config = { ...this._config, ...config };
  }

  getRunnerConfig(): RunnerConfig {
    return { ...this._config };
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
      moonshotApiKey: config.get<string>('moonshotApiKey', ''),
      braveSearchKey: config.get<string>('braveSearchKey', ''),
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

  public getSessionsDir(): string | null {
    const dir = this.getAltimeterPath();
    if (!dir) return null;
    return path.join(dir, 'sessions');
  }

  public getAltimeterDir(): string | null {
    const dir = this.getAltimeterPath();
    return dir || null;
  }

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
    if (config.moonshotApiKey) {
      env['MOONSHOT_API_KEY'] = config.moonshotApiKey;
    }
    if (config.braveSearchKey) {
      env['BRAVE_API_KEY'] = config.braveSearchKey;
    }

    return env;
  }

  /**
   * Map a provider id to the settings key, env var, and human label for its API key.
   */
  private static PROVIDER_KEY_MAP: Record<string, { setting: string; env: string; label: string; url: string }> = {
    google:    { setting: 'googleApiKey',    env: 'GOOGLE_API_KEY',    label: 'Google Gemini',    url: 'https://aistudio.google.com' },
    anthropic: { setting: 'anthropicApiKey', env: 'ANTHROPIC_API_KEY', label: 'Anthropic Claude', url: 'https://console.anthropic.com' },
    openai:    { setting: 'openaiApiKey',    env: 'OPENAI_API_KEY',    label: 'OpenAI',           url: 'https://platform.openai.com' },
    moonshot:  { setting: 'moonshotApiKey',  env: 'MOONSHOT_API_KEY',  label: 'Moonshot (Kimi)',  url: 'https://platform.moonshot.ai' },
  };

  /**
   * Ensure the model provider key and Brave Search key are configured.
   * Prompts the user for any missing keys and persists them to global settings.
   * Returns false if the user cancelled a required prompt.
   */
  private async ensureApiKeys(provider: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('altimeter');

    // Provider key (required)
    const info = AgentRunner.PROVIDER_KEY_MAP[provider];
    if (info) {
      const existing = cfg.get<string>(info.setting, '') || process.env[info.env] || '';
      if (!existing) {
        const entered = await vscode.window.showInputBox({
          title: `${info.label} API key required`,
          prompt: `Enter your ${info.label} API key (get one at ${info.url})`,
          password: true,
          ignoreFocusOut: true,
          placeHolder: info.env,
        });
        if (!entered) {
          vscode.window.showWarningMessage(`Altimeter: ${info.label} API key is required to run.`);
          return false;
        }
        await cfg.update(info.setting, entered.trim(), vscode.ConfigurationTarget.Global);
      }
    }

    // Brave Search key (optional, prompted once per session)
    const braveExisting = cfg.get<string>('braveSearchKey', '') || process.env.BRAVE_API_KEY || '';
    if (!braveExisting && !this._bravePrompted) {
      this._bravePrompted = true;
      const entered = await vscode.window.showInputBox({
        title: 'Brave Search API key (optional)',
        prompt: 'Enter your Brave Search API key for web search (free 2k/mo at brave.com/search/api). Leave blank to skip.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'BRAVE_API_KEY (optional — press Enter to skip)',
      });
      if (entered && entered.trim()) {
        await cfg.update('braveSearchKey', entered.trim(), vscode.ConfigurationTarget.Global);
      }
    }

    return true;
  }

  private getPermissionRules(): Record<string, string> {
    const config = vscode.workspace.getConfiguration('altimeter');
    return config.get<Record<string, string>>('permissionRules', {
      file_read: 'always',
      grep: 'always',
      glob: 'always',
      file_write: 'ask',
      file_edit: 'ask',
      bash: 'ask',
      code_run: 'ask',
    });
  }

  private buildAllowedTools(): string[] {
    const rules = this.getPermissionRules();
    const allowed: string[] = [];
    for (const [tool, rule] of Object.entries(rules)) {
      if (rule === 'always') {
        allowed.push(tool);
      }
    }
    return allowed;
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

    // Merge runner config overrides with options and settings
    const provider = options.provider || this._config.provider || config.provider;
    const model = options.model || this._config.model || config.model;

    const keysOk = await this.ensureApiKeys(provider);
    if (!keysOk) {
      throw new Error(`Missing API key for provider "${provider}". Set it in Altimeter settings and try again.`);
    }
    const maxTurns = options.maxTurns || config.maxTurns;
    const mode = options.mode || this._config.mode || 'auto';
    const auto = options.auto !== undefined ? options.auto : config.autoApprove;

    const args = [
      indexPath,
      'run',
      options.prompt,
      '--provider', provider,
      '--model', model,
      '--max-turns', String(maxTurns),
    ];

    // Mode handling: Plan mode gets --plan, Auto mode gets --auto, Default uses permission rules
    if (mode === 'plan') {
      args.push('--plan');
      args.push('--auto');
    } else if (mode === 'auto' || auto) {
      args.push('--auto');
    } else {
      // Default mode: use --auto but restrict with allowed-tools from permission rules
      args.push('--auto');
      const allowedTools = options.allowedTools || this.buildAllowedTools();
      if (allowedTools.length > 0) {
        args.push('--allowed-tools', allowedTools.join(','));
      }
    }

    if (options.maxBudget !== undefined) {
      args.push('--max-budget', String(options.maxBudget));
    }

    if (options.sessionId) {
      args.push('--session', options.sessionId);
    }

    const env = this.buildEnv(provider);

    this.outputChannel.appendLine(`\n[Altimeter] Running: node ${args.join(' ')}`);
    this.outputChannel.appendLine(`[Altimeter] Working dir: ${altimeterDir}`);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let streamedText = '';

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

        // Streaming: detect text output vs JSON/tool-use and forward text chunks
        if (options.onChunk) {
          const lines = chunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and JSON objects (tool calls, status messages)
            if (!trimmed) {
              continue;
            }
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              // Likely JSON — skip for streaming text
              continue;
            }
            // Skip common CLI status lines
            if (trimmed.startsWith('[tool:') || trimmed.startsWith('[Tool]') || trimmed.startsWith('---') || trimmed.startsWith('===')) {
              continue;
            }
            // Skip session/model metadata and stats lines
            if (trimmed.startsWith('Session:') || trimmed.startsWith('Model:') || /^\[\d+ turns?\s/.test(trimmed)) {
              continue;
            }
            // This is text content — forward it
            streamedText += line + '\n';
            options.onChunk(line + '\n');
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.outputChannel.append(`[stderr] ${chunk}`);
        if (options.onStderr) {
          // Strip ANSI escape codes so consumers get clean text
          const clean = chunk.replace(/\x1b\[[0-9;]*m/g, '');
          options.onStderr(clean);
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

        // Try to parse structured JSON from the output.
        // Without --json flag, the output is mostly text with possible JSON summary at end.
        const parsed = this._parseRunOutput(stdout);

        // If we streamed text and didn't get good parsed text, use the streamed content
        if (streamedText.trim() && (!parsed.text || parsed.text === '(no output)' || parsed.text.trimStart().startsWith('{'))) {
          parsed.text = streamedText.trim();
        }

        resolve(parsed);
      });

      proc.on('error', (err) => {
        this.currentProcess = null;
        reject(new Error(`Failed to start Altimeter: ${err.message}`));
      });
    });
  }

  private _parseRunOutput(stdout: string): RunResult {
    const fallback: RunResult = {
      text: stdout.trim() || '(no output)',
      turns: 0,
      usage: { input: 0, output: 0 },
      cost_usd: 0,
      stop_reason: 'unknown',
      messages: [],
    };

    // Strategy 1: Try parsing entire stdout as JSON (most common case with --json)
    try {
      const result = JSON.parse(stdout.trim()) as RunResult;
      if (result && typeof result.text === 'string') {
        return result;
      }
    } catch {
      // Not valid JSON as-is, try extraction
    }

    // Strategy 2: Find the outermost { ... } containing "text" field
    // Use a balanced-brace approach instead of greedy regex
    const textIdx = stdout.indexOf('"text"');
    if (textIdx === -1) {
      return fallback;
    }

    // Walk backwards from "text" to find the opening brace of the JSON object
    let braceStart = -1;
    for (let i = textIdx - 1; i >= 0; i--) {
      if (stdout[i] === '{') {
        braceStart = i;
        break;
      }
    }
    if (braceStart === -1) {
      return fallback;
    }

    // Walk forward from braceStart counting braces to find the matching close
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < stdout.length; i++) {
      if (stdout[i] === '{') { depth++; }
      else if (stdout[i] === '}') {
        depth--;
        if (depth === 0) {
          braceEnd = i;
          break;
        }
      }
    }
    if (braceEnd === -1) {
      return fallback;
    }

    try {
      const result = JSON.parse(stdout.slice(braceStart, braceEnd + 1)) as RunResult;
      if (result && typeof result.text === 'string') {
        return result;
      }
    } catch {
      // Extraction failed
    }

    // Strategy 3: If stdout looks like raw JSON, try to extract just the text field
    // This prevents showing raw JSON when parsing fails on the full object
    if (stdout.trim().startsWith('{') && stdout.includes('"text"')) {
      const textMatch = stdout.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (textMatch) {
        fallback.text = JSON.parse(`"${textMatch[1]}"`);
        fallback.stop_reason = 'parse_error';
      }
    }

    return fallback;
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
