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
- **Bold** only key nouns, 1-2 words: **tests**, **deploy**, **production**. NEVER bold sentences.
- UPPER CASE for emotional cheering or concern: GREAT FIND, NICE, RISKY, FINALLY, OOPS, NOT IDEAL.
- No filler. No "methodical", "surgical", "disciplined", "clean work". Facts and reactions only.
- Don't repeat what previous commentary already said.`

// Format templates — one is randomly selected per commentary.
// This ensures visual variety across messages.
const FORMAT_TEMPLATES = [
  // 1. Bullet list
  `Use bullet points. Each bullet = one thing done or one observation.
Example:
- Researched how the feature works
- Rewrote the page with new layout
- Shipped without **tests** — RISKY
- Checked for errors before pushing`,

  // 2. One-liner
  `Write a single sentence. Punchy, complete, under 20 words.
Example: Agent investigated the bug, found the root cause, and fixed it — NICE WORK.
Example: Still reading code after 30 actions — hasn't changed anything yet.`,

  // 3. Headline + context
  `Start with a short UPPER CASE reaction (2-4 words), then one sentence of context.
Example:
SOLID APPROACH. Agent read the dependencies first, then made targeted changes across three files.
Example:
NOT GREAT. Pushed to **production** without running any tests — hope nothing breaks.`,

  // 4. Numbered progress
  `Use numbered steps showing what the agent did in order. Add a final verdict line.
Example:
1. Read the existing code
2. Made changes to the login flow
3. Tested locally
4. Pushed to **production**
Verdict: proper process, nothing to flag.`,

  // 5. Short + question
  `Summarize in one sentence, then ask a pointed rhetorical question.
Example:
Agent rewrote the entire settings page and shipped it immediately. Did they test this at all?
Example:
Third time reading the same code. Lost, or just being thorough?`,
]

// Adaptive batching
const MIN_BATCH_SIZE = 5
const MAX_BATCH_SIZE = 40
const IDLE_TIMEOUT_MS = 20000
const MAX_WAIT_MS = 60000

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
  private recentCommentary: string[] = []
  private lastFormatIdx = -1

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
      if (this.eventBuffer.length > 0 && !this.generating) {
        this.idleTimer = setTimeout(() => {
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
      if (this.eventBuffer.length > 0) {
        this.flush()
      }
    }
  }

  private pickFormat(): string {
    // Pick a random format that's different from the last one used
    let idx: number
    do {
      idx = Math.floor(Math.random() * FORMAT_TEMPLATES.length)
    } while (idx === this.lastFormatIdx && FORMAT_TEMPLATES.length > 1)
    this.lastFormatIdx = idx
    return FORMAT_TEMPLATES[idx]
  }

  private async generateCommentary(events: KibitzEvent[]): Promise<void> {
    const modelConfig = MODELS.find(m => m.id === this.model)
    if (!modelConfig) {
      this.emit('error', new Error(`Unknown model: ${this.model}`))
      return
    }

    const apiKey = ''
    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(events)
    const provider = this.providers[modelConfig.provider]

    // Pick the dominant agent/project — whichever has the most events in the batch
    const counts = new Map<string, { count: number; event: typeof events[0] }>()
    for (const e of events) {
      const key = `${e.agent}:${e.projectName}`
      const existing = counts.get(key)
      if (existing) existing.count++
      else counts.set(key, { count: 1, event: e })
    }
    const dominant = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0].event

    const entry: CommentaryEntry = {
      timestamp: Date.now(),
      sessionId: dominant.sessionId,
      projectName: dominant.projectName,
      sessionTitle: dominant.sessionTitle,
      agent: dominant.agent,
      source: dominant.source,
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

      // Track recent commentary to avoid repetition
      this.recentCommentary.push(full)
      if (this.recentCommentary.length > 5) {
        this.recentCommentary.shift()
      }
    } catch (err) {
      this.emit('error', err)
    }
  }

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT

    // Add random format template
    prompt += `\n\nFormat for this message:\n${this.pickFormat()}`

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

    let prompt = sections.join('\n\n')

    // Include recent commentary so the LLM doesn't repeat itself
    if (this.recentCommentary.length > 0) {
      prompt += `\n\nPrevious commentary (don't repeat):\n`
      prompt += this.recentCommentary.slice(-3).map(c => `- ${c.slice(0, 80)}...`).join('\n')
    }

    prompt += `\n\nSummarize what the agent did. Plain language, with your reaction.`

    return prompt
  }
}
