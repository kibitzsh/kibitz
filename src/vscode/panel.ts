import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { CommentaryEngine } from '../core/commentary'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEntry, ModelId, MODELS, ProviderStatus } from '../core/types'

export class KibitzPanel {
  private panel: vscode.WebviewPanel
  private disposed = false

  constructor(
    private context: vscode.ExtensionContext,
    private engine: CommentaryEngine,
    private watcher: SessionWatcher,
    private providers: ProviderStatus[],
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'kibitz',
      'Kibitz',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )

    this.panel.webview.html = this.getHtml()

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'focus') {
        this.engine.setFocus(msg.value)
        this.context.globalState.update('kibitz.focus', msg.value)
      } else if (msg.type === 'model') {
        this.engine.setModel(msg.value as ModelId)
      } else if (msg.type === 'pause') {
        this.engine.pause()
      } else if (msg.type === 'resume') {
        this.engine.resume()
      }
    })

    this.panel.onDidDispose(() => {
      this.disposed = true
    })

    // Restore saved focus
    const savedFocus = this.context.globalState.get<string>('kibitz.focus', '')
    if (savedFocus) {
      this.engine.setFocus(savedFocus)
      this.panel.webview.postMessage({ type: 'set-focus', value: savedFocus })
    }

    // Send initial state
    const sessions = this.watcher.getActiveSessions()
    this.panel.webview.postMessage({ type: 'sessions', value: sessions.length })
    this.panel.webview.postMessage({ type: 'model', value: this.engine.getModel() })
    this.panel.webview.postMessage({ type: 'providers', value: this.providers })
  }

  reveal(): void {
    this.panel.reveal()
  }

  isVisible(): boolean {
    return !this.disposed && this.panel.visible
  }

  addCommentary(entry: CommentaryEntry, streaming: boolean): void {
    if (this.disposed) return
    this.panel.webview.postMessage({ type: 'commentary-start', value: entry })
  }

  appendChunk(chunk: string): void {
    if (this.disposed) return
    this.panel.webview.postMessage({ type: 'commentary-chunk', value: chunk })
  }

  finishCommentary(entry: CommentaryEntry): void {
    if (this.disposed) return
    this.panel.webview.postMessage({ type: 'commentary-done', value: entry })
    const sessions = this.watcher.getActiveSessions()
    this.panel.webview.postMessage({ type: 'sessions', value: sessions.length })
  }

  showError(msg: string): void {
    if (this.disposed) return
    this.panel.webview.postMessage({ type: 'error', value: msg })
  }

  updateModel(model: ModelId): void {
    if (this.disposed) return
    this.panel.webview.postMessage({ type: 'model', value: model })
  }

  dispose(): void {
    this.panel.dispose()
    this.disposed = true
  }

  private getHtml(): string {
    const mediaPath = path.join(this.context.extensionPath, 'media', 'panel.html')
    if (fs.existsSync(mediaPath)) {
      return fs.readFileSync(mediaPath, 'utf8')
    }
    return getInlineHtml(this.providers)
  }
}

