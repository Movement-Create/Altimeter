import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { AgentRunner, RunnerConfig } from './agent-runner';
import { AltimeterStatusBar } from './status-bar';
import { SessionsProvider } from './sessions-provider';

export class AltimeterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'altimeter.chatView';

  private _view?: vscode.WebviewView;
  private _runner: AgentRunner;
  private _statusBar: AltimeterStatusBar;
  private _extensionUri: vscode.Uri;
  private _isRunning = false;
  private _streamingMessageStarted = false;
  private _sessionId: string = randomUUID();
  private _sessionsProvider?: SessionsProvider;

  constructor(
    extensionUri: vscode.Uri,
    runner: AgentRunner,
    statusBar: AltimeterStatusBar
  ) {
    this._extensionUri = extensionUri;
    this._runner = runner;
    this._statusBar = statusBar;
  }

  public setSessionsProvider(provider: SessionsProvider): void {
    this._sessionsProvider = provider;
    this._sessionsProvider.setActive(this._sessionId);
  }

  public get currentSessionId(): string {
    return this._sessionId;
  }

  public async newSession(): Promise<void> {
    await vscode.commands.executeCommand('altimeter.chatView.focus');
    this._sessionId = randomUUID();
    this._postMessage({ type: 'clearMessages', showEmpty: true });
    this._sessionsProvider?.setActive(this._sessionId);
  }

  public async loadSession(id: string): Promise<void> {
    if (!this._sessionsProvider) return;
    await vscode.commands.executeCommand('altimeter.chatView.focus');
    // Give the webview a moment to resolve if it was just created
    await new Promise((r) => setTimeout(r, 150));

    this._sessionId = id;
    const messages = this._sessionsProvider.replaySession(id);

    this._postMessage({ type: 'clearMessages', showEmpty: false });
    for (const m of messages) {
      this._postMessage({
        type: 'addMessage',
        role: m.role,
        content: m.content,
      });
    }
    if (messages.length === 0) {
      this._postMessage({ type: 'clearMessages', showEmpty: true });
    }
    this._sessionsProvider.setActive(this._sessionId);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendMessage':
          await this._handleUserMessage(message.text);
          break;
        case 'cancel':
          this._runner.cancel();
          this._isRunning = false;
          this._streamingMessageStarted = false;
          this._statusBar.setIdle();
          this._postMessage({ type: 'streamEnd' });
          this._postMessage({ type: 'loading', active: false });
          break;
        case 'configChange':
          this._handleConfigChange(message);
          break;
        case 'clearSession':
          this._sessionId = randomUUID();
          this._sessionsProvider?.setActive(this._sessionId);
          break;
        case 'requestFiles':
          await this._handleRequestFiles(message.query);
          break;
        case 'openFile':
          await this._handleOpenFile(message.path, message.line);
          break;
        case 'pickModel':
          await this._handlePickModel();
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'ready':
          // Webview is ready
          break;
      }
    });
  }

  async sendPromptToChat(prompt: string): Promise<void> {
    // Focus the view first
    await vscode.commands.executeCommand('altimeter.chatView.focus');

    // Wait a tick for the webview to be ready
    await new Promise((r) => setTimeout(r, 200));

    // Display the user message
    this._postMessage({ type: 'addMessage', role: 'user', content: prompt });

    // Run the agent
    await this._runAgent(prompt);
  }

  private async _handleUserMessage(text: string): Promise<void> {
    if (this._isRunning) {
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    await this._runAgent(trimmed);
  }

  private async _runAgent(prompt: string): Promise<void> {
    if (this._isRunning) {
      return;
    }

    this._isRunning = true;
    this._streamingMessageStarted = false;
    this._statusBar.setRunning('Thinking');
    this._postMessage({ type: 'loading', active: true });

    // Expand @file and @selection references in the prompt
    const expandedPrompt = await this._expandPromptReferences(prompt);

    try {
      const result = await this._runner.run({
        prompt: expandedPrompt,
        sessionId: this._sessionId,
        onStdout: (chunk) => {
          this._parseAndForwardChunk(chunk);
        },
        onStderr: (chunk) => {
          // Parse tool call and error events from stderr
          this._parseStderrForTools(chunk);
        },
        onChunk: (text) => {
          this._streamingMessageStarted = true;
          this._postMessage({ type: 'streamChunk', text });
        },
      });

      // Signal end of stream
      this._postMessage({ type: 'streamEnd' });

      // If no streaming happened, post the full response as a message
      if (!this._streamingMessageStarted) {
        let displayText = result.text || '(no response)';
        if (displayText.trimStart().startsWith('{') && displayText.includes('"text"')) {
          try {
            const parsed = JSON.parse(displayText);
            if (parsed && typeof parsed.text === 'string') {
              displayText = parsed.text;
            }
          } catch {
            // Not JSON, use as-is
          }
        }
        this._postMessage({
          type: 'addMessage',
          role: 'assistant',
          content: displayText,
        });
      }

      // Post stats
      this._postMessage({
        type: 'stats',
        turns: result.turns,
        tokens: (result.usage?.input || 0) + (result.usage?.output || 0),
        cost: result.cost_usd || 0,
        inputTokens: result.usage?.input || 0,
        outputTokens: result.usage?.output || 0,
      });
    } catch (err) {
      this._postMessage({ type: 'streamEnd' });
      const errMsg = err instanceof Error ? err.message : String(err);
      this._postMessage({
        type: 'addMessage',
        role: 'error',
        content: `Error: ${errMsg}`,
      });
      this._statusBar.setError('Failed');
    } finally {
      this._isRunning = false;
      this._streamingMessageStarted = false;
      this._statusBar.setIdle();
      this._postMessage({ type: 'loading', active: false });
      this._sessionsProvider?.refresh();
    }
  }

  private _handleConfigChange(message: { model?: string; mode?: string; effort?: string }): void {
    const config: RunnerConfig = {};
    if (message.model) {
      // Derive provider from model name
      if (message.model.startsWith('gemini')) {
        config.provider = 'google';
      } else if (message.model.startsWith('claude')) {
        config.provider = 'anthropic';
      } else if (message.model.startsWith('gpt')) {
        config.provider = 'openai';
      } else if (message.model.startsWith('kimi') || message.model.startsWith('moonshot')) {
        config.provider = 'moonshot';
      }
      config.model = message.model;
    }
    if (message.mode) {
      config.mode = message.mode.toLowerCase();
    }
    if (message.effort) {
      config.effort = message.effort.toLowerCase();
    }
    this._runner.setConfig(config);
  }

  private async _handleOpenFile(relPath: string, line?: number): Promise<void> {
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

  private async _handlePickModel(): Promise<void> {
    const models = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'gpt-4o',
      'gpt-4o-mini',
      'kimi-k2-0905-preview',
      'kimi-k2-thinking-turbo',
      'moonshot-v1-32k',
    ];
    const picked = await vscode.window.showQuickPick(models, {
      title: 'Select Altimeter Model',
      placeHolder: 'Pick a model for the active session',
    });
    if (picked) {
      this._handleConfigChange({ model: picked });
      this._postMessage({ type: 'modelChanged', model: picked });
    }
  }

  private async _handleRequestFiles(query?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._postMessage({ type: 'fileList', files: [], noWorkspace: true });
      return;
    }

    try {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
      const filePaths = files.map(f => vscode.workspace.asRelativePath(f));
      const filtered = query
        ? filePaths.filter(p => p.toLowerCase().includes(query.toLowerCase()))
        : filePaths;
      this._postMessage({ type: 'fileList', files: filtered.slice(0, 30) });
    } catch {
      this._postMessage({ type: 'fileList', files: [] });
    }
  }

  private async _expandPromptReferences(prompt: string): Promise<string> {
    let expanded = prompt;
    const contextBlocks: string[] = [];

    // Handle /selection
    if (expanded.includes('/selection')) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const selectedText = editor.document.getText(editor.selection);
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = editor.selection.start.line + 1;
        const endLine = editor.selection.end.line + 1;
        contextBlocks.push(
          `[Selected code from ${fileName} lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``
        );
        expanded = expanded.replace(/\/selection/g, '');
      }
    }

    // Handle /file references — pattern: /path/to/file.ext
    // Must contain a directory separator or start from a known extension
    // Requires at least one / in the path or a recognized code file extension
    const fileRefPattern = /(?:^|\s)\/((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|json|css|html|md|py|rs|go|java|c|cpp|h|hpp|yaml|yml|toml|xml|sql|sh|bash|env|txt|cfg|conf|ini|lock|prisma|graphql|proto|vue|svelte))\b/g;
    let match;
    const fileRefs: string[] = [];
    while ((match = fileRefPattern.exec(expanded)) !== null) {
      if (match[1] !== 'selection') {
        fileRefs.push(match[1]);
      }
    }

    for (const filePath of fileRefs) {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          const fullUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
          const fileContent = await vscode.workspace.fs.readFile(fullUri);
          const text = Buffer.from(fileContent).toString('utf-8');
          const ext = path.extname(filePath).slice(1) || '';
          contextBlocks.push(
            `[Context: ${filePath}]\n\`\`\`${ext}\n${text}\n\`\`\``
          );
        }
      } catch {
        // File not found, skip
      }
      expanded = expanded.replace(new RegExp(`\\/${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), filePath);
    }

    if (contextBlocks.length > 0) {
      return contextBlocks.join('\n\n') + '\n\n' + expanded.trim();
    }

    return expanded;
  }

  private _parseAndForwardChunk(chunk: string): void {
    // Look for tool call patterns in the output (legacy lowercase format)
    const toolCallPattern = /\[tool:([^\]]+)\]/g;
    let match;
    while ((match = toolCallPattern.exec(chunk)) !== null) {
      this._postMessage({
        type: 'toolCall',
        name: match[1],
        input: {},
      });
    }
  }

  private _lastToolName = '';
  private _lastToolInput = '';
  private _thinkingBuffer = '';
  private _thinkingStartedAt = 0;
  private _capturingThinking = false;

  private _parseStderrForTools(chunk: string): void {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;

      // Match [Thinking] start
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
        this._postMessage({
          type: 'thinking',
          text: this._thinkingBuffer.trim(),
          durationMs,
        });
        this._capturingThinking = false;
        this._thinkingBuffer = '';
        this._thinkingStartedAt = 0;
        continue;
      }
      if (this._capturingThinking) {
        this._thinkingBuffer += line + '\n';
        continue;
      }

      // Match [Tool] tool_name
      const toolMatch = clean.match(/^\[Tool\]\s+(\S+)/);
      if (toolMatch) {
        this._lastToolName = toolMatch[1];
        this._lastToolInput = '';
        this._postMessage({
          type: 'toolCall',
          name: toolMatch[1],
          input: {},
        });
        continue;
      }

      // Match [ToolDone] result preview
      const doneMatch = clean.match(/^\[ToolDone\]\s*(.*)/);
      if (doneMatch) {
        this._postMessage({
          type: 'toolResult',
          name: this._lastToolName,
          output: doneMatch[1] || '',
          isError: false,
        });
        continue;
      }

      // Match [Error] message
      const errorMatch = clean.match(/^\[Error\]\s+(.+)/);
      if (errorMatch) {
        this._postMessage({
          type: 'toolResult',
          name: this._lastToolName,
          output: errorMatch[1],
          isError: true,
        });
        continue;
      }

      // Lines between [Tool] and [ToolDone]/[Error] are tool input (JSON)
      if (this._lastToolName && !clean.startsWith('[')) {
        this._lastToolInput += clean + '\n';
        // Try to parse as JSON and send as input update
        try {
          const input = JSON.parse(this._lastToolInput.trim());
          this._postMessage({
            type: 'toolInput',
            name: this._lastToolName,
            input,
          });
        } catch {
          // Incomplete JSON, wait for more lines
        }
      }
    }
  }

  private _postMessage(message: unknown): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );

    // Use a nonce to allow only specific scripts
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
            <option value="claude-3-5-haiku-20241022">claude-3.5-haiku</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="kimi-k2-0905-preview">kimi-k2</option>
            <option value="kimi-k2-thinking-turbo">kimi-k2-thinking</option>
            <option value="moonshot-v1-32k">moonshot-v1-32k</option>
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
        <textarea
          id="messageInput"
          placeholder="Ask anything... (/ to ref files)"
          rows="1"
          aria-label="Message input"
        ></textarea>
        <button id="sendBtn" title="Send (Enter)" aria-label="Send message">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div id="file-autocomplete" class="hidden"></div>
      <div id="input-hint">Enter to send · Shift+Enter for newline</div>
    </div>
  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  public get view(): vscode.WebviewView | undefined {
    return this._view;
  }
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
