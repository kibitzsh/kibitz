import { KibitzEvent } from '../types'

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    type?: string
    role?: string
    content?: Array<{
      type: string
      text?: string
      input_text?: string
    }>
    name?: string
    arguments?: string
    call_id?: string
    output?: string
    status?: string
    turn_id?: string
    model_provider?: string
    cli_version?: string
    cwd?: string
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

function projectNameFromCwd(cwd: string): string {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || 'unknown'
}

export function parseCodexLine(line: string, filePath: string): KibitzEvent[] {
  let obj: CodexLine
  try {
    obj = JSON.parse(line)
  } catch {
    return []
  }

  const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
  const sessionId = sessionIdFromFilePath(filePath)

  const events: KibitzEvent[] = []

  if (obj.type === 'session_meta' && obj.payload) {
    const cwd = obj.payload.cwd || ''
    events.push({
      sessionId,
      projectName: projectNameFromCwd(cwd),
      agent: 'codex',
      source: 'cli',
      timestamp,
      type: 'meta',
      summary: `Codex session started (${obj.payload.model_provider || 'unknown'}, v${obj.payload.cli_version || '?'})`,
      details: { cwd, provider: obj.payload.model_provider, version: obj.payload.cli_version },
    })
  }

  if (obj.type === 'response_item' && obj.payload) {
    const p = obj.payload

    // Function call (tool use)
    if (p.type === 'function_call' && p.name) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(p.arguments || '{}')
      } catch { /* ignore */ }
      const summary = summarizeCodexTool(p.name, args)
      events.push({
        sessionId,
        projectName: projectFromFilePath(filePath),
        agent: 'codex',
        source: 'cli',
        timestamp,
        type: 'tool_call',
        summary,
        details: { tool: p.name, input: args },
      })
    }

    // Function call output (tool result)
    if (p.type === 'function_call_output') {
      events.push({
        sessionId,
        projectName: projectFromFilePath(filePath),
        agent: 'codex',
        source: 'cli',
        timestamp,
        type: 'tool_result',
        summary: `Tool completed: ${truncate(p.output || '', 60)}`,
        details: { output: p.output, call_id: p.call_id },
      })
    }

    // Assistant message
    if (p.role === 'assistant' && p.content) {
      for (const block of p.content) {
        const text = block.text || block.input_text || ''
        if (text.trim()) {
          events.push({
            sessionId,
            projectName: projectFromFilePath(filePath),
            agent: 'codex',
            source: 'cli',
            timestamp,
            type: 'message',
            summary: truncate(text.trim(), 120),
            details: { text },
          })
        }
      }
    }
  }

  if (obj.type === 'event_msg' && obj.payload) {
    if (obj.payload.type === 'task_started') {
      events.push({
        sessionId,
        projectName: projectFromFilePath(filePath),
        agent: 'codex',
        source: 'cli',
        timestamp,
        type: 'meta',
        summary: 'Codex task started',
        details: { turn_id: obj.payload.turn_id },
      })
    }
  }

  return events
}

function summarizeCodexTool(name: string, args: Record<string, unknown>): string {
  if (name === 'shell' || name === 'run_command') {
    return `Running: ${truncate(String(args.command || args.cmd || ''), 80)}`
  }
  if (name === 'read_file' || name === 'file_read') {
    return `Reading ${truncate(String(args.path || args.file_path || ''), 60)}`
  }
  if (name === 'write_file' || name === 'file_write') {
    return `Writing ${truncate(String(args.path || args.file_path || ''), 60)}`
  }
  if (name === 'edit_file' || name === 'apply_diff') {
    return `Editing ${truncate(String(args.path || args.file_path || ''), 60)}`
  }
  return `Using tool: ${name}`
}

function sessionIdFromFilePath(filePath: string): string {
  // rollout-2026-02-26T14-50-17-019c9b80-85dd-7c42-b95b-b1b1eb9fdafb.jsonl
  const basename = String(filePath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.jsonl$/i, '') || ''
  const match = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
  return match ? match[1] : basename
}

function projectFromFilePath(filePath: string): string {
  // For codex, we don't have project info in the path, use session meta CWD if available
  return 'codex'
}
