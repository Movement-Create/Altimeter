import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from './agent-runner';

export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  filePath: string;
  status: 'done' | 'running' | 'errored';
}

const RECENT_LIMIT = 5;

export interface ReplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

type SessionNode = SessionTreeItem | ShowAllTreeItem;

export class SessionsProvider
  implements vscode.TreeDataProvider<SessionNode>
{
  public static readonly viewType = 'altimeter.sessionsView';

  private _onDidChangeTreeData = new vscode.EventEmitter<
    SessionNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _activeSessionId: string | null = null;
  private _showAll = false;

  constructor(private runner: AgentRunner) {}

  setActive(id: string | null): void {
    this._activeSessionId = id;
    this.refresh();
  }

  toggleShowAll(): void {
    this._showAll = !this._showAll;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SessionNode[]> {
    const sessions = this.listSessionsFromDisk();
    const items: SessionNode[] = [];
    const visible = this._showAll ? sessions : sessions.slice(0, RECENT_LIMIT);
    for (const s of visible) {
      items.push(new SessionTreeItem(s, s.id === this._activeSessionId));
    }
    if (!this._showAll && sessions.length > RECENT_LIMIT) {
      items.push(new ShowAllTreeItem(sessions.length - RECENT_LIMIT));
    }
    return items;
  }

  listSessionsFromDisk(): SessionMeta[] {
    const dir = this.runner.getSessionsDir();
    if (!dir || !fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir);
    const out: SessionMeta[] = [];

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      const id = name.replace(/\.jsonl$/, '');

      try {
        const stream = fs.readFileSync(full, 'utf-8');
        const firstLine = stream.split('\n', 1)[0];
        if (!firstLine) continue;
        const event = JSON.parse(firstLine);
        if (event.type !== 'session_start') continue;

        const cfg = event.data?.config ?? {};
        let title = cfg.title || `Session ${id.slice(0, 8)}`;

        // Try to upgrade title from first user message if title is generic
        if (/^Session \d{4}-\d{2}-\d{2}$/.test(title) || !cfg.title) {
          const firstUser = this.findFirstUserMessage(stream);
          if (firstUser) {
            title = firstUser.slice(0, 50).replace(/\s+/g, ' ').trim();
            if (firstUser.length > 50) title += '…';
          }
        }

        out.push({
          id,
          title,
          created_at: cfg.created_at || new Date(0).toISOString(),
          filePath: full,
          status: this.deriveStatus(stream),
        });
      } catch {
        // Skip unreadable sessions
      }
    }

    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private deriveStatus(content: string): 'done' | 'running' | 'errored' {
    let hasAssistant = false;
    let hasError = false;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant_message') hasAssistant = true;
        if (ev.type === 'error' || ev.type === 'tool_error') hasError = true;
      } catch { /* skip */ }
    }
    if (hasError) return 'errored';
    if (hasAssistant) return 'done';
    return 'running';
  }

  private findFirstUserMessage(content: string): string | null {
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user_message') {
          return String(ev.data?.content ?? '');
        }
      } catch {
        // skip
      }
    }
    return null;
  }

  replaySession(id: string): ReplayMessage[] {
    const dir = this.runner.getSessionsDir();
    if (!dir) return [];
    const file = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return [];

    const content = fs.readFileSync(file, 'utf-8');
    const messages: ReplayMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user_message') {
          messages.push({
            role: 'user',
            content: String(ev.data?.content ?? ''),
          });
        } else if (ev.type === 'assistant_message') {
          messages.push({
            role: 'assistant',
            content: String(ev.data?.content ?? ''),
          });
        }
      } catch {
        // skip
      }
    }
    return messages;
  }

  renameSession(id: string, newTitle: string): boolean {
    const dir = this.runner.getSessionsDir();
    if (!dir) return false;
    const file = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return false;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0) return false;

    try {
      const first = JSON.parse(lines[0]);
      if (first.type !== 'session_start') return false;
      first.data.config.title = newTitle;
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(file, lines.join('\n'), 'utf-8');
      this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  deleteSession(id: string): boolean {
    const dir = this.runner.getSessionsDir();
    if (!dir) return false;
    const file = path.join(dir, `${id}.jsonl`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      this.refresh();
      return true;
    } catch {
      return false;
    }
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly meta: SessionMeta,
    isActive: boolean
  ) {
    super(meta.title, vscode.TreeItemCollapsibleState.None);
    this.id = meta.id;
    this.tooltip = `${meta.title}\n${meta.created_at}\n${meta.id}`;
    this.description = relativeTime(meta.created_at);
    this.contextValue = 'altimeterSession';
    this.iconPath = iconForStatus(meta.status, isActive);
    this.command = {
      command: 'altimeter.openSession',
      title: 'Open Session',
      arguments: [meta.id],
    };
  }
}

export class ShowAllTreeItem extends vscode.TreeItem {
  constructor(hiddenCount: number) {
    super(`Show all (${hiddenCount} more)`, vscode.TreeItemCollapsibleState.None);
    this.id = '__altimeter_show_all__';
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.contextValue = 'altimeterShowAll';
    this.command = {
      command: 'altimeter.toggleShowAllSessions',
      title: 'Show All Sessions',
    };
  }
}

function iconForStatus(
  status: SessionMeta['status'],
  isActive: boolean
): vscode.ThemeIcon {
  if (status === 'errored') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
  }
  if (status === 'running') {
    return new vscode.ThemeIcon('sync~spin');
  }
  return new vscode.ThemeIcon(isActive ? 'comment-discussion' : 'check');
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}
