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
  const modelSelect = document.getElementById('modelSelect');
  const modeSelect = document.getElementById('modeSelect');
  const effortSelect = document.getElementById('effortSelect');
  const fileAutocomplete = document.getElementById('file-autocomplete');

  let isLoading = false;
  let messageCount = 0;
  let streamingBubble = null;
  let streamingContent = '';
  let fileList = [];
  let currentTurnId = 0;
  let chatHistory = []; // { role, content } entries for state persistence
  let lastPrompt = '';
  let pendingThinking = null; // { text, startedAt }

  const SLASH_COMMANDS = [
    { cmd: '/file', desc: 'Insert a file reference' },
    { cmd: '/model', desc: 'Switch the active model' },
    { cmd: '/clear', desc: 'Clear the current session' },
    { cmd: '/new', desc: 'Start a new session' },
    { cmd: '/help', desc: 'Show available commands' },
  ];
  let paletteMode = null; // 'commands' | 'files' | null

  // ── State ──────────────────────────────────────────────────────

  function setState() {
    sendBtn.disabled = isLoading;
    messageInput.disabled = isLoading;
  }

  function saveState() {
    vscode.setState({ chatHistory, messageCount });
  }

  function restoreState() {
    const state = vscode.getState();
    if (state && state.chatHistory && state.chatHistory.length > 0) {
      chatHistory = state.chatHistory;
      messageCount = state.messageCount || 0;
      // Re-render saved messages without animation
      messagesEl.innerHTML = '';
      chatHistory.forEach((entry) => {
        appendMessage(entry.role, entry.content, true);
      });
      return true;
    }
    return false;
  }

  // ── Init ───────────────────────────────────────────────────────

  function init() {
    // Restore previous conversation or show empty state
    if (!restoreState()) {
      showEmptyState();
    }

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

    // Toolbar config change listeners
    if (modelSelect) {
      modelSelect.addEventListener('change', sendConfigChange);
    }
    if (modeSelect) {
      modeSelect.addEventListener('change', sendConfigChange);
    }
    if (effortSelect) {
      effortSelect.addEventListener('change', sendConfigChange);
    }

    // /file autocomplete
    messageInput.addEventListener('input', handleSlashMention);
    messageInput.addEventListener('keydown', handleAutocompleteNav);

    // Notify extension we're ready
    vscode.postMessage({ type: 'ready' });

    messageInput.focus();
  }

  // ── Auto-resize textarea ────────────────────────────────────────

  function autoResize() {
    requestAnimationFrame(() => {
      messageInput.style.height = 'auto';
      const newHeight = Math.min(messageInput.scrollHeight, 120);
      messageInput.style.height = newHeight + 'px';
    });
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
    lastPrompt = text;

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
    chatHistory = [];
    saveState();
    showEmptyState();
    vscode.postMessage({ type: 'clearSession' });
  }

  // ── Toolbar config ──────────────────────────────────────────────

  function sendConfigChange() {
    vscode.postMessage({
      type: 'configChange',
      model: modelSelect ? modelSelect.value : undefined,
      mode: modeSelect ? modeSelect.value : undefined,
      effort: effortSelect ? effortSelect.value : undefined,
    });
  }

  // ── /file autocomplete ─────────────────────────────────────────

  let autocompleteActive = false;
  let autocompleteIndex = 0;
  let slashStartPos = -1;

  function handleSlashMention() {
    const value = messageInput.value;
    const cursorPos = messageInput.selectionStart;

    const beforeCursor = value.slice(0, cursorPos);
    const lastSlash = beforeCursor.lastIndexOf('/');

    if (lastSlash >= 0) {
      const charBefore = lastSlash > 0 ? beforeCursor[lastSlash - 1] : ' ';
      if (charBefore === ' ' || lastSlash === 0) {
        const textAfterSlash = beforeCursor.slice(lastSlash + 1);
        if (textAfterSlash.includes(' ') || textAfterSlash === 'selection') {
          hideAutocomplete();
          return;
        }
        slashStartPos = lastSlash;

        // If the text after / looks like a path (contains /, .) or starts with a file-command prefix,
        // show file picker. Otherwise show command palette.
        const looksLikePath = textAfterSlash.includes('/') || textAfterSlash.includes('.');
        const matchesCommand = SLASH_COMMANDS.some((c) =>
          c.cmd.slice(1).startsWith(textAfterSlash)
        );

        if (!looksLikePath && (textAfterSlash === '' || matchesCommand)) {
          showCommandPalette(textAfterSlash);
          return;
        }

        paletteMode = 'files';
        vscode.postMessage({ type: 'requestFiles', query: textAfterSlash });
        return;
      }
    }

    hideAutocomplete();
  }

  function showCommandPalette(query) {
    if (!fileAutocomplete) return;
    const filtered = SLASH_COMMANDS.filter((c) =>
      c.cmd.slice(1).toLowerCase().startsWith(query.toLowerCase())
    );
    if (filtered.length === 0) {
      hideAutocomplete();
      return;
    }

    paletteMode = 'commands';
    fileAutocomplete.innerHTML = '';
    fileAutocomplete.setAttribute('role', 'listbox');
    autocompleteIndex = 0;
    autocompleteActive = true;

    filtered.forEach((c, idx) => {
      const item = document.createElement('div');
      item.classList.add('autocomplete-item');
      item.setAttribute('role', 'option');
      item.id = 'autocomplete-opt-' + idx;
      item.dataset.command = c.cmd;
      if (idx === 0) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
      }
      const cmdSpan = document.createElement('span');
      cmdSpan.style.fontWeight = '600';
      cmdSpan.textContent = c.cmd;
      const descSpan = document.createElement('span');
      descSpan.style.opacity = '0.6';
      descSpan.style.marginLeft = '8px';
      descSpan.textContent = c.desc;
      item.appendChild(cmdSpan);
      item.appendChild(descSpan);
      item.addEventListener('click', () => runSlashCommand(c.cmd));
      fileAutocomplete.appendChild(item);
    });

    messageInput.setAttribute('aria-expanded', 'true');
    fileAutocomplete.classList.remove('hidden');
  }

  function runSlashCommand(cmd) {
    const value = messageInput.value;
    const before = value.slice(0, slashStartPos);
    const after = value.slice(messageInput.selectionStart);
    messageInput.value = (before + after).replace(/^\s+/, '');
    hideAutocomplete();

    switch (cmd) {
      case '/file':
        messageInput.value = before + '/' + after;
        messageInput.selectionStart = messageInput.selectionEnd = before.length + 1;
        paletteMode = 'files';
        slashStartPos = before.length;
        vscode.postMessage({ type: 'requestFiles', query: '' });
        messageInput.focus();
        break;
      case '/model':
        vscode.postMessage({ type: 'pickModel' });
        messageInput.focus();
        break;
      case '/clear':
        clearChat();
        break;
      case '/new':
        vscode.postMessage({ type: 'newSession' });
        break;
      case '/help':
        appendLocalHelpMessage();
        messageInput.focus();
        break;
    }
  }

  function appendLocalHelpMessage() {
    const lines = SLASH_COMMANDS.map((c) => `- \`${c.cmd}\` — ${c.desc}`).join('\n');
    const content = `**Available slash commands:**\n\n${lines}`;
    appendMessage('assistant', content);
  }

  function handleAutocompleteNav(e) {
    if (!autocompleteActive) return;

    const items = fileAutocomplete.querySelectorAll('.autocomplete-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteIndex = Math.min(autocompleteIndex + 1, items.length - 1);
      updateAutocompleteHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteIndex = Math.max(autocompleteIndex - 1, 0);
      updateAutocompleteHighlight(items);
    } else if (e.key === 'Enter' && autocompleteActive) {
      e.preventDefault();
      const selected = items[autocompleteIndex];
      if (selected) {
        if (selected.dataset.command) {
          runSlashCommand(selected.dataset.command);
        } else if (selected.dataset.path) {
          insertFileRef(selected.dataset.path);
        }
      }
    } else if (e.key === 'Escape') {
      hideAutocomplete();
    }
  }

  function showAutocomplete(files, noWorkspace) {
    if (!fileAutocomplete) {
      hideAutocomplete();
      return;
    }

    if (noWorkspace) {
      fileAutocomplete.innerHTML = '';
      fileAutocomplete.removeAttribute('role');
      const hint = document.createElement('div');
      hint.classList.add('autocomplete-item');
      hint.classList.add('autocomplete-hint');
      hint.textContent = 'Open a folder to reference files';
      fileAutocomplete.appendChild(hint);
      fileAutocomplete.classList.remove('hidden');
      return;
    }

    if (files.length === 0) {
      hideAutocomplete();
      return;
    }

    fileAutocomplete.innerHTML = '';
    fileAutocomplete.setAttribute('role', 'listbox');
    fileAutocomplete.id = 'file-autocomplete';
    autocompleteIndex = 0;
    autocompleteActive = true;

    files.forEach((filePath, idx) => {
      const item = document.createElement('div');
      item.classList.add('autocomplete-item');
      item.setAttribute('role', 'option');
      item.id = 'autocomplete-opt-' + idx;
      if (idx === 0) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.setAttribute('aria-selected', 'false');
      }
      item.dataset.path = filePath;
      item.textContent = filePath;
      item.addEventListener('click', () => insertFileRef(filePath));
      fileAutocomplete.appendChild(item);
    });

    messageInput.setAttribute('aria-expanded', 'true');
    messageInput.setAttribute('aria-activedescendant', 'autocomplete-opt-0');
    messageInput.setAttribute('aria-controls', 'file-autocomplete');
    fileAutocomplete.classList.remove('hidden');
  }

  function hideAutocomplete() {
    if (fileAutocomplete) {
      fileAutocomplete.classList.add('hidden');
      fileAutocomplete.innerHTML = '';
      fileAutocomplete.removeAttribute('role');
    }
    messageInput.removeAttribute('aria-expanded');
    messageInput.removeAttribute('aria-activedescendant');
    messageInput.removeAttribute('aria-controls');
    autocompleteActive = false;
    slashStartPos = -1;
    paletteMode = null;
  }

  function updateAutocompleteHighlight(items) {
    items.forEach((item, idx) => {
      const isActive = idx === autocompleteIndex;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-selected', String(isActive));
    });
    messageInput.setAttribute('aria-activedescendant', 'autocomplete-opt-' + autocompleteIndex);
  }

  function insertFileRef(filePath) {
    const value = messageInput.value;
    const before = value.slice(0, slashStartPos);
    const after = value.slice(messageInput.selectionStart);
    messageInput.value = before + '/' + filePath + ' ' + after;
    messageInput.selectionStart = messageInput.selectionEnd = slashStartPos + filePath.length + 2;
    hideAutocomplete();
    messageInput.focus();
  }

  // ── Streaming ──────────────────────────────────────────────────

  function handleStreamChunk(text) {
    // Remove empty state if present
    const emptyState = messagesEl.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    if (!streamingBubble) {
      // Create a new assistant message bubble for streaming
      messageCount++;
      streamingBubble = document.createElement('div');
      streamingBubble.classList.add('message', 'assistant', 'streaming');
      streamingBubble.dataset.id = String(messageCount);

      const meta = document.createElement('div');
      meta.classList.add('message-meta');
      meta.textContent = 'Altimeter';

      const contentEl = document.createElement('div');
      contentEl.classList.add('message-content');

      streamingBubble.appendChild(meta);
      streamingBubble.appendChild(contentEl);
      messagesEl.appendChild(streamingBubble);
      streamingContent = '';
    }

    streamingContent += text;
    const contentEl = streamingBubble.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(streamingContent);
      attachCopyButtons(contentEl);
      rewriteFileLinks(contentEl);
    }
    scrollToBottom();
  }

  function handleStreamEnd() {
    if (streamingBubble) {
      streamingBubble.classList.remove('streaming');
      // Re-render final content with markdown
      const contentEl = streamingBubble.querySelector('.message-content');
      if (contentEl && streamingContent) {
        contentEl.innerHTML = renderMarkdown(streamingContent);
        attachCopyButtons(contentEl);
        rewriteFileLinks(contentEl);
      }
      if (pendingThinking) {
        prependThinkingBlock(streamingBubble, pendingThinking);
        pendingThinking = null;
      }
      // Save streamed message to history
      if (streamingContent) {
        chatHistory.push({ role: 'assistant', content: streamingContent });
        saveState();
      }
    }
    streamingBubble = null;
    streamingContent = '';
  }

  // ── Message rendering ──────────────────────────────────────────

  function appendMessage(role, content, skipSave) {
    messageCount++;

    const wrapper = document.createElement('div');
    wrapper.classList.add('message', role);
    wrapper.dataset.id = String(messageCount);

    const meta = document.createElement('div');
    meta.classList.add('message-meta');
    meta.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Altimeter';

    const contentEl = document.createElement('div');
    contentEl.classList.add('message-content');

    if (role === 'user') {
      contentEl.textContent = content;
    } else if (role === 'error') {
      contentEl.textContent = content;
      const retryBtn = document.createElement('button');
      retryBtn.className = 'retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        if (lastPrompt && !isLoading) {
          wrapper.remove();
          appendMessage('user', lastPrompt);
          vscode.postMessage({ type: 'sendMessage', text: lastPrompt });
        }
      });
      contentEl.appendChild(document.createElement('br'));
      contentEl.appendChild(retryBtn);
    } else {
      contentEl.innerHTML = renderMarkdown(content);
      attachCopyButtons(contentEl);
      rewriteFileLinks(contentEl);
    }

    wrapper.appendChild(meta);
    wrapper.appendChild(contentEl);
    messagesEl.appendChild(wrapper);

    // Persist to state (skip during restore to avoid re-saving)
    if (!skipSave) {
      chatHistory.push({ role, content });
      saveState();
    }

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
    // Group tool calls by turn — reuse existing container for the same turn
    let container = messagesEl.querySelector(`.tool-calls-container[data-turn="${currentTurnId}"]`);
    if (!container) {
      container = document.createElement('div');
      container.classList.add('tool-calls-container');
      container.dataset.turn = String(currentTurnId);
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

  function findRunningToolCall(toolName) {
    // Find by name first, fall back to any running tool call
    if (toolName) {
      const toolCalls = messagesEl.querySelectorAll(`.tool-call[data-tool="${CSS.escape(toolName)}"]`);
      for (const tc of toolCalls) {
        const statusEl = tc.querySelector('.tool-status');
        if (statusEl && statusEl.textContent === 'running...') {
          return tc;
        }
      }
    }
    // Fallback: find any running tool call
    const allCalls = messagesEl.querySelectorAll('.tool-call');
    for (const tc of allCalls) {
      const statusEl = tc.querySelector('.tool-status');
      if (statusEl && statusEl.textContent === 'running...') {
        return tc;
      }
    }
    return null;
  }

  function updateToolInput(toolName, input) {
    const target = findRunningToolCall(toolName);
    if (!target) return;

    const body = target.querySelector('.tool-body');
    if (!body) return;

    // Replace existing input or add new
    let inputSection = body.querySelector('.tool-input-section');
    if (!inputSection) {
      inputSection = document.createElement('div');
      inputSection.classList.add('tool-input-section');

      const label = document.createElement('div');
      label.classList.add('tool-section-label');
      label.textContent = 'Input';

      const code = document.createElement('div');
      code.classList.add('tool-code');

      inputSection.appendChild(label);
      inputSection.appendChild(code);
      body.insertBefore(inputSection, body.firstChild);
    }

    const code = inputSection.querySelector('.tool-code');
    if (code) {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
      code.textContent = inputStr.length > 2000 ? inputStr.slice(0, 2000) + '...' : inputStr;
    }

    scrollToBottom();
  }

  function updateToolResult(toolName, output, isError) {
    const target = findRunningToolCall(toolName);
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
      <div class="logo-large">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="12" cy="12" r="9"/>
          <line x1="12" y1="3" x2="12" y2="12"/>
          <line x1="12" y1="12" x2="18" y2="9"/>
        </svg>
      </div>
      <p>Ask anything, or select code and right-click to explain or fix it.</p>
    `;
    messagesEl.appendChild(emptyState);
  }

  // ── Loading state ───────────────────────────────────────────────

  function setLoading(active) {
    isLoading = active;
    setState();

    if (active) {
      currentTurnId++;
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

      // Unordered lists (with nesting support)
      if (line.match(/^(\s*)[-*+] /)) {
        html += parseList(lines, i, 'ul');
        // Advance past all list lines (including nested)
        while (i < lines.length && lines[i].match(/^(\s*)[-*+] /) || (i < lines.length && lines[i].match(/^\s+\S/) && i > 0 && lines[i - 1].match(/^(\s*)[-*+] /))) {
          i++;
        }
        continue;
      }

      // Ordered lists (with nesting support)
      if (line.match(/^(\s*)\d+\. /)) {
        html += parseList(lines, i, 'ol');
        while (i < lines.length && lines[i].match(/^(\s*)\d+\. /) || (i < lines.length && lines[i].match(/^\s+\S/) && i > 0 && lines[i - 1].match(/^(\s*)\d+\. /))) {
          i++;
        }
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

  function parseList(lines, startIdx, listType) {
    // Collect list items with their indent levels
    const items = [];
    let idx = startIdx;
    const bulletRe = /^(\s*)([-*+])\s+(.*)/;
    const orderedRe = /^(\s*)(\d+)\.\s+(.*)/;
    const re = listType === 'ul' ? bulletRe : orderedRe;

    while (idx < lines.length) {
      const m = lines[idx].match(re);
      if (m) {
        items.push({ indent: m[1].length, text: m[3] });
        idx++;
      } else if (lines[idx].match(/^\s+\S/) && items.length > 0) {
        // Continuation line — append to previous item
        items[items.length - 1].text += ' ' + lines[idx].trim();
        idx++;
      } else {
        break;
      }
    }

    // Build nested HTML from flat indent list
    function buildNested(items, pos, baseIndent) {
      let html = `<${listType}>`;
      while (pos < items.length && items[pos].indent >= baseIndent) {
        if (items[pos].indent === baseIndent) {
          html += `<li>${inlineMarkdown(items[pos].text)}`;
          pos++;
          // Check if next items are deeper (nested)
          if (pos < items.length && items[pos].indent > baseIndent) {
            const result = buildNested(items, pos, items[pos].indent);
            html += result.html;
            pos = result.pos;
          }
          html += '</li>';
        } else {
          // Deeper than expected — start sublist
          const result = buildNested(items, pos, items[pos].indent);
          html += result.html;
          pos = result.pos;
        }
      }
      html += `</${listType}>`;
      return { html, pos };
    }

    return buildNested(items, 0, items.length > 0 ? items[0].indent : 0).html + '\n';
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

  // ── File link rewrite ──────────────────────────────────────────

  function rewriteFileLinks(container) {
    const anchors = container.querySelectorAll('a');
    anchors.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href) || href.startsWith('#')) return;
      const match = href.match(/^([^#]+?)(?:#L(\d+)(?:-L?(\d+))?)?$/);
      if (!match) return;
      const pathPart = match[1];
      if (!/\.[a-z0-9]+$/i.test(pathPart)) return;

      a.classList.add('file-link');
      a.dataset.path = pathPart;
      if (match[2]) a.dataset.line = match[2];
      a.title = pathPart;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({
          type: 'openFile',
          path: pathPart,
          line: match[2] ? parseInt(match[2], 10) : undefined,
        });
      });
    });
  }

  // ── Thinking block ─────────────────────────────────────────────

  function prependThinkingBlock(bubble, thinking) {
    if (!bubble || !thinking || !thinking.text) return;
    if (bubble.querySelector('.thinking-block')) return;

    const details = document.createElement('details');
    details.className = 'thinking-block';
    const summary = document.createElement('summary');
    const icon = document.createElement('span');
    icon.className = 'thinking-icon';
    icon.textContent = '💭';
    const label = document.createElement('span');
    const secs = thinking.durationMs ? (thinking.durationMs / 1000).toFixed(1) : null;
    label.textContent = secs ? `Thought for ${secs}s` : 'Reasoning';
    summary.appendChild(icon);
    summary.appendChild(label);

    const body = document.createElement('div');
    body.className = 'thinking-content';
    body.textContent = thinking.text;

    details.appendChild(summary);
    details.appendChild(body);

    const meta = bubble.querySelector('.message-meta');
    if (meta && meta.nextSibling) {
      bubble.insertBefore(details, meta.nextSibling);
    } else {
      bubble.appendChild(details);
    }
  }

  // ── Message handler (from extension) ────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'addMessage': {
        // Remove empty state if present
        const emptyState = messagesEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        appendMessage(msg.role, msg.content);
        break;
      }

      case 'clearMessages': {
        messagesEl.innerHTML = '';
        messageCount = 0;
        chatHistory = [];
        saveState();
        if (msg.showEmpty) {
          showEmptyState();
        }
        break;
      }

      case 'streamChunk': {
        handleStreamChunk(msg.text);
        break;
      }

      case 'streamEnd': {
        handleStreamEnd();
        break;
      }

      case 'toolCall': {
        const emptyState = messagesEl.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        appendToolCall(msg);
        break;
      }

      case 'toolInput': {
        updateToolInput(msg.name, msg.input);
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

      case 'fileList': {
        showAutocomplete(msg.files || [], msg.noWorkspace);
        break;
      }

      case 'thinking': {
        pendingThinking = {
          text: msg.text || '',
          durationMs: msg.durationMs || 0,
        };
        if (streamingBubble) {
          prependThinkingBlock(streamingBubble, pendingThinking);
          pendingThinking = null;
        }
        break;
      }

      case 'focusInput': {
        messageInput.focus();
        break;
      }

      case 'toggleThinking': {
        const blocks = messagesEl.querySelectorAll('.thinking-block');
        const anyClosed = Array.from(blocks).some((b) => !b.open);
        blocks.forEach((b) => { b.open = anyClosed; });
        break;
      }
    }
  });

  // ── Start ───────────────────────────────────────────────────────
  init();

})();
