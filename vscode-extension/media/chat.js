// Altimeter Chat Webview — Client-side JavaScript
// Handles message rendering, markdown parsing, tool calls, and VS Code API communication

(function () {
  'use strict';

  // Acquire VS Code API (singleton)
  const vscode = acquireVsCodeApi();

  // DOM references
  const messagesEl = document.getElementById('messages');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const loadingBar = document.getElementById('loading-bar');
  const loadingText = document.getElementById('loading-text');
  const cancelBtn = document.getElementById('cancelBtn');
  const clearBtn = document.getElementById('clearBtn');

  let isLoading = false;
  let messageCount = 0;

  // ── State ──────────────────────────────────────────────────────

  function setState() {
    sendBtn.disabled = isLoading;
    messageInput.disabled = isLoading;
  }

  // ── Init ───────────────────────────────────────────────────────

  function init() {
    // Show empty state
    showEmptyState();

    // Auto-resize textarea
    messageInput.addEventListener('input', autoResize);

    // Send on Enter (Shift+Enter for newline)
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);
    cancelBtn.addEventListener('click', cancelRun);
    clearBtn.addEventListener('click', clearChat);

    // Notify extension we're ready
    vscode.postMessage({ type: 'ready' });

    messageInput.focus();
  }

  // ── Auto-resize textarea ────────────────────────────────────────

  function autoResize() {
    messageInput.style.height = 'auto';
    const newHeight = Math.min(messageInput.scrollHeight, 120);
    messageInput.style.height = newHeight + 'px';
  }

  // ── Send message ───────────────────────────────────────────────

  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isLoading) return;

    // Remove empty state if present
    const emptyState = messagesEl.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Add user message to UI
    appendMessage('user', text);

    // Send to extension
    vscode.postMessage({ type: 'sendMessage', text });

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
  }

  function cancelRun() {
    vscode.postMessage({ type: 'cancel' });
  }

  function clearChat() {
    messagesEl.innerHTML = '';
    messageCount = 0;
    showEmptyState();
  }

  // ── Message rendering ──────────────────────────────────────────

  function appendMessage(role, content) {
    messageCount++;

    const wrapper = document.createElement('div');
    wrapper.classList.add('message', role);
    wrapper.dataset.id = String(messageCount);

    const meta = document.createElement('div');
    meta.classList.add('message-meta');
    meta.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Altimeter';

    const contentEl = document.createElement('div');
    contentEl.classList.add('message-content');

    if (role === 'user' || role === 'error') {
      contentEl.textContent = content;
    } else {
      contentEl.innerHTML = renderMarkdown(content);
      attachCopyButtons(contentEl);
    }

    wrapper.appendChild(meta);
    wrapper.appendChild(contentEl);
    messagesEl.appendChild(wrapper);

    scrollToBottom();
    return wrapper;
  }

  function appendStats(data) {
    const statsEl = document.createElement('div');
    statsEl.classList.add('stats');

    const parts = [];
    if (data.turns !== undefined && data.turns > 0) {
      parts.push(`${data.turns} turn${data.turns !== 1 ? 's' : ''}`);
    }
    if (data.tokens !== undefined && data.tokens > 0) {
      parts.push(`${formatNumber(data.tokens)} tokens`);
    }
    if (data.inputTokens !== undefined && data.outputTokens !== undefined && data.tokens > 0) {
      parts.push(`↑${formatNumber(data.inputTokens)} ↓${formatNumber(data.outputTokens)}`);
    }
    if (data.cost !== undefined && data.cost > 0) {
      parts.push(`$${data.cost.toFixed(4)}`);
    }

    if (parts.length === 0) return;

    statsEl.innerHTML = parts.map(p => `<span>${escapeHtml(p)}</span>`).join('');

    // Append after last assistant message
    const messages = messagesEl.querySelectorAll('.message.assistant');
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      lastMsg.appendChild(statsEl);
    }
  }

  function appendToolCall(data) {
    // Find last assistant message, or create a container
    let container = messagesEl.querySelector('.tool-calls-container:last-child');
    if (!container) {
      container = document.createElement('div');
      container.classList.add('tool-calls-container');
      messagesEl.appendChild(container);
    }

    const details = document.createElement('details');
    details.classList.add('tool-call');
    details.dataset.tool = data.name;

    const summary = document.createElement('summary');

    const badge = document.createElement('span');
    badge.classList.add('tool-badge');
    badge.textContent = 'tool';

    const name = document.createElement('span');
    name.classList.add('tool-name');
    name.textContent = data.name || 'unknown';

    const status = document.createElement('span');
    status.classList.add('tool-status');
    status.textContent = 'running...';

    summary.appendChild(badge);
    summary.appendChild(name);
    summary.appendChild(status);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.classList.add('tool-body');

    if (data.input && Object.keys(data.input).length > 0) {
      const label = document.createElement('div');
      label.classList.add('tool-section-label');
      label.textContent = 'Input';

      const code = document.createElement('div');
      code.classList.add('tool-code');
      code.textContent = JSON.stringify(data.input, null, 2);

      body.appendChild(label);
      body.appendChild(code);
    }

    details.appendChild(body);
    container.appendChild(details);

    scrollToBottom();
    return { details, status, body };
  }

  function updateToolResult(toolName, output, isError) {
    // Find the last tool call with this name that has 'running...' status
    const toolCalls = messagesEl.querySelectorAll(`.tool-call[data-tool="${CSS.escape(toolName)}"]`);
    let target = null;
    for (const tc of toolCalls) {
      const statusEl = tc.querySelector('.tool-status');
      if (statusEl && statusEl.textContent === 'running...') {
        target = tc;
        break;
      }
    }

    if (!target) return;

    const statusEl = target.querySelector('.tool-status');
    if (statusEl) {
      statusEl.textContent = isError ? '✗ error' : '✓ done';
      statusEl.classList.add(isError ? 'error' : 'success');
    }

    const body = target.querySelector('.tool-body');
    if (body && output) {
      const label = document.createElement('div');
      label.classList.add('tool-section-label');
      label.textContent = isError ? 'Error Output' : 'Output';

      const code = document.createElement('div');
      code.classList.add('tool-code');
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      code.textContent = outputStr.length > 2000 ? outputStr.slice(0, 2000) + '...' : outputStr;

      body.appendChild(label);
      body.appendChild(code);
    }
  }

  function showEmptyState() {
    const emptyState = document.createElement('div');
    emptyState.classList.add('empty-state');
    emptyState.innerHTML = `
      <div class="logo-large">⌀</div>
      <p>Start a conversation with Altimeter. Ask anything, or select code in the editor and right-click to explain or fix it.</p>
    `;
    messagesEl.appendChild(emptyState);
  }

  // ── Loading state ───────────────────────────────────────────────

  function setLoading(active) {
    isLoading = active;
    setState();

    if (active) {
      loadingBar.classList.remove('hidden');
      loadingText.textContent = 'Thinking...';
    } else {
      loadingBar.classList.add('hidden');
    }

    scrollToBottom();
  }

  // ── Scroll ──────────────────────────────────────────────────────

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── Copy to clipboard ───────────────────────────────────────────

  function attachCopyButtons(container) {
    const codeBlocks = container.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
      const copyBtn = pre.querySelector('.copy-btn');
      if (!copyBtn) return;

      copyBtn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        if (!code) return;

        const text = code.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch(() => {
          // Fallback
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        });
      });
    });
  }

  // ── Markdown Renderer ───────────────────────────────────────────
  // Lightweight markdown parser — handles the most common patterns

  function renderMarkdown(text) {
    if (!text) return '';

    // Escape HTML first (will un-escape specific patterns)
    let html = '';
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code blocks
      const fenceMatch = line.match(/^(`{3,}|~{3,})\s*(\S*)/);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = fenceMatch[2] || '';
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith(fence)) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence

        const code = codeLines.join('\n');
        html += buildCodeBlock(lang, code);
        continue;
      }

      // Headers
      const h3 = line.match(/^### (.+)/);
      const h2 = line.match(/^## (.+)/);
      const h1 = line.match(/^# (.+)/);
      if (h1) { html += `<h1>${inlineMarkdown(h1[1])}</h1>\n`; i++; continue; }
      if (h2) { html += `<h2>${inlineMarkdown(h2[1])}</h2>\n`; i++; continue; }
      if (h3) { html += `<h3>${inlineMarkdown(h3[1])}</h3>\n`; i++; continue; }

      // Blockquotes
      if (line.startsWith('> ')) {
        const quoteLines = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          quoteLines.push(lines[i].slice(2));
          i++;
        }
        html += `<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>\n`;
        continue;
      }

      // Unordered lists
      if (line.match(/^[-*+] /)) {
        const items = [];
        while (i < lines.length && lines[i].match(/^[-*+] /)) {
          items.push(`<li>${inlineMarkdown(lines[i].slice(2))}</li>`);
          i++;
        }
        html += `<ul>${items.join('')}</ul>\n`;
        continue;
      }

      // Ordered lists
      const olMatch = line.match(/^(\d+)\. /);
      if (olMatch) {
        const items = [];
        while (i < lines.length && lines[i].match(/^\d+\. /)) {
          items.push(`<li>${inlineMarkdown(lines[i].replace(/^\d+\. /, ''))}</li>`);
          i++;
        }
        html += `<ol>${items.join('')}</ol>\n`;
        continue;
      }

      // Horizontal rules
      if (line.match(/^[-*_]{3,}$/)) {
        html += '<hr>\n';
        i++;
        continue;
      }

      // Empty line → paragraph break
      if (line.trim() === '') {
        html += '\n';
        i++;
        continue;
      }

      // Regular paragraph line
      html += `<p>${inlineMarkdown(line)}</p>\n`;
      i++;
    }

    return html;
  }

  function inlineMarkdown(text) {
    // Escape HTML entities
    let out = escapeHtml(text);

    // Inline code `...`
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold **...**
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // Italic *...*
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(/_([^_]+)_/g, '<em>$1</em>');

    // Strikethrough ~~...~~
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // Links [text](url)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    return out;
  }

  function buildCodeBlock(lang, code) {
    const escapedCode = escapeHtml(code);
    const langLabel = lang || 'code';
    return `<pre><div class="code-block-header"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="copy-btn">Copy</button></div><code class="language-${escapeHtml(lang)}">${escapedCode}</code></pre>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ── Message handler (from extension) ────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'addMessage': {
        // Remove empty state if present
        const emptyState = messagesEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        // Remove tool calls container (if any) before adding response
        if (msg.role === 'assistant' || msg.role === 'error') {
          const toolContainers = messagesEl.querySelectorAll('.tool-calls-container');
          // Keep them in place — they show above the response
        }

        appendMessage(msg.role, msg.content);
        break;
      }

      case 'toolCall': {
        const emptyState = messagesEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        appendToolCall(msg);
        break;
      }

      case 'toolResult': {
        updateToolResult(msg.name, msg.output, msg.isError);
        break;
      }

      case 'stats': {
        appendStats(msg);
        break;
      }

      case 'loading': {
        setLoading(msg.active);
        if (msg.active && msg.message) {
          loadingText.textContent = msg.message;
        }
        break;
      }
    }
  });

  // ── Start ───────────────────────────────────────────────────────
  init();

})();
