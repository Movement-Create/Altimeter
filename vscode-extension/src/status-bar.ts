import * as vscode from 'vscode';

export class AltimeterStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'altimeter.openChat';
    this.statusBarItem.tooltip = 'Open Altimeter Chat';
    this.setIdle();
    this.statusBarItem.show();
  }

  setIdle() {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    this.isRunning = false;
    this.statusBarItem.text = '⌀ Altimeter';
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.tooltip = 'Open Altimeter Chat';
  }

  setRunning(message = 'Running') {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.spinnerIndex = 0;

    const updateSpinner = () => {
      const frame = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length];
      this.statusBarItem.text = `${frame} Altimeter: ${message}...`;
      this.spinnerIndex++;
    };

    updateSpinner();
    this.spinnerInterval = setInterval(updateSpinner, 100);
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    this.statusBarItem.tooltip = 'Altimeter is running — click to open chat';
  }

  setError(message = 'Error') {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    this.isRunning = false;
    this.statusBarItem.text = `$(error) Altimeter: ${message}`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );

    // Auto-reset after 5 seconds
    setTimeout(() => {
      this.setIdle();
    }, 5000);
  }

  dispose() {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
    }
    this.statusBarItem.dispose();
  }
}
