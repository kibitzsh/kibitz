import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_SUMMARY_INTERVAL_MS, normalizeSummaryIntervalMs } from './summary-interval'

const SHARED_DIR = path.join(os.homedir(), '.kibitz')
const SUMMARY_INTERVAL_FILE = 'summary-interval'

function sharedSettingPath(fileName: string, ensureDir = false): string {
  if (ensureDir && !fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true })
  }
  return path.join(SHARED_DIR, fileName)
}

function writeSharedValue(fileName: string, value: string): void {
  try {
    const filePath = sharedSettingPath(fileName, true)
    fs.writeFileSync(filePath, value, 'utf8')
  } catch {
    // Best-effort persistence.
  }
}

function readSharedValue(fileName: string): string | undefined {
  try {
    const filePath = sharedSettingPath(fileName)
    if (!fs.existsSync(filePath)) return undefined
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

export function persistSharedSummaryIntervalMs(intervalMs: number): void {
  const normalized = normalizeSummaryIntervalMs(intervalMs)
  writeSharedValue(SUMMARY_INTERVAL_FILE, String(normalized))
}

export function readSharedSummaryIntervalMs(fallback = DEFAULT_SUMMARY_INTERVAL_MS): number {
  const raw = readSharedValue(SUMMARY_INTERVAL_FILE)
  if (!raw) return normalizeSummaryIntervalMs(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return normalizeSummaryIntervalMs(fallback)
  return normalizeSummaryIntervalMs(parsed, fallback)
}
