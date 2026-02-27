import { EventEmitter } from 'events'
import {
  COMMENTARY_STYLE_OPTIONS,
  CommentaryStyleId,
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
- UPPER CASE short reactions when it helps: GREAT FIND, NICE MOVE, RISK ALERT, SOLID CHECK, WATCH OUT.
- Vary judgment wording across messages; avoid repeating one catchphrase.
- Always judge execution direction using the session goal + concrete actions in this batch.
- Close with a sentence that captures the current direction and momentum of the work.
- Emoji are allowed when they add meaning (max 2 per commentary).
- No filler. No "methodical", "surgical", "disciplined", "clean work". Facts and reactions only.
- Don't repeat what previous commentary already said.
- Never mention session IDs, logs, traces, prompts, JSONL files, or internal tooling.
- Never write in first person ("I", "I'll", "we") or future tense plans.`

// Format templates — one is selected per commentary from the enabled style set.
const FORMAT_TEMPLATES: Record<CommentaryStyleId, string> = {
  bullets: `Use bullet points. Each bullet = one thing done or one observation.
Close with a sentence on direction and momentum.
Example:
- Researched how the feature works
- Rewrote the page with new layout
- Shipped without **tests** — RISKY
- Checked for errors before pushing`,

  'one-liner': `Write a single sentence. Punchy, complete, under 20 words.
One closing sentence on where this is headed.
Example: Agent investigated the bug, found the root cause, and fixed it — NICE WORK.
Example: Still reading code after 30 actions — hasn't changed anything yet.`,

  'headline-context': `Start with a short UPPER CASE reaction (2-4 words), then one sentence of context.
Close with a read on momentum.
Example:
SOLID APPROACH. Agent read the dependencies first, then made targeted changes across three files.
Example:
NOT GREAT. Pushed to **production** without running any tests — hope nothing breaks.`,

  'numbered-progress': `Use numbered steps showing what the agent did in order. Finish with a momentum line.
Example:
1. Read the existing code
2. Made changes to the login flow
3. Tested locally
4. Pushed to **production**
Proper process, nothing to flag.`,

  'short-question': `Summarize in one sentence, then ask a pointed rhetorical question.
End with a one-sentence read on direction.
Example:
Agent rewrote the entire settings page and shipped it immediately. Did they test this at all?
Example:
Third time reading the same code. Lost, or just being thorough?`,

  table: `Use a compact markdown table with columns: Action | Why it mattered.
Include 3-5 rows max, then one sentence on momentum.
Example:
| Action | Why it mattered |
| --- | --- |
| Ran tests | Verified changes before shipping |
| Skipped lint | Could hide style regressions |
Mostly careful, one loose end.`,

  'emoji-bullets': `Use bullet points with emoji tags to signal risk/quality.
Use only these tags: ✅, ⚠️, 🔥, ❄️.
Close with a direction sentence.
Example:
- ✅ Fixed the failing migration script
- ⚠️ Pushed without rerunning integration tests
- 🔥 Found the root cause in auth token parsing`,

  scoreboard: `Use a scoreboard format with these labels:
Wins:
Risks:
Next:
Each label should have 1-3 short bullets, then one line on where things stand.`,
}

const DEFAULT_FORMAT_STYLE_IDS: CommentaryStyleId[] = COMMENTARY_STYLE_OPTIONS.map((option) => option.id)

const PRESET_INSTRUCTIONS = {
  auto: '',
  'critical-coder': 'Be a VERY CRITICAL coder using code terminology. Call out architectural or process flaws directly and sharply.',
  'precise-short': 'Be precise and short. Keep the output compact and information-dense with minimal words.',
  emotional: 'Be emotional and expressive. React strongly to good or risky behavior while staying factual.',
  newbie: 'Explain for non-developers. Avoid jargon or explain it in plain words with simple cause/effect.',
} as const

type CommentaryPresetId = keyof typeof PRESET_INSTRUCTIONS

function normalizeFormatStyles(styleIds: readonly string[]): CommentaryStyleId[] {
  const requested = new Set(styleIds.map((styleId) => String(styleId || '').trim()))
  const normalized = COMMENTARY_STYLE_OPTIONS
    .map((option) => option.id)
    .filter((styleId) => requested.has(styleId))
  return normalized.length > 0 ? normalized : DEFAULT_FORMAT_STYLE_IDS.slice()
}

