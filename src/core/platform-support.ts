import { execFileSync, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export type SessionProvider = 'claude' | 'codex'

/**
 * Keep CLI discovery consistent across panel and terminal flows.
 */
export function getProviderCliCommand(
  provider: SessionProvider,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `${provider}.cmd` : provider
}

/**
 * Resolve npm .cmd wrappers to their underlying JavaScript file.
 * This avoids cmd.exe arg limits on Windows for long prompts.
 */
export function resolveCmdNodeScript(cmdPath: string): string | null {
  if (!String(cmdPath || '').toLowerCase().endsWith('.cmd')) return null
  try {
    const content = fs.readFileSync(cmdPath, 'utf8')
    const match = content.match(/%dp0%\\(.+?\.js)/i)
    if (!match) return null
    const scriptPath = path.join(path.dirname(cmdPath), match[1])
    return fs.existsSync(scriptPath) ? scriptPath : null
  } catch {
    return null
  }
}

/**
 * Merge user shell PATH into process PATH so packaged VS Code extension host
 * can still locate user-installed CLIs.
 */
export function inheritShellPath(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') {
    inheritDarwinPath()
    return
  }

  if (platform === 'win32') {
    inheritNpmPrefixPath('win32')
    return
  }

  // Linux remains best-effort in this phase.
  inheritNpmPrefixPath('linux')
}

export function findCommandPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  try {
    if (platform === 'win32') {
      const out = execSync(`where ${command}`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return first || undefined
    }

    const out = execFileSync('which', [command], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

function inheritDarwinPath(): void {
  const currentPath = process.env.PATH || ''
  const parts = new Set(currentPath.split(path.delimiter).filter(Boolean))
  const candidateShells = [process.env.SHELL, '/bin/zsh', '/bin/bash']
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)

  for (const shell of candidateShells) {
    if (!fs.existsSync(shell)) continue
    try {
      const shellPath = execFileSync(shell, ['-lic', 'echo $PATH'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!shellPath) continue
      process.env.PATH = mergePath(currentPath, shellPath, parts)
      return
    } catch {
      // Try next shell candidate.
    }
  }
}

function inheritNpmPrefixPath(platform: 'win32' | 'linux'): void {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    const npmPrefix = execFileSync(npmCommand, ['prefix', '-g'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: platform === 'win32',
    }).trim()
    if (!npmPrefix) return

    const candidates = platform === 'win32'
      ? [npmPrefix, path.join(npmPrefix, 'node_modules', '.bin')]
      : [path.join(npmPrefix, 'bin')]

    let nextPath = process.env.PATH || ''
    const parts = new Set(nextPath.split(path.delimiter).filter(Boolean))
    for (const candidate of candidates) {
      if (!candidate || parts.has(candidate)) continue
      nextPath = nextPath ? `${candidate}${path.delimiter}${nextPath}` : candidate
      parts.add(candidate)
    }
    process.env.PATH = nextPath
  } catch {
    // npm unavailable; keep current PATH.
  }
}

function mergePath(currentPath: string, shellPath: string, knownParts: Set<string>): string {
  const additions: string[] = []
  for (const candidate of shellPath.split(path.delimiter).filter(Boolean)) {
    if (knownParts.has(candidate)) continue
    knownParts.add(candidate)
    additions.push(candidate)
  }
  if (additions.length === 0) return currentPath
  return currentPath
    ? `${currentPath}${path.delimiter}${additions.join(path.delimiter)}`
    : additions.join(path.delimiter)
}
