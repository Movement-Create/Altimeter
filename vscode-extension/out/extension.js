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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const agent_runner_1 = require("./agent-runner");
const chat_provider_1 = require("./chat-provider");
const status_bar_1 = require("./status-bar");
const commands_1 = require("./commands");
function activate(context) {
    // Create output channel
    const outputChannel = vscode.window.createOutputChannel('Altimeter');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('Altimeter extension activating...');
    // Create core services
    const statusBar = new status_bar_1.AltimeterStatusBar();
    context.subscriptions.push({ dispose: () => statusBar.dispose() });
    const runner = new agent_runner_1.AgentRunner(outputChannel);
    // Create and register the chat webview provider
    const chatProvider = new chat_provider_1.AltimeterChatProvider(context.extensionUri, runner, statusBar);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chat_provider_1.AltimeterChatProvider.viewType, chatProvider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
    }));
    // Register all commands
    (0, commands_1.registerCommands)(context, runner, chatProvider, statusBar, outputChannel);
    // First-run API key check
    const altConfig = vscode.workspace.getConfiguration('altimeter');
    const hasSettingsKey = altConfig.get('googleApiKey', '') ||
        altConfig.get('anthropicApiKey', '') ||
        altConfig.get('openaiApiKey', '');
    const hasEnvKey = process.env.GOOGLE_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY;
    if (!hasSettingsKey && !hasEnvKey) {
        vscode.window
            .showWarningMessage('Altimeter: No API key configured. Set one in Settings to use the agent.', 'Open Settings')
            .then((selection) => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'altimeter api key');
            }
        });
    }
    outputChannel.appendLine('Altimeter extension activated.');
}
function deactivate() {
    // Cleanup is handled by disposables
}
//# sourceMappingURL=extension.js.map