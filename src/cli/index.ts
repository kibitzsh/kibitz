import * as readline from 'readline'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import {
  CommentaryEntry,
  DEFAULT_MODEL,
  DispatchRequest,
  DispatchTarget,
  KeyResolver,
  MODELS,
  ModelId,
  ProviderId,
  SessionInfo,
} from '../core/types'
import { inheritShellPath } from '../core/platform-support'
import { SessionDispatchService } from '../core/session-dispatch'
import {
  parseSummaryIntervalInput,
  summaryIntervalLabel,
  summaryIntervalToken,
  summaryIntervalTokensList,
} from '../core/summary-interval'
import { persistSharedSummaryIntervalMs, readSharedSummaryIntervalMs } from '../core/shared-settings'

// Minimal ANSI helpers (no dependency on chalk).
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

const noopKeyResolver: KeyResolver = {
  async getKey(_provider: ProviderId) {
    return 'subscription'
  },
}

function parseArgs(args: string[]): { model: ModelId; focus: string; agent: string | null } {
  let model: ModelId = DEFAULT_MODEL
  let focus = ''
  let agent: string | null = null

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--model' && args[index + 1]) {
      const value = args[++index]
      const found = MODELS.find((entry) => {
        return entry.id === value || entry.label.toLowerCase().includes(value.toLowerCase())
      })
      if (found) model = found.id
      continue
    }

    if (arg === '--focus' && args[index + 1]) {
      focus = args[++index]
      continue
    }

    if (arg === '--agent' && args[index + 1]) {
      agent = args[++index]
      continue
    }

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { model, focus, agent }
}

function printHelp(): void {
  console.log(`
${c.bold('KIBITZ')} — Live commentary + cross-session dispatch

${c.bold('Usage:')}
  kibitz [options]

${c.bold('Options:')}
  --model <name>   Commentary model (opus, sonnet, haiku, gpt-4o, gpt-4o-mini)
  --focus <text>   Focus instructions for commentary
  --agent <name>   Filter events by agent (claude, codex)
  --help, -h       Show this help

${c.bold('Slash commands:')}
  /help
  /pause
  /resume
  /focus <text>
  /model <id-or-label>
  /preset <id>
  /interval <${summaryIntervalTokensList()}>
  /sessions
  /target <index|agent:sessionId|new-codex|new-claude>

${c.bold('Composer behavior:')}
  Plain text sends prompt to selected target.
`)
}

