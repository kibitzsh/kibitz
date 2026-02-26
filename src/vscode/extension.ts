import * as vscode from 'vscode'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KibitzPanel } from './panel'
import { MODELS, ModelId, KeyResolver, ProviderId, ProviderStatus } from '../core/types'
import { checkClaudeCliAvailable } from '../core/providers/anthropic'
import { checkCodexCliAvailable } from '../core/providers/openai'

let watcher: SessionWatcher | undefined
let engine: CommentaryEngine | undefined
let panel: KibitzPanel | undefined

const noopKeyResolver: KeyResolver = {
  async getKey(_provider: ProviderId) { return 'subscription' },
}

function detectProviders(): ProviderStatus[] {
  const claude = checkClaudeCliAvailable()
  const codex = checkCodexCliAvailable()
  return [
    { provider: 'anthropic', label: 'Claude', available: claude.available, version: claude.version, error: claude.error },
    { provider: 'openai', label: 'Codex', available: codex.available, version: codex.version, error: codex.error },
  ]
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('kibitz.open', () => {
      if (!watcher) {
        watcher = new SessionWatcher()
        engine = new CommentaryEngine(noopKeyResolver)

        watcher.on('event', (event) => {
          engine!.addEvent(event)
        })

        engine.on('commentary-start', (entry) => {
          panel?.addCommentary(entry, true)
        })
        engine.on('commentary-chunk', ({ entry, chunk }) => {
          panel?.appendChunk(chunk)
        })
        engine.on('commentary-done', (entry) => {
          panel?.finishCommentary(entry)
        })
        engine.on('error', (err) => {
          panel?.showError(String(err))
        })

        watcher.start()
      }

      const providers = detectProviders()

      if (!panel || !panel.isVisible()) {
        panel = new KibitzPanel(context, engine!, watcher!, providers)
      }
      panel.reveal()
    }),

    vscode.commands.registerCommand('kibitz.switchModel', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Open Kibitz first (Kibitz: Open)')
        return
      }
      const providers = detectProviders()
      const availableModels = MODELS.filter(m => {
        const status = providers.find(p => p.provider === m.provider)
        return status?.available
      })
      if (availableModels.length === 0) {
        vscode.window.showErrorMessage('No CLI subscriptions found. Install claude or codex CLI.')
        return
      }
      const items = availableModels.map(m => ({
        label: m.label,
        description: m.id === engine!.getModel() ? '(current)' : '',
        modelId: m.id,
      }))
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select commentary model' })
      if (pick) {
        engine.setModel(pick.modelId as ModelId)
        panel?.updateModel(pick.modelId as ModelId)
      }
    }),
  )

  context.subscriptions.push({
    dispose() {
      watcher?.stop()
      panel?.dispose()
    },
  })
}

export function deactivate() {
  watcher?.stop()
  panel?.dispose()
}
