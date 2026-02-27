import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import {
  DispatchRequest,
  DispatchStatus,
  DispatchTarget,
  SessionInfo,
} from './types'
import {
  SessionProvider,
  findCommandPath,
  getProviderCliCommand,
  resolveCmdNodeScript,
} from './platform-support'

export interface DispatchCommand {
  provider: SessionProvider
  command: string
  args: string[]
}

export interface SessionDispatchOptions {
  getActiveSessions: () => SessionInfo[]
  launchInteractiveSession?: (provider: SessionProvider, prompt: string) => Promise<void>
}

export class SessionDispatchService extends EventEmitter {
  constructor(private options: SessionDispatchOptions) {
    super()
  }

  async dispatch(request: DispatchRequest): Promise<void> {
    const prompt = String(request.prompt || '').trim()
    if (!prompt) {
      this.emitStatus('failed', request.target, 'Prompt cannot be empty')
      return
    }

    this.emitStatus('queued', request.target, `Queued for ${describeTarget(request.target)}`)

    if (request.target.kind === 'existing') {
      await this.dispatchExistingSession(request.target, prompt)
      return
    }

    const provider = request.target.kind === 'new-codex' ? 'codex' : 'claude'
    this.emitStatus('started', request.target, `Starting new ${provider} session`)

    try {
      if (request.origin === 'vscode') {
        if (!this.options.launchInteractiveSession) {
          throw new Error('Interactive launcher is not available in VS Code mode')
        }
        await this.options.launchInteractiveSession(provider, prompt)
      } else {
        await runInteractiveInTerminal(provider, prompt)
      }
      this.emitStatus('sent', request.target, `Started new ${provider} session`)
    } catch (error) {
      this.emitStatus('failed', request.target, normalizeError(error))
    }
  }

  private async dispatchExistingSession(target: DispatchTarget, prompt: string): Promise<void> {
    const targetSessionId = String(target.sessionId || '').trim().toLowerCase()
    const targetAgent = target.agent
    if (!targetSessionId || (targetAgent !== 'claude' && targetAgent !== 'codex')) {
      this.emitStatus('failed', target, 'Missing target session or provider')
      return
    }

    const active = this.options.getActiveSessions()
    const activeMatch = active.find((session) => {
      return session.agent === targetAgent && session.id.toLowerCase() === targetSessionId
    })
    if (!activeMatch) {
      this.emitStatus('failed', target, `Target session ${targetSessionId} is not active`)
      return
    }

    this.emitStatus('started', target, `Dispatching to ${targetAgent}:${targetSessionId}`)

    try {
      const command = buildExistingDispatchCommand(target, prompt)
      await runBackgroundCommand(command)
      this.emitStatus('sent', target, `Prompt sent to ${targetAgent}:${targetSessionId}`)
    } catch (error) {
      this.emitStatus('failed', target, normalizeError(error))
    }
  }

  private emitStatus(
    state: DispatchStatus['state'],
    target: DispatchTarget,
    message: string,
  ): void {
    const status: DispatchStatus = {
      state,
      message,
      target,
      timestamp: Date.now(),
    }
    this.emit('status', status)
  }
}

export function buildExistingDispatchCommand(
  target: DispatchTarget,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): DispatchCommand {
  if (target.kind !== 'existing') {
    throw new Error(`Expected existing target, got "${target.kind}"`)
  }

  const sessionId = String(target.sessionId || '').trim()
  const agent = target.agent
  if (!sessionId || (agent !== 'claude' && agent !== 'codex')) {
    throw new Error('Missing existing-session target details')
  }

  if (agent === 'codex') {
    return {
      provider: 'codex',
      command: getProviderCliCommand('codex', platform),
      args: ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, prompt],
    }
  }

  return {
    provider: 'claude',
    command: getProviderCliCommand('claude', platform),
    args: ['-p', prompt, '--output-format', 'stream-json', '--resume', sessionId],
  }
}

export function buildInteractiveDispatchCommand(
  provider: SessionProvider,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): DispatchCommand {
  return {
    provider,
    command: getProviderCliCommand(provider, platform),
    args: [prompt],
  }
}

export interface ResolvedLaunchCommand {
  command: string
  args: string[]
  shell: boolean
}

export function resolveDispatchCommand(
  command: DispatchCommand,
  platform: NodeJS.Platform = process.platform,
): ResolvedLaunchCommand {
  const pathHint = findCommandPath(command.command, platform)
  if (!pathHint) {
    throw new Error(`CLI not found: ${command.command}`)
  }

  if (platform === 'win32') {
    const nodeScript = resolveCmdNodeScript(pathHint)
    if (nodeScript) {
      return {
        command: process.execPath,
        args: [nodeScript, ...command.args],
        shell: false,
      }
    }

    if (pathHint.toLowerCase().endsWith('.cmd')) {
      return {
        command: pathHint,
        args: command.args,
        shell: true,
      }
    }
  }

  return {
    command: pathHint,
    args: command.args,
    shell: false,
  }
}

async function runBackgroundCommand(command: DispatchCommand): Promise<void> {
  const resolved = resolveDispatchCommand(command)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: resolved.shell,
      windowsHide: true,
    })

    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      const normalized = String(stderr || '').trim()
      if (looksLikeUnsupportedFlags(normalized)) {
        reject(new Error('Provider CLI does not support required resume flags. Update the CLI version.'))
        return
      }

      reject(new Error(normalized || `Dispatch exited with code ${code}`))
    })
  })
}

async function runInteractiveInTerminal(provider: SessionProvider, prompt: string): Promise<void> {
  const command = buildInteractiveDispatchCommand(provider, prompt)
  const resolved = resolveDispatchCommand(command)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      stdio: 'inherit',
      shell: resolved.shell,
      windowsHide: false,
    })

    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Interactive session exited with code ${code}`))
    })
  })
}

function describeTarget(target: DispatchTarget): string {
  if (target.kind === 'new-codex') return 'new codex session'
  if (target.kind === 'new-claude') return 'new claude session'
  return `${target.agent || 'unknown'}:${target.sessionId || 'unknown'}`
}

function looksLikeUnsupportedFlags(stderr: string): boolean {
  const normalized = String(stderr || '').toLowerCase()
  if (!normalized) return false
  return normalized.includes('unknown option')
    || normalized.includes('unknown flag')
    || normalized.includes('unrecognized option')
    || normalized.includes('did you mean')
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Dispatch failed')
}
