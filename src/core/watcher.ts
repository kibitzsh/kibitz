import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'
import { KibitzEvent, SessionInfo } from './types'
import { parseClaudeLine } from './parsers/claude'
import { parseCodexLine } from './parsers/codex'

interface WatchedFile {
  filePath: string
  sessionId: string
  offset: number
  agent: 'claude' | 'codex'
  ignore: boolean
  watcher: fs.FSWatcher | null
  projectName: string
  sessionTitle?: string
}

export class SessionWatcher extends EventEmitter {
  private watched = new Map<string, WatchedFile>()
  private scanInterval: ReturnType<typeof setInterval> | null = null
  private claudeIdeLocks = new Map<string, { pid: number; workspaceFolders: string[] }>()
  private sessionProjectNames = new Map<string, string>() // sessionId → projectName from meta
  private static readonly ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000

  constructor() {
    super()
  }

  start(): void {
    this.scan()
    this.scanInterval = setInterval(() => this.scan(), 15_000)
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    for (const w of this.watched.values()) {
      w.watcher?.close()
    }
    this.watched.clear()
  }

  getActiveSessions(): SessionInfo[] {
    const now = Date.now()
    const sessionsByKey = new Map<string, SessionInfo>()
    for (const w of this.watched.values()) {
      if (w.ignore) continue
      this.reconcileCodexSessionTitle(w)
      try {
        const stat = fs.statSync(w.filePath)
        if (now - stat.mtimeMs > SessionWatcher.ACTIVE_SESSION_WINDOW_MS) continue
        const session: SessionInfo = {
          id: w.sessionId,
          projectName: w.projectName,
          sessionTitle: w.sessionTitle,
          agent: w.agent,
          source: this.detectSource(w),
          filePath: w.filePath,
          lastActivity: stat.mtimeMs,
        }
        const key = `${session.agent}:${session.id.toLowerCase()}`
        const existing = sessionsByKey.get(key)
        if (!existing || existing.lastActivity < session.lastActivity) {
          sessionsByKey.set(key, session)
        }
      } catch { /* file gone */ }
    }
    return Array.from(sessionsByKey.values()).sort((a, b) => b.lastActivity - a.lastActivity)
  }

  private scan(): void {
    this.loadIdeLocks()
    this.scanClaude()
    this.scanCodex()
    this.pruneStale()
  }

