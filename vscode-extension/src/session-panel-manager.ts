import * as vscode from 'vscode';
import { AgentRunner, RunnerConfig } from './agent-runner';
import { AltimeterStatusBar } from './status-bar';
import { SessionsProvider } from './sessions-provider';

/**
 * Manages per-session WebviewPanels so each session can live in its own editor tab.
 * Each panel gets an isolated SessionPanel controller that talks to the shared AgentRunner.
 */
export class SessionPanelManager {
  private _panels = new Map<string, SessionPanel>();

  constructor(
    private extensionUri: vscode.Uri,
    private runner: AgentRunner,
    private statusBar: AltimeterStatusBar,
    private sessionsProvider: SessionsProvider
  ) {}

  async openSession(sessionId: string, title?: string): Promise<void> {
    const existing = this._panels.get(sessionId);
    if (existing) {
      existing.reveal();
      return;
    }

    const displayTitle = (title || 'Altimeter').slice(0, 30);
    const panel = vscode.window.createWebviewPanel(
      'altimeter.sessionPanel',
      displayTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    const controller = new SessionPanel(
      panel,
      sessionId,
      this.extensionUri,
      this.runner,
      this.statusBar,
      this.sessionsProvider
    );

    this._panels.set(sessionId, controller);
    panel.onDidDispose(() => {
      this._panels.delete(sessionId);
    });

    await controller.initialize();
  }
}

class SessionPanel {
  private _isRunning = false;
  private _streamingMessageStarted = false;
  private _lastToolName = '';
  private _lastToolInput = '';
  private _thinkingBuffer = '';
  private _thinkingStartedAt = 0;
  private _capturingThinking = false;

  constructor(
    private panel: vscode.WebviewPanel,
    private sessionId: string,
    private extensionUri: vscode.Uri,
    private runner: AgentRunner,
    private statusBar: AltimeterStatusBar,
    private sessionsProvider: SessionsProvider
  ) {}

  reveal(): void {
    this.panel.reveal();
  }

