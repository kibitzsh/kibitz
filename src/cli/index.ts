import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { SessionWatcher } from '../core/watcher'
import { CommentaryEngine } from '../core/commentary'
import { KeyResolver, ProviderId, ModelId, MODELS, DEFAULT_MODEL, CommentaryEntry } from '../core/types'

// Simple colors without external deps (ANSI escape codes)
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

class CLIKeyResolver implements KeyResolver {
  private config: Record<string, string> = {}
  private configPath = path.join(os.homedir(), '.kibitz', 'config.json')

  constructor() {
    this.load()
  }

  async getKey(provider: ProviderId): Promise<string | undefined> {
    const envKey = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    return process.env[envKey] || this.config[`${provider}_api_key`]
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      }
    } catch { /* no config */ }
  }
}

function parseArgs(args: string[]): { model: ModelId; focus: string; agent: string | null } {
  let model: ModelId = DEFAULT_MODEL
  let focus = ''
  let agent: string | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      const val = args[++i]
      // Support short names
      const found = MODELS.find(m => m.id === val || m.label.toLowerCase().includes(val.toLowerCase()))
      if (found) model = found.id
    } else if (args[i] === '--focus' && args[i + 1]) {
      focus = args[++i]
    } else if (args[i] === '--agent' && args[i + 1]) {
      agent = args[++i]
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { model, focus, agent }
}

function printHelp(): void {
  console.log(`
${c.bold('KIBITZ')} — Live commentary on AI coding agents

${c.bold('Usage:')}
  kibitz [options]

${c.bold('Options:')}
  --model <name>   Commentary model (opus, sonnet, haiku, gpt-4o, gpt-4o-mini)
  --focus <text>    Focus instructions (e.g., "roast everything")
  --agent <name>    Filter by agent (claude, codex)
  --help, -h        Show this help

${c.bold('Environment:')}
  ANTHROPIC_API_KEY  Anthropic API key (for Claude models)
  OPENAI_API_KEY     OpenAI API key (for GPT models)

${c.bold('Interactive:')}
  Type while running to update focus/tone instructions.
  Press Ctrl+C to exit.
`)
}

function timeStr(): string {
  const d = new Date()
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatCommentary(text: string): string {
  // Convert **bold** to terminal bold
  return text.replace(/\*\*(.+?)\*\*/g, (_, inner) => c.bold(inner))
}

function agentColor(agent: string): (s: string) => string {
  return agent === 'claude' ? c.yellow : c.green
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  console.log(c.bold('\n  KIBITZ') + c.dim(' — Live AI agent commentary\n'))
  console.log(c.dim(`  Model: ${opts.model}`))
  if (opts.focus) console.log(c.dim(`  Focus: ${opts.focus}`))
  if (opts.agent) console.log(c.dim(`  Agent filter: ${opts.agent}`))
  console.log(c.dim('  Watching for sessions... (type to change focus, Ctrl+C to exit)\n'))

  const keyResolver = new CLIKeyResolver()
  const watcher = new SessionWatcher()
  const engine = new CommentaryEngine(keyResolver)

  engine.setModel(opts.model)
  if (opts.focus) engine.setFocus(opts.focus)

  watcher.on('event', (event) => {
    if (opts.agent && event.agent !== opts.agent) return
    engine.addEvent(event)
  })

  engine.on('commentary-start', (entry: CommentaryEntry) => {
    const ac = agentColor(entry.agent)
    const badge = ac(`${entry.agent}/${entry.projectName}`)
    const source = c.dim(`(${entry.source})`)
    console.log(`  ${c.dim(timeStr())} ${badge} ${source}`)
    console.log(`  ${c.dim(entry.eventSummary)}`)
    process.stdout.write('  ')
  })

  engine.on('commentary-chunk', ({ chunk }: { entry: CommentaryEntry; chunk: string }) => {
    process.stdout.write(formatCommentary(chunk))
  })

  engine.on('commentary-done', () => {
    console.log('\n')
  })

  engine.on('error', (err: Error) => {
    console.log(`  ${c.red('Error:')} ${err.message}\n`)
  })

  watcher.start()

  // Interactive focus input
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)

    let inputBuffer = ''
    process.stdin.on('keypress', (_str, key) => {
      if (key.ctrl && key.name === 'c') {
        watcher.stop()
        console.log(c.dim('\n  Kibitz out. '))
        process.exit(0)
      }
      if (key.name === 'return') {
        if (inputBuffer.trim()) {
          engine.setFocus(inputBuffer.trim())
          console.log(c.dim(`\n  Focus updated: "${inputBuffer.trim()}"\n`))
        }
        inputBuffer = ''
        return
      }
      if (key.name === 'backspace') {
        inputBuffer = inputBuffer.slice(0, -1)
        return
      }
      if (_str) {
        inputBuffer += _str
      }
    })
  }

  // Keep running
  process.on('SIGINT', () => {
    watcher.stop()
    console.log(c.dim('\n  Kibitz out. '))
    process.exit(0)
  })
}

main().catch(err => {
  console.error(c.red(`Fatal: ${err.message}`))
  process.exit(1)
})
