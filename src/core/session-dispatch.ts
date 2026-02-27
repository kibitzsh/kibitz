import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
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
      this.emitStatus('failed', target, `Selected ${describeProvider(targetAgent)} session is not active`)
      return
    }

    const targetLabel = describeTarget(target)
    this.emitStatus('started', target, `Dispatching to ${targetLabel}`)

    try {
      const command = buildExistingDispatchCommand(target, prompt)
      const dispatchCwd = deriveDispatchCwdForSession(activeMatch)
      const beforeDispatch = captureSessionFileSnapshot(activeMatch.filePath)
      const handle = await startBackgroundCommand(command, { cwd: dispatchCwd })
      const dispatchOutcome = await runWithTimeout(
        waitForDispatchAcknowledgement(
          activeMatch.filePath,
          prompt,
          beforeDispatch,
          handle.completion,
        ),
        20_000,
        'Dispatch timed out waiting for target session update',
      )

      // If process exited before prompt was observed, enforce full verification.
      if (dispatchOutcome === 'process-complete') {
        verifyExistingDispatchDelivery(activeMatch.filePath, prompt, beforeDispatch)
      }

      // Keep completion promise observed to avoid unhandled rejections after early ack.
      void handle.completion.catch(() => undefined)
      this.emitStatus('sent', target, `Prompt sent to ${targetLabel}`)
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
    args: ['-p', prompt, '--verbose', '--output-format', 'stream-json', '--resume', sessionId],
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

type DispatchAcknowledgement = 'prompt-observed' | 'process-complete'

async function waitForDispatchAcknowledgement(
  filePath: string,
  prompt: string,
  before: SessionFileSnapshot,
  completion: Promise<void>,
): Promise<DispatchAcknowledgement> {
  let completionState = 0 // 0: running, 1: success, 2: failed
  let completionError: Error | null = null

  completion.then(() => {
    completionState = 1
  }).catch((error) => {
    completionState = 2
    completionError = error instanceof Error ? error : new Error(String(error || 'Dispatch failed'))
  })

  while (true) {
    if (completionState === 2) {
      throw completionError || new Error('Dispatch failed')
    }

    if (hasSessionUpdateWithPrompt(filePath, prompt, before)) {
      return 'prompt-observed'
    }

    if (completionState === 1) {
      return 'process-complete'
    }

    await sleepMs(120)
  }
}

interface BackgroundHandle {
  completion: Promise<void>
}

async function startBackgroundCommand(
  command: DispatchCommand,
  options: { cwd?: string } = {},
): Promise<BackgroundHandle> {
  const resolved = resolveDispatchCommand(command)
  return await new Promise<BackgroundHandle>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: resolved.shell,
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })

    let stderr = ''
    let spawned = false
    let launchSettled = false

    const failLaunch = (error: Error): void => {
      if (launchSettled) return
      launchSettled = true
      reject(error)
    }

    const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
      child.on('error', (error) => {
        if (!spawned) {
          failLaunch(error)
          return
        }
        rejectCompletion(error)
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolveCompletion()
          return
        }

        const normalized = String(stderr || '').trim()
        if (looksLikeUnsupportedFlags(normalized)) {
          rejectCompletion(new Error('Provider CLI does not support required resume flags. Update the CLI version.'))
          return
        }

        rejectCompletion(new Error(normalized || `Dispatch exited with code ${code}`))
      })
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('spawn', () => {
      spawned = true
      if (launchSettled) return
      launchSettled = true
      resolve({ completion })
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

  const provider = describeProvider(target.agent)
  const project = cleanTargetLabel(target.projectName, 24)
  const sessionTitle = cleanTargetLabel(target.sessionTitle, 44)

  if (project && sessionTitle) return `${provider} session (${project} › ${sessionTitle})`
  if (sessionTitle) return `${provider} session (${sessionTitle})`
  if (project) return `${provider} session (${project})`
  return `${provider} session`
}

function describeProvider(agent: string | undefined): string {
  return String(agent || '').toLowerCase() === 'claude' ? 'Claude' : 'Codex'
}

function cleanTargetLabel(value: unknown, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text)) return ''
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return `${text.slice(0, max - 3).trimEnd()}...`
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

interface SessionFileSnapshot {
  exists: boolean
  size: number
  mtimeMs: number
}

function captureSessionFileSnapshot(filePath: string): SessionFileSnapshot {
  try {
    const stat = fs.statSync(filePath)
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0,
    }
  }
}

function verifyExistingDispatchDelivery(
  filePath: string,
  prompt: string,
  before: SessionFileSnapshot,
): void {
  if (!hasSessionFileChanged(filePath, before)) {
    throw new Error('Target session did not update after dispatch')
  }

  const promptSignature = firstPromptSignature(prompt)
  if (promptSignature.length < 4) return

  const tail = readSessionTailSinceOffset(filePath, before.size)
  if (!tail) {
    throw new Error('Target session updated but prompt text was not found')
  }

  if (!tail.toLowerCase().includes(promptSignature.toLowerCase())) {
    throw new Error('Prompt text was not found in target session update')
  }
}

function hasSessionUpdateWithPrompt(
  filePath: string,
  prompt: string,
  before: SessionFileSnapshot,
): boolean {
  if (!hasSessionFileChanged(filePath, before)) return false

  const promptSignature = firstPromptSignature(prompt)
  if (promptSignature.length < 4) return true

  const tail = readSessionTailSinceOffset(filePath, before.size)
  if (!tail) return false

  return tail.toLowerCase().includes(promptSignature.toLowerCase())
}

function hasSessionFileChanged(filePath: string, before: SessionFileSnapshot): boolean {
  const after = captureSessionFileSnapshot(filePath)
  if (!after.exists) {
    throw new Error('Target session file is not accessible after dispatch')
  }
  return after.size > before.size || after.mtimeMs > before.mtimeMs
}

function firstPromptSignature(prompt: string): string {
  const lines = String(prompt || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
  const first = lines[0] || String(prompt || '').trim()
  return first.slice(0, 160)
}

function readSessionTailSinceOffset(filePath: string, previousSize: number): string {
  try {
    const stat = fs.statSync(filePath)
    const maxBytes = 1024 * 512
    const start = Math.max(0, previousSize - 2048)
    const desiredStart = stat.size - start > maxBytes
      ? Math.max(0, stat.size - maxBytes)
      : start

    const length = Math.max(0, stat.size - desiredStart)
    if (length === 0) return ''

    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, desiredStart)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }).catch((error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function deriveDispatchCwdForSession(session: SessionInfo): string | undefined {
  if (session.agent !== 'claude') return undefined
  return decodeClaudeProjectPathFromSessionFile(session.filePath)
}

function decodeClaudeProjectPathFromSessionFile(filePath: string): string | undefined {
  if (!filePath) return undefined
  const projectDir = path.basename(path.dirname(filePath))
  if (!projectDir) return undefined

  const parts = projectDir.split('-').filter(Boolean)
  if (parts.length === 0) return undefined

  if (parts.length >= 2 && /^[A-Za-z]$/.test(parts[0])) {
    const windowsPath = `${parts[0]}:\\${parts.slice(1).join('\\')}`
    if (fs.existsSync(windowsPath)) return windowsPath
  }

  const unixPath = `/${parts.join('/')}`
  if (fs.existsSync(unixPath)) return unixPath
  return undefined
}
