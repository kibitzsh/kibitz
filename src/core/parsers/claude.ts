import { KibitzEvent } from '../types'

interface ClaudeLine {
  type?: string
  sessionId?: string
  cwd?: string
  slug?: string
  version?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      name?: string
      input?: Record<string, unknown>
      text?: string
      tool_use_id?: string
    }>
  }
  timestamp?: string
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `Running: ${truncate(String(input.command || ''), 80)}`
    case 'Read':
      return `Reading ${shortPath(String(input.file_path || ''))}`
    case 'Write':
      return `Writing ${shortPath(String(input.file_path || ''))}`
    case 'Edit':
      return `Editing ${shortPath(String(input.file_path || ''))}`
    case 'Grep':
      return `Searching for "${truncate(String(input.pattern || ''), 40)}"`
    case 'Glob':
      return `Finding files: ${truncate(String(input.pattern || ''), 40)}`
    case 'Task':
      return `Spawning agent: ${truncate(String(input.description || ''), 60)}`
    case 'TodoWrite':
      return 'Updating task list'
    case 'WebSearch':
      return `Web search: "${truncate(String(input.query || ''), 50)}"`
    case 'WebFetch':
      return `Fetching: ${truncate(String(input.url || ''), 60)}`
    default:
      return `Using tool: ${name}`
  }
}

function shortPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '.../' + parts.slice(-2).join('/')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/')
  return parts[parts.length - 1] || 'unknown'
}

export function parseClaudeLine(line: string, filePath: string): KibitzEvent[] {
  let obj: ClaudeLine
  try {
    obj = JSON.parse(line)
  } catch {
    return []
  }

  const sessionId = obj.sessionId || sessionIdFromFilePath(filePath)
  const projectName = obj.cwd ? projectNameFromCwd(obj.cwd) : projectFromFilePath(filePath)
  const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()

  // Skip internal types we don't care about
  if (obj.type === 'queue-operation' || obj.type === 'file-history-snapshot' || obj.type === 'progress') {
    return []
  }

  const events: KibitzEvent[] = []

  if (obj.type === 'assistant' && obj.message?.content) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_use' && block.name && block.input) {
        events.push({
          sessionId,
          projectName,
          agent: 'claude',
          source: 'cli', // will be overridden by watcher
          timestamp,
          type: 'tool_call',
          summary: summarizeToolUse(block.name, block.input as Record<string, unknown>),
          details: { tool: block.name, input: block.input },
        })
      } else if (block.type === 'text' && block.text) {
        const text = block.text.trim()
        if (text.length > 0) {
          events.push({
            sessionId,
            projectName,
            agent: 'claude',
            source: 'cli',
            timestamp,
            type: 'message',
            summary: truncate(text, 120),
            details: { text },
          })
        }
      }
    }
  }

  if (obj.type === 'user' && obj.message?.content) {
    // Track tool results
    for (const block of obj.message.content) {
      if (block.type === 'tool_result') {
        events.push({
          sessionId,
          projectName,
          agent: 'claude',
          source: 'cli',
          timestamp,
          type: 'tool_result',
          summary: 'Tool completed',
          details: { tool_use_id: block.tool_use_id },
        })
      }
    }
  }

  return events
}

function projectFromFilePath(filePath: string): string {
  // ~/.claude/projects/-Users-vasily-projects-room/session.jsonl
  const parts = filePath.split('/')
  const projectDir = parts[parts.length - 2] || ''
  // Convert -Users-vasily-projects-room → room
  const segments = projectDir.split('-').filter(Boolean)
  return segments[segments.length - 1] || 'unknown'
}

function sessionIdFromFilePath(filePath: string): string {
  const basename = filePath.split('/').pop() || ''
  return basename.replace('.jsonl', '')
}