function timeStr(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatCommentary(text: string): string {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, (_, inner) => c.bold(inner))
    .replace(/`([^`]+)`/g, (_, code) => c.cyan(code))
    .replace(/^[-*] /gm, '  • ')
}

function agentColor(agent: string): (s: string) => string {
  return agent === 'claude' ? c.yellow : c.green
}

function visibleSessionName(session: SessionInfo): string {
  const title = String(session.sessionTitle || '').trim()
  if (title) return title
  const project = String(session.projectName || '').trim()
  if (project) return project
  return `${session.agent} session`
}

function normalizeTarget(target: DispatchTarget): DispatchTarget {
  if (target.kind === 'new-claude') return { kind: 'new-claude' }
  if (target.kind === 'new-codex') return { kind: 'new-codex' }

  return {
    kind: 'existing',
    agent: target.agent,
    sessionId: String(target.sessionId || '').trim().toLowerCase(),
    projectName: target.projectName,
    sessionTitle: target.sessionTitle,
  }
}

function parseTargetArg(rawArg: string, sessions: SessionInfo[]): DispatchTarget | null {
  const raw = String(rawArg || '').trim()
  if (!raw) return null

  if (raw === 'new-codex') return { kind: 'new-codex' }
  if (raw === 'new-claude') return { kind: 'new-claude' }

  if (/^\d+$/.test(raw)) {
    const index = Number(raw)
    if (index < 1 || index > sessions.length) return null
    const session = sessions[index - 1]
    return {
      kind: 'existing',
      agent: session.agent,
      sessionId: String(session.id || '').trim().toLowerCase(),
      projectName: session.projectName,
      sessionTitle: session.sessionTitle,
    }
  }

  const match = raw.match(/^(claude|codex):(.+)$/i)
  if (!match) return null
  const agent = match[1].toLowerCase() as 'claude' | 'codex'
  const sessionId = String(match[2] || '').trim().toLowerCase()
  if (!sessionId) return null

  const found = sessions.find((session) => {
    return session.agent === agent && String(session.id || '').trim().toLowerCase() === sessionId
  })

  return {
    kind: 'existing',
    agent,
    sessionId,
    projectName: found?.projectName,
    sessionTitle: found?.sessionTitle,
  }
}

function describeTarget(target: DispatchTarget): string {
  if (target.kind === 'new-codex') return 'new-codex'
  if (target.kind === 'new-claude') return 'new-claude'
  return `${target.agent || 'unknown'}:${target.sessionId || 'unknown'}`
}

async function main(): Promise<void> {
  inheritShellPath()

  const options = parseArgs(process.argv.slice(2))

  console.log(c.bold('\n  KIBITZ') + c.dim(' — Live AI commentary + session dispatch\n'))
  console.log(c.dim(`  Model: ${options.model}`))
  if (options.focus) console.log(c.dim(`  Focus: ${options.focus}`))
  if (options.agent) console.log(c.dim(`  Agent filter: ${options.agent}`))
  console.log(c.dim('  Watching for sessions... type /help for commands.\n'))

  const watcher = new SessionWatcher()
  const engine = new CommentaryEngine(noopKeyResolver)
  const dispatch = new SessionDispatchService({
    getActiveSessions: () => watcher.getActiveSessions(),
  })

  const initialSummaryIntervalMs = readSharedSummaryIntervalMs()
  engine.setSummaryIntervalMs(initialSummaryIntervalMs)

  engine.setModel(options.model)
  if (options.focus) engine.setFocus(options.focus)

  console.log(c.dim(`  Summary interval: ${summaryIntervalToken(engine.getSummaryIntervalMs())} (${summaryIntervalLabel(engine.getSummaryIntervalMs())})`))

  let selectedTarget: DispatchTarget = { kind: 'new-codex' }

  function activeSessions(): SessionInfo[] {
    return watcher.getActiveSessions().filter((session) => {
      return !options.agent || session.agent === options.agent
    })
  }

  function printSessions(): void {
    const sessions = activeSessions()
    if (sessions.length === 0) {
      console.log(`  ${c.dim('No active sessions in watcher window.')}`)
      return
    }

    console.log(`  ${c.bold('Active sessions:')}`)
    sessions.forEach((session, index) => {
      const marker = selectedTarget.kind === 'existing'
        && selectedTarget.agent === session.agent
        && String(selectedTarget.sessionId || '').toLowerCase() === String(session.id || '').toLowerCase()
        ? c.green('*')
        : ' '

      const project = session.projectName ? ` project=${session.projectName}` : ''
      const title = visibleSessionName(session)
      console.log(`  ${marker} [${index + 1}] ${session.agent}:${session.id} ${title}${project}`)
    })
  }

  function printPromptLine(): void {
    const target = describeTarget(selectedTarget)
    rl.setPrompt(c.dim(`kibitz[${target}]> `))
    rl.prompt()
  }

  watcher.on('event', (event) => {
    if (options.agent && event.agent !== options.agent) return
    engine.addEvent(event)
  })

  engine.on('commentary-start', (entry: CommentaryEntry) => {
    const color = agentColor(entry.agent)
    const badge = color(`${entry.agent}/${entry.projectName}`)
    const source = c.dim(`(${entry.source})`)
    console.log(`\n  ${c.dim(timeStr())} ${badge} ${source}`)
    console.log(`  ${c.dim(entry.eventSummary)}`)
    process.stdout.write('  ')
  })

  engine.on('commentary-chunk', ({ chunk }: { entry: CommentaryEntry; chunk: string }) => {
    process.stdout.write(formatCommentary(chunk))
  })

  engine.on('commentary-done', () => {
    console.log('\n')
    printPromptLine()
  })

  engine.on('error', (error: Error) => {
    console.log(`\n  ${c.red('Error:')} ${error.message}`)
    printPromptLine()
  })

  dispatch.on('status', (status) => {
    const label = status.state.toUpperCase()
    const color = status.state === 'failed'
      ? c.red
      : status.state === 'sent'
        ? c.green
        : c.cyan
    console.log(`\n  ${color(label)} ${status.message}`)
    printPromptLine()
  })

  engine.on('summary-interval-changed', (intervalMs: number) => {
    persistSharedSummaryIntervalMs(intervalMs)
  })

  watcher.start()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 1000,
  })

  async function handleSlash(raw: string): Promise<void> {
    const body = raw.slice(1).trim()
    const firstSpace = body.indexOf(' ')
    const command = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase()
    const args = firstSpace === -1 ? '' : body.slice(firstSpace + 1).trim()

    if (command === 'help') {
      printHelp()
      return
    }

    if (command === 'pause') {
      engine.pause()
      console.log(`  ${c.dim('Commentary paused')}`)
      return
    }

    if (command === 'resume') {
      engine.resume()
      console.log(`  ${c.dim('Commentary resumed')}`)
      return
    }

    if (command === 'focus') {
      if (!args) {
        console.log(`  ${c.red('Usage: /focus <text>')}`)
        return
      }
      engine.setFocus(args)
      console.log(`  ${c.dim('Focus updated')}`)
      return
    }

    if (command === 'model') {
      if (!args) {
        console.log(`  ${c.red('Usage: /model <id-or-label>')}`)
        return
      }
      const found = MODELS.find((model) => {
        const needle = args.toLowerCase()
        return model.id.toLowerCase() === needle || model.label.toLowerCase().includes(needle)
      })
      if (!found) {
        console.log(`  ${c.red('Unknown model: ' + args)}`)
        return
      }
      engine.setModel(found.id)
      console.log(`  ${c.dim('Model set to ' + found.label)}`)
      return
    }

    if (command === 'preset') {
      if (!args) {
        console.log(`  ${c.red('Usage: /preset <auto|critical-coder|precise-short|emotional|newbie>')}`)
        return
      }
      engine.setPreset(args)
      console.log(`  ${c.dim('Preset set to ' + engine.getPreset())}`)
      return
    }

    if (command === 'interval') {
      if (!args) {
        console.log(`  ${c.dim(`Summary interval: ${summaryIntervalToken(engine.getSummaryIntervalMs())} (${summaryIntervalLabel(engine.getSummaryIntervalMs())})`)}`)
        console.log(`  ${c.dim(`Usage: /interval <${summaryIntervalTokensList()}>`)}`)
        return
      }
      const parsed = parseSummaryIntervalInput(args)
      if (parsed == null) {
        console.log(`  ${c.red(`Usage: /interval <${summaryIntervalTokensList()}>`)}`)
        return
      }
      engine.setSummaryIntervalMs(parsed)
      console.log(`  ${c.dim(`Summary interval set to ${summaryIntervalToken(parsed)} (${summaryIntervalLabel(parsed)})`)}`)
      return
    }

    if (command === 'sessions') {
      printSessions()
      return
    }

    if (command === 'target') {
      if (!args) {
        console.log(`  ${c.red('Usage: /target <index|agent:sessionId|new-codex|new-claude>')}`)
        return
      }
      const next = parseTargetArg(args, activeSessions())
      if (!next) {
        console.log(`  ${c.red('Invalid target: ' + args)}`)
        return
      }
      selectedTarget = normalizeTarget(next)
      console.log(`  ${c.dim('Target set to ' + describeTarget(selectedTarget))}`)
      return
    }

    console.log(`  ${c.red('Unknown command: /' + command)}`)
  }

  rl.on('line', async (line) => {
    const trimmed = String(line || '').trim()
    if (!trimmed) {
      printPromptLine()
      return
    }

    if (trimmed.startsWith('/')) {
      await handleSlash(trimmed)
      printPromptLine()
      return
    }

    const request: DispatchRequest = {
      target: selectedTarget,
      prompt: trimmed,
      origin: 'cli',
    }

    await dispatch.dispatch(request)
    printPromptLine()
  })

  rl.on('close', () => {
    watcher.stop()
    console.log(c.dim('\n  Kibitz out.'))
    process.exit(0)
  })

  process.on('SIGINT', () => {
    watcher.stop()
    rl.close()
  })

  printPromptLine()
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(c.red(`Fatal: ${message}`))
  process.exit(1)
})