  private scanClaude(): void {
    const claudeDir = path.join(os.homedir(), '.claude', 'projects')
    if (!fs.existsSync(claudeDir)) return

    let projectDirs: string[]
    try {
      projectDirs = fs.readdirSync(claudeDir).filter(d => {
        const full = path.join(claudeDir, d)
        try { return fs.statSync(full).isDirectory() } catch { return false }
      })
    } catch { return }

    const now = Date.now()
    for (const dir of projectDirs) {
      const dirPath = path.join(claudeDir, dir)
      let files: string[]
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
      } catch { continue }

      for (const file of files) {
        const filePath = path.join(dirPath, file)
        try {
          const stat = fs.statSync(filePath)
          if (now - stat.mtimeMs > SessionWatcher.ACTIVE_SESSION_WINDOW_MS) continue // skip stale
        } catch { continue }

        if (!this.watched.has(filePath)) {
          const projectName = extractProjectName(dir)
          this.watchFile(filePath, 'claude', projectName)
        }
      }
    }
  }

  private scanCodex(): void {
    const currentTime = Date.now()
    for (const sessionsDir of codexSessionDirs(2)) {
      if (!fs.existsSync(sessionsDir)) continue

      let files: string[]
      try {
        files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      for (const file of files) {
        const filePath = path.join(sessionsDir, file)
        try {
          const stat = fs.statSync(filePath)
          if (currentTime - stat.mtimeMs > SessionWatcher.ACTIVE_SESSION_WINDOW_MS) continue
        } catch {
          continue
        }

        if (!this.watched.has(filePath)) {
          this.watchFile(filePath, 'codex', 'codex')
        }
      }
    }
  }

  private watchFile(filePath: string, agent: 'claude' | 'codex', projectName: string): void {
    let offset: number
    try {
      const stat = fs.statSync(filePath)
      offset = stat.size // start from current end, only read new content
    } catch { return }

    let resolvedProjectName = projectName
    if (agent === 'codex') {
      const codexProject = extractCodexProjectName(filePath)
      if (codexProject) resolvedProjectName = codexProject
    }

    const sessionId = extractSessionIdFromLog(
      filePath,
      agent,
      deriveSessionId(filePath, agent),
    )
    const ignore = (agent === 'codex' && isKibitzInternalCodexSession(filePath))
      || (agent === 'claude' && isKibitzInternalClaudeSession(filePath))
    const sessionTitle = extractSessionTitle(filePath, agent, sessionId)
    const entry: WatchedFile = {
      filePath,
      sessionId,
      offset,
      agent,
      ignore,
      watcher: null,
      projectName: resolvedProjectName,
      sessionTitle,
    }

    try {
      entry.watcher = fs.watch(filePath, () => {
        this.readNewLines(entry)
      })
    } catch {
      // fs.watch failed, fall back to polling via scan interval
    }

    this.watched.set(filePath, entry)
  }

  private readNewLines(entry: WatchedFile): void {
    if (entry.ignore) {
      try {
        const stat = fs.statSync(entry.filePath)
        entry.offset = stat.size
      } catch { /* file gone */ }
      return
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(entry.filePath)
    } catch { return }

    this.reconcileCodexSessionTitle(entry)
    if (stat.size <= entry.offset) return

    const fd = fs.openSync(entry.filePath, 'r')
    const buf = Buffer.alloc(stat.size - entry.offset)
    fs.readSync(fd, buf, 0, buf.length, entry.offset)
    fs.closeSync(fd)
    entry.offset = stat.size

    const chunk = buf.toString('utf8')
    const lines = chunk.split('\n').filter(l => l.trim())

    for (const line of lines) {
      if (entry.agent === 'codex' && isKibitzInternalCodexLine(line)) {
        entry.ignore = true
        break
      }

      if (!entry.sessionTitle) {
        if (entry.agent === 'codex') {
          const title = extractCodexSessionTitle(entry.filePath, entry.sessionId)
          if (title) entry.sessionTitle = title
        }
      }
      if (!entry.sessionTitle) {
        const title = extractSessionTitleFromLine(line, entry.agent)
        if (title) entry.sessionTitle = title
      }

      let events: KibitzEvent[]
      if (entry.agent === 'claude') {
        events = parseClaudeLine(line, entry.filePath)
      } else {
        events = parseCodexLine(line, entry.filePath)
      }

      for (const event of events) {
        const normalizedEventSessionId = normalizeSessionId(event.sessionId, entry.agent)
        if (normalizedEventSessionId && normalizedEventSessionId !== entry.sessionId) {
          entry.sessionId = normalizedEventSessionId
        }
        event.sessionId = entry.sessionId

        // Override source detection
        event.source = this.detectSource(entry)
        event.sessionTitle = entry.sessionTitle || fallbackSessionTitle(entry.projectName, entry.agent)

        // Update project name from meta events
        if (event.type === 'meta' && event.details.cwd) {
          const cwd = String(event.details.cwd)
          const name = cwd.split('/').pop() || cwd.split('\\').pop() || 'unknown'
          this.sessionProjectNames.set(event.sessionId, name)
          entry.projectName = name
          event.projectName = name
        } else if (this.sessionProjectNames.has(event.sessionId)) {
          event.projectName = this.sessionProjectNames.get(event.sessionId)!
          entry.projectName = event.projectName
        }

        this.emit('event', event)
      }
    }
  }

  private reconcileCodexSessionTitle(entry: WatchedFile): void {
    if (entry.agent !== 'codex') return

    const threadTitle = getCodexThreadTitle(entry.sessionId)
    if (threadTitle) {
      if (threadTitle !== entry.sessionTitle) entry.sessionTitle = threadTitle
      return
    }

    // Avoid persisting prompt/instruction text as a session label when no thread title exists.
    if (entry.sessionTitle && isNoiseSessionTitle(entry.sessionTitle)) {
      entry.sessionTitle = undefined
    }
  }

  private loadIdeLocks(): void {
    const ideDir = path.join(os.homedir(), '.claude', 'ide')
    if (!fs.existsSync(ideDir)) return

    this.claudeIdeLocks.clear()
    try {
      const files = fs.readdirSync(ideDir).filter(f => f.endsWith('.lock'))
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(ideDir, file), 'utf8')
          const lock = JSON.parse(content)
          this.claudeIdeLocks.set(file, {
            pid: lock.pid,
            workspaceFolders: lock.workspaceFolders || [],
          })
        } catch { /* corrupt lock */ }
      }
    } catch { /* can't read ide dir */ }
  }

  private detectSource(entry: WatchedFile): 'vscode' | 'cli' {
    if (entry.agent === 'codex') return 'cli'
    // If there are IDE lock files, assume VS Code sessions
    return this.claudeIdeLocks.size > 0 ? 'vscode' : 'cli'
  }

  private pruneStale(): void {
    const now = Date.now()
    for (const [filePath, entry] of this.watched) {
      try {
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > SessionWatcher.ACTIVE_SESSION_WINDOW_MS) {
          entry.watcher?.close()
          this.watched.delete(filePath)
        }
      } catch {
        entry.watcher?.close()
        this.watched.delete(filePath)
      }
    }
  }
}

