import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { CommentaryEngine } from '../core/commentary'
import {
  COMMENTARY_STYLE_OPTIONS,
  CommentaryStyleId,
  CommentaryEntry,
  DispatchStatus,
  DispatchTarget,
  ModelId,
  MODELS,
  ProviderStatus,
  SessionInfo,
} from '../core/types'

interface PanelHandlers {
  onDispatchPrompt?: (target: DispatchTarget, prompt: string) => void
  onSetTarget?: (target: DispatchTarget) => void
}

type WebviewToExtensionMessage =
  | { type: 'focus'; value: string }
  | { type: 'model'; value: ModelId }
  | { type: 'preset'; value: string }
  | { type: 'format-styles'; value: CommentaryStyleId[] }
  | { type: 'show-event-summary'; value: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'dispatch-prompt'; value: { target: DispatchTarget; prompt: string } }
  | { type: 'set-target'; value: DispatchTarget }

type ExtensionToWebviewMessage =
  | { type: 'history'; value: CommentaryEntry[] }
  | { type: 'commentary-start'; value: CommentaryEntry }
  | { type: 'commentary-chunk'; value: string }
  | { type: 'commentary-done'; value: CommentaryEntry }
  | { type: 'error'; value: string }
  | { type: 'sessions'; value: number }
  | { type: 'model'; value: ModelId }
  | { type: 'set-focus'; value: string }
  | { type: 'set-preset'; value: string }
  | { type: 'set-format-styles'; value: CommentaryStyleId[] }
  | { type: 'set-show-event-summary'; value: boolean }
  | { type: 'providers'; value: ProviderStatus[] }
  | { type: 'active-sessions'; value: SessionInfo[] }
  | { type: 'dispatch-status'; value: DispatchStatus }
  | { type: 'target-selected'; value: DispatchTarget }

export class KibitzPanel {
  private panel: vscode.WebviewPanel
  private disposed = false
  private activeSessions: SessionInfo[] = []
  private selectedTarget: DispatchTarget = { kind: 'new-codex' }
  private showEventSummary = false

  constructor(
    private context: vscode.ExtensionContext,
    private engine: CommentaryEngine,
    private providers: ProviderStatus[],
    private extensionVersion: string,
    private handlers: PanelHandlers = {},
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'kibitz',
      'Kibitz',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )

    this.panel.webview.html = this.getHtml()

    this.panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'focus') {
        this.engine.setFocus(msg.value)
        this.context.globalState.update('kibitz.focus', msg.value)
        return
      }

      if (msg.type === 'model') {
        this.engine.setModel(msg.value)
        return
      }

      if (msg.type === 'preset') {
        this.engine.setPreset(msg.value)
        return
      }

      if (msg.type === 'format-styles') {
        this.engine.setFormatStyles(msg.value)
        return
      }

      if (msg.type === 'show-event-summary') {
        this.showEventSummary = !!msg.value
        this.context.globalState.update('kibitz.showEventSummary', this.showEventSummary)
        this.postMessage({ type: 'set-show-event-summary', value: this.showEventSummary })
        return
      }

      if (msg.type === 'pause') {
        this.engine.pause()
        return
      }

      if (msg.type === 'resume') {
        this.engine.resume()
        return
      }

      if (msg.type === 'set-target') {
        this.selectedTarget = msg.value
        this.handlers.onSetTarget?.(msg.value)
        return
      }

      if (msg.type === 'dispatch-prompt') {
        const target = msg.value?.target
        const prompt = String(msg.value?.prompt || '')
        if (!target || !prompt.trim()) return
        this.handlers.onDispatchPrompt?.(target, prompt)
      }
    })

    this.panel.onDidDispose(() => {
      this.disposed = true
    })

    const savedFocus = this.context.globalState.get<string>('kibitz.focus', '')
    if (savedFocus) {
      this.engine.setFocus(savedFocus)
      this.postMessage({ type: 'set-focus', value: savedFocus })
    }

    this.showEventSummary = this.context.globalState.get<boolean>('kibitz.showEventSummary', false)

    this.postMessage({ type: 'sessions', value: 0 })
    this.postMessage({ type: 'model', value: this.engine.getModel() })
    this.postMessage({ type: 'set-preset', value: this.engine.getPreset() })
    this.postMessage({ type: 'set-format-styles', value: this.engine.getFormatStyles() })
    this.postMessage({ type: 'set-show-event-summary', value: this.showEventSummary })
    this.postMessage({ type: 'providers', value: this.providers })
    this.postMessage({ type: 'active-sessions', value: [] })
    this.postMessage({ type: 'target-selected', value: this.selectedTarget })
  }

  reveal(): void {
    this.panel.reveal()
  }

  isVisible(): boolean {
    return !this.disposed
  }

  addCommentary(entry: CommentaryEntry): void {
    if (this.disposed) return
    this.postMessage({ type: 'commentary-start', value: entry })
  }

  appendChunk(chunk: string): void {
    if (this.disposed) return
    this.postMessage({ type: 'commentary-chunk', value: chunk })
  }

  finishCommentary(entry: CommentaryEntry): void {
    if (this.disposed) return
    this.postMessage({ type: 'commentary-done', value: entry })
  }

  showError(msg: string): void {
    if (this.disposed) return
    this.postMessage({ type: 'error', value: msg })
  }

  updateModel(model: ModelId): void {
    if (this.disposed) return
    this.postMessage({ type: 'model', value: model })
  }

  updatePreset(preset: string): void {
    if (this.disposed) return
    this.postMessage({ type: 'set-preset', value: preset })
  }

  updateFormatStyles(styleIds: CommentaryStyleId[]): void {
    if (this.disposed) return
    this.postMessage({ type: 'set-format-styles', value: styleIds.slice() })
  }

  updateProviders(providers: ProviderStatus[]): void {
    if (this.disposed) return
    this.providers = providers
    this.postMessage({ type: 'providers', value: providers })
  }

  updateActiveSessions(sessions: SessionInfo[]): void {
    if (this.disposed) return
    this.activeSessions = sessions.slice()
    this.postMessage({ type: 'active-sessions', value: this.activeSessions })
    this.postMessage({ type: 'sessions', value: this.activeSessions.length })
  }

  setHistory(entries: CommentaryEntry[]): void {
    if (this.disposed) return
    this.postMessage({ type: 'history', value: entries.slice() })
  }

  setTarget(target: DispatchTarget): void {
    this.selectedTarget = target
    if (this.disposed) return
    this.postMessage({ type: 'target-selected', value: target })
  }

  postDispatchStatus(status: DispatchStatus): void {
    if (this.disposed) return
    this.postMessage({ type: 'dispatch-status', value: status })
  }

  dispose(): void {
    this.panel.dispose()
    this.disposed = true
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.panel.webview.postMessage(message)
  }

  private getHtml(): string {
    const mediaPath = path.join(this.context.extensionPath, 'media', 'panel.html')
    if (fs.existsSync(mediaPath)) {
      return fs.readFileSync(mediaPath, 'utf8')
    }
    return getInlineHtml(
      this.providers,
      this.extensionVersion,
      this.engine.getModel(),
      this.engine.getPreset(),
      this.engine.getFormatStyles(),
    )
  }
}

