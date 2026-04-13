"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AltimeterChatProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
class AltimeterChatProvider {
    constructor(extensionUri, runner, statusBar) {
        this._isRunning = false;
        this._streamingMessageStarted = false;
        this._sessionId = (0, crypto_1.randomUUID)();
        this._lastToolName = '';
        this._lastToolInput = '';
        this._extensionUri = extensionUri;
        this._runner = runner;
        this._statusBar = statusBar;
    }
    resolveWebviewView(webviewView, _context, _token) {
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
                    this._sessionId = (0, crypto_1.randomUUID)();
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
    async sendPromptToChat(prompt) {
        // Focus the view first
        await vscode.commands.executeCommand('altimeter.chatView.focus');
        // Wait a tick for the webview to be ready
        await new Promise((r) => setTimeout(r, 200));
        // Display the user message
        this._postMessage({ type: 'addMessage', role: 'user', content: prompt });
        // Run the agent
        await this._runAgent(prompt);
    }
    async _handleUserMessage(text) {
        if (this._isRunning) {
            return;
        }
        const trimmed = text.trim();
        if (!trimmed) {
            return;
        }
        await this._runAgent(trimmed);
    }
    async _runAgent(prompt) {
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
                    }
                    catch {
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
        }
        catch (err) {
            this._postMessage({ type: 'streamEnd' });
            const errMsg = err instanceof Error ? err.message : String(err);
            this._postMessage({
                type: 'addMessage',
                role: 'error',
                content: `Error: ${errMsg}`,
            });
            this._statusBar.setError('Failed');
        }
        finally {
            this._isRunning = false;
            this._streamingMessageStarted = false;
            this._statusBar.setIdle();
            this._postMessage({ type: 'loading', active: false });
        }
    }
    _handleConfigChange(message) {
        const config = {};
        if (message.model) {
            // Derive provider from model name
            if (message.model.startsWith('gemini')) {
                config.provider = 'google';
            }
            else if (message.model.startsWith('claude')) {
                config.provider = 'anthropic';
            }
            else if (message.model.startsWith('gpt')) {
                config.provider = 'openai';
            }
            else if (message.model.startsWith('kimi') || message.model.startsWith('moonshot')) {
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
    async _handleRequestFiles(query) {
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
        }
        catch {
            this._postMessage({ type: 'fileList', files: [] });
        }
    }
    async _expandPromptReferences(prompt) {
        let expanded = prompt;
        const contextBlocks = [];
        // Handle /selection
        if (expanded.includes('/selection')) {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const selectedText = editor.document.getText(editor.selection);
                const fileName = vscode.workspace.asRelativePath(editor.document.uri);
                const startLine = editor.selection.start.line + 1;
                const endLine = editor.selection.end.line + 1;
                contextBlocks.push(`[Selected code from ${fileName} lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``);
                expanded = expanded.replace(/\/selection/g, '');
            }
        }
        // Handle /file references — pattern: /path/to/file.ext
        // Must contain a directory separator or start from a known extension
        // Requires at least one / in the path or a recognized code file extension
        const fileRefPattern = /(?:^|\s)\/((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|json|css|html|md|py|rs|go|java|c|cpp|h|hpp|yaml|yml|toml|xml|sql|sh|bash|env|txt|cfg|conf|ini|lock|prisma|graphql|proto|vue|svelte))\b/g;
        let match;
        const fileRefs = [];
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
                    contextBlocks.push(`[Context: ${filePath}]\n\`\`\`${ext}\n${text}\n\`\`\``);
                }
            }
            catch {
                // File not found, skip
            }
            expanded = expanded.replace(new RegExp(`\\/${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), filePath);
        }
        if (contextBlocks.length > 0) {
            return contextBlocks.join('\n\n') + '\n\n' + expanded.trim();
        }
        return expanded;
    }
    _parseAndForwardChunk(chunk) {
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
    _parseStderrForTools(chunk) {
        const lines = chunk.split('\n');
        for (const line of lines) {
            const clean = line.trim();
            if (!clean)
                continue;
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
                }
                catch {
                    // Incomplete JSON, wait for more lines
                }
            }
        }
    }
    _postMessage(message) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }
    _getHtmlForWebview(webview) {
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js'));
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
    get view() {
        return this._view;
    }
}
exports.AltimeterChatProvider = AltimeterChatProvider;
AltimeterChatProvider.viewType = 'altimeter.chatView';
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=chat-provider.js.map