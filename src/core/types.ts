export interface KibitzEvent {
  sessionId: string
  projectName: string
  sessionTitle?: string
  agent: 'claude' | 'codex'
  source: 'vscode' | 'cli'
  timestamp: number
  type: 'tool_call' | 'tool_result' | 'message' | 'subagent' | 'meta'
  summary: string
  details: Record<string, unknown>
}

export interface SessionInfo {
  id: string
  projectName: string
  sessionTitle?: string
  agent: 'claude' | 'codex'
  source: 'vscode' | 'cli'
  filePath: string
  lastActivity: number
}

export type DispatchTargetKind = 'existing' | 'new-codex' | 'new-claude'

export interface DispatchTarget {
  kind: DispatchTargetKind
  agent?: 'claude' | 'codex'
  sessionId?: string
  projectName?: string
  sessionTitle?: string
}

export interface DispatchRequest {
  target: DispatchTarget
  prompt: string
  origin: 'vscode' | 'cli'
}

export interface DispatchStatus {
  state: 'queued' | 'started' | 'sent' | 'failed'
  message: string
  target: DispatchTarget
  timestamp: number
}

export type CommentaryStyleId =
  | 'bullets'
  | 'one-liner'
  | 'headline-context'
  | 'numbered-progress'
  | 'short-question'
  | 'table'
  | 'emoji-bullets'
  | 'scoreboard'

export interface CommentaryStyleOption {
  id: CommentaryStyleId
  label: string
}

export const COMMENTARY_STYLE_OPTIONS: CommentaryStyleOption[] = [
  { id: 'bullets', label: 'Bullet list' },
  { id: 'one-liner', label: 'One-liner' },
  { id: 'headline-context', label: 'Headline + context' },
  { id: 'numbered-progress', label: 'Numbered progress' },
  { id: 'short-question', label: 'Short + question' },
  { id: 'table', label: 'Table' },
  { id: 'emoji-bullets', label: 'Emoji bullets' },
  { id: 'scoreboard', label: 'Scoreboard' },
]

export type ModelId =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001'
  | 'gpt-4o'
  | 'gpt-4o-mini'

export type ProviderId = 'anthropic' | 'openai'

export interface ModelConfig {
  id: ModelId
  label: string
  provider: ProviderId
}

export const MODELS: ModelConfig[] = [
  { id: 'claude-opus-4-6', label: 'Claude Opus', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku', provider: 'anthropic' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' },
]

export const DEFAULT_MODEL: ModelId = 'claude-opus-4-6'

export interface CommentaryEntry {
  timestamp: number
  sessionId: string
  projectName: string
  sessionTitle?: string
  agent: 'claude' | 'codex'
  source: 'vscode' | 'cli'
  eventSummary: string
  commentary: string
}

export interface Provider {
  generate(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string,
    model: ModelId,
    onChunk: (text: string) => void,
  ): Promise<string>
}

// KeyResolver kept for backwards compat but both providers use CLI subscriptions
export interface KeyResolver {
  getKey(provider: ProviderId): Promise<string | undefined>
}

export interface ProviderStatus {
  provider: ProviderId
  label: string
  available: boolean
  version?: string
  error?: string
}
