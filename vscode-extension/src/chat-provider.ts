import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRunner } from './agent-runner';
import { AltimeterStatusBar } from './status-bar';

export class AltimeterChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'altimeter.chatView';

  private _view?: vscode.WebviewView;
  private _runner: AgentRunner;
  private _statusBar: AltimeterStatusBar;
  private _extensionUri: vscode.Uri;
  private _isRunning = false;

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
          this._statusBar.setIdle();
          this._postMessage({ type: 'loading', active: false });
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
    this._statusBar.setRunning('Thinking');
    this._postMessage({ type: 'loading', active: true });

    try {
      const result = await this._runner.run({
        prompt,
        onStdout: (chunk) => {
          // Try to detect tool call patterns from raw output
          // Altimeter may emit tool calls to stdout before JSON
          this._parseAndForwardChunk(chunk);
        },
        onStderr: (chunk) => {
          // Log stderr to output channel only, don't show in UI
        },
      });

      // Post the final response
      this._postMessage({
        type: 'addMessage',
        role: 'assistant',
        content: result.text || '(no response)',
      });

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
      const errMsg = err instanceof Error ? err.message : String(err);
      this._postMessage({
        type: 'addMessage',
        role: 'error',
        content: `Error: ${errMsg}`,
      });
      this._statusBar.setError('Failed');
    } finally {
      this._isRunning = false;
      this._statusBar.setIdle();
      this._postMessage({ type: 'loading', active: false });
    }
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
      <div id="input-wrapper">
        <textarea
          id="messageInput"
          placeholder="Ask Altimeter anything..."
          rows="1"
          aria-label="Message input"
        ></textarea>
        <button id="sendBtn" title="Send (Enter)" aria-label="Send message">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
            <path d="M8 1l7 7-7 7M15 8H1"/>
          </svg>
        </button>
      </div>
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