function extractSessionTitle(
  filePath: string,
  agent: 'claude' | 'codex',
  sessionId?: string,
): string | undefined {
  return agent === 'claude'
    ? extractClaudeSessionTitle(filePath)
    : extractCodexSessionTitle(filePath, sessionId)
}

function extractSessionTitleFromLine(line: string, agent: 'claude' | 'codex'): string | undefined {
  try {
    const obj: any = JSON.parse(line)
    if (agent === 'claude') {
      if (obj.type !== 'user') return undefined
      const content = obj.message?.content
      if (typeof content === 'string') return pickSessionTitle(content)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string') {
            const title = pickSessionTitle(block.text)
            if (title) return title
          }
        }
      }
      return undefined
    }

    if (obj.type === 'session_meta') {
      const explicitTitle = pickSessionTitle(String(
        obj.payload?.title
        || obj.payload?.session_title
        || obj.payload?.name
        || obj.payload?.summary
        || '',
      ))
      if (explicitTitle) return explicitTitle
    }

    if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
      return pickSessionTitle(String(obj.payload.message || ''))
    }

    if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
      const contentBlocks = obj.payload.content
      if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          const text = typeof block?.text === 'string'
            ? block.text
            : typeof block?.input_text === 'string'
              ? block.input_text
              : ''
          const title = pickSessionTitle(text)
          if (title) return title
        }
      }
    }
  } catch { /* ignore malformed lines */ }
  return undefined
}

function extractClaudeSessionTitle(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user') {
          const msg = obj.message
          if (!msg) continue
          const content = msg.content
          if (typeof content === 'string' && content.trim()) {
            const title = pickSessionTitle(content)
            if (title) return title
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                const title = pickSessionTitle(block.text)
                if (title) return title
              }
            }
          }
        }
      } catch { /* skip bad lines */ }
    }
  } catch { /* unreadable */ }
  return undefined
}

function extractCodexSessionTitle(filePath: string, sessionId?: string): string | undefined {
  const codexSessionId = sessionId || deriveSessionId(filePath, 'codex')
  const explicitThreadTitle = getCodexThreadTitle(codexSessionId)
  if (explicitThreadTitle) return explicitThreadTitle

  const logDerivedTitle = extractCodexSessionTitleFromLog(filePath)
  return logDerivedTitle || undefined
}

function getCodexThreadTitle(sessionId?: string): string | undefined {
  const normalizedSessionId = String(sessionId || '').trim().toLowerCase()
  if (!normalizedSessionId) return undefined
  return readCodexThreadTitles().titles.get(normalizedSessionId)
}

function extractCodexSessionTitleFromLog(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8')

    // Some logs expose a first-class title in session metadata.
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj: any = JSON.parse(line)
        if (obj.type !== 'session_meta') continue
        const explicitTitle = pickSessionTitle(String(
          obj.payload?.title
          || obj.payload?.session_title
          || obj.payload?.name
          || obj.payload?.summary
          || '',
        ))
        if (explicitTitle) return explicitTitle
      } catch { /* skip bad lines */ }
    }

    // Do not derive Codex titles from raw user prompts. Prompt text leaks into labels.
  } catch { /* unreadable */ }
  return undefined
}