function sameFormatStyles(a: readonly CommentaryStyleId[], b: readonly CommentaryStyleId[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

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

type DirectionState = 'on-track' | 'drifting' | 'blocked'
type ConfidenceState = 'high' | 'medium' | 'low'
type SecurityState = 'clean' | 'watch' | 'alert'

interface SecurityRule {
  severity: 'high' | 'medium'
  signal: string
  pattern: RegExp
}

export interface SecurityFinding {
  severity: 'high' | 'medium'
  signal: string
  evidence: string
}

export interface CommentaryAssessment {
  direction: DirectionState
  confidence: ConfidenceState
  security: SecurityState
  activitySummary: string
  progressSignals: string[]
  driftSignals: string[]
  securityFindings: SecurityFinding[]
}

const TEST_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|test:[\w:-]+)\b/i,
  /\b(?:jest|vitest|mocha|ava|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle(?:w)?\s+test|rspec|phpunit)\b/i,
]

const DEPLOY_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:deploy|release|publish)\b/i,
  /\b(?:kubectl\s+apply|helm\s+upgrade|terraform\s+apply|serverless\s+deploy|vercel\s+--prod|netlify\s+deploy|fly\s+deploy)\b/i,
]

const ERROR_SIGNAL_PATTERN = /\b(?:error|failed|failure|exception|traceback|panic|denied|timeout|cannot|can't|unable)\b/i

const SECURITY_COMMAND_RULES: SecurityRule[] = [
  {
    severity: 'high',
    signal: 'Remote script piped directly into a shell',
    pattern: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:bash|sh|zsh|pwsh|powershell)\b/i,
  },
  {
    severity: 'high',
    signal: 'TLS verification explicitly disabled',
    pattern: /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b/i,
  },
  {
    severity: 'high',
    signal: 'Destructive root-level delete command',
    pattern: /\brm\s+-rf\s+\/(?:\s|$)/i,
  },
  {
    severity: 'medium',
    signal: 'Insecure transport flag used in command',
    pattern: /\bcurl\b[^\n]*\s(?:--insecure|-k)\b/i,
  },
  {
    severity: 'medium',
    signal: 'Git hooks bypassed with --no-verify',
    pattern: /\bgit\b[^\n]*\s--no-verify\b/i,
  },
  {
    severity: 'medium',
    signal: 'SSH host key verification disabled',
    pattern: /\bStrictHostKeyChecking\s*=\s*no\b/i,
  },
  {
    severity: 'medium',
    signal: 'Overly broad file permissions (chmod 777)',
    pattern: /\bchmod\s+777\b/i,
  },
  {
    severity: 'medium',
    signal: 'Potential secret exposed in command arguments',
    pattern: /\b(?:api[_-]?key|token|password)\s*=\s*\S+/i,
  },
]

const SECURITY_PATH_RULES: SecurityRule[] = [
  {
    severity: 'medium',
    signal: 'Secret-related file touched',
    pattern: /(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|id_rsa|id_dsa|authorized_keys|known_hosts|credentials?|secrets?)(?:$|[\\/])/i,
  },
  {
    severity: 'medium',
    signal: 'Sensitive key/cert file touched',
    pattern: /\.(?:pem|key|p12|pfx)$/i,
  },
]

const JUDGMENT_PHRASES = [
  'NOT IDEAL',
  'NOT GREAT',
  'WATCH OUT',
  'RISK ALERT',
  'GREAT FIND',
  'NICE MOVE',
  'SOLID CHECK',
]

