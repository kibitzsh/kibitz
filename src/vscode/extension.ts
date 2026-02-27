import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KibitzPanel } from './panel'
import {
  COMMENTARY_STYLE_OPTIONS,
  CommentaryStyleId,
  DispatchRequest,
  DispatchTarget,
  KeyResolver,
  MODELS,
  ModelId,
  ProviderId,
  ProviderStatus,
} from '../core/types'
import { checkClaudeCliAvailable } from '../core/providers/anthropic'
import { checkCodexCliAvailable } from '../core/providers/openai'
import {
  persistFormatStyles,
  persistModel,
  persistPreset,
  readPersistedFormatStyles,
  readPersistedModel,
  readPersistedPreset,
} from './persistence'
import { inheritShellPath, SessionProvider } from '../core/platform-support'
import {
  buildInteractiveDispatchCommand,
  resolveDispatchCommand,
  SessionDispatchService,
} from '../core/session-dispatch'

let watcher: SessionWatcher | undefined
let engine: CommentaryEngine | undefined
let panel: KibitzPanel | undefined
let dispatchService: SessionDispatchService | undefined
let sessionsRefreshTimer: ReturnType<typeof setInterval> | null = null
let panelTarget: DispatchTarget = { kind: 'new-codex' }
let commentaryHistory: Array<{
  timestamp: number
  sessionId: string
  projectName: string
  sessionTitle?: string
  agent: 'claude' | 'codex'
  source: 'vscode' | 'cli'
  eventSummary: string
  commentary: string
}> = []

const noopKeyResolver: KeyResolver = {
  async getKey(_provider: ProviderId) {
    return 'subscription'
  },
}

function detectProviders(): ProviderStatus[] {
  const claude = checkClaudeCliAvailable()
  const codex = checkCodexCliAvailable()
  return [
    {
      provider: 'anthropic',
      label: 'Claude',
      available: claude.available,
      version: claude.version,
      error: claude.error,
    },
    {
      provider: 'openai',
      label: 'Codex',
      available: codex.available,
      version: codex.version,
      error: codex.error,
    },
  ]
}

function postActiveSessions(): void {
  if (!watcher || !panel) return
  panel.updateActiveSessions(watcher.getActiveSessions())
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Unknown error')
}

function formatProviderLabel(provider: SessionProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

function quotePosix(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`
}

function quotePowerShell(value: string): string {
  return `'${String(value || '').replace(/'/g, "''")}'`
}

async function spawnAndWait(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk || '')
    })
    child.once('error', (error) => {
      reject(error)
    })
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const message = stderr.trim() || `${command} exited with code ${code}`
      reject(new Error(message))
    })
  })
}

function buildMacCommandScript(command: string, args: string[]): string {
  const cmdLine = [command, ...args]
    .map((arg) => quotePosix(arg))
    .join(' ')

  return [
    '#!/bin/zsh',
    cmdLine,
    'status=$?',
    'echo',
    'if [ "$status" -ne 0 ]; then',
    '  echo "Command failed with exit code $status"',
    'fi',
    'exec $SHELL -l',
  ].join('\n')
}

