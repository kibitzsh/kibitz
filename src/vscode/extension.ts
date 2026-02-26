import * as vscode from 'vscode'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KibitzPanel } from './panel'
import { MODELS, ModelId, ProviderId, KeyResolver } from '../core/types'

let watcher: SessionWatcher | undefined
let engine: CommentaryEngine | undefined
let panel: KibitzPanel | undefined

class VSCodeKeyResolver implements KeyResolver {
  constructor(private secrets: vscode.SecretStorage) {}

  async getKey(provider: ProviderId): Promise<string | undefined> {
    const secretKey = provider === 'anthropic' ? 'kibitz.anthropicApiKey' : 'kibitz.openaiApiKey'
    const envKey = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    return (await this.secrets.get(secretKey)) || process.env[envKey]
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    const secretKey = provider === 'anthropic' ? 'kibitz.anthropicApiKey' : 'kibitz.openaiApiKey'
    await this.secrets.store(secretKey, key)
  }
}

export function activate(context: vscode.ExtensionContext) {
  const keyResolver = new VSCodeKeyResolver(context.secrets)

  context.subscriptions.push(
    vscode.commands.registerCommand('kibitz.open', () => {
      if (!watcher) {
        watcher = new SessionWatcher()
        engine = new CommentaryEngine(keyResolver)

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
        description: m.id === engine!.getModel() ? '(current)' : '',
        modelId: m.id,
      }))
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select commentary model' })
      if (pick) {
        engine.setModel(pick.modelId as ModelId)
        panel?.updateModel(pick.modelId as ModelId)
      }
    }),

    // Set API Key — only needed for OpenAI (Claude uses subscription via CLI)
    vscode.commands.registerCommand('kibitz.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter OpenAI API key (Claude uses your subscription — no key needed)',
        password: true,
        placeHolder: 'sk-...',
      })
      if (key) {
        await keyResolver.setKey('openai', key)
        vscode.window.showInformationMessage('OpenAI API key saved.')
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