  async initialize(): Promise<void> {
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendMessage':
          await this.handleUserMessage(message.text);
          break;
        case 'cancel':
          this.runner.cancel();
          this._isRunning = false;
          this._streamingMessageStarted = false;
          this.statusBar.setIdle();
          this.post({ type: 'streamEnd' });
          this.post({ type: 'loading', active: false });
          break;
        case 'configChange':
          this.handleConfigChange(message);
          break;
        case 'openFile':
          await this.handleOpenFile(message.path, message.line);
          break;
        case 'pickModel':
          await this.handlePickModel();
          break;
        case 'clearSession':
        case 'newSession':
          // Tabs are per-session; closing the tab is how you "leave".
          break;
        case 'requestFiles':
          await this.handleRequestFiles(message.query);
          break;
        case 'ready':
          await this.replay();
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.runner.cancel();
    });
  }

  private async replay(): Promise<void> {
    const messages = this.sessionsProvider.replaySession(this.sessionId);
    this.post({ type: 'clearMessages', showEmpty: messages.length === 0 });
    for (const m of messages) {
      this.post({ type: 'addMessage', role: m.role, content: m.content });
    }
    // Use the first user message as the tab title
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      this.panel.title = firstUser.content.slice(0, 30).replace(/\s+/g, ' ').trim() || 'Altimeter';
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (this._isRunning) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.panel.title === 'Altimeter' || !this.panel.title) {
      this.panel.title = trimmed.slice(0, 30).replace(/\s+/g, ' ').trim();
    }
    await this.runAgent(trimmed);
  }

  private async runAgent(prompt: string): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    this._streamingMessageStarted = false;
    this.statusBar.setRunning('Thinking');
    this.post({ type: 'loading', active: true });

    try {
      const result = await this.runner.run({
        prompt,
        sessionId: this.sessionId,
        onStdout: () => { /* legacy tool markers handled by stderr */ },
        onStderr: (chunk) => this.parseStderrForTools(chunk),
        onChunk: (text) => {
          this._streamingMessageStarted = true;
          this.post({ type: 'streamChunk', text });
        },
      });

      this.post({ type: 'streamEnd' });

      if (!this._streamingMessageStarted) {
        this.post({
          type: 'addMessage',
          role: 'assistant',
          content: result.text || '(no response)',
        });
      }

      this.post({
        type: 'stats',
        turns: result.turns,
        tokens: (result.usage?.input || 0) + (result.usage?.output || 0),
        cost: result.cost_usd || 0,
        inputTokens: result.usage?.input || 0,
        outputTokens: result.usage?.output || 0,
      });
    } catch (err) {
      this.post({ type: 'streamEnd' });
      const errMsg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'addMessage', role: 'error', content: `Error: ${errMsg}` });
      this.statusBar.setError('Failed');
    } finally {
      this._isRunning = false;
      this._streamingMessageStarted = false;
      this.statusBar.setIdle();
      this.post({ type: 'loading', active: false });
      this.sessionsProvider.refresh();
    }
  }

  private handleConfigChange(message: { model?: string; mode?: string; effort?: string }): void {
    const config: RunnerConfig = {};
    if (message.model) {
      if (message.model.startsWith('gemini')) config.provider = 'google';
      else if (message.model.startsWith('claude')) config.provider = 'anthropic';
      else if (message.model.startsWith('gpt')) config.provider = 'openai';
      else if (message.model.startsWith('kimi') || message.model.startsWith('moonshot')) config.provider = 'moonshot';
      config.model = message.model;
    }
    if (message.mode) config.mode = message.mode.toLowerCase();
    if (message.effort) config.effort = message.effort.toLowerCase();
    this.runner.setConfig(config);
  }

  private async handleOpenFile(relPath: string, line?: number): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0 || !relPath) return;
    try {
      const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = { preview: false };
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not open ${relPath}: ${msg}`);
    }
  }

  private async handlePickModel(): Promise<void> {
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'claude-3-5-sonnet-20241022',
      'gpt-4o',
      'gpt-4o-mini',
    ];
    const picked = await vscode.window.showQuickPick(models, {
      title: 'Select Altimeter Model',
    });
    if (picked) {
      this.handleConfigChange({ model: picked });
      this.post({ type: 'modelChanged', model: picked });
    }
  }

  private async handleRequestFiles(query?: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: 'fileList', files: [], noWorkspace: true });
      return;
    }
    try {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
      const filePaths = files.map((f) => vscode.workspace.asRelativePath(f));
      const filtered = query
        ? filePaths.filter((p) => p.toLowerCase().includes(query.toLowerCase()))
        : filePaths;
      this.post({ type: 'fileList', files: filtered.slice(0, 30) });
    } catch {
      this.post({ type: 'fileList', files: [] });
    }
  }

  private parseStderrForTools(chunk: string): void {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;

      if (clean === '[Thinking]') {
        this._capturingThinking = true;
        this._thinkingBuffer = '';
        this._thinkingStartedAt = Date.now();
        continue;
      }
      const thinkingDoneMatch = clean.match(/^\[ThinkingDone\](?:\s+(\d+))?/);
      if (thinkingDoneMatch) {
        const explicit = thinkingDoneMatch[1] ? parseInt(thinkingDoneMatch[1], 10) : 0;
        const durationMs = explicit || (this._thinkingStartedAt ? Date.now() - this._thinkingStartedAt : 0);
        this.post({ type: 'thinking', text: this._thinkingBuffer.trim(), durationMs });
        this._capturingThinking = false;
        this._thinkingBuffer = '';
        this._thinkingStartedAt = 0;
        continue;
      }
      if (this._capturingThinking) {
        this._thinkingBuffer += line + '\n';
        continue;
      }

      const toolMatch = clean.match(/^\[Tool\]\s+(\S+)/);
      if (toolMatch) {
        this._lastToolName = toolMatch[1];
        this._lastToolInput = '';
        this.post({ type: 'toolCall', name: toolMatch[1], input: {} });
        continue;
      }
      const doneMatch = clean.match(/^\[ToolDone\]\s*(.*)/);
      if (doneMatch) {
        this.post({ type: 'toolResult', name: this._lastToolName, output: doneMatch[1] || '', isError: false });
        continue;
      }
      const errorMatch = clean.match(/^\[Error\]\s+(.+)/);
      if (errorMatch) {
        this.post({ type: 'toolResult', name: this._lastToolName, output: errorMatch[1], isError: true });
        continue;
      }
      if (this._lastToolName && !clean.startsWith('[')) {
        this._lastToolInput += clean + '\n';
        try {
          const input = JSON.parse(this._lastToolInput.trim());
          this.post({ type: 'toolInput', name: this._lastToolName, input });
        } catch { /* incomplete JSON */ }
      }
    }
  }

  private post(message: unknown): void {
    this.panel.webview.postMessage(message);
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${cssUri}" rel="stylesheet">
  <title>Altimeter</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <span class="logo">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="8" cy="8" r="6"/>
          <line x1="8" y1="2" x2="8" y2="8"/>
          <line x1="8" y1="8" x2="12" y2="6"/>
        </svg>
      </span>
      <span class="title">Altimeter</span>
      <div class="header-actions">
        <button id="clearBtn" class="icon-btn" title="Clear chat" aria-label="Clear chat">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25zM3.613 5.5l.806 8.87A1.75 1.75 0 006.166 16h3.668a1.75 1.75 0 001.747-1.63l.806-8.87z"/>
          </svg>
        </button>
      </div>
    </div>

    <div id="messages" role="log" aria-live="polite"></div>

    <div id="loading-bar" class="hidden">
      <div class="loading-indicator">
        <span class="spinner"></span>
        <span id="loading-text">Thinking...</span>
        <button id="cancelBtn" class="cancel-btn">Cancel</button>
      </div>
    </div>

    <div id="input-area">
      <div id="toolbar">
        <div class="select-wrap">
          <select id="modelSelect" aria-label="Model">
            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            <option value="claude-3-5-sonnet-20241022">claude-3.5-sonnet</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-4o-mini">gpt-4o-mini</option>
          </select>
        </div>
        <div class="select-wrap">
          <select id="modeSelect" aria-label="Mode">
            <option value="auto">Auto</option>
            <option value="default">Default</option>
            <option value="plan">Plan</option>
          </select>
        </div>
        <div class="select-wrap">
          <select id="effortSelect" aria-label="Effort">
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      <div id="input-wrapper">
        <textarea id="messageInput" placeholder="Ask anything... (/ for commands)" rows="1" aria-label="Message input"></textarea>
        <button id="sendBtn" title="Send (Enter)" aria-label="Send message">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div id="file-autocomplete" class="hidden"></div>
      <div id="input-hint">Enter to send · Shift+Enter for newline · / for commands</div>
    </div>
  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