function extractCodexProjectName(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj: any = JSON.parse(line)
        if (obj.type !== 'session_meta') continue
        const cwd = typeof obj.payload?.cwd === 'string' ? obj.payload.cwd : ''
        if (!cwd) continue
        const name = cwd.split('/').pop() || cwd.split('\\').pop()
        if (name && name.trim()) return name.trim()
      } catch { /* skip bad lines */ }
    }
  } catch { /* unreadable */ }
  return undefined
}

function isKibitzInternalCodexSession(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')
    const maxProbeLines = 50
    for (let i = 0; i < lines.length && i < maxProbeLines; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const obj: any = JSON.parse(line)
        if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
          const msg = String(obj.payload?.message || '').toLowerCase()
          if (looksLikeKibitzGeneratedPrompt(msg)) return true
        }
        if (obj.type === 'response_item'
          && obj.payload?.type === 'message'
          && obj.payload?.role === 'user'
          && Array.isArray(obj.payload?.content)) {
          for (const block of obj.payload.content) {
            const text = typeof block?.text === 'string'
              ? block.text
              : typeof block?.input_text === 'string'
                ? block.input_text
                : ''
            if (looksLikeKibitzGeneratedPrompt(String(text).toLowerCase())) return true
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // unreadable session file
  }
  return false
}

function isKibitzInternalCodexLine(line: string): boolean {
  try {
    const obj: any = JSON.parse(line)
    if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
      const msg = String(obj.payload?.message || '').toLowerCase()
      return looksLikeKibitzGeneratedPrompt(msg)
    }
    if (obj.type === 'response_item'
      && obj.payload?.type === 'message'
      && obj.payload?.role === 'user'
      && Array.isArray(obj.payload?.content)) {
      for (const block of obj.payload.content) {
        const text = typeof block?.text === 'string'
          ? block.text
          : typeof block?.input_text === 'string'
            ? block.input_text
            : ''
        if (looksLikeKibitzGeneratedPrompt(String(text).toLowerCase())) return true
      }
    }
  } catch {
    // ignore malformed lines
  }
  return false
}

function looksLikeKibitzGeneratedPrompt(text: string): boolean {
  if (!text) return false
  // tone preset: is absent when preset=auto (the default), so don't require it
  return text.includes('you oversee ai coding agents. summarize what they did')
    && text.includes('format for this message:')
}

function isKibitzInternalClaudeSession(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && i < 20; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const obj: any = JSON.parse(line)
        if (obj.type !== 'user') continue
        const msg = obj.message
        const c = msg?.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          for (const block of c) {
            if (block.type === 'text') { text = block.text; break }
          }
        }
        if (text) return looksLikeKibitzGeneratedPrompt(text.toLowerCase())
        break
      } catch { /* ignore malformed */ }
    }
  } catch { /* unreadable */ }
  return false
}

interface CodexThreadTitlesSnapshot {
  mtimeMs: number
  titles: Map<string, string>
  order: string[]
}

const codexThreadTitlesCache: CodexThreadTitlesSnapshot = {
  mtimeMs: -1,
  titles: new Map<string, string>(),
  order: [],
}

function readCodexThreadTitles(): CodexThreadTitlesSnapshot {
  const statePath = path.join(os.homedir(), '.codex', '.codex-global-state.json')
  try {
    const stat = fs.statSync(statePath)
    if (stat.mtimeMs === codexThreadTitlesCache.mtimeMs) return codexThreadTitlesCache

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const rawTitles = raw?.['thread-titles']?.titles
    const rawOrder = raw?.['thread-titles']?.order

    const titles = new Map<string, string>()
    if (rawTitles && typeof rawTitles === 'object' && !Array.isArray(rawTitles)) {
      for (const [key, value] of Object.entries(rawTitles)) {
        const sessionId = String(key || '').trim().toLowerCase()
        if (!sessionId) continue
        const title = pickSessionTitle(String(value || ''))
        if (title) titles.set(sessionId, title)
      }
    }

    const order = Array.isArray(rawOrder)
      ? rawOrder
        .map((item: unknown) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
      : []

    codexThreadTitlesCache.mtimeMs = stat.mtimeMs
    codexThreadTitlesCache.titles = titles
    codexThreadTitlesCache.order = order
  } catch {
    // Keep the last successful cache. If no cache exists, this remains empty.
  }

  return codexThreadTitlesCache
}

function deriveSessionId(filePath: string, agent: 'claude' | 'codex'): string {
  const basename = path.basename(filePath, '.jsonl')
  if (agent !== 'codex') return basename

  const match = basename.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)
  return match ? match[1].toLowerCase() : basename.toLowerCase()
}

