import * as vscode from 'vscode'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KibitzPanel } from './panel'
import { MODELS, ModelId, KeyResolver, ProviderId } from '../core/types'

let watcher: SessionWatcher | undefined
let engine: CommentaryEngine | undefined
let panel: KibitzPanel | undefined

// No API keys needed — both providers use CLI subscriptions
// (Claude CLI for Anthropic, Codex CLI for OpenAI)
const noopKeyResolver: KeyResolver = {
  async getKey(_provider: ProviderId) { return 'subscription' },
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

      if (!panel || !panel.isVisible()) {
        panel = new KibitzPanel(context, engine!, watcher!)
      }
      panel.reveal()
    }),

    vscode.commands.registerCommand('kibitz.switchModel', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Open Kibitz first (Kibitz: Open)')
        return
      }
      const items = MODELS.map(m => ({
        label: m.label,
        description: `${m.id === engine!.getModel() ? '(current) ' : ''}via ${m.provider === 'anthropic' ? 'Claude CLI' : 'Codex CLI'}`,
        modelId: m.id,
      }))
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select commentary model (all use your subscriptions)' })
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
