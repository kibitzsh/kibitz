import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KibitzPanel } from './panel'
import {
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
  persistModel,
  persistPreset,
  readPersistedModel,
  readPersistedPreset,
} from './persistence'
import { inheritShellPath, SessionProvider } from '../core/platform-support'
import { SessionDispatchService } from '../core/session-dispatch'

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

function quoteArg(value: string): string {
  const safe = String(value || '').replace(/"/g, '\\"')
  return `"${safe}"`
}

async function launchInteractiveFromPanel(
  context: vscode.ExtensionContext,
  provider: SessionProvider,
  prompt: string,
): Promise<void> {
  const launcherPath = path.join(context.extensionPath, 'dist', 'vscode', 'interactive-launcher.js')
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Interactive launcher not found at ${launcherPath}. Run build first.`)
  }

  const promptFile = path.join(
    os.tmpdir(),
    `kibitz-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  )
  fs.writeFileSync(promptFile, prompt, 'utf8')

  const terminal = vscode.window.createTerminal({ name: `Kibitz ${provider}` })
  const command = `${quoteArg(process.execPath)} ${quoteArg(launcherPath)} --provider ${provider} --prompt-file ${quoteArg(promptFile)}`
  terminal.show(true)
  terminal.sendText(command, true)

  // Best-effort cleanup; launcher reads immediately at process start.
  setTimeout(() => {
    try {
      fs.unlinkSync(promptFile)
    } catch {
      // Ignore cleanup errors.
    }
  }, 90_000)
}

function ensureRuntime(context: vscode.ExtensionContext): void {
  if (watcher && engine && dispatchService) return

  commentaryHistory = context.globalState.get('kibitz.commentaryHistory', [])
  if (!Array.isArray(commentaryHistory)) commentaryHistory = []

  watcher = new SessionWatcher()
  engine = new CommentaryEngine(noopKeyResolver)
  dispatchService = new SessionDispatchService({
    getActiveSessions: () => watcher?.getActiveSessions() || [],
    launchInteractiveSession: (provider, prompt) => launchInteractiveFromPanel(context, provider, prompt),
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