function normalizeSessionId(
  rawSessionId: unknown,
  agent: 'claude' | 'codex',
): string {
  const value = String(rawSessionId || '').trim()
  if (!value) return ''
  if (agent === 'codex') return value.toLowerCase()
  return value
}

function extractSessionIdFromLog(
  filePath: string,
  agent: 'claude' | 'codex',
  fallback: string,
): string {
  const normalizedFallback = normalizeSessionId(fallback, agent)
  if (agent !== 'claude') return normalizedFallback

  try {
    const stat = fs.statSync(filePath)
    const length = Math.min(stat.size, 512 * 1024)
    if (length <= 0) return normalizedFallback

    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(length)
      const offset = Math.max(0, stat.size - length)
      fs.readSync(fd, buf, 0, length, offset)
      const lines = buf.toString('utf8').split('\n').filter((line) => line.trim())
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const obj: any = JSON.parse(lines[i])
          const fromLine = normalizeSessionId(obj?.sessionId, agent)
          if (fromLine) return fromLine
        } catch {
          // ignore malformed line
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // ignore unreadable session log
  }

  return normalizedFallback
}

function pickSessionTitle(raw: string): string | undefined {
  if (!raw.trim()) return undefined
  if (looksLikeKibitzGeneratedPrompt(raw.toLowerCase())) return undefined

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const cleaned = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned || isNoiseSessionTitle(cleaned)) continue

    return cleaned
  }

  return undefined
}