export function getInlineHtml(
  providers: ProviderStatus[],
  extensionVersion: string,
  initialModel: ModelId,
  initialPreset: string,
  initialFormatStyles: CommentaryStyleId[] = COMMENTARY_STYLE_OPTIONS.map((option) => option.id),
): string {
  const availableProviders = new Set(providers.filter((provider) => provider.available).map((provider) => provider.provider))
  const availableModels = MODELS.filter((model) => availableProviders.has(model.provider))
  const fallbackModel = availableModels[0]?.id || initialModel

  const modelOptionsHtml = availableModels.map((model) => {
    const selected = model.id === initialModel ? ' selected' : ''
    return `<option value="${model.id}"${selected}>${escapeHtml(model.label)}</option>`
  }).join('\n')

  const modelData = JSON.stringify(
    availableModels.map((model) => ({ id: model.id, label: model.label, provider: model.provider })),
  ).replace(/</g, '\\u003c')

  const templateOptionsHtml = [
    { value: 'auto', label: 'Template: Auto' },
    { value: 'critical-coder', label: 'Very Critical Coder' },
    { value: 'precise-short', label: 'Precise + Short' },
    { value: 'emotional', label: 'Emotional' },
    { value: 'newbie', label: 'For Newbies' },
  ].map((item) => {
    const selected = item.value === initialPreset ? ' selected' : ''
    return `<option value="${item.value}"${selected}>${escapeHtml(item.label)}</option>`
  }).join('\n')

  const formatStyleOptionsData = JSON.stringify(COMMENTARY_STYLE_OPTIONS).replace(/</g, '\\u003c')
  const initialFormatStylesData = JSON.stringify(
    Array.isArray(initialFormatStyles) && initialFormatStyles.length > 0
      ? initialFormatStyles
      : COMMENTARY_STYLE_OPTIONS.map((option) => option.id),
  ).replace(/</g, '\\u003c')

  const providerBadges = providers.map((provider) => {
    const dot = provider.available ? '●' : '○'
    const color = provider.available ? '#22c55e' : '#6b7280'
    const title = provider.available
      ? `${provider.label} CLI ${provider.version || ''}`.trim()
      : `${provider.label} CLI not found`
    return `<span class="provider-badge" style="color:${color}" title="${escapeHtml(title)}">${dot} ${escapeHtml(provider.label)}</span>`
  }).join('\n')

  const safeVersion = extensionVersion.replace(/[^0-9a-zA-Z._-]/g, '') || 'dev'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #3f3f46);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #52525b);
    --codex-provider: #10b981;
    --claude-provider: #f97316;
    --badge-vscode: #6366f1;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, monospace);
    font-size: var(--vscode-font-size, 13px);
  }
  body {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .header {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 1px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    padding: 2px 7px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-version {
    color: #cbd5e1;
    background: #1f2937;
    border: 1px solid #334155;
  }
  .badge-sessions {
    color: #cbd5e1;
    background: rgba(71, 85, 105, 0.38);
    border: 1px solid rgba(100, 116, 139, 0.52);
  }
  .provider-badge {
    font-size: 12px;
    font-weight: 600;
  }
  .controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .controls button {
    min-width: 32px;
    cursor: pointer;
  }
  #pause-btn {
    appearance: none;
    background: rgba(255, 255, 255, 0.06);
    color: #e2e8f0;
    border: none;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    padding: 6px 9px;
  }
  #pause-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  #pause-btn:focus {
    outline: 1px solid var(--vscode-focusBorder, #0ea5e9);
  }
  .native-select-hidden {
    display: none;
  }
  .menu-host {
    position: relative;
  }
  .menu-trigger {
    appearance: none;
    background: rgba(255, 255, 255, 0.06);
    color: #e2e8f0;
    border: none;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.15;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-weight: 600;
    padding: 5px 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .menu-trigger:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .menu-trigger:focus {
    outline: 1px solid var(--vscode-focusBorder, #0ea5e9);
  }
  .menu-trigger .caret {
    color: #9ca3af;
    opacity: 0.95;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }
  .menu-list {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 230px;
    max-height: 220px;
    overflow-y: auto;
    background: rgba(24, 24, 27, 0.98);
    border: 1px solid rgba(82, 82, 91, 0.5);
    border-radius: 8px;
    box-shadow: 0 10px 22px rgba(0, 0, 0, 0.45);
    padding: 4px;
    z-index: 10;
  }
  .controls .menu-list {
    top: calc(100% + 6px);
    bottom: auto;
    left: auto;
    right: 0;
  }
  .menu-list.hidden { display: none; }
  .menu-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 11px;
    line-height: 1.2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 5px 7px;
    border-radius: 5px;
    cursor: pointer;
  }
  .menu-option:hover {
    background: rgba(251, 146, 60, 0.2);
  }
  .menu-option.selected {
    background: rgba(251, 146, 60, 0.27);
    color: #fdba74;
  }
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
  }
  .entry {
    margin-bottom: 12px;
    padding: 8px 10px;
    border-left: 2px solid rgba(148, 163, 184, 0.35);
    cursor: pointer;
  }
  .entry.codex { border-left-color: var(--codex-provider); }
  .entry.claude { border-left-color: var(--claude-provider); }
  .entry.selected-target {
    outline: none;
    border-left-width: 3px;
  }
  .entry:hover { background: transparent; }
  .entry-header {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    margin-bottom: 6px;
    font-size: 12px;
    opacity: 0.82;
  }
  .agent-badge {
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    border-radius: 4px;
    padding: 2px 6px;
    color: #fff;
  }
  .agent-badge.codex { background: var(--codex-provider); }
  .agent-badge.claude { background: var(--claude-provider); }
  .source-badge { opacity: 0.7; }
  .session-line {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
    opacity: 0.85;
    font-size: 11px;
    overflow: hidden;
  }
  .project-name,
  .session-name {
    font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: min(42vw, 420px);
  }
  .session-divider {
    opacity: 0.55;
    font-size: 10px;
  }
  .event-summary {
    display: none;
  }
  .show-event-summary .event-summary {
    margin-bottom: 5px;
    font-size: 11px;
    opacity: 0.64;
    font-style: italic;
    display: block;
  }
  .commentary {
    font-size: 13px;
    line-height: 1.55;
  }
  .commentary strong { font-weight: 700; }
  .commentary code {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    padding: 1px 4px;
    font-size: 12px;
  }
  .commentary p {
    margin: 2px 0;
  }
  .commentary ul {
    margin: 2px 0;
    padding-left: 17px;
  }
  .commentary li { margin-bottom: 2px; }
  .commentary table {
    width: 100%;
    border-collapse: collapse;
    margin: 4px 0 6px;
    font-size: 12px;
  }
  .commentary th,
  .commentary td {
    border: 1px solid var(--border);
    padding: 3px 5px;
    text-align: left;
    vertical-align: top;
  }
  .commentary th {
    background: rgba(255, 255, 255, 0.06);
  }
  .error-entry,
  .system-entry {
    padding: 7px 9px;
    border-radius: 6px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  .error-entry {
    color: #fecaca;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
  }
  .system-entry {
    color: var(--fg);
    opacity: 0.84;
    background: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.22);
  }
  .empty-state {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    opacity: 0.48;
    padding: 24px;
  }
  .empty-state h2 {
    margin: 0 0 8px;
    font-size: 17px;
  }
  .empty-state p {
    margin: 0;
    font-size: 12px;
    max-width: 360px;
  }
  .composer {
    border-top: 1px solid var(--border);
    padding: 8px 12px;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .composer-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }
  .target-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .target-badge {
    max-width: min(46vw, 440px);
    background: rgba(255, 255, 255, 0.04);
    color: var(--fg);
    border: 1px solid var(--input-border);
    border-radius: 999px;
    font-size: 11px;
    padding: 4px 9px;
    cursor: pointer;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .target-badge:hover {
    border-color: var(--vscode-focusBorder, #0ea5e9);
  }
  .target-badge.selected {
    background: rgba(255, 255, 255, 0.055);
    border-color: rgba(148, 163, 184, 0.42);
  }
  .composer-input {
    width: 100%;
    min-height: 36px;
    max-height: 140px;
    resize: vertical;
    border-radius: 6px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--input-fg);
    font-size: 12px;
    padding: 7px 9px;
    line-height: 1.4;
    outline: none;
  }
  .composer-input:focus,
  .target-badge:focus {
    border-color: var(--vscode-focusBorder, #0ea5e9);
  }
  .send-btn {
    width: 34px;
    min-width: 34px;
    border-radius: 6px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--fg);
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }
  .send-btn:hover {
    border-color: var(--vscode-focusBorder, #0ea5e9);
  }
  .composer-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    overflow: visible;
    white-space: nowrap;
  }
  .composer-meta .menu-trigger {
    background: transparent;
    color: #9ca3af;
    border: none;
    box-shadow: none;
    padding: 3px 0;
  }
  .composer-meta .menu-trigger:hover {
    background: transparent;
    color: #cbd5e1;
  }
  .composer-meta .menu-trigger:focus,
  .composer-meta .menu-trigger:focus-visible {
    outline: none;
    box-shadow: none;
  }
  .composer-meta #preset-menu-label,
  .composer-meta #style-menu-label {
    color: #9ca3af;
  }
  .style-menu {
    min-width: 230px;
  }
  .style-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    line-height: 1.2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 4px 5px;
    border-radius: 4px;
    cursor: pointer;
  }
  .style-item:hover {
    background: rgba(251, 146, 60, 0.2);
  }
  .style-item input {
    margin: 0;
  }
  .slash-menu {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 118px;
    z-index: 8;
    max-height: 240px;
    overflow-y: auto;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 7px;
    box-shadow: 0 7px 20px rgba(0, 0, 0, 0.35);
  }
  .slash-menu.hidden { display: none; }
  .slash-item {
    border-bottom: 1px solid var(--border);
    padding: 7px 9px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    cursor: pointer;
    font-size: 12px;
  }
  .slash-item:last-child { border-bottom: none; }
  .slash-item:hover,
  .slash-item.selected {
    background: rgba(99, 102, 241, 0.22);
  }
  .slash-item-main {
    color: #c7d2fe;
    font-family: monospace;
    white-space: nowrap;
  }
  .slash-item-desc {
    opacity: 0.74;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cursor {
    animation: blink 0.8s infinite;
  }
  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }
