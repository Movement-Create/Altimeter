import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRunner, RunnerConfig } from './agent-runner';
import { AltimeterStatusBar } from './status-bar';

export class AltimeterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'altimeter.chatView';

  private _view?: vscode.WebviewView;
  private _runner: AgentRunner;
  private _statusBar: AltimeterStatusBar;
  private _extensionUri: vscode.Uri;
  private _isRunning = false;
  private _streamingMessageStarted = false;

  constructor(
    extensionUri: vscode.Uri,
    runner: AgentRunner,
    statusBar: AltimeterStatusBar
  ) {
    this._extensionUri = extensionUri;
    this._runner = runner;
    this._statusBar = statusBar;
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
        case 'requestFiles':
          await this._handleRequestFiles(message.query);
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
        onStdout: (chunk) => {
          this._parseAndForwardChunk(chunk);
        },
        onStderr: () => {
          // Log stderr to output channel only
        },
        onChunk: (text) => {
          // Stream text chunks to the webview in real-time
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

  private async _handleRequestFiles(query?: string): Promise<void> {
    try {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
      const filePaths = files.map(f => vscode.workspace.asRelativePath(f));
      // Filter by query if provided
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

    // Handle @selection
    if (expanded.includes('@selection')) {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const selectedText = editor.document.getText(editor.selection);
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = editor.selection.start.line + 1;
        const endLine = editor.selection.end.line + 1;
        contextBlocks.push(
          `[Selected code from ${fileName} lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``
        );
        expanded = expanded.replace(/@selection/g, '');
      }
    }

    // Handle @file references — pattern: @path/to/file
    const fileRefPattern = /@([\w./-]+\.\w+)/g;
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
      expanded = expanded.replace(new RegExp(`@${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), filePath);
    }

    if (contextBlocks.length > 0) {
      return contextBlocks.join('\n\n') + '\n\n' + expanded.trim();
    }

    return expanded;
  }

  private _parseAndForwardChunk(chunk: string): void {
    // Look for tool call patterns in the output
    // These are heuristic matches based on common Altimeter output formats
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
      <span class="logo">⌀</span>
      <span class="title">Altimeter</span>
      <button id="clearBtn" class="icon-btn" title="Clear chat">$(trash)</button>
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
        <select id="modelSelect" aria-label="Model">
          <option value="gemini-2.5-flash">gemini-2.5-flash</option>
          <option value="gemini-2.5-pro">gemini-2.5-pro</option>
          <option value="claude-3-5-sonnet-20241022">claude-3.5-sonnet</option>
          <option value="claude-3-5-haiku-20241022">claude-3.5-haiku</option>
          <option value="gpt-4o">gpt-4o</option>
          <option value="gpt-4o-mini">gpt-4o-mini</option>
        </select>
        <select id="modeSelect" aria-label="Mode">
          <option value="auto">Auto</option>
          <option value="default">Default</option>
          <option value="plan">Plan</option>
        </select>
        <select id="effortSelect" aria-label="Effort">
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="high">High</option>
        </select>
      </div>
      <div id="input-wrapper">
        <textarea
          id="messageInput"
          placeholder="Ask Altimeter anything... (@ to reference files)"
          rows="1"
          aria-label="Message input"
        ></textarea>
        <button id="sendBtn" title="Send (Enter)" aria-label="Send message">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M8 1l7 7-7 7M15 8H1"/>
          </svg>
        </button>
      </div>
      <div id="file-autocomplete" class="hidden"></div>
      <div id="input-hint">Enter to send · Shift+Enter for newline · @ to reference files</div>
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
