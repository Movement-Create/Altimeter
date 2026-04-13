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
exports.AltimeterStatusBar = void 0;
const vscode = __importStar(require("vscode"));
class AltimeterStatusBar {
    constructor() {
        this.spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        this.spinnerIndex = 0;
        this.spinnerInterval = null;
        this.isRunning = false;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.tooltip = 'Altimeter is running — click to open chat';
    }
    setError(message = 'Error') {
        if (this.spinnerInterval) {
            clearInterval(this.spinnerInterval);
            this.spinnerInterval = null;
        }
        this.isRunning = false;
        this.statusBarItem.text = `$(error) Altimeter: ${message}`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
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
exports.AltimeterStatusBar = AltimeterStatusBar;
//# sourceMappingURL=status-bar.js.map