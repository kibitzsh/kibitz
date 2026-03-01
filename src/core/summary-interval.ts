export interface SummaryIntervalOption {
  ms: number
  token: string
  label: string
}

export const SUMMARY_INTERVAL_OPTIONS: SummaryIntervalOption[] = [
  { ms: 15_000, token: '15s', label: '15 seconds' },
  { ms: 30_000, token: '30s', label: '30 seconds' },
  { ms: 60_000, token: '1m', label: '1 minute' },
  { ms: 5 * 60_000, token: '5m', label: '5 minutes' },
  { ms: 15 * 60_000, token: '15m', label: '15 minutes' },
  { ms: 60 * 60_000, token: '1h', label: '1 hour' },
]

export const DEFAULT_SUMMARY_INTERVAL_MS = 30_000
export const SUMMARY_MAX_WAIT_MULTIPLIER = 3

const SUMMARY_INTERVAL_OPTION_BY_MS = new Map(
  SUMMARY_INTERVAL_OPTIONS.map((option) => [option.ms, option]),
)

export function normalizeSummaryIntervalMs(value: number, fallback = DEFAULT_SUMMARY_INTERVAL_MS): number {
  if (SUMMARY_INTERVAL_OPTION_BY_MS.has(value)) return value
  return SUMMARY_INTERVAL_OPTION_BY_MS.has(fallback) ? fallback : DEFAULT_SUMMARY_INTERVAL_MS
}

function parseTimeToken(raw: string): number | null {
  const trimmed = String(raw || '').trim().toLowerCase()
  if (!trimmed) return null

  const exact = SUMMARY_INTERVAL_OPTIONS.find((option) => option.token === trimmed || option.label === trimmed)
  if (exact) return exact.ms

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000
    }
  }

  const match = trimmed.match(/^(\d+)\s*([smh])$/)
  if (!match) return null

  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2]
  if (unit === 's') return value * 1000
  if (unit === 'm') return value * 60_000
  if (unit === 'h') return value * 60 * 60_000
  return null
}

export function parseSummaryIntervalInput(raw: string): number | undefined {
  const parsed = parseTimeToken(raw)
  if (parsed == null) return undefined
  if (!SUMMARY_INTERVAL_OPTION_BY_MS.has(parsed)) return undefined
  return parsed
}

export function getSummaryIntervalOption(ms: number): SummaryIntervalOption {
  return SUMMARY_INTERVAL_OPTION_BY_MS.get(normalizeSummaryIntervalMs(ms)) || SUMMARY_INTERVAL_OPTIONS[1]
}

export function summaryIntervalToken(ms: number): string {
  return getSummaryIntervalOption(ms).token
}

export function summaryIntervalLabel(ms: number): string {
  return getSummaryIntervalOption(ms).label
}

export function summaryIntervalMaxWaitMs(ms: number): number {
  const normalized = normalizeSummaryIntervalMs(ms)
  return normalized * SUMMARY_MAX_WAIT_MULTIPLIER
}

export function summaryIntervalTokensList(): string {
  return SUMMARY_INTERVAL_OPTIONS.map((option) => option.token).join('|')
}