function isNoiseSessionTitle(text: string): boolean {
  const lower = text.toLowerCase()
  const normalized = lower.replace(/^[#>*\-\s]+/, '').trim()
  if (normalized.length < 8) return true
  if (looksLikeSessionIdentifier(normalized)) return true
  // Drop opaque machine blobs (JWT/base64-like) that are never useful as titles.
  if (/^[a-z0-9+/_=-]{64,}$/.test(normalized)) return true

  if (normalized.startsWith('the user opened the file ')
    || normalized.includes('may or may not be related to the current task')) return true
  // Drop file-reference lines like "logo.svg: media/logo.svg" or "file.ts: src/file.ts"
  if (/^[\w][\w.\-]*\.[a-z]{2,6}:\s/i.test(normalized)) return true
  if (/^\d+\)\s+after deciding to use a skill\b/.test(normalized)
    || /^\d+\)\s+when `?skill\.md`? references\b/.test(normalized)
    || /^\d+\)\s+if `?skill\.md`? points\b/.test(normalized)
    || /^\d+\)\s+if `?scripts\/`? exist\b/.test(normalized)
    || /^\d+\)\s+if `?assets\/`? or templates exist\b/.test(normalized)
    || /^perform( a)? repository commit\b/.test(normalized)) return true
  if (normalized.startsWith('agents.md instructions for')
    || normalized.startsWith('a skill is a set of local instructions')
    || normalized.startsWith('researched how the feature works')
    || normalized.startsWith('context from my ide setup:')
    || normalized.startsWith('open tabs:')
    || normalized.startsWith('my request for codex:')
    || normalized.startsWith('available skills')
    || normalized.startsWith('how to use skills')
    || normalized.startsWith('never mention session ids')
    || normalized.startsWith('never write in first person')
    || normalized.startsWith('you oversee ai coding agents')
    || normalized.startsWith('plain language.')
    || normalized.startsWith('bold only key nouns')
    || normalized.startsWith('upper case')
    || normalized.startsWith('emoji are allowed')
    || normalized.startsWith('no filler.')
    || normalized.startsWith("don't repeat what previous commentary")
    || normalized.startsWith('rules:')
    || normalized.startsWith('format for this message:')
    || normalized.startsWith('tone preset:')
    || normalized.startsWith('additional user instruction:')
    || normalized.startsWith('skill-creator:')
    || normalized.startsWith('skill-installer:')
    || normalized.startsWith('- skill-')
    || normalized.startsWith('discovery:')
    || normalized.startsWith('trigger rules:')
    || normalized.startsWith('missing/blocked:')
    || normalized.startsWith('how to use a skill')
    || normalized.startsWith('context hygiene:')
    || normalized.startsWith('safety and fallback:')
    || normalized.startsWith('environment_context')
    || normalized.startsWith('/environment_context')
    || normalized.startsWith('permissions instructions')
    || normalized.startsWith('filesystem sandboxing defines')
    || normalized.startsWith('collaboration mode:')
    || normalized.startsWith('system instructions:')
    || normalized.startsWith('user request:')
    || normalized.startsWith('active goals')
    || normalized.startsWith('room memory')
    || normalized.startsWith('recent activity')
    || normalized.startsWith('room workers')
    || normalized.startsWith('room tasks')
    || normalized.startsWith('recent decisions')
    || normalized.startsWith('pending questions to keeper')
    || normalized.startsWith('execution settings')
    || normalized.startsWith('instructions')
    || normalized.startsWith('based on the current state')
    || normalized.startsWith('important: you must call at least one tool')
    || normalized.startsWith('respond only with a tool call')
    || normalized.startsWith('use bullet points.')
    || normalized.startsWith('write a single sentence.')
    || normalized.startsWith('start with a short upper case reaction')
    || normalized.startsWith('use numbered steps showing what the agent did in order')
    || normalized.startsWith('summarize in one sentence, then ask a pointed rhetorical question')
    || normalized.startsWith('use a compact markdown table with columns')
    || normalized.startsWith('use bullet points with emoji tags')
    || normalized.startsWith('use a scoreboard format with these labels')
    || normalized.startsWith('example:')
    || normalized.startsWith('session: ')
    || normalized.startsWith('actions (')
    || normalized.startsWith('previous commentary')
    || normalized.startsWith('summarize only this session')
    || normalized.startsWith('never mention ids/logs/prompts/traces')
    || normalized.startsWith('never say "i", "i\'ll", "we"')) return true
  if (normalized.includes('only key nouns')
    || normalized.includes('fixed the login page')
    || normalized.includes('edited auth middleware')
    || normalized.includes('max 2 per commentary')
    || normalized.includes("don't repeat what previous commentary already said")) return true
  if (normalized.startsWith('cwd:') || normalized.startsWith('shell:')) return true
  if (normalized.startsWith('your identity')
    || normalized.startsWith('room id:')
    || normalized.startsWith('worker id:')) return true
  if (normalized.startsWith('you are codex, a coding agent')) return true

  return false
}

function looksLikeSessionIdentifier(text: string): boolean {
  if (/^[0-9a-f]{8}$/.test(text)) return true
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text)) return true
  if (/^session[\s:_-]*[0-9a-f]{8,}$/.test(text)) return true
  if (/^turn[\s:_-]*[0-9a-f]{8,}$/.test(text)) return true
  if (/^rollout-\d{4}-\d{2}-\d{2}t\d{2}[-:]\d{2}[-:]\d{2}[-a-z0-9]+(?:\.jsonl)?$/.test(text)) return true
  return false
}

function extractProjectName(dirName: string): string {
  // -Users-vasily-projects-room → room
  const parts = dirName.split('-').filter(Boolean)
  return parts[parts.length - 1] || 'unknown'
}

function codexSessionDirs(daysBack: number): string[] {
  const home = os.homedir()
  const results: string[] = []
  const seen = new Set<string>()
  const now = new Date()
  const totalDays = Math.max(1, daysBack)

  for (let offset = 0; offset < totalDays; offset++) {
    const d = new Date(now)
    d.setDate(now.getDate() - offset)
    const dir = path.join(
      home, '.codex', 'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    )
    if (seen.has(dir)) continue
    seen.add(dir)
    results.push(dir)
  }

  return results
}

function fallbackSessionTitle(projectName: string, agent: 'claude' | 'codex'): string {
  const project = (projectName || '').trim()
  if (project) return project
  return `${agent} session`
}
