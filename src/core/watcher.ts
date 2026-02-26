import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'
import { KibitzEvent, SessionInfo } from './types'
import { parseClaudeLine } from './parsers/claude'
import { parseCodexLine } from './parsers/codex'

interface WatchedFile {
  filePath: string
  offset: number
  agent: 'claude' | 'codex'
  watcher: fs.FSWatcher | null
  projectName: string
}

export class SessionWatcher extends EventEmitter {
  private watched = new Map<string, WatchedFile>()
  private scanInterval: ReturnType<typeof setInterval> | null = null
  private claudeIdeLocks = new Map<string, { pid: number; workspaceFolders: string[] }>()
  private sessionProjectNames = new Map<string, string>() // sessionId → projectName from meta

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
    // Deduplicate: keep only the most recent session per project+agent combo
    const best = new Map<string, { info: SessionInfo; mtime: number }>()
    for (const w of this.watched.values()) {
      try {
        const stat = fs.statSync(w.filePath)
        // 2-minute window — only truly active sessions
        if (now - stat.mtimeMs > 2 * 60 * 1000) continue
        const key = `${w.agent}:${w.projectName}`
        const existing = best.get(key)
        if (!existing || stat.mtimeMs > existing.mtime) {
          best.set(key, {
            info: {
              id: path.basename(w.filePath, '.jsonl'),
              projectName: w.projectName,
              agent: w.agent,
              source: this.detectSource(w),
              filePath: w.filePath,
              lastActivity: stat.mtimeMs,
            },
            mtime: stat.mtimeMs,
          })
        }
      } catch { /* file gone */ }
    }
    return Array.from(best.values()).map(b => b.info)
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
          if (now - stat.mtimeMs > 5 * 60 * 1000) continue // skip stale
        } catch { continue }

        if (!this.watched.has(filePath)) {
          const projectName = extractProjectName(dir)
          this.watchFile(filePath, 'claude', projectName)
        }
      }
    }
  }

  private scanCodex(): void {
    const now = new Date()
    const sessionsDir = path.join(
      os.homedir(), '.codex', 'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    )
    if (!fs.existsSync(sessionsDir)) return

    let files: string[]
    try {
      files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))
    } catch { return }

    const currentTime = Date.now()
    for (const file of files) {
      const filePath = path.join(sessionsDir, file)
      try {
        const stat = fs.statSync(filePath)
        if (currentTime - stat.mtimeMs > 5 * 60 * 1000) continue
      } catch { continue }

      if (!this.watched.has(filePath)) {
        this.watchFile(filePath, 'codex', 'codex')
      }
    }
  }

  private watchFile(filePath: string, agent: 'claude' | 'codex', projectName: string): void {
    let offset: number
    try {
      const stat = fs.statSync(filePath)
      offset = stat.size // start from current end, only read new content
    } catch { return }

    const entry: WatchedFile = { filePath, offset, agent, watcher: null, projectName }

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
    let stat: fs.Stats
    try {
      stat = fs.statSync(entry.filePath)
    } catch { return }

    if (stat.size <= entry.offset) return

    const fd = fs.openSync(entry.filePath, 'r')
    const buf = Buffer.alloc(stat.size - entry.offset)
    fs.readSync(fd, buf, 0, buf.length, entry.offset)
    fs.closeSync(fd)
    entry.offset = stat.size

    const chunk = buf.toString('utf8')
    const lines = chunk.split('\n').filter(l => l.trim())

    for (const line of lines) {
      let events: KibitzEvent[]
      if (entry.agent === 'claude') {
        events = parseClaudeLine(line, entry.filePath)
      } else {
        events = parseCodexLine(line, entry.filePath)
      }

      for (const event of events) {
        // Override source detection
        event.source = this.detectSource(entry)

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
        if (now - stat.mtimeMs > 10 * 60 * 1000) {
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

function extractProjectName(dirName: string): string {
  // -Users-vasily-projects-room → room
  const parts = dirName.split('-').filter(Boolean)
  return parts[parts.length - 1] || 'unknown'
}
