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
- Emoji are allowed when they add meaning (max 2 per commentary).
- No filler. No "methodical", "surgical", "disciplined", "clean work". Facts and reactions only.
- Don't repeat what previous commentary already said.
- Never mention session IDs, logs, traces, prompts, JSONL files, or internal tooling.
- Never write in first person ("I", "I'll", "we") or future tense plans.`

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

  // 6. Compact markdown table
  `Use a compact markdown table with columns: Action | Why it mattered.
Include 3-5 rows max, then one verdict sentence.
Example:
| Action | Why it mattered |
| --- | --- |
| Ran tests | Verified changes before shipping |
| Skipped lint | Could hide style regressions |
Verdict: mostly careful, one loose end.`,

  // 7. Emoji-tagged bullets
  `Use bullet points with emoji tags to signal risk/quality.
Use only these tags: ✅, ⚠️, 🔥, ❄️.
Example:
- ✅ Fixed the failing migration script
- ⚠️ Pushed without rerunning integration tests
- 🔥 Found the root cause in auth token parsing`,

  // 8. Quick scoreboard
  `Use a scoreboard format with these labels:
Wins:
Risks:
Next:
Each label should have 1-3 short bullets.`,
]

const PRESET_INSTRUCTIONS = {
  auto: '',
  'critical-coder': 'Be a VERY CRITICAL coder using code terminology. Call out architectural or process flaws directly and sharply.',
  'precise-short': 'Be precise and short. Keep the output compact and information-dense with minimal words.',
  emotional: 'Be emotional and expressive. React strongly to good or risky behavior while staying factual.',
  newbie: 'Explain for non-developers. Avoid jargon or explain it in plain words with simple cause/effect.',
} as const

type CommentaryPresetId = keyof typeof PRESET_INSTRUCTIONS

const SESSION_ID_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
  /\brollout-\d{4}-\d{2}-\d{2}t\d{2}[-:]\d{2}[-:]\d{2}[-a-z0-9]+(?:\.jsonl)?\b/gi,
  /\bsession[\s:_-]*[0-9a-f]{8,}\b/gi,
  /\bturn[\s:_-]*[0-9a-f]{8,}\b/gi,
]

// Adaptive batching
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 40
const IDLE_TIMEOUT_MS = 5000
const MAX_WAIT_MS = 15000

interface SessionState {
  events: KibitzEvent[]
  idleTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  recentCommentary: string[]
}

export class CommentaryEngine extends EventEmitter {
  private sessions = new Map<string, SessionState>()
  private flushQueue: string[] = []
  private queuedSessions = new Set<string>()
  private generating = false
  private model: ModelId = DEFAULT_MODEL
  private userFocus = ''
  private preset: CommentaryPresetId = 'auto'
  private providers: Record<ProviderId, Provider> = {
    anthropic: new AnthropicProvider(),
    openai: new OpenAIProvider(),
  }
  private keyResolver: KeyResolver
  private paused = false
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

  setPreset(preset: string): void {
    const next: CommentaryPresetId = Object.prototype.hasOwnProperty.call(PRESET_INSTRUCTIONS, preset)
      ? preset as CommentaryPresetId
      : 'auto'
    this.preset = next
    this.emit('preset-changed', this.preset)
  }

  getPreset(): CommentaryPresetId {
    return this.preset
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

    const key = this.sessionKey(event)
    const state = this.ensureSessionState(key)
    state.events.push(event)

    // Hard cap — flush immediately
    if (state.events.length >= MAX_BATCH_SIZE) {
      this.requestFlush(key, true)
      return
    }

    // Reset idle timer on each new event (wait for activity to settle)
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = setTimeout(() => this.requestFlush(key, false), IDLE_TIMEOUT_MS)

    // Start max-wait timer on first event in batch
    if (!state.maxTimer) {
      state.maxTimer = setTimeout(() => this.requestFlush(key, true), MAX_WAIT_MS)
    }
  }

  private sessionKey(event: KibitzEvent): string {
    return `${event.agent}:${event.sessionId}`
  }

  private ensureSessionState(key: string): SessionState {
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        events: [],
        idleTimer: null,
        maxTimer: null,
        recentCommentary: [],
      })
    }
    return this.sessions.get(key)!
  }

  private clearSessionTimers(state: SessionState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer)
      state.idleTimer = null
    }
    if (state.maxTimer) {
      clearTimeout(state.maxTimer)
      state.maxTimer = null
    }
  }

  private requestFlush(key: string, force: boolean): void {
    const state = this.sessions.get(key)
    if (!state) return

    this.clearSessionTimers(state)

    if (state.events.length === 0) return

    // Need minimum events for meaningful commentary unless force-flushing.
    if (!force && state.events.length < MIN_BATCH_SIZE) {
      state.idleTimer = setTimeout(() => this.requestFlush(key, true), IDLE_TIMEOUT_MS)
      return
    }

    this.enqueueFlush(key)
  }

  private enqueueFlush(key: string): void {
    if (this.queuedSessions.has(key)) return
    this.queuedSessions.add(key)
    this.flushQueue.push(key)
    this.processFlushQueue()
  }

  private async processFlushQueue(): Promise<void> {
    if (this.generating) return

    while (this.flushQueue.length > 0) {
      const key = this.flushQueue.shift()!
      this.queuedSessions.delete(key)

      const state = this.sessions.get(key)
      if (!state || state.events.length === 0) continue

      const batch = state.events.splice(0)
      this.generating = true

      try {
        await this.generateCommentary(batch, state)
      } catch (err) {
        this.emit('error', err)
      } finally {
        this.generating = false
      }

      // Events may have arrived while we were generating.
      if (state.events.length > 0) {
        if (state.events.length >= MIN_BATCH_SIZE) {
          this.enqueueFlush(key)
        } else if (!state.idleTimer) {
          state.idleTimer = setTimeout(() => this.requestFlush(key, true), IDLE_TIMEOUT_MS)
        }
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

  private async generateCommentary(events: KibitzEvent[], state: SessionState): Promise<void> {
    if (events.length === 0) return

    const modelConfig = MODELS.find(m => m.id === this.model)
    if (!modelConfig) {
      this.emit('error', new Error(`Unknown model: ${this.model}`))
      return
    }

    const apiKey = ''
    const systemPrompt = this.buildSystemPrompt()
    const userPrompt = this.buildUserPrompt(events, state.recentCommentary)
    const provider = this.providers[modelConfig.provider]
    const latest = events[events.length - 1]

    const entry: CommentaryEntry = {
      timestamp: Date.now(),
      sessionId: latest.sessionId,
      projectName: latest.projectName,
      sessionTitle: latest.sessionTitle,
      agent: latest.agent,
      source: latest.source,
      eventSummary: events.map(e => sanitizePromptText(e.summary)).join(' → '),
      commentary: '',
    }

    this.emit('commentary-start', entry)

    try {
      let streamedRaw = ''
      const full = await provider.generate(
        systemPrompt,
        userPrompt,
        apiKey || '',
        this.model,
        (chunk) => {
          streamedRaw += chunk
        },
      )
      const rawOutput = full || streamedRaw
      entry.commentary = sanitizeGeneratedCommentary(rawOutput)
      if (entry.commentary) {
        this.emit('commentary-chunk', { entry, chunk: entry.commentary })
      }
      this.emit('commentary-done', entry)

      // Track recent commentary per session to avoid repetition.
      state.recentCommentary.push(entry.commentary)
      if (state.recentCommentary.length > 5) {
        state.recentCommentary.shift()
      }
    } catch (err) {
      this.emit('error', err)
    }
  }

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT

    // Add random format template
    prompt += `\n\nFormat for this message:\n${this.pickFormat()}`

    if (this.preset !== 'auto') {
      prompt += `\n\nTone preset:\n${PRESET_INSTRUCTIONS[this.preset]}`
    }

    if (this.userFocus.trim()) {
      prompt += `\n\nAdditional user instruction: ${this.userFocus}`
    }
    return prompt
  }

  private buildUserPrompt(events: KibitzEvent[], recentCommentary: string[]): string {
    const latest = events[events.length - 1]
    const lines = events.map(e => `  ${e.type}: ${sanitizePromptText(e.summary)}`)
    let prompt = `Session: ${latest.agent}/${latest.projectName}\n`
    prompt += `Actions (${events.length}):\n${lines.join('\n')}`

    // Include recent commentary so the LLM doesn't repeat itself
    if (recentCommentary.length > 0) {
      prompt += `\n\nPrevious commentary (don't repeat):\n`
      prompt += recentCommentary
        .slice(-3)
        .map(c => `- ${sanitizePromptText(c).slice(0, 80)}...`)
        .join('\n')
    }

    prompt += `\n\nSummarize only this session's actions. Plain language, with your reaction.`
    prompt += `\nNever mention IDs/logs/prompts/traces or internal data-collection steps.`
    prompt += `\nNever say "I", "I'll", "we", or any future plan.`

    return prompt
  }
}

function redactSessionIdentifiers(text: string): string {
  let out = text
  for (const pattern of SESSION_ID_PATTERNS) {
    out = out.replace(pattern, '[session]')
  }
  return out
}

function sanitizePromptText(text: string): string {
  return redactSessionIdentifiers(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeGeneratedCommentary(text: string): string {
  let out = redactSessionIdentifiers(String(text || ''))
  out = out.replace(/\blocal session logs?\b/gi, 'recent actions')
  out = out.replace(/\bsession logs?\b/gi, 'actions')
  out = out.replace(/\bsession id\b/gi, 'session')

  const blockedLine = /\b(i['’]?ll|i will|we(?:'ll| will)?)\b.*\b(pull|fetch|read|inspect|scan|parse|load|check)\b.*\b(session|log|trace|jsonl|prompt|history)\b/i
  const keptLines = out.split('\n').filter(line => !blockedLine.test(line.trim()))
  out = keptLines.join('\n').trim()

  if (!out) {
    return 'Agent completed actions in this session.'
  }
  return out
}
