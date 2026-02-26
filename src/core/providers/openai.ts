import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { Provider, ModelId } from '../types'

let cachedCodexScript: string | null = null
let codexScriptResolved = false

/**
 * On Windows, resolve codex.cmd → underlying .js script to bypass cmd.exe limits.
 * Same pattern as Quoroom's resolveCodexNodeScript.
 */
function resolveCodexNodeScript(): string | null {
  if (codexScriptResolved) return cachedCodexScript
  codexScriptResolved = true
  if (process.platform !== 'win32') return null
  try {
    const cmdPath = execSync('where codex.cmd', {
      encoding: 'utf-8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0].trim()
    const content = readFileSync(cmdPath, 'utf-8')
    const match = content.match(/%dp0%\\(.+?\.js)/)
    if (!match) return null
    const script = join(dirname(cmdPath), match[1])
    if (existsSync(script)) {
      cachedCodexScript = script
      return script
    }
  } catch { /* codex not installed */ }
  return null
}

/**
 * Uses the Codex CLI with user's OpenAI subscription — no API key needed.
 * Spawns `codex exec --json --skip-git-repo-check <prompt>` and streams the response.
 * Same pattern as Quoroom's executeCodex in agent-executor.ts.
 */
export class OpenAIProvider implements Provider {
  async generate(
    systemPrompt: string,
    userPrompt: string,
    _apiKey: string, // unused — uses subscription
    _model: ModelId,
    onChunk: (text: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
      const args = ['exec', '--json', '--skip-git-repo-check', fullPrompt]

      let proc: ReturnType<typeof spawn>
      try {
        const nodeScript = resolveCodexNodeScript()
        if (nodeScript) {
          proc = spawn(process.execPath, [nodeScript, ...args], {
            cwd: homedir(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } else {
          const codexCmd = process.platform === 'win32' ? 'codex.cmd' : 'codex'
          proc = spawn(codexCmd, args, {
            cwd: homedir(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: process.platform === 'win32',
          })
        }
      } catch (err) {
        reject(new Error(`Failed to spawn codex CLI: ${err instanceof Error ? err.message : String(err)}`))
        return
      }

      if (!proc.stdout || !proc.stderr) {
        reject(new Error('Failed to create stdio pipes for codex CLI'))
        try { proc.kill() } catch {}
        return
      }

      let full = ''
      let buffer = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            // Codex JSON output: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
            if (event.type === 'item.completed' && event.item) {
              if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
                full += event.item.text
                onChunk(event.item.text)
              }
            }
          } catch { /* skip non-JSON */ }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0 && !full) {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
        } else {
          resolve(full)
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Codex CLI error: ${err.message}`))
      })

      // 60s timeout
      setTimeout(() => {
        try { proc.kill() } catch {}
      }, 60_000)
    })
  }
}
