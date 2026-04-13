import * as vscode from 'vscode';
import { AgentRunner } from './agent-runner';
import { AltimeterChatProvider } from './chat-provider';
import { AltimeterStatusBar } from './status-bar';
import { SessionsProvider, SessionTreeItem } from './sessions-provider';
import { SessionPanelManager } from './session-panel-manager';

export function registerCommands(
  context: vscode.ExtensionContext,
  runner: AgentRunner,
  chatProvider: AltimeterChatProvider,
  statusBar: AltimeterStatusBar,
  outputChannel: vscode.OutputChannel,
  sessionsProvider: SessionsProvider,
  sessionPanelManager: SessionPanelManager
): void {
  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.openChat', async () => {
      await vscode.commands.executeCommand('altimeter.chatView.focus');
    })
  );

  // Run Prompt (quick input → shows result in output + notification)
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.runPrompt', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter a prompt for Altimeter',
        placeHolder: 'e.g. Write a Python function to sort a list',
        ignoreFocusOut: true,
      });

      if (!prompt) {
        return;
      }

      // Send to chat panel for best UX
      await chatProvider.sendPromptToChat(prompt);
    })
  );

  // Run on Selection
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.runOnSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const instructions = await vscode.window.showInputBox({
        prompt: 'What should Altimeter do with the selected text?',
        placeHolder: 'e.g. Refactor this to use async/await',
        ignoreFocusOut: true,
      });

      if (!instructions) {
        return;
      }

      const languageId = editor.document.languageId;
      const prompt = buildCodePrompt(instructions, selection, languageId);
      await chatProvider.sendPromptToChat(prompt);
    })
  );

  // Explain Selection
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const languageId = editor.document.languageId;
      const prompt = buildCodePrompt('Explain this code in detail. Describe what it does, how it works, and any important patterns or gotchas.', selection, languageId);
      await chatProvider.sendPromptToChat(prompt);
    })
  );

  // Fix Selection
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.fixSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const languageId = editor.document.languageId;
      const prompt = buildCodePrompt('Find and fix any bugs, errors, or issues in this code. Show the corrected version with a brief explanation of what was fixed.', selection, languageId);
      await chatProvider.sendPromptToChat(prompt);
    })
  );

  // Context menu: Explain in Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.explainInChat', async () => {
      await vscode.commands.executeCommand('altimeter.explainSelection');
    })
  );

  // Context menu: Fix in Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.fixInChat', async () => {
      await vscode.commands.executeCommand('altimeter.fixSelection');
    })
  );

  // Context menu: Ask Altimeter
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.askAltimeter', async () => {
      await vscode.commands.executeCommand('altimeter.runOnSelection');
    })
  );

  // List Tools
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.listTools', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading Altimeter tools...',
          cancellable: false,
        },
        async () => {
          try {
            const tools = await runner.listTools();
            if (tools.length === 0) {
              vscode.window.showInformationMessage('No tools found');
              return;
            }

            const items: vscode.QuickPickItem[] = tools.map((t) => ({
              label: t,
            }));

            const selected = await vscode.window.showQuickPick(items, {
              title: `Altimeter Tools (${tools.length})`,
              placeHolder: 'Select a tool to learn more...',
            });

            if (selected) {
              outputChannel.appendLine(`\nTool selected: ${selected.label}`);
              outputChannel.show(true);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to list tools: ${msg}`);
          }
        }
      );
    })
  );

  // List Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.listSessions', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading Altimeter sessions...',
          cancellable: false,
        },
        async () => {
          try {
            const sessions = await runner.listSessions();
            if (sessions.length === 0) {
              vscode.window.showInformationMessage('No sessions found');
              return;
            }

            const items: vscode.QuickPickItem[] = sessions.map((s) => ({
              label: s,
            }));

            await vscode.window.showQuickPick(items, {
              title: `Altimeter Sessions (${sessions.length})`,
              placeHolder: 'Your past sessions',
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to list sessions: ${msg}`);
          }
        }
      );
    })
  );

  // Add Memory
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.addMemory', async () => {
      const fact = await vscode.window.showInputBox({
        prompt: 'Add a fact to Altimeter memory',
        placeHolder: 'e.g. I prefer TypeScript over JavaScript',
        ignoreFocusOut: true,
      });

      if (!fact) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Adding to memory...',
          cancellable: false,
        },
        async () => {
          try {
            const result = await runner.addMemory(fact);
            vscode.window.showInformationMessage(`Memory added: ${fact}`);
            outputChannel.appendLine(`\n[Memory] Added: ${fact}`);
            if (result) {
              outputChannel.appendLine(result);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to add memory: ${msg}`);
          }
        }
      );
    })
  );

  // Search Memory
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.searchMemory', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Search Altimeter memory',
        placeHolder: 'e.g. TypeScript preferences',
        ignoreFocusOut: true,
      });

      if (!query) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Searching memory...',
          cancellable: false,
        },
        async () => {
          try {
            const results = await runner.searchMemory(query);
            if (results.length === 0) {
              vscode.window.showInformationMessage(`No memories found for: "${query}"`);
              return;
            }

            const items: vscode.QuickPickItem[] = results.map((r) => ({
              label: r,
            }));

            await vscode.window.showQuickPick(items, {
              title: `Memory results for "${query}"`,
              placeHolder: 'Search results',
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to search memory: ${msg}`);
          }
        }
      );
    })
  );
  // New Session
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.newSession', async () => {
      await chatProvider.newSession();
    })
  );

  // Refresh Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.refreshSessions', () => {
      sessionsProvider.refresh();
    })
  );

  // Open Session (called from tree item click or command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'altimeter.openSession',
      async (idOrItem?: string | SessionTreeItem) => {
        let id: string | undefined;
        if (typeof idOrItem === 'string') {
          id = idOrItem;
        } else if (idOrItem && 'meta' in idOrItem) {
          id = idOrItem.meta.id;
        } else {
          const sessions = sessionsProvider.listSessionsFromDisk();
          if (sessions.length === 0) {
            vscode.window.showInformationMessage('No sessions found');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            sessions.map((s) => ({
              label: s.title,
              description: s.created_at,
              id: s.id,
            })),
            { title: 'Open Altimeter Session' }
          );
          id = picked?.id;
        }
        if (id) {
          const sessions = sessionsProvider.listSessionsFromDisk();
          const meta = sessions.find((s) => s.id === id);
          await sessionPanelManager.openSession(id, meta?.title);
        }
      }
    )
  );

  // Toggle Show All Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.toggleShowAllSessions', () => {
      sessionsProvider.toggleShowAll();
    })
  );

  // Focus Chat Input (Ctrl+L)
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.focusInput', async () => {
      await vscode.commands.executeCommand('altimeter.chatView.focus');
      const view = chatProvider.view;
      if (view) {
        view.webview.postMessage({ type: 'focusInput' });
      }
    })
  );

  // Toggle Thinking Blocks (Ctrl+Shift+T)
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.toggleThinking', () => {
      const view = chatProvider.view;
      if (view) {
        view.webview.postMessage({ type: 'toggleThinking' });
      }
    })
  );

  // Clear Current Session (Ctrl+Shift+K)
  context.subscriptions.push(
    vscode.commands.registerCommand('altimeter.clearSession', async () => {
      await chatProvider.newSession();
    })
  );

  // Rename Session
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'altimeter.renameSession',
      async (item?: SessionTreeItem) => {
        if (!item || !('meta' in item)) return;
        const newTitle = await vscode.window.showInputBox({
          title: 'Rename Session',
          value: item.meta.title,
          ignoreFocusOut: true,
        });
        if (!newTitle) return;
        const ok = sessionsProvider.renameSession(item.meta.id, newTitle);
        if (!ok) {
          vscode.window.showErrorMessage('Failed to rename session');
        }
      }
    )
  );

  // Delete Session
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'altimeter.deleteSession',
      async (item?: SessionTreeItem) => {
        if (!item || !('meta' in item)) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete session "${item.meta.title}"?`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return;
        const ok = sessionsProvider.deleteSession(item.meta.id);
        if (!ok) {
          vscode.window.showErrorMessage('Failed to delete session');
        } else if (chatProvider.currentSessionId === item.meta.id) {
          await chatProvider.newSession();
        }
      }
    )
  );
}

function buildCodePrompt(
  instruction: string,
  code: string,
  languageId: string
): string {
  const lang = languageId !== 'plaintext' ? languageId : '';
  return `${instruction}\n\n\`\`\`${lang}\n${code}\n\`\`\``;
}
