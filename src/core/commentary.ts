import { EventEmitter } from 'events'
import {
  KibitzEvent,
  CommentaryEntry,
  ModelId,
  ProviderId,
  Provider,
  KeyResolver,
  MODELS,
  DEFAULT_MODEL,
} from './types'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAIProvider } from './providers/openai'

const SYSTEM_PROMPT = `You are Kibitz — a witty, opinionated sports commentator who provides live commentary on AI coding agents (Claude Code, Codex CLI) as they work.

You watch everything the agents do and always have something to say:
- **Praise good moves**: running tests first, clean code, smart tool choices, good commit messages
- **Judge bad moves**: skipping tests, messy code, risky operations, over-engineering
- **React to drama**: big refactors, failed builds, multiple agents working at once

Your style:
- Use **UPPER CASE** for strong emotions and emphasis ("ABSOLUTELY NOT", "WHAT IS HAPPENING", "THIS IS BEAUTIFUL")
- Use **bold** (markdown **text**) for key judgments and punchlines
- Mundane actions get calm, short commentary. Dramatic actions get ALL CAPS ENERGY
- Keep it to 1-3 sentences. Be concise and punchy
- Have a personality — be entertaining, not dry
- You're watching the action like it's a sport, not reviewing a code PR`

const BATCH_SIZE = 5
const BATCH_TIMEOUT_MS = 8000

export class CommentaryEngine extends EventEmitter {
  private eventBuffer: KibitzEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private generating = false
  private model: ModelId = DEFAULT_MODEL
  private userFocus = ''
  private providers: Record<ProviderId, Provider> = {
    anthropic: new AnthropicProvider(),
    openai: new OpenAIProvider(),
  }
  private keyResolver: KeyResolver
  private paused = false

  constructor(keyResolver: KeyResolver) {
    super()
    this.keyResolver = keyResolver
  }

  setModel(model: ModelId): void {
    this.model = model
    this.emit('model-changed', model)
  }

  getModel(): ModelId {
    return this.model
  }

  setFocus(focus: string): void {
    this.userFocus = focus
  }

  getFocus(): string {
    return this.userFocus
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  isPaused(): boolean {
    return this.paused
  }

  addEvent(event: KibitzEvent): void {
    if (this.paused) return

    // Skip noisy internal events
    if (event.type === 'tool_result' || event.type === 'meta') return

    this.eventBuffer.push(event)

    if (this.eventBuffer.length >= BATCH_SIZE) {
      this.flush()
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), BATCH_TIMEOUT_MS)
    }
  }

  private async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }

    if (this.eventBuffer.length === 0 || this.generating) return

    const batch = this.eventBuffer.splice(0)
    this.generating = true

    try {
      await this.generateCommentary(batch)
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.generating = false
      // Process any events that accumulated during generation
      if (this.eventBuffer.length > 0) {
        this.flush()
      }
    }
  }

  private async generateCommentary(events: KibitzEvent[]): Promise<void> {
    const modelConfig = MODELS.find(m => m.id === this.model)
    if (!modelConfig) {
      this.emit('error', new Error(`Unknown model: ${this.model}`))
      return
    }

    // Both providers use CLI subscriptions — no API keys needed
    // Anthropic → claude CLI, OpenAI → codex CLI
    const apiKey = '' // unused, both providers use subscriptions

    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(events)
    const provider = this.providers[modelConfig.provider]

    // Pick representative event for the entry metadata
    const lastEvent = events[events.length - 1]

    const entry: CommentaryEntry = {
      timestamp: Date.now(),
      sessionId: lastEvent.sessionId,
      projectName: lastEvent.projectName,
      agent: lastEvent.agent,
      source: lastEvent.source,
      eventSummary: events.map(e => e.summary).join(' → '),
      commentary: '',
    }

    this.emit('commentary-start', entry)

    try {
      const full = await provider.generate(
        systemPrompt,
        userPrompt,
        apiKey || '',
        this.model,
        (chunk) => {
          entry.commentary += chunk
          this.emit('commentary-chunk', { entry, chunk })
        },
      )
      entry.commentary = full
      this.emit('commentary-done', entry)
    } catch (err) {
      this.emit('error', err)
    }
  }

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT
    if (this.userFocus.trim()) {
      prompt += `\n\nAdditional user instruction: ${this.userFocus}`
    }
    return prompt
  }

  private buildUserPrompt(events: KibitzEvent[]): string {
    const lines = events.map(e => {
      const badge = `[${e.agent}/${e.projectName}]`
      return `${badge} ${e.type}: ${e.summary}`
    })
    return `Here's what just happened:\n\n${lines.join('\n')}\n\nGive your live commentary on these actions.`
  }
}