function getDetailValue(details: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = details[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function extractCommand(event: KibitzEvent): string {
  if (event.type !== 'tool_call') return ''
  const details = event.details || {}
  const input = typeof details.input === 'object' && details.input
    ? details.input as Record<string, unknown>
    : {}
  const direct = getDetailValue(details as Record<string, unknown>, 'command', 'cmd')
  if (direct) return direct
  return getDetailValue(input, 'command', 'cmd')
}

function extractTouchedPath(event: KibitzEvent): string {
  if (event.type !== 'tool_call') return ''
  const details = event.details || {}
  const input = typeof details.input === 'object' && details.input
    ? details.input as Record<string, unknown>
    : {}
  const direct = getDetailValue(details as Record<string, unknown>, 'path', 'file_path')
  if (direct) return direct
  return getDetailValue(input, 'path', 'file_path')
}

function extractToolName(event: KibitzEvent): string {
  const details = event.details || {}
  const value = details.tool
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function pushUnique(list: string[], value: string, maxItems = 4): void {
  const normalized = sanitizePromptText(value)
  if (!normalized) return
  if (list.includes(normalized)) return
  if (list.length < maxItems) list.push(normalized)
}

function pushSecurityFinding(findings: SecurityFinding[], finding: SecurityFinding): void {
  const key = `${finding.severity}:${finding.signal}:${finding.evidence}`
  const exists = findings.some((item) => `${item.severity}:${item.signal}:${item.evidence}` === key)
  if (!exists) findings.push(finding)
}

function detectSecurityFindings(findings: SecurityFinding[], sourceText: string, rules: SecurityRule[]): void {
  const evidence = sanitizePromptText(sourceText).slice(0, 140)
  if (!evidence) return
  for (const rule of rules) {
    if (!rule.pattern.test(sourceText)) continue
    pushSecurityFinding(findings, {
      severity: rule.severity,
      signal: rule.signal,
      evidence,
    })
  }
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function summarizeActivity(
  reads: number,
  writes: number,
  searches: number,
  commands: number,
  tests: number,
  errors: number,
): string {
  return `reads=${reads}, writes=${writes}, searches=${searches}, commands=${commands}, tests=${tests}, errors=${errors}`
}

function summarizeClosingEvidence(assessment: CommentaryAssessment): string {
  if (assessment.progressSignals.length > 0) return assessment.progressSignals[0]
  if (assessment.driftSignals.length > 0) return assessment.driftSignals[0]
  return assessment.activitySummary
}

function createClosingLine(assessment: CommentaryAssessment): string {
  const evidence = summarizeClosingEvidence(assessment)
  const dir = assessment.direction === 'on-track' ? 'on track' : assessment.direction
  const sec = assessment.security !== 'clean' ? ` Security is ${assessment.security}.` : ''
  return `${evidence} — looks ${dir} with ${assessment.confidence} confidence.${sec}`
}

function extractRecentlyUsedJudgments(recentCommentary: string[]): string[] {
  const found = new Set<string>()
  for (const text of recentCommentary.slice(-5)) {
    const upper = String(text || '').toUpperCase()
    for (const phrase of JUDGMENT_PHRASES) {
      if (upper.includes(phrase)) found.add(phrase)
    }
  }
  return Array.from(found).slice(0, 4)
}

export function buildCommentaryAssessment(events: KibitzEvent[], sessionTitle?: string): CommentaryAssessment {
  let reads = 0
  let writes = 0
  let searches = 0
  let commands = 0
  let tests = 0
  let deploys = 0
  let errors = 0
  const touchedFiles: string[] = []
  const progressSignals: string[] = []
  const driftSignals: string[] = []
  const securityFindings: SecurityFinding[] = []

  for (const event of events) {
    const summary = sanitizePromptText(event.summary)
    const summaryLower = summary.toLowerCase()
    const toolName = extractToolName(event)
    const command = extractCommand(event)
    const touchedPath = extractTouchedPath(event)

    if (event.type === 'tool_call') {
      if (summaryLower.startsWith('reading ') || toolName.includes('read')) reads += 1
      if (
        summaryLower.startsWith('writing ')
        || summaryLower.startsWith('editing ')
        || toolName.includes('write')
        || toolName.includes('edit')
        || toolName.includes('apply_diff')
      ) {
        writes += 1
      }
      if (
        summaryLower.startsWith('searching ')
        || summaryLower.startsWith('finding files')
        || toolName.includes('grep')
        || toolName.includes('glob')
      ) {
        searches += 1
      }
      if (command) {
        commands += 1
        if (hasPattern(command, TEST_COMMAND_PATTERNS)) tests += 1
        if (hasPattern(command, DEPLOY_COMMAND_PATTERNS)) deploys += 1
        detectSecurityFindings(securityFindings, command, SECURITY_COMMAND_RULES)
      }
      if (touchedPath) {
        pushUnique(touchedFiles, touchedPath, 3)
        detectSecurityFindings(securityFindings, touchedPath, SECURITY_PATH_RULES)
      }
    }

    const output = typeof event.details?.output === 'string' ? event.details.output : ''
    const combinedText = `${summary}\n${output}`
    if ((event.type === 'message' || event.type === 'tool_result') && ERROR_SIGNAL_PATTERN.test(combinedText)) {
      errors += 1
    }
  }

  if (writes > 0) pushUnique(progressSignals, `${writes} write/edit actions executed`)
  if (tests > 0) pushUnique(progressSignals, `${tests} test commands detected`)
  if (deploys > 0) pushUnique(progressSignals, `${deploys} deploy/release commands detected`)
  if (touchedFiles.length > 0) pushUnique(progressSignals, `touched files: ${touchedFiles.join(', ')}`)

  if (reads >= 4 && writes === 0) pushUnique(driftSignals, `${reads} reads with no code edits`)
  if (commands >= 6 && writes === 0 && tests === 0) {
    pushUnique(driftSignals, `${commands} commands executed without visible code/test progress`)
  }
  if (errors >= 2) pushUnique(driftSignals, `${errors} error/failure signals seen in outputs`)
  if (deploys > 0 && tests === 0) pushUnique(driftSignals, 'deploy/release command seen without test evidence')
  if (progressSignals.length === 0 && events.length >= 3) {
    pushUnique(driftSignals, 'no concrete progress signal captured in this batch')
  }

  let direction: DirectionState = 'on-track'
  if (errors >= 3 && writes === 0 && tests === 0) {
    direction = 'blocked'
  } else if (driftSignals.length > 0 && writes === 0 && tests === 0) {
    direction = 'drifting'
  } else if (progressSignals.length === 0) {
    direction = 'drifting'
  }

  const evidenceScore = writes + tests + deploys + (errors > 0 ? 1 : 0)
  const confidence: ConfidenceState = events.length >= 8 || evidenceScore >= 3
    ? 'high'
    : events.length >= 4 || evidenceScore >= 1
      ? 'medium'
      : 'low'

  const security: SecurityState = securityFindings.some((finding) => finding.severity === 'high')
    ? 'alert'
    : securityFindings.length > 0
      ? 'watch'
      : 'clean'

  if (sessionTitle) {
    pushUnique(progressSignals, `session goal/title: ${sessionTitle}`, 5)
  }

  return {
    direction,
    confidence,
    security,
    activitySummary: summarizeActivity(reads, writes, searches, commands, tests, errors),
    progressSignals,
    driftSignals,
    securityFindings: securityFindings.slice(0, 3),
  }
}

export function applyAssessmentSignals(commentary: string, assessment: CommentaryAssessment): string {
  let out = String(commentary || '').trim()
  if (!out) {
    out = 'Agent completed actions in this session.'
  }

  const hasSecuritySignal = /\bsecurity\b|\bsecurity alert\b|\bsecurity watch\b/i.test(out)
  if (!hasSecuritySignal && assessment.security !== 'clean') {
    const top = assessment.securityFindings[0]
    const label = assessment.security === 'alert' ? 'SECURITY ALERT' : 'SECURITY WATCH'
    const reason = top ? `${top.signal} (${top.evidence})` : 'Risky behavior detected in this batch.'
    out = `${label}: ${reason}\n${out}`
  }

  const hasClosingLine = /\bverdict\b|\bon.?track\b|\bdrifting\b|\bblocked\b|\bmomentum\b/i.test(out)
  if (!hasClosingLine) {
    out = `${out}\n${createClosingLine(assessment)}`
  }
  return out
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
  private enabledFormatStyleIds: CommentaryStyleId[] = DEFAULT_FORMAT_STYLE_IDS.slice()
  private lastFormatStyleId: CommentaryStyleId | null = null

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

  setFormatStyles(styleIds: string[]): void {
    const next = normalizeFormatStyles(Array.isArray(styleIds) ? styleIds : [])
    if (sameFormatStyles(next, this.enabledFormatStyleIds)) return
    this.enabledFormatStyleIds = next
    if (this.lastFormatStyleId && !this.enabledFormatStyleIds.includes(this.lastFormatStyleId)) {
      this.lastFormatStyleId = null
    }
    this.emit('format-styles-changed', this.enabledFormatStyleIds.slice())
  }

  getFormatStyles(): CommentaryStyleId[] {
    return this.enabledFormatStyleIds.slice()
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
    const enabled = this.enabledFormatStyleIds.length > 0
      ? this.enabledFormatStyleIds
      : DEFAULT_FORMAT_STYLE_IDS

    const pool = this.lastFormatStyleId && enabled.length > 1
      ? enabled.filter((styleId) => styleId !== this.lastFormatStyleId)
      : enabled

    const pickedStyleId = pool[Math.floor(Math.random() * pool.length)]
    this.lastFormatStyleId = pickedStyleId
    return FORMAT_TEMPLATES[pickedStyleId]
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
    const latest = events[events.length - 1]
    const assessment = buildCommentaryAssessment(events, latest.sessionTitle)
    const userPrompt = this.buildUserPrompt(events, state.recentCommentary, assessment)
    const provider = this.providers[modelConfig.provider]

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
      entry.commentary = applyAssessmentSignals(
        sanitizeGeneratedCommentary(rawOutput),
        assessment,
      )
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
      entry.commentary = 'Commentary unavailable right now.'
      this.emit('commentary-chunk', { entry, chunk: entry.commentary })
      this.emit('commentary-done', entry)
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

  private buildUserPrompt(
    events: KibitzEvent[],
    recentCommentary: string[],
    assessment: CommentaryAssessment,
  ): string {
    const latest = events[events.length - 1]
    const lines = events.map(e => `  ${e.type}: ${sanitizePromptText(e.summary)}`)
    let prompt = `Session: ${latest.agent}/${latest.projectName}\n`
    if (latest.sessionTitle) {
      prompt += `Session title: ${sanitizePromptText(latest.sessionTitle)}\n`
    }
    prompt += `Actions (${events.length}):\n${lines.join('\n')}`

    prompt += `\n\nDirection context:\n`
    prompt += `- Activity snapshot: ${assessment.activitySummary}\n`
    if (assessment.progressSignals.length > 0) {
      prompt += `- Progress signals: ${assessment.progressSignals.join(' | ')}\n`
    }
    if (assessment.driftSignals.length > 0) {
      prompt += `- Drift/block signals: ${assessment.driftSignals.join(' | ')}\n`
    }
    prompt += `- Initial direction estimate from raw signals: ${assessment.direction} (${assessment.confidence} confidence)\n`

    prompt += `\nSecurity auto-check:\n`
    prompt += `- Security state: ${assessment.security}\n`
    if (assessment.securityFindings.length > 0) {
      prompt += assessment.securityFindings
        .map((finding) => `- ${finding.severity.toUpperCase()}: ${finding.signal} (${finding.evidence})`)
        .join('\n')
      prompt += '\n'
    } else {
      prompt += `- No explicit security flags in this batch.\n`
    }

    // Include recent commentary so the LLM doesn't repeat itself
    if (recentCommentary.length > 0) {
      prompt += `\n\nPrevious commentary (don't repeat):\n`
      prompt += recentCommentary
        .slice(-3)
        .map(c => `- ${sanitizePromptText(c).slice(0, 80)}...`)
        .join('\n')
      prompt += `\nUse different judgment wording than these previous lines.`
    }
    const recentlyUsed = extractRecentlyUsedJudgments(recentCommentary)
    if (recentlyUsed.length > 0) {
      prompt += `\nAvoid reusing these reaction phrases: ${recentlyUsed.join(', ')}.`
    }

    prompt += `\n\nSummarize only this session's actions. Plain language, with your reaction.`
    prompt += `\nClose with one sentence about direction and momentum — weave in confidence and security naturally.`
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
