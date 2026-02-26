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

const SYSTEM_PROMPT = `You oversee AI coding agents. Summarize what they did in plain language anyone can understand.

Rules:
- Plain language. "Fixed the login page" not "Edited auth middleware".
- Use bullet points to structure. Each bullet = one thing that happened or one observation.
- Bold only names and key nouns (1-2 words max): **agent**, **tests**, **deploy**. Never bold full sentences.
- Use UPPER CASE for emotional reactions: NICE CATCH, RISKY MOVE, GREAT WORK, NOT IDEAL, FINALLY.
- No filler. No "methodical", "surgical", "clean work". Just facts and reactions.

Example:
The **room** agent worked on the settings feature:
- Researched how settings currently work
- Rewrote the settings page with new layout
- Shipped without running **tests** — RISKY MOVE
- At least checked for errors before pushing

Example:
Two agents active on **vasily** project:
- One is investigating a login bug — reading code, hasn't changed anything yet
- The other just deployed a fix to **production**. NICE — tested first.`

// Adaptive batching: accumulate more context before summarizing
const MIN_BATCH_SIZE = 5       // need enough actions for a meaningful summary
const MAX_BATCH_SIZE = 40      // cap to avoid huge prompts
const IDLE_TIMEOUT_MS = 20000  // flush after 20s of no new events
const MAX_WAIT_MS = 60000      // never wait more than 60s from first event

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
