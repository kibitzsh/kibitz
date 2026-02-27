import * as fs from 'fs'
import { spawn } from 'child_process'
import { SessionProvider } from '../core/platform-support'
import {
  buildInteractiveDispatchCommand,
  resolveDispatchCommand,
} from '../core/session-dispatch'

interface CliArgs {
  provider: SessionProvider
  promptFile: string
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--provider' && argv[i + 1]) {
      const provider = String(argv[++i]).trim().toLowerCase()
      if (provider === 'claude' || provider === 'codex') {
        out.provider = provider
      }
      continue
    }
    if (arg === '--prompt-file' && argv[i + 1]) {
      out.promptFile = String(argv[++i]).trim()
    }
  }

  if (!out.provider) {
    throw new Error('Missing required --provider (claude|codex)')
  }
  if (!out.promptFile) {
    throw new Error('Missing required --prompt-file')
  }
  return out as CliArgs
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const prompt = fs.readFileSync(args.promptFile, 'utf8').trim()
  if (!prompt) {
    throw new Error('Prompt file is empty')
  }

  const command = buildInteractiveDispatchCommand(args.provider, prompt)
  const resolved = resolveDispatchCommand(command)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      stdio: 'inherit',
      shell: resolved.shell,
      windowsHide: false,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Interactive session exited with code ${code}`))
    })
  })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