function buildMacCommandScriptWithMarker(
  command: string,
  args: string[],
  markerPath: string,
): string {
  const marker = quotePosix(markerPath)
  return [
    '#!/bin/zsh',
    `echo "started $(date +%s)" > ${marker}`,
    buildMacCommandScript(command, args),
  ].join('\n')
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    if (fs.existsSync(filePath)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

function escapeAppleScriptText(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function launchExternalTerminalWindow(
  provider: SessionProvider,
  prompt: string,
): Promise<void> {
  const command = buildInteractiveDispatchCommand(provider, prompt)
  const resolved = resolveDispatchCommand(command)

  if (process.platform === 'darwin') {
    const markerPath = path.join(
      os.tmpdir(),
      `kibitz-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}.started`,
    )
    const scriptPath = path.join(
      os.tmpdir(),
      `kibitz-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}.command`,
    )
    const scriptBody = buildMacCommandScriptWithMarker(resolved.command, resolved.args, markerPath)
    fs.writeFileSync(scriptPath, scriptBody, { encoding: 'utf8', mode: 0o755 })

    await spawnAndWait('open', ['-a', 'Terminal', scriptPath])
    let launched = await waitForFile(markerPath, 6000)
    if (!launched) {
      const escapedScriptPath = escapeAppleScriptText(scriptPath)
      await spawnAndWait('osascript', [
        '-e',
        'tell application "Terminal" to activate',
        '-e',
        `tell application "Terminal" to do script "zsh " & quoted form of "${escapedScriptPath}"`,
      ])
      launched = await waitForFile(markerPath, 6000)
    }

    if (!launched) {
      throw new Error('Terminal did not execute launcher script')
    }

    setTimeout(() => {
      try {
        fs.unlinkSync(scriptPath)
      } catch {
        // Best-effort cleanup.
      }
      try {
        fs.unlinkSync(markerPath)
      } catch {
        // Best-effort cleanup.
      }
    }, 5 * 60 * 1000)
    return
  }

  if (process.platform === 'win32') {
    const argList = resolved.args.map((arg) => quotePowerShell(arg)).join(', ')
    const psScript = [
      "$ErrorActionPreference='Stop'",
      `Start-Process -WindowStyle Normal -FilePath ${quotePowerShell(resolved.command)} -ArgumentList @(${argList})`,
    ].join('; ')

    await spawnAndWait('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      psScript,
    ])
    return
  }

  // Linux is best-effort in this project.
  await spawnAndWait('x-terminal-emulator', ['-e', resolved.command, ...resolved.args])
}

async function launchInteractiveFromPanel(
  provider: SessionProvider,
  prompt: string,
): Promise<void> {
  try {
    await launchExternalTerminalWindow(provider, prompt)
  } catch (error) {
    throw new Error(`Failed to open external ${formatProviderLabel(provider)} terminal: ${normalizeErrorMessage(error)}`)
  }

  void vscode.window.setStatusBarMessage(
    `Kibitz: opened ${formatProviderLabel(provider)} in external terminal window.`,
    6000,
  )
}

function ensureRuntime(context: vscode.ExtensionContext): void {
  if (watcher && engine && dispatchService) return

  commentaryHistory = context.globalState.get('kibitz.commentaryHistory', [])
  if (!Array.isArray(commentaryHistory)) commentaryHistory = []

  watcher = new SessionWatcher()
  engine = new CommentaryEngine(noopKeyResolver)
  dispatchService = new SessionDispatchService({
    getActiveSessions: () => watcher?.getActiveSessions() || [],
    launchInteractiveSession: (provider, prompt) => launchInteractiveFromPanel(provider, prompt),
  })

  watcher.on('event', (event) => {
    engine!.addEvent(event)
    postActiveSessions()
  })

  engine.on('model-changed', (model: ModelId) => {
    context.globalState.update('kibitz.model', model)
    persistModel(context.globalStorageUri.fsPath, model)
    panel?.updateModel(model)
  })

  engine.on('preset-changed', (preset: string) => {
    context.globalState.update('kibitz.preset', preset)
    persistPreset(context.globalStorageUri.fsPath, preset)
    panel?.updatePreset(preset)
  })

  engine.on('format-styles-changed', (styleIds: CommentaryStyleId[]) => {
    context.globalState.update('kibitz.formatStyles', styleIds)
    persistFormatStyles(context.globalStorageUri.fsPath, styleIds)
    panel?.updateFormatStyles(styleIds)
  })

  engine.on('commentary-start', (entry) => {
    panel?.addCommentary(entry)
  })

  engine.on('commentary-chunk', ({ chunk }) => {
    panel?.appendChunk(chunk)
  })

  engine.on('commentary-done', (entry) => {
    commentaryHistory.push(entry)
    if (commentaryHistory.length > 200) {
      commentaryHistory = commentaryHistory.slice(-200)
    }
    void context.globalState.update('kibitz.commentaryHistory', commentaryHistory)
    panel?.finishCommentary(entry)
  })

  engine.on('error', (error) => {
    panel?.showError(String(error))
  })

  dispatchService.on('status', (status) => {
    panel?.postDispatchStatus(status)
  })

  watcher.start()

  if (sessionsRefreshTimer) clearInterval(sessionsRefreshTimer)
  sessionsRefreshTimer = setInterval(() => {
    postActiveSessions()
  }, 5000)
}

async function handlePanelDispatch(target: DispatchTarget, prompt: string): Promise<void> {
  if (!dispatchService) return
  const request: DispatchRequest = {
    target,
    prompt,
    origin: 'vscode',
  }
  await dispatchService.dispatch(request)
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  inheritShellPath()
  const extensionVersion = String((context.extension.packageJSON as { version?: string }).version || 'dev')

  context.subscriptions.push(
    vscode.commands.registerCommand('kibitz.open', () => {
      ensureRuntime(context)

      const savedModel = readPersistedModel(
        context.globalStorageUri.fsPath,
        context.globalState.get<ModelId>('kibitz.model'),
      )
      if (savedModel && engine!.getModel() !== savedModel) {
        engine!.setModel(savedModel)
      }

      const savedPreset = readPersistedPreset(
        context.globalStorageUri.fsPath,
        context.globalState.get<string>('kibitz.preset', 'auto'),
      )
      if (engine!.getPreset() !== savedPreset) {
        engine!.setPreset(savedPreset)
      }

      const fallbackStyles = context.globalState.get<CommentaryStyleId[]>(
        'kibitz.formatStyles',
        COMMENTARY_STYLE_OPTIONS.map((option) => option.id),
      )
      const savedFormatStyles = readPersistedFormatStyles(context.globalStorageUri.fsPath, fallbackStyles)
      const currentFormatStyles = engine!.getFormatStyles()
      const sameFormatStyles = savedFormatStyles.length === currentFormatStyles.length
        && savedFormatStyles.every((styleId, index) => styleId === currentFormatStyles[index])
      if (!sameFormatStyles) {
        engine!.setFormatStyles(savedFormatStyles)
      }

      const providers = detectProviders()
      let panelCreated = false
      if (!panel || !panel.isVisible()) {
        panel = new KibitzPanel(context, engine!, providers, extensionVersion, {
          onDispatchPrompt: (target, prompt) => {
            void handlePanelDispatch(target, prompt)
          },
          onSetTarget: (target) => {
            panelTarget = target
          },
        })
        panelCreated = true
      } else {
        panel.updateProviders(providers)
      }

      panel.reveal()
      if (panelCreated) {
        panel.setHistory(commentaryHistory)
      }
      panel.setTarget(panelTarget)
      postActiveSessions()
    }),

    vscode.commands.registerCommand('kibitz.switchModel', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Open Kibitz first (Kibitz: Open)')
        return
      }

      const providers = detectProviders()
      const availableModels = MODELS.filter((model) => {
        const provider = providers.find((status) => status.provider === model.provider)
        return Boolean(provider?.available)
      })

      if (availableModels.length === 0) {
        vscode.window.showErrorMessage('No CLI subscriptions found. Install claude or codex CLI.')
        return
      }

      const items = availableModels.map((model) => ({
        label: model.label,
        description: model.id === engine!.getModel() ? '(current)' : '',
        modelId: model.id,
      }))

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select commentary model',
      })
      if (picked) {
        engine.setModel(picked.modelId as ModelId)
      }
    }),
  )

  context.subscriptions.push({
    dispose() {
      if (sessionsRefreshTimer) {
        clearInterval(sessionsRefreshTimer)
        sessionsRefreshTimer = null
      }
      watcher?.stop()
      panel?.dispose()
    },
  })
}

export function deactivate(): void {
  if (sessionsRefreshTimer) {
    clearInterval(sessionsRefreshTimer)
    sessionsRefreshTimer = null
  }
  watcher?.stop()
  panel?.dispose()
}