function getInlineHtml(providers: ProviderStatus[]): string {
  // Only show models whose provider is available
  const availableProviders = new Set(providers.filter(p => p.available).map(p => p.provider))
  const availableModels = MODELS.filter(m => availableProviders.has(m.provider))
  const modelOptions = availableModels.map(
    m => `<option value="${m.id}">${m.label}</option>`,
  ).join('\n')

  // Provider status badges HTML
  const providerBadges = providers.map(p => {
    const dot = p.available ? '●' : '○'
    const color = p.available ? '#22c55e' : '#6b7280'
    const title = p.available ? `${p.label} CLI v${p.version}` : `${p.label} CLI not found`
    return `<span class="provider-badge" title="${title}" style="color: ${color}">${dot} ${p.label}</span>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #444);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #444);
    --badge-claude: #d97706;
    --badge-codex: #059669;
    --badge-vscode: #6366f1;
    --badge-cli: #8b5cf6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, monospace);
    font-size: var(--vscode-font-size, 13px);
    background: var(--bg);
    color: var(--fg);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .header h1 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 1px;
  }
  .badge {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
  }
  .badge-sessions { background: var(--badge-vscode); color: white; }
  .badge-model { background: #374151; color: #d1d5db; border: 1px solid #4b5563; }
  .provider-badge {
    font-size: 11px;
    font-weight: 500;
    cursor: default;
  }
  .controls {
    display: flex;
    gap: 6px;
    margin-left: auto;
    align-items: center;
  }
  .controls select, .controls button {
    font-size: 11px;
    padding: 3px 6px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 3px;
    cursor: pointer;
  }
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
  }
  .entry {
    margin-bottom: 12px;
    padding: 8px;
    border-left: 3px solid var(--border);
    animation: fadeIn 0.3s;
  }
  .entry.claude { border-left-color: var(--badge-claude); }
  .entry.codex { border-left-color: var(--badge-codex); }
  .entry-header {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
  .entry-header .agent-badge {
    padding: 1px 4px;
    border-radius: 2px;
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
  }
  .agent-badge.claude { background: var(--badge-claude); color: white; }
  .agent-badge.codex { background: var(--badge-codex); color: white; }
  .source-badge { font-size: 10px; opacity: 0.6; }
  .event-summary {
    font-size: 11px;
    opacity: 0.6;
    margin-bottom: 4px;
    font-style: italic;
  }
  .commentary {
    font-size: 13px;
    line-height: 1.6;
  }
  .commentary strong { font-weight: 700; }
  .commentary ul {
    margin: 2px 0;
    padding-left: 16px;
  }
  .commentary li {
    margin-bottom: 2px;
  }
  .commentary p {
    margin: 2px 0;
  }
  .error-entry {
    color: #ef4444;
    padding: 6px 8px;
    font-size: 12px;
    opacity: 0.8;
  }
  .input-area {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .input-area input {
    width: 100%;
    padding: 6px 8px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    font-size: 12px;
    outline: none;
  }
  .input-area input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }
  .cursor { animation: blink 0.8s infinite; }
  @keyframes blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.5;
    text-align: center;
    padding: 40px;
  }
  .empty-state h2 { font-size: 16px; margin-bottom: 8px; }
  .empty-state p { font-size: 12px; max-width: 300px; }
</style>
</head>
<body>
  <div class="header">
    <h1>KIBITZ</h1>
    ${providerBadges}
    <span class="badge badge-sessions" id="sessions">0 sessions</span>
    <div class="controls">
      <select id="model-select">
        ${modelOptions}
      </select>
      <button id="pause-btn">Pause</button>
    </div>
  </div>
  <div class="feed" id="feed">
    <div class="empty-state" id="empty">
      <h2>Waiting for action...</h2>
      <p>Start a Claude Code or Codex session and Kibitz will provide live commentary.</p>
    </div>
  </div>
  <div class="input-area">
    <input type="text" id="focus-input" placeholder='Focus: e.g., "roast everything", "focus on security", "be a pirate"' />
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const feed = document.getElementById('feed');
  const empty = document.getElementById('empty');
  const sessionsEl = document.getElementById('sessions');
  const modelSelect = document.getElementById('model-select');
  const pauseBtn = document.getElementById('pause-btn');
  const focusInput = document.getElementById('focus-input');
  let currentEntry = null;
  let currentRawText = '';
  let autoScroll = true;
  let paused = false;

  feed.addEventListener('scroll', () => {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    autoScroll = atBottom;
  });

  function scrollToBottom() {
    if (autoScroll) feed.scrollTop = feed.scrollHeight;
  }

  function renderCommentary(text) {
    // Split into lines, group bullets into <ul>, wrap rest in <p>
    const lines = text.split('\\n');
    let html = '';
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bullet = trimmed.match(/^[-*]\\s+(.*)/);
      if (bullet) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + fmt(bullet[1]) + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + fmt(trimmed) + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  function fmt(s) {
    return s
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\`([^\`]+)\`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:2px;font-size:12px">$1</code>');
  }

  function timeStr(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'model', value: modelSelect.value });
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    vscode.postMessage({ type: paused ? 'pause' : 'resume' });
  });

  let focusTimer = null;
  focusInput.addEventListener('input', () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      vscode.postMessage({ type: 'focus', value: focusInput.value });
    }, 500);
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;

    if (msg.type === 'commentary-start') {
      empty.style.display = 'none';
      const entry = msg.value;
      const div = document.createElement('div');
      div.className = 'entry ' + entry.agent;
      div.innerHTML = \`
        <div class="entry-header">
          <span class="agent-badge \${entry.agent}">\${entry.agent}</span>
          <span>\${entry.projectName}</span>
          <span class="source-badge">[\${entry.source}]</span>
          <span>\${timeStr(entry.timestamp)}</span>
        </div>
        <div class="event-summary">\${entry.eventSummary}</div>
        <div class="commentary" id="current-commentary"><span class="cursor">|</span></div>
      \`;
      feed.appendChild(div);
      currentEntry = div;
      currentRawText = '';
      scrollToBottom();
    }

    if (msg.type === 'commentary-chunk') {
      const el = document.getElementById('current-commentary');
      if (el) {
        currentRawText += msg.value;
        el.innerHTML = renderCommentary(currentRawText) + '<span class="cursor">|</span>';
        scrollToBottom();
      }
    }

    if (msg.type === 'commentary-done') {
      const el = document.getElementById('current-commentary');
      if (el) {
        el.innerHTML = renderCommentary(msg.value.commentary);
        el.removeAttribute('id');
      }
      currentEntry = null;
      scrollToBottom();
    }

    if (msg.type === 'error') {
      const div = document.createElement('div');
      div.className = 'error-entry';
      div.textContent = msg.value;
      feed.appendChild(div);
      scrollToBottom();
    }

    if (msg.type === 'sessions') {
      sessionsEl.textContent = msg.value + ' session' + (msg.value !== 1 ? 's' : '');
    }

    if (msg.type === 'model') {
      modelSelect.value = msg.value;
    }

    if (msg.type === 'set-focus') {
      focusInput.value = msg.value;
    }

    if (msg.type === 'providers') {
      // Update provider badges dynamically if needed
      const badges = document.querySelectorAll('.provider-badge');
      msg.value.forEach((p, i) => {
        if (badges[i]) {
          const dot = p.available ? '●' : '○';
          const color = p.available ? '#22c55e' : '#6b7280';
          badges[i].style.color = color;
          badges[i].textContent = dot + ' ' + p.label;
          badges[i].title = p.available ? p.label + ' CLI v' + (p.version || '') : p.label + ' CLI not found';
        }
      });
    }
  });
</script>
</body>
</html>`
}
