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

const SYSTEM_PROMPT = `You are Kibitz — a senior super-agent overseeing other AI coding agents. You see the big picture: what they're trying to accomplish, whether their approach is sound, and what they're getting wrong.

Your role: You're the boss reviewing a sequence of moves, not narrating each one. Judge the STRATEGY, not individual file operations.

Rules:
- Look at the full sequence of actions and assess the overall approach
- Don't mention specific filenames or tool names unless they reveal a problem
- Judge: Is the agent's strategy sound? Are they cutting corners? Being thorough? Wasting time?
- One assessment per batch. Not one comment per action.

Format:
- **Bold** for your verdict
- Bullet points for multiple observations (2-3 max)
- CAPS only for genuine critical issues
- 2-4 lines total. Dense, useful judgment — no filler, no narration

Bad (per-file narration): "Reading watcher.ts, then editing commentary.ts, then running tsc..."
Good (big picture): "**Solid refactor cycle.** Read first, edit, type-check. No blind changes. But skipped tests — confidence or laziness?"

Bad (restating events): "The agent committed and pushed the changes to remote."
Good (judgment): "**Ship-and-pray.** Committed and pushed without running tests. Hope nothing breaks in prod."`

// Adaptive batching: accumulate more context before judging
const MIN_BATCH_SIZE = 3       // don't comment on 1-2 actions
const MAX_BATCH_SIZE = 20      // cap to avoid huge prompts
const IDLE_TIMEOUT_MS = 5000   // flush after 5s of no new events
const MAX_WAIT_MS = 25000      // never wait more than 25s from first event

export class CommentaryEngine extends EventEmitter {
  private eventBuffer: KibitzEvent[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
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

    // Hard cap — flush immediately
    if (this.eventBuffer.length >= MAX_BATCH_SIZE) {
      this.flush()
      return
    }

    // Reset idle timer on each new event (wait for activity to settle)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.flush(), IDLE_TIMEOUT_MS)

    // Start max-wait timer on first event in batch
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => this.flush(), MAX_WAIT_MS)
    }
  }

  private async flush(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null }

    // Need minimum events for meaningful commentary
    if (this.eventBuffer.length < MIN_BATCH_SIZE || this.generating) {
      // If generating, events will be processed after current generation
      // If too few events, restart idle timer to wait for more
      if (this.eventBuffer.length > 0 && !this.generating) {
        this.idleTimer = setTimeout(() => {
          // Force flush whatever we have after another idle period
          this.forceFlush()
        }, IDLE_TIMEOUT_MS)
      }
      return
    }

    this.doFlush()
  }

  private forceFlush(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null }
    if (this.eventBuffer.length === 0 || this.generating) return
    this.doFlush()
  }

  private async doFlush(): Promise<void> {
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
    // Group events by session for context
    const bySession = new Map<string, KibitzEvent[]>()
    for (const e of events) {
      const key = `${e.agent}/${e.projectName}`
      if (!bySession.has(key)) bySession.set(key, [])
      bySession.get(key)!.push(e)
    }

    const sections: string[] = []
    for (const [session, evts] of bySession) {
      const lines = evts.map(e => `  ${e.type}: ${e.summary}`)
      sections.push(`[${session}] (${evts.length} actions):\n${lines.join('\n')}`)
    }

    return `${sections.join('\n\n')}\n\nAssess the overall approach and strategy. What's the agent doing right or wrong?`
  }
}
