import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { Provider, ModelId } from '../types'

let cachedClaudePath: string | null = null
const PROVIDER_TIMEOUT_MS = 90_000

/**
 * On Windows, .cmd wrappers from npm have 8191-char limit.
 * Resolve to the underlying .js script to bypass it.
 */
function resolveNodeScript(cmdPath: string): string | null {
  if (process.platform !== 'win32' || !cmdPath.endsWith('.cmd')) return null
  try {
    const content = readFileSync(cmdPath, 'utf-8')
    const match = content.match(/%dp0%\\(.+?\.js)/)
    if (match) {
      const script = join(dirname(cmdPath), match[1])
      if (existsSync(script)) return script
    }
  } catch { /* fall through */ }
  return null
}

/**
 * Resolve the full path to the `claude` CLI binary.
 * Same approach as Quoroom — probes common locations, falls back to login-shell `which`.
 */
function resolveClaudePath(): string | null {
  if (cachedClaudePath) return cachedClaudePath

  const home = homedir()
  const isWindows = process.platform === 'win32'

  const candidates: string[] = isWindows
    ? [
        join(home, '.claude', 'bin', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Claude', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
        'C:\\Program Files\\Claude\\claude.exe',
        join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      ]
    : [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/snap/bin/claude',
        '/opt/homebrew/bin/claude',
      ]

  for (const p of candidates) {
    if (existsSync(p)) {
      cachedClaudePath = p
      return p
    }
  }

  // Fall back to shell resolution
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CLAUDECODE

  if (isWindows) {
    try {
      const resolved = execSync('where claude', {
        encoding: 'utf-8', env, timeout: 5000,
      }).trim().split('\n')[0].trim()
      if (resolved && existsSync(resolved)) {
        cachedClaudePath = resolved
        return resolved
      }
    } catch { /* not in PATH */ }
  } else {
    const shells = ['/bin/zsh', '/bin/bash']
    for (const sh of shells) {
      if (!existsSync(sh)) continue
      try {
        const resolved = execSync(`${sh} -lic 'which claude'`, {
          encoding: 'utf-8', env, timeout: 5000,
        }).trim()
        if (resolved && existsSync(resolved)) {
          cachedClaudePath = resolved
          return resolved
        }
      } catch { /* shell not available */ }
    }
  }

  return null
}

/**
 * Uses the Claude CLI with user's subscription — no API key needed.
 * Spawns `claude -p <prompt> --output-format stream-json` and streams the response.
 */
export class AnthropicProvider implements Provider {
  async generate(
    systemPrompt: string,
    userPrompt: string,
    _apiKey: string, // unused — uses subscription
    model: ModelId,
    onChunk: (text: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const claudePath = resolveClaudePath()
      if (!claudePath) {
        reject(new Error('Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code'))
        return
      }

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
      const args = [
        '-p', fullPrompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--max-turns', '1',
        '--model', model,
      ]

      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.CLAUDECODE

      let proc: ReturnType<typeof spawn>
      try {
        const nodeScript = resolveNodeScript(claudePath)
        if (nodeScript) {
          proc = spawn(process.execPath, [nodeScript, ...args], {
            cwd: homedir(), env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } else {
          proc = spawn(claudePath, args, {
            cwd: homedir(), env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: process.platform === 'win32',
          })
        }
      } catch (err) {
        reject(new Error(`Failed to spawn claude CLI: ${err instanceof Error ? err.message : String(err)}`))
        return
      }

      if (!proc.stdout || !proc.stderr) {
        reject(new Error('Failed to create stdio pipes for Claude CLI'))
        try { proc.kill() } catch {}
        return
      }

      let full = ''
      let buffer = ''
      let stderr = ''
      let timedOut = false

      proc.stdout.on('data', (data: Buffer) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            // assistant message with text content
            if (event.type === 'assistant') {
              const content = event.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    full += block.text
                    onChunk(block.text)
                  }
                }
              }
            }
            // result event — final text
            if (event.type === 'result' && event.result) {
              // Only use if we haven't already captured text
              if (!full) {
                full = String(event.result)
                onChunk(full)
              }
            }
          } catch { /* skip non-JSON */ }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      const timeout = setTimeout(() => {
        timedOut = true
        try { proc.kill() } catch {}
      }, PROVIDER_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (timedOut && !full) {
          reject(new Error(`Claude CLI timed out after ${PROVIDER_TIMEOUT_MS}ms`))
          return
        }
        if (code !== 0 && !full) {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
        } else {
          resolve(full)
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`Claude CLI error: ${err.message}`))
      })
    })
  }
}

export function checkClaudeCliAvailable(): { available: boolean; version?: string; error?: string } {
  const claudePath = resolveClaudePath()
  if (!claudePath) {
    return { available: false, error: 'Claude CLI not found' }
  }
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.CLAUDECODE
    const version = execSync(`"${claudePath}" --version`, { encoding: 'utf-8', env, timeout: 5000 }).trim()
    return { available: true, version }
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) }
  }
}