</style>
</head>
<body>
  <div class="header">
    <h1>KIBITZ</h1>
    <span class="badge badge-version">v${safeVersion}</span>
    ${providerBadges}
    <span class="badge badge-sessions" id="sessions">0 sessions</span>

    <div class="controls">
      <div class="menu-host">
        <button id="model-menu-btn" class="menu-trigger" title="Model" aria-label="Model">
          <span class="icon">🤖</span>
          <span id="model-menu-label">Model</span>
          <span class="caret">▾</span>
        </button>
        <div id="model-menu" class="menu-list hidden"></div>
      </div>
      <select id="model-select" class="native-select-hidden">${modelOptionsHtml}</select>
      <button id="pause-btn" title="Pause commentary" aria-label="Pause commentary">⏸</button>
    </div>
  </div>

  <div id="feed" class="feed">
    <div id="empty" class="empty-state">
      <h2>Waiting for action...</h2>
      <p>Start a Claude Code or Codex session and Kibitz will provide live commentary.</p>
    </div>
  </div>

  <div class="composer">
    <div id="slash-menu" class="slash-menu hidden"></div>
    <div id="target-badges" class="target-badges"></div>
    <div class="composer-row">
      <textarea
        id="composer-input"
        class="composer-input"
        placeholder="Send prompt (Enter=send, Shift+Enter=newline, / for commands). Use /1 to select target, /1 text to send."
      ></textarea>
      <button id="composer-send" class="send-btn" title="Send" aria-label="Send">➤</button>
    </div>
    <div class="composer-meta">
      <div class="menu-host">
        <button id="preset-menu-btn" class="menu-trigger" title="Summary tone" aria-label="Summary tone">
          <span class="icon">🎛</span>
          <span id="preset-menu-label">Summary tone</span>
          <span class="caret">▾</span>
        </button>
        <div id="preset-menu" class="menu-list hidden"></div>
      </div>
      <select id="preset-select" class="native-select-hidden">${templateOptionsHtml}</select>
      <div class="menu-host">
        <button id="style-menu-btn" class="menu-trigger" title="Response formats" aria-label="Response formats">
          <span class="icon">🧩</span>
          <span id="style-menu-label">Response formats</span>
          <span class="caret">▾</span>
        </button>
        <div id="style-menu" class="menu-list style-menu hidden"></div>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const feed = document.getElementById('feed');
  const empty = document.getElementById('empty');
  const sessionsEl = document.getElementById('sessions');
  const modelSelect = document.getElementById('model-select');
  const modelMenuBtn = document.getElementById('model-menu-btn');
  const modelMenu = document.getElementById('model-menu');
  const modelMenuLabel = document.getElementById('model-menu-label');
  const presetSelect = document.getElementById('preset-select');
  const presetMenuBtn = document.getElementById('preset-menu-btn');
  const presetMenu = document.getElementById('preset-menu');
  const presetMenuLabel = document.getElementById('preset-menu-label');
  const pauseBtn = document.getElementById('pause-btn');
  const styleMenuBtn = document.getElementById('style-menu-btn');
  const styleMenuLabel = document.getElementById('style-menu-label');
  const styleMenu = document.getElementById('style-menu');
  const targetBadges = document.getElementById('target-badges');
  const composerInput = document.getElementById('composer-input');
  const composerSend = document.getElementById('composer-send');
  const slashMenu = document.getElementById('slash-menu');

  const ALL_MODEL_OPTIONS = ${modelData};
  const FORMAT_STYLE_OPTIONS = ${formatStyleOptionsData};
  const INITIAL_FORMAT_STYLES = ${initialFormatStylesData};
  const FALLBACK_MODEL_ID = ${JSON.stringify(fallbackModel)};
  const MODEL_PROVIDER = Object.fromEntries(ALL_MODEL_OPTIONS.map((opt) => [opt.id, opt.provider]));
  const PROVIDER_AGENT = { anthropic: 'claude', openai: 'codex' };

  const SLASH_COMMANDS = [
    { name: 'help', usage: '/help', insert: '/help', takesArg: false, description: 'Show all slash commands' },
    { name: 'pause', usage: '/pause', insert: '/pause', takesArg: false, description: 'Pause commentary stream' },
    { name: 'resume', usage: '/resume', insert: '/resume', takesArg: false, description: 'Resume commentary stream' },
    { name: 'clear', usage: '/clear', insert: '/clear', takesArg: false, description: 'Clear feed messages' },
    { name: 'focus', usage: '/focus <text>', insert: '/focus ', takesArg: true, description: 'Set focus guidance text' },
    { name: 'model', usage: '/model <id-or-label>', insert: '/model ', takesArg: true, description: 'Switch model' },
    { name: 'preset', usage: '/preset <id-or-label>', insert: '/preset ', takesArg: true, description: 'Switch template preset' },
    { name: 'summary', usage: '/summary <on|off>', insert: '/summary ', takesArg: true, description: 'Show or hide event summary line' },
  ];

  let paused = false;
  let autoScroll = true;
  let activeSessions = [];
  let pendingActiveSessions = null;
  let selectedTarget = { kind: 'new-codex' };
  let pendingDispatches = [];
  let slashItems = [];
  let slashSelectedIndex = 0;
  let showEventSummary = false;
  let selectedFormatStyles = new Set(
    (Array.isArray(INITIAL_FORMAT_STYLES) ? INITIAL_FORMAT_STYLES : [])
      .map((value) => String(value || '').trim())
      .filter((value) => FORMAT_STYLE_OPTIONS.some((option) => option.id === value)),
  );
  if (selectedFormatStyles.size === 0) {
    selectedFormatStyles = new Set(FORMAT_STYLE_OPTIONS.map((option) => option.id));
  }

  let currentEntry = null;
  let currentRawText = '';
  let pendingTypingText = '';
  let finalCommentaryText = '';
  let streamDone = false;
  let typingTimer = null;
  const TYPING_INTERVAL_MS = 18;
  const TYPING_CHARS_PER_TICK = 2;

  function sessionKey(agent, sessionId) {
    return String(agent || '').toLowerCase() + ':' + String(sessionId || '').trim().toLowerCase();
  }

  function sessionKeyFromInfo(session) {
    return sessionKey(session && session.agent, session && session.id);
  }

  function isTypingDraftLocked() {
    return String(composerInput.value || '').trim().length > 0;
  }

  function reorderSessionsStable(nextSessions) {
    const incoming = Array.isArray(nextSessions) ? nextSessions.slice() : [];
    const byKey = new Map();
    for (const session of incoming) {
      const key = sessionKeyFromInfo(session);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, session);
    }

    const ordered = [];
    for (const prev of activeSessions) {
      const key = sessionKeyFromInfo(prev);
      if (!byKey.has(key)) continue;
      ordered.push(byKey.get(key));
      byKey.delete(key);
    }

    for (const session of incoming) {
      const key = sessionKeyFromInfo(session);
      if (!byKey.has(key)) continue;
      ordered.push(byKey.get(key));
      byKey.delete(key);
    }

    return ordered;
  }

  function applyActiveSessions(nextSessions) {
    activeSessions = reorderSessionsStable(nextSessions);
    sessionsEl.textContent = activeSessions.length + ' session' + (activeSessions.length === 1 ? '' : 's');
    syncTargetBadges();
  }

  function queueOrApplyActiveSessions(nextSessions) {
    const incoming = Array.isArray(nextSessions) ? nextSessions.slice() : [];
    if (isTypingDraftLocked()) {
      pendingActiveSessions = incoming;
      return;
    }
    pendingActiveSessions = null;
    applyActiveSessions(incoming);
  }

  function flushPendingActiveSessions() {
    if (!pendingActiveSessions) return;
    if (isTypingDraftLocked()) return;
    const incoming = pendingActiveSessions;
    pendingActiveSessions = null;
    applyActiveSessions(incoming);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function timeStr(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function looksLikeSessionCode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    if (/^[0-9a-f]{8}$/.test(normalized)) return true;
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(normalized)) return true;
    if (/^session[\\s:_-]*[0-9a-f]{8,}$/.test(normalized)) return true;
    if (/^turn[\\s:_-]*[0-9a-f]{8,}$/.test(normalized)) return true;
    if (/^rollout-\\d{4}-\\d{2}-\\d{2}t\\d{2}[-:]\\d{2}[-:]\\d{2}[-a-z0-9]+(?:\\.jsonl)?$/.test(normalized)) return true;
    return false;
  }

  function normalizeLabel(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function sameLabel(a, b) {
    const left = normalizeLabel(a);
    const right = normalizeLabel(b);
    return Boolean(left && right && left === right);
  }

  function truncateLabel(value, max) {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= max) return text;
    if (max <= 1) return text.slice(0, max);
    if (max <= 3) return text.slice(0, max);
    return text.slice(0, max - 3).trimEnd() + '...';
  }

  function canonicalSession(entry) {
    const key = sessionKey(entry.agent, entry.sessionId);
    return activeSessions.find((session) => sessionKey(session.agent, session.id) === key) || null;
  }

  function displaySessionName(entry) {
    const canonical = canonicalSession(entry);
    const canonicalTitle = String((canonical && canonical.sessionTitle) || '').trim();
    const entryTitle = String(entry.sessionTitle || '').trim();
    const project = String((canonical && canonical.projectName) || entry.projectName || '').trim();

    if (canonicalTitle && !looksLikeSessionCode(canonicalTitle) && !sameLabel(canonicalTitle, project)) {
      return truncateLabel(canonicalTitle, 52);
    }
    if (entryTitle && !looksLikeSessionCode(entryTitle) && !sameLabel(entryTitle, project)) {
      return truncateLabel(entryTitle, 52);
    }
    if (canonicalTitle && !looksLikeSessionCode(canonicalTitle)) return truncateLabel(canonicalTitle, 52);
    if (entryTitle && !looksLikeSessionCode(entryTitle)) return truncateLabel(entryTitle, 52);
    if (project && !looksLikeSessionCode(project)) return truncateLabel(project, 36);
    return String(entry.agent || 'session') + ' session';
  }

  function displayProjectName(entry) {
    const canonical = canonicalSession(entry);
    const project = String((canonical && canonical.projectName) || entry.projectName || '').trim();
    if (project && !looksLikeSessionCode(project)) return project;
    return '';
  }

  function renderCommentary(text) {
    const lines = String(text || '').split('\\n');
    let html = '';
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;

      const table = renderTableIfPresent(lines, i);
      if (table) {
        if (inList) { html += '</ul>'; inList = false; }
        html += table.html;
        i = table.nextIndex;
        continue;
      }

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

  function fmt(text) {
    return escapeHtml(String(text || ''))
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\\u0060([^\\u0060]+)\\u0060/g, '<code>$1</code>');
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\\|/, '')
      .replace(/\\|$/, '')
      .split('|')
      .map((part) => part.trim());
  }

  function isTableSeparator(line) {
    if (!line.includes('|')) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function renderTableIfPresent(lines, index) {
    if (index + 1 >= lines.length) return null;
    const headerLine = lines[index].trim();
    const separatorLine = lines[index + 1].trim();
    if (!headerLine.includes('|') || !isTableSeparator(separatorLine)) return null;

    const headers = splitTableRow(headerLine);
    if (headers.length === 0) return null;

    let rows = '';
    let rowCount = 0;
    let i = index + 2;
    for (; i < lines.length; i++) {
      const rowLine = lines[i].trim();
      if (!rowLine || !rowLine.includes('|')) break;
      const cells = splitTableRow(rowLine);
      if (cells.length === 0) break;
      rows += '<tr>' + headers.map((_, col) => '<td>' + fmt(cells[col] || '') + '</td>').join('') + '</tr>';
      rowCount++;
    }

    if (rowCount === 0) return null;
    const headHtml = headers.map((head) => '<th>' + fmt(head) + '</th>').join('');
    return {
      html: '<table><thead><tr>' + headHtml + '</tr></thead><tbody>' + rows + '</tbody></table>',
      nextIndex: i - 1,
    };
  }

  function pushSystemEntry(message, isError) {
    const div = document.createElement('div');
    div.className = isError ? 'error-entry' : 'system-entry';
    div.textContent = String(message || '');
    feed.appendChild(div);
    empty.style.display = 'none';
    scrollToBottom();
  }

  function renderStaticEntry(entry) {
    const safeAgent = entry.agent === 'claude' ? 'claude' : 'codex';
    const safeSource = escapeHtml(entry.source || 'cli');
    const rawProjectName = displayProjectName(entry);
    const rawSessionName = displaySessionName(entry);
    const projectName = escapeHtml(rawProjectName);
    const sessionName = sameLabel(rawProjectName, rawSessionName) ? '' : escapeHtml(rawSessionName);
    const eventSummary = escapeHtml(truncateLabel(entry.eventSummary || '', 160));

    const sessionLineHtml = (projectName || sessionName)
      ? ('<div class="session-line">'
        + (projectName ? '<span class="project-name">' + projectName + '</span>' : '')
        + ((projectName && sessionName) ? '<span class="session-divider">›</span>' : '')
        + (sessionName ? '<span class="session-name">' + sessionName + '</span>' : '')
        + '</div>')
      : '';

    const div = document.createElement('div');
    div.className = 'entry ' + safeAgent;
    div.setAttribute('data-agent', safeAgent);
    div.setAttribute('data-session', String(entry.sessionId || '').trim().toLowerCase());
    div.innerHTML = ''
      + '<div class="entry-header">'
      + '  <span class="agent-badge ' + safeAgent + '">' + safeAgent + '</span>'
      + '  <span class="source-badge">[' + safeSource + ']</span>'
      + '  <span>' + escapeHtml(timeStr(entry.timestamp || Date.now())) + '</span>'
      +    sessionLineHtml
      + '</div>'
      + '<div class="event-summary">' + eventSummary + '</div>'
      + '<div class="commentary">' + renderCommentary(entry.commentary || '') + '</div>';
    feed.appendChild(div);
  }

  function clearFeed() {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    currentEntry = null;
    currentRawText = '';
    pendingTypingText = '';
    finalCommentaryText = '';
    streamDone = false;
    feed.innerHTML = '';
    feed.appendChild(empty);
    empty.style.display = 'flex';
  }

  function renderCurrentCommentary(withCursor) {
    const node = document.getElementById('current-commentary');
    if (!node) return;
    const body = renderCommentary(currentRawText);
    node.innerHTML = withCursor ? body + '<span class="cursor">|</span>' : body;
  }

  function finalizeCurrentCommentary() {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }

    const node = document.getElementById('current-commentary');
    if (node) {
      const finalText = finalCommentaryText || currentRawText;
      node.innerHTML = renderCommentary(finalText);
      node.removeAttribute('id');
    }

    currentEntry = null;
    currentRawText = '';
    pendingTypingText = '';
    finalCommentaryText = '';
    streamDone = false;
    scrollToBottom();
  }

  function ensureTypingLoop() {
    if (typingTimer) return;
    typingTimer = setInterval(() => {
      if (!currentEntry) {
        clearInterval(typingTimer);
        typingTimer = null;
        return;
      }

      if (!pendingTypingText) {
        if (streamDone) finalizeCurrentCommentary();
        return;
      }

      const take = Math.min(TYPING_CHARS_PER_TICK, pendingTypingText.length);
      currentRawText += pendingTypingText.slice(0, take);
      pendingTypingText = pendingTypingText.slice(take);
      renderCurrentCommentary(true);
      scrollToBottom();
    }, TYPING_INTERVAL_MS);
  }

  function scrollToBottom() {
    if (autoScroll) {
      feed.scrollTop = feed.scrollHeight;
    }
  }

  feed.addEventListener('scroll', () => {
    autoScroll = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  });

  function normalizeChoice(value) {
    return String(value || '')
      .toLowerCase()
      .trim()
      .replace(/^template:\\s*/, '')
      .replace(/\\s+/g, ' ');
  }

  function resolveSelectOption(selectEl, rawArg) {
    const needle = normalizeChoice(rawArg);
    if (!needle) return null;
    const options = Array.from(selectEl.options).map((option) => ({
      value: option.value,
      label: option.textContent || option.value,
    }));

    const exact = options.find((option) => {
      return normalizeChoice(option.value) === needle || normalizeChoice(option.label) === needle;
    });
    if (exact) return exact;

    return options.find((option) => {
      return normalizeChoice(option.value).includes(needle) || normalizeChoice(option.label).includes(needle);
    }) || null;
  }

  function optionLabel(option) {
    return String((option && option.textContent) || (option && option.value) || '').trim();
  }

  function syncModelMenuButton() {
    const option = modelSelect.options[modelSelect.selectedIndex] || null;
    const label = option ? optionLabel(option) : 'Model';
    if (modelMenuLabel) modelMenuLabel.textContent = label;
    const aria = 'Model: ' + label;
    modelMenuBtn.title = aria;
    modelMenuBtn.setAttribute('aria-label', aria);
  }

  function syncPresetMenuButton() {
    const option = presetSelect.options[presetSelect.selectedIndex] || null;
    const label = option ? optionLabel(option) : 'Summary tone';
    if (presetMenuLabel) presetMenuLabel.textContent = label;
    const aria = 'Summary tone: ' + label;
    presetMenuBtn.title = aria;
    presetMenuBtn.setAttribute('aria-label', aria);
  }

  function renderModelMenu() {
    const options = Array.from(modelSelect.options);
    modelMenu.innerHTML = options.map((option) => {
      const value = String(option.value || '');
      const label = optionLabel(option);
      const selected = value === modelSelect.value ? ' selected' : '';
      return (
        '<div class="menu-option' + selected + '" data-value="' + escapeHtml(value) + '">' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<span>' + (selected ? '✓' : '') + '</span>' +
        '</div>'
      );
    }).join('');

    const items = modelMenu.querySelectorAll('.menu-option[data-value]');
    items.forEach((item) => {
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const value = String(item.getAttribute('data-value') || '');
        if (!value) return;
        if (modelSelect.value !== value) {
          modelSelect.value = value;
          modelSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
        } else {
          syncModelMenuButton();
        }
        hideModelMenu();
      });
    });
  }

  function renderPresetMenu() {
    const options = Array.from(presetSelect.options);
    presetMenu.innerHTML = options.map((option) => {
      const value = String(option.value || '');
      const label = optionLabel(option);
      const selected = value === presetSelect.value ? ' selected' : '';
      return (
        '<div class="menu-option' + selected + '" data-value="' + escapeHtml(value) + '">' +
          '<span>' + escapeHtml(label) + '</span>' +
          '<span>' + (selected ? '✓' : '') + '</span>' +
        '</div>'
      );
    }).join('');

    const items = presetMenu.querySelectorAll('.menu-option[data-value]');
    items.forEach((item) => {
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const value = String(item.getAttribute('data-value') || '');
        if (!value) return;
        if (presetSelect.value !== value) {
          presetSelect.value = value;
          presetSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
        } else {
          syncPresetMenuButton();
        }
        hidePresetMenu();
      });
    });
  }

  function normalizeFormatStyleIds(styleIds) {
    const requested = new Set(
      (Array.isArray(styleIds) ? styleIds : [])
        .map((styleId) => String(styleId || '').trim()),
    );
    const normalized = FORMAT_STYLE_OPTIONS
      .map((option) => option.id)
      .filter((styleId) => requested.has(styleId));
    return normalized.length > 0
      ? normalized
      : FORMAT_STYLE_OPTIONS.map((option) => option.id);
  }

  function selectedFormatStyleList() {
    return normalizeFormatStyleIds(Array.from(selectedFormatStyles));
  }

  function styleMenuText() {
    return 'Response formats (' + selectedFormatStyleList().length + ')';
  }

  function hideModelMenu() {
    modelMenu.classList.add('hidden');
  }

  function hidePresetMenu() {
    presetMenu.classList.add('hidden');
  }

  function hideStyleMenu() {
    styleMenu.classList.add('hidden');
  }

  function hideAllMenus() {
    hideModelMenu();
    hidePresetMenu();
    hideStyleMenu();
  }

  function showModelMenu() {
    hideAllMenus();
    modelMenu.classList.remove('hidden');
  }

  function showPresetMenu() {
    hideAllMenus();
    presetMenu.classList.remove('hidden');
  }

  function showStyleMenu() {
    hideAllMenus();
    styleMenu.classList.remove('hidden');
  }

  function toggleModelMenu() {
    if (modelMenu.classList.contains('hidden')) {
      showModelMenu();
      return;
    }
    hideModelMenu();
  }

  function togglePresetMenu() {
    if (presetMenu.classList.contains('hidden')) {
      showPresetMenu();
      return;
    }
    hidePresetMenu();
  }

  function toggleStyleMenu() {
    if (styleMenu.classList.contains('hidden')) {
      showStyleMenu();
      return;
    }
    hideStyleMenu();
  }

  function syncStyleMenuButton() {
    const label = styleMenuText();
    if (styleMenuLabel) styleMenuLabel.textContent = label;
    styleMenuBtn.setAttribute('aria-label', label);
    styleMenuBtn.title = label;
  }

  function postFormatStylesChange() {
    const styles = selectedFormatStyleList();
    vscode.postMessage({ type: 'format-styles', value: styles });
    renderStyleMenu();
    syncStyleMenuButton();
  }

  function renderStyleMenu() {
    const selected = new Set(selectedFormatStyleList());
    styleMenu.innerHTML = FORMAT_STYLE_OPTIONS.map((option) => {
      const checked = selected.has(option.id) ? ' checked' : '';
      return (
        '<label class="style-item" data-style-id="' + escapeHtml(option.id) + '">' +
          '<input type="checkbox" data-style-id="' + escapeHtml(option.id) + '"' + checked + ' />' +
          '<span>' + escapeHtml(option.label) + '</span>' +
        '</label>'
      );
    }).join('');

    const checkboxes = styleMenu.querySelectorAll('input[type="checkbox"][data-style-id]');
    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const styleId = String(checkbox.getAttribute('data-style-id') || '').trim();
        if (!styleId) return;

        if (checkbox.checked) {
          selectedFormatStyles.add(styleId);
          postFormatStylesChange();
          return;
        }

        selectedFormatStyles.delete(styleId);
        if (selectedFormatStyles.size === 0) {
          selectedFormatStyles.add(styleId);
          checkbox.checked = true;
          pushSystemEntry('At least one response format must stay enabled.', true);
          return;
        }
        postFormatStylesChange();
      });
    });
  }

  function setFormatStylesFromExtension(styleIds) {
    selectedFormatStyles = new Set(normalizeFormatStyleIds(styleIds));
    renderStyleMenu();
    syncStyleMenuButton();
  }

  function parseSlashInput(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw.startsWith('/')) return null;
    const body = raw.slice(1);
    const firstSpace = body.indexOf(' ');
    if (firstSpace === -1) {
      return { command: body.toLowerCase(), args: '' };
    }
    return {
      command: body.slice(0, firstSpace).toLowerCase(),
      args: body.slice(firstSpace + 1).trim(),
    };
  }

  function targetByNumericIndex(index) {
    const idx = Number(index) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= currentBadgeTargets.length) return null;
    return currentBadgeTargets[idx].target;
  }

  function parseNumericTargetInput(rawValue) {
    const raw = String(rawValue || '');
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const onlyNumber = trimmed.match(/^(\\d{1,2})$/);
    if (onlyNumber) {
      const index = Number(onlyNumber[1]);
      const target = targetByNumericIndex(index);
      if (!target) return null;
      return { mode: 'select-only', index, target, prompt: '' };
    }

    const numberFirst = trimmed.match(/^(\\d{1,2})\\s+([\\s\\S]+)$/);
    if (numberFirst) {
      const index = Number(numberFirst[1]);
      const target = targetByNumericIndex(index);
      const prompt = String(numberFirst[2] || '').trim();
      if (!target || !prompt) return null;
      return { mode: 'send', index, target, prompt };
    }

    const numberLast = trimmed.match(/^([\\s\\S]+?)\\s+(\\d{1,2})$/);
    if (numberLast) {
      const index = Number(numberLast[2]);
      const target = targetByNumericIndex(index);
      const prompt = String(numberLast[1] || '').trim();
      if (!target || !prompt) return null;
      return { mode: 'send', index, target, prompt };
    }

    return null;
  }

  function parseNumericSlashTargetInput(rawValue) {
    const trimmed = String(rawValue || '').trim();
    const slashPrefixMatch = trimmed.match(/^\\/(\\d{1,2})(?:\\s+([\\s\\S]+))?$/);
    if (slashPrefixMatch) {
      const index = Number(slashPrefixMatch[1]);
      const target = targetByNumericIndex(index);
      if (!target) return null;
      const prompt = String(slashPrefixMatch[2] || '').trim();
      if (!prompt) return { mode: 'select-only', index, target, prompt: '', token: '/' + String(index) };
      return { mode: 'send', index, target, prompt, token: '/' + String(index) };
    }

    const slashSuffixMatch = trimmed.match(/^(\\d{1,2})\\/(?:\\s*([\\s\\S]+))?$/);
    if (!slashSuffixMatch) return null;

    const index = Number(slashSuffixMatch[1]);
    const target = targetByNumericIndex(index);
    if (!target) return null;

    const prompt = String(slashSuffixMatch[2] || '').trim();
    if (!prompt) return { mode: 'select-only', index, target, prompt: '', token: String(index) + '/' };
    return { mode: 'send', index, target, prompt, token: String(index) + '/' };
  }

  function findSlashCommand(name) {
    return SLASH_COMMANDS.find((cmd) => cmd.name === String(name || '').toLowerCase());
  }

  function hideSlashMenu() {
    slashItems = [];
    slashSelectedIndex = 0;
    slashMenu.classList.add('hidden');
    slashMenu.innerHTML = '';
  }

  function updateSlashMenu() {
    const parsed = parseSlashInput(composerInput.value);
    if (!parsed) {
      hideSlashMenu();
      return;
    }

    const query = parsed.command || '';
    slashItems = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(query));
    if (slashItems.length === 0) {
      hideSlashMenu();
      return;
    }

    if (slashSelectedIndex >= slashItems.length) {
      slashSelectedIndex = 0;
    }

    slashMenu.innerHTML = slashItems.map((cmd, index) => {
      const selected = index === slashSelectedIndex ? ' selected' : '';
      return (
        '<div class="slash-item' + selected + '" data-index="' + index + '">' +
          '<span class="slash-item-main">' + escapeHtml(cmd.usage) + '</span>' +
          '<span class="slash-item-desc">' + escapeHtml(cmd.description) + '</span>' +
        '</div>'
      );
    }).join('');

    slashMenu.classList.remove('hidden');

    const items = slashMenu.querySelectorAll('.slash-item');
    items.forEach((item) => {
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const idx = Number(item.getAttribute('data-index'));
        pickSlashCommandFromMenu(Number.isNaN(idx) ? 0 : idx);
      });
    });
  }

  function pickSlashCommandFromMenu(index) {
    if (index < 0 || index >= slashItems.length) return;
    const cmd = slashItems[index];
    composerInput.value = cmd.insert;
    composerInput.focus();
    updateSlashMenu();
  }

  function refreshPauseButton() {
    const icon = paused ? '▶' : '⏸';
    const label = paused ? 'Resume commentary' : 'Pause commentary';
    pauseBtn.textContent = icon;
    pauseBtn.title = label;
    pauseBtn.setAttribute('aria-label', label);
  }

  function setPausedState(nextPaused, notifyExtension) {
    paused = !!nextPaused;
    refreshPauseButton();
    if (notifyExtension) {
      vscode.postMessage({ type: paused ? 'pause' : 'resume' });
    }
  }

  function setEventSummaryVisibility(nextVisible, notifyExtension) {
    showEventSummary = !!nextVisible;
    document.body.classList.toggle('show-event-summary', showEventSummary);
    if (notifyExtension) {
      vscode.postMessage({ type: 'show-event-summary', value: showEventSummary });
    }
  }

  function showSlashHelp() {
    const commands = SLASH_COMMANDS.map((cmd) => cmd.usage).join(', ');
    pushSystemEntry('Slash commands: ' + commands, false);
  }

  function executeSlashCommand(rawInput) {
    const parsed = parseSlashInput(rawInput);
    if (!parsed || !parsed.command) return null;

    const cmd = findSlashCommand(parsed.command);
    if (!cmd) return null;

    if (cmd.takesArg && !parsed.args) {
      pushSystemEntry('Missing argument for ' + cmd.usage, true);
      return 'keep';
    }

    if (cmd.name === 'help') {
      showSlashHelp();
      return 'clear';
    }
    if (cmd.name === 'pause') {
      setPausedState(true, true);
      return 'clear';
    }
    if (cmd.name === 'resume') {
      setPausedState(false, true);
      return 'clear';
    }
    if (cmd.name === 'clear') {
      clearFeed();
      return 'clear';
    }
    if (cmd.name === 'focus') {
      vscode.postMessage({ type: 'focus', value: parsed.args });
      pushSystemEntry('Focus updated', false);
      return 'clear';
    }
    if (cmd.name === 'model') {
      const option = resolveSelectOption(modelSelect, parsed.args);
      if (!option) {
        pushSystemEntry('Unknown model: ' + parsed.args, true);
        return 'keep';
      }
      modelSelect.value = option.value;
      modelSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      pushSystemEntry('Model set to ' + option.label, false);
      return 'clear';
    }
    if (cmd.name === 'preset') {
      const option = resolveSelectOption(presetSelect, parsed.args);
      if (!option) {
        pushSystemEntry('Unknown preset: ' + parsed.args, true);
        return 'keep';
      }
      presetSelect.value = option.value;
      presetSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      pushSystemEntry('Preset set to ' + option.label, false);
      return 'clear';
    }
    if (cmd.name === 'summary') {
      const normalized = String(parsed.args || '').trim().toLowerCase();
      if (normalized !== 'on' && normalized !== 'off') {
        pushSystemEntry('Usage: /summary on|off', true);
        return 'keep';
      }
      const nextVisible = normalized === 'on';
      setEventSummaryVisibility(nextVisible, true);
      pushSystemEntry('Event summary ' + (nextVisible ? 'enabled' : 'disabled'), false);
      return 'clear';
    }

    return null;
  }

  function targetKey(target) {
    const kind = String(target && target.kind || '').trim();
    if (kind === 'new-codex') return 'new-codex';
    if (kind === 'new-claude') return 'new-claude';
    if (kind !== 'existing') return targetKey(newSessionTargetForCurrentProvider());
    const agent = String(target.agent || '').trim().toLowerCase();
    const sessionId = String(target.sessionId || '').trim().toLowerCase();
    return 'existing:' + agent + ':' + sessionId;
  }

  function providerForModelId(modelId) {
    const key = String(modelId || '').trim();
    return MODEL_PROVIDER[key] || null;
  }

  function currentProviderForNewSession() {
    const modelProvider = providerForModelId(modelSelect.value);
    if (modelProvider === 'anthropic' || modelProvider === 'openai') return modelProvider;
    const fallback = ALL_MODEL_OPTIONS[0] && ALL_MODEL_OPTIONS[0].provider;
    return fallback === 'anthropic' || fallback === 'openai' ? fallback : 'openai';
  }

  function newSessionTargetForCurrentProvider() {
    return currentProviderForNewSession() === 'anthropic'
      ? { kind: 'new-claude' }
      : { kind: 'new-codex' };
  }

  let currentBadgeTargets = [];

  function filteredModelOptions() {
    return ALL_MODEL_OPTIONS.slice();
  }

  function refreshModelOptions(preferredModel, notifyOnFallback) {
    const options = filteredModelOptions();
    if (options.length === 0) {
      modelSelect.innerHTML = '';
      renderModelMenu();
      syncModelMenuButton();
      return;
    }

    modelSelect.innerHTML = options.map((option) => {
      return '<option value="' + option.id + '">' + escapeHtml(option.label) + '</option>';
    }).join('');

    const preferred = String(preferredModel || '').trim();
    const hasPreferred = preferred && options.some((option) => option.id === preferred);
    const nextModel = hasPreferred ? preferred : options[0].id || FALLBACK_MODEL_ID;

    modelSelect.value = nextModel;
    renderModelMenu();
    syncModelMenuButton();

    if (notifyOnFallback && !hasPreferred) {
      vscode.postMessage({ type: 'model', value: nextModel });
      const fallbackLabel = options.find((option) => option.id === nextModel)?.label || nextModel;
      pushSystemEntry('Model auto-switched to ' + fallbackLabel + ' for selected target', false);
    }
  }

  function targetLabelFromSession(session) {
    const project = String(session.projectName || '').trim();
    const title = String(session.sessionTitle || '').trim();
    const cleanTitle = title && !looksLikeSessionCode(title) ? truncateLabel(title, 34) : '';
    const cleanProject = project && !looksLikeSessionCode(project) ? truncateLabel(project, 18) : '';

    let label = session.agent.toUpperCase();
    if (cleanProject) {
      label += ' · ' + cleanProject;
    }
    if (cleanTitle) {
      if (!sameLabel(cleanTitle, cleanProject)) {
        label += cleanProject ? ' › ' + cleanTitle : ' · ' + cleanTitle;
      }
    } else {
      label += ' › ' + String(session.id || '').slice(0, 8);
    }
    return label;
  }

  function selectTargetSilently(nextTarget) {
    selectedTarget = nextTarget;
    refreshModelOptions(modelSelect.value, true);
    renderTargetBadges();
    highlightSelectedEntries();
  }

  function buildTargetBadgeItems() {
    const items = [];
    const newTarget = newSessionTargetForCurrentProvider();
    const newProviderLabel = newTarget.kind === 'new-claude' ? 'Claude' : 'Codex';
    items.push({
      key: targetKey(newTarget),
      target: newTarget,
      label: '/1 New session (' + newProviderLabel + ')',
      className: 'new-session',
    });

    for (let i = 0; i < activeSessions.length; i++) {
      const session = activeSessions[i];
      const target = {
        kind: 'existing',
        agent: session.agent,
        sessionId: String(session.id || '').trim().toLowerCase(),
        projectName: session.projectName,
        sessionTitle: session.sessionTitle,
      };
      items.push({
        key: targetKey(target),
        target,
        label: '/' + String(i + 2) + ' ' + targetLabelFromSession(session),
        className: session.agent === 'claude' ? 'claude' : 'codex',
      });
    }
    return items;
  }

  function ensureSelectedTargetValid() {
    const newTarget = newSessionTargetForCurrentProvider();
    const currentKey = targetKey(selectedTarget);

    if (selectedTarget.kind === 'existing') {
      const exists = activeSessions.some((session) => {
        return targetKey({
          kind: 'existing',
          agent: session.agent,
          sessionId: String(session.id || '').trim().toLowerCase(),
        }) === currentKey;
      });
      if (exists) return false;
    }

    if (selectedTarget.kind === 'new-codex' || selectedTarget.kind === 'new-claude') {
      if (currentKey === targetKey(newTarget)) return false;
    }

    selectedTarget = newTarget;
    return true;
  }

  function renderTargetBadges() {
    currentBadgeTargets = buildTargetBadgeItems();
    const selectedKey = targetKey(selectedTarget);
    targetBadges.innerHTML = currentBadgeTargets.map((item, index) => {
      const selected = item.key === selectedKey ? ' selected' : '';
      return '<button class="target-badge ' + item.className + selected + '" data-index="' + index + '" type="button" title="' + escapeHtml(item.label) + '">' + escapeHtml(item.label) + '</button>';
    }).join('');

    const nodes = targetBadges.querySelectorAll('.target-badge');
    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        const index = Number(node.getAttribute('data-index'));
        if (!Number.isFinite(index) || index < 0 || index >= currentBadgeTargets.length) return;
        const next = currentBadgeTargets[index].target;
        selectTargetSilently(next);
        vscode.postMessage({ type: 'set-target', value: next });
      });
    });
  }

  function syncTargetBadges() {
    const targetChanged = ensureSelectedTargetValid();
    renderTargetBadges();
    highlightSelectedEntries();
    if (targetChanged) {
      vscode.postMessage({ type: 'set-target', value: selectedTarget });
    }
  }

  function highlightSelectedEntries() {
    const entries = feed.querySelectorAll('.entry[data-agent][data-session]');
    entries.forEach((node) => {
      const agent = String(node.getAttribute('data-agent') || '').toLowerCase();
      const sessionId = String(node.getAttribute('data-session') || '').toLowerCase();
      const selected = selectedTarget
        && selectedTarget.kind === 'existing'
        && String(selectedTarget.agent || '').toLowerCase() === agent
        && String(selectedTarget.sessionId || '').toLowerCase() === sessionId;
      if (selected) node.classList.add('selected-target');
      else node.classList.remove('selected-target');
    });
  }

  function cloneDispatchTarget(target) {
    const kind = String(target && target.kind || '').trim();
    if (kind === 'existing') {
      return {
        kind: 'existing',
        agent: String(target.agent || '').toLowerCase() === 'claude' ? 'claude' : 'codex',
        sessionId: String(target.sessionId || '').trim().toLowerCase(),
        projectName: target.projectName,
        sessionTitle: target.sessionTitle,
      };
    }
    return {
      kind: kind === 'new-claude' ? 'new-claude' : 'new-codex',
    };
  }

  function targetAgent(target) {
    if (target && target.kind === 'existing') {
      return String(target.agent || '').toLowerCase() === 'claude' ? 'claude' : 'codex';
    }
    if (target && target.kind === 'new-claude') return 'claude';
    if (target && target.kind === 'new-codex') return 'codex';
    const provider = MODEL_PROVIDER[modelSelect.value] || 'openai';
    return PROVIDER_AGENT[provider] === 'claude' ? 'claude' : 'codex';
  }

  function addLocalPromptEntry(target, promptText, timestamp) {
    const agent = targetAgent(target);
    const localSessionId = target.kind === 'existing'
      ? String(target.sessionId || '').trim().toLowerCase()
      : ('local-' + String(timestamp) + '-' + Math.random().toString(16).slice(2));
    const localSessionTitle = target.kind === 'existing'
      ? String(target.sessionTitle || '').trim()
      : ('New ' + (agent === 'claude' ? 'Claude' : 'Codex') + ' session');

    renderStaticEntry({
      timestamp,
      sessionId: localSessionId,
      projectName: String(target.projectName || '').trim(),
      sessionTitle: localSessionTitle,
      agent,
      source: 'you',
      eventSummary: 'Prompt sent',
      commentary: promptText,
    });
    highlightSelectedEntries();
    scrollToBottom();
  }

  function postPromptDispatch(target, promptText) {
    const prompt = String(promptText || '').trim();
    if (!prompt) return;
    const nextTarget = cloneDispatchTarget(target);
    const pending = {
      target: nextTarget,
      prompt,
      timestamp: Date.now(),
    };
    pendingDispatches.push(pending);

    addLocalPromptEntry(nextTarget, prompt, pending.timestamp);

    composerInput.value = '';
    hideSlashMenu();
    flushPendingActiveSessions();

    vscode.postMessage({
      type: 'dispatch-prompt',
      value: {
        target: nextTarget,
        prompt,
      },
    });
  }

  function submitComposer() {
    const raw = composerInput.value;
    const numericSlash = parseNumericSlashTargetInput(raw);
    if (numericSlash) {
      selectTargetSilently(numericSlash.target);
      vscode.postMessage({ type: 'set-target', value: numericSlash.target });
      if (numericSlash.mode === 'select-only') {
        composerInput.value = String(numericSlash.token || ('/' + String(numericSlash.index))) + ' ';
        composerInput.focus();
        hideSlashMenu();
        return;
      }

      postPromptDispatch(numericSlash.target, numericSlash.prompt);
      return;
    }

    const parsed = parseSlashInput(raw);

    if (parsed) {
      const cmd = findSlashCommand(parsed.command);
      if (!cmd && slashItems.length > 0) {
        pickSlashCommandFromMenu(slashSelectedIndex);
        return;
      }
      if (!cmd) {
        pushSystemEntry('Unknown command: /' + parsed.command, true);
        return;
      }

      const result = executeSlashCommand(raw);
      if (result === 'clear') {
        composerInput.value = '';
      }
      updateSlashMenu();
      return;
    }

    const numeric = parseNumericTargetInput(raw);
    if (numeric) {
      selectTargetSilently(numeric.target);
      vscode.postMessage({ type: 'set-target', value: numeric.target });
      if (numeric.mode === 'select-only') {
        composerInput.value = String(numeric.index) + ' ';
        composerInput.focus();
        hideSlashMenu();
        return;
      }

      postPromptDispatch(numeric.target, numeric.prompt);
      return;
    }

    const prompt = String(raw || '').trim();
    if (!prompt) return;

    postPromptDispatch(selectedTarget, prompt);
  }

  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'model', value: modelSelect.value });
    renderModelMenu();
    syncModelMenuButton();
    syncTargetBadges();
  });

  presetSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'preset', value: presetSelect.value });
    renderPresetMenu();
    syncPresetMenuButton();
  });

  modelMenuBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleModelMenu();
  });

  modelMenu.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  presetMenuBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePresetMenu();
  });

  presetMenu.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  styleMenuBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleStyleMenu();
  });

  styleMenu.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  pauseBtn.addEventListener('click', () => {
    setPausedState(!paused, true);
  });

  composerInput.addEventListener('input', () => {
    const numericSlash = parseNumericSlashTargetInput(composerInput.value);
    if (numericSlash) {
      selectTargetSilently(numericSlash.target);
      vscode.postMessage({ type: 'set-target', value: numericSlash.target });
    }
    updateSlashMenu();
    flushPendingActiveSessions();
  });

  composerInput.addEventListener('keydown', (event) => {
    const parsed = parseSlashInput(composerInput.value);

    if (parsed) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (slashItems.length === 0) return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        slashSelectedIndex = (slashSelectedIndex + delta + slashItems.length) % slashItems.length;
        updateSlashMenu();
        return;
      }

      if (event.key === 'Tab') {
        if (slashItems.length === 0) return;
        event.preventDefault();
        pickSlashCommandFromMenu(slashSelectedIndex);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  });

  composerSend.addEventListener('click', () => {
    submitComposer();
    composerInput.focus();
  });

  composerInput.addEventListener('focus', () => {
    updateSlashMenu();
  });

  composerInput.addEventListener('blur', () => {
    setTimeout(() => hideSlashMenu(), 100);
    flushPendingActiveSessions();
  });

  document.addEventListener('mousedown', (event) => {
    const eventTarget = event && event.target;
    const target = eventTarget && eventTarget.nodeType === 1
      ? eventTarget.closest('.menu-host')
      : null;
    if (target) return;
    hideAllMenus();
  });

  feed.addEventListener('click', (event) => {
    const entry = event.target && event.target.closest ? event.target.closest('.entry[data-agent][data-session]') : null;
    if (!entry) return;

    const agent = String(entry.getAttribute('data-agent') || '').toLowerCase();
    const sessionId = String(entry.getAttribute('data-session') || '').toLowerCase();
    if (!agent || !sessionId) return;

    const session = activeSessions.find((item) => {
      return item.agent === agent && String(item.id || '').trim().toLowerCase() === sessionId;
    });

    const next = {
      kind: 'existing',
      agent,
      sessionId,
      projectName: session ? session.projectName : undefined,
      sessionTitle: session ? session.sessionTitle : undefined,
    };

    selectTargetSilently(next);
    vscode.postMessage({ type: 'set-target', value: next });
  });

  refreshPauseButton();
  setFormatStylesFromExtension(INITIAL_FORMAT_STYLES);
  renderPresetMenu();
  syncPresetMenuButton();
  refreshModelOptions(modelSelect.value, false);
  syncTargetBadges();

  window.addEventListener('message', (event) => {
    const msg = event.data || {};

    if (msg.type === 'commentary-start') {
      if (currentEntry) finalizeCurrentCommentary();

      const entry = msg.value || {};
      empty.style.display = 'none';

      const safeAgent = entry.agent === 'claude' ? 'claude' : 'codex';
      const safeSource = escapeHtml(entry.source || 'cli');
      const rawProjectName = displayProjectName(entry);
      const rawSessionName = displaySessionName(entry);
      const projectName = escapeHtml(rawProjectName);
      const sessionName = sameLabel(rawProjectName, rawSessionName) ? '' : escapeHtml(rawSessionName);
      const eventSummary = escapeHtml(truncateLabel(entry.eventSummary || '', 160));

      const sessionLineHtml = (projectName || sessionName)
        ? ('<div class="session-line">'
          + (projectName ? '<span class="project-name">' + projectName + '</span>' : '')
          + ((projectName && sessionName) ? '<span class="session-divider">›</span>' : '')
          + (sessionName ? '<span class="session-name">' + sessionName + '</span>' : '')
          + '</div>')
        : '';

      const div = document.createElement('div');
      div.className = 'entry ' + safeAgent;
      div.setAttribute('data-agent', safeAgent);
      div.setAttribute('data-session', String(entry.sessionId || '').trim().toLowerCase());
      div.innerHTML = ''
        + '<div class="entry-header">'
        + '  <span class="agent-badge ' + safeAgent + '">' + safeAgent + '</span>'
        + '  <span class="source-badge">[' + safeSource + ']</span>'
        + '  <span>' + escapeHtml(timeStr(entry.timestamp || Date.now())) + '</span>'
        +    sessionLineHtml
        + '</div>'
        + '<div class="event-summary">' + eventSummary + '</div>'
        + '<div class="commentary" id="current-commentary"><span class="cursor">|</span></div>';

      feed.appendChild(div);
      currentEntry = div;
      currentRawText = '';
      pendingTypingText = '';
      finalCommentaryText = '';
      streamDone = false;
      renderCurrentCommentary(true);
      highlightSelectedEntries();
      scrollToBottom();
      return;
    }

    if (msg.type === 'history') {
      clearFeed();
      const entries = Array.isArray(msg.value) ? msg.value : [];
      for (const entry of entries) {
        if (!entry) continue;
        renderStaticEntry(entry);
      }
      empty.style.display = entries.length === 0 ? 'flex' : 'none';
      highlightSelectedEntries();
      scrollToBottom();
      return;
    }

    if (msg.type === 'commentary-chunk') {
      if (currentEntry) {
        pendingTypingText += String(msg.value || '');
        ensureTypingLoop();
      }
      return;
    }

    if (msg.type === 'commentary-done') {
      if (currentEntry) {
        finalCommentaryText = String(msg.value && msg.value.commentary || '');
        const typedAndQueued = currentRawText + pendingTypingText;
        if (finalCommentaryText.startsWith(typedAndQueued)) {
          pendingTypingText += finalCommentaryText.slice(typedAndQueued.length);
        } else {
          pendingTypingText = finalCommentaryText.slice(currentRawText.length);
        }
        streamDone = true;
        if (!pendingTypingText && currentRawText === finalCommentaryText) {
          finalizeCurrentCommentary();
        } else {
          ensureTypingLoop();
        }
      }
      return;
    }

    if (msg.type === 'error') {
      pushSystemEntry(msg.value, true);
      return;
    }

    if (msg.type === 'sessions') {
      const count = Number(msg.value || 0);
      sessionsEl.textContent = count + ' session' + (count === 1 ? '' : 's');
      return;
    }

    if (msg.type === 'model') {
      refreshModelOptions(msg.value, false);
      return;
    }

    if (msg.type === 'set-focus') {
      // Focus is behavior-only. We keep the composer as dispatch text.
      return;
    }

    if (msg.type === 'set-preset') {
      presetSelect.value = msg.value || 'auto';
      renderPresetMenu();
      syncPresetMenuButton();
      return;
    }

    if (msg.type === 'set-format-styles') {
      setFormatStylesFromExtension(msg.value || []);
      return;
    }

    if (msg.type === 'set-show-event-summary') {
      setEventSummaryVisibility(!!msg.value, false);
      return;
    }

    if (msg.type === 'providers') {
      const badges = document.querySelectorAll('.provider-badge');
      (msg.value || []).forEach((provider, idx) => {
        const badge = badges[idx];
        if (!badge) return;
        const dot = provider.available ? '●' : '○';
        badge.style.color = provider.available ? '#22c55e' : '#6b7280';
        badge.textContent = dot + ' ' + provider.label;
        badge.title = provider.available
          ? provider.label + ' CLI ' + (provider.version || '')
          : provider.label + ' CLI not found';
      });
      return;
    }

    if (msg.type === 'active-sessions') {
      queueOrApplyActiveSessions(msg.value);
      return;
    }

    if (msg.type === 'target-selected') {
      if (!msg.value) return;
      selectedTarget = msg.value;
      syncTargetBadges();
      return;
    }

    if (msg.type === 'dispatch-status') {
      const status = msg.value || {};
      const state = String(status.state || '').toLowerCase();
      if (state === 'sent' || state === 'failed') {
        const pending = pendingDispatches.length > 0 ? pendingDispatches.shift() : null;
        if (state === 'failed' && pending && !String(composerInput.value || '').trim()) {
          composerInput.value = pending.prompt;
        }
      }
      if (state === 'failed') {
        const message = String(status.message || 'Dispatch failed');
        pushSystemEntry(message, true);
      }
    }
  });
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
