import * as vscode from 'vscode';
import { AgentRunner } from './agent-runner';
import { AltimeterChatProvider } from './chat-provider';
import { AltimeterStatusBar } from './status-bar';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  // Create output channel
  const outputChannel = vscode.window.createOutputChannel('Altimeter');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Altimeter extension activating...');

  // Create core services
  const statusBar = new AltimeterStatusBar();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  const runner = new AgentRunner(outputChannel);

  // Create and register the chat webview provider
  const chatProvider = new AltimeterChatProvider(
    context.extensionUri,
    runner,
    statusBar
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AltimeterChatProvider.viewType,
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register all commands
  registerCommands(context, runner, chatProvider, statusBar, outputChannel);

  outputChannel.appendLine('Altimeter extension activated.');
}

export function deactivate() {
  // Cleanup is handled by disposables
}
