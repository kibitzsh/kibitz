import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_SUMMARY_INTERVAL_MS, normalizeSummaryIntervalMs } from './summary-interval'

const SHARED_DIR = path.join(os.homedir(), '.kibitz')
const SUMMARY_INTERVAL_FILE = 'summary-interval'
const UPDATE_CLI_CACHE_FILE = 'update-cli-cache.json'
const UPDATE_EXTENSION_CACHE_FILE = 'update-extension-cache.json'

export interface UpdateCheckCache {
  checkedAt: number
  latestVersion?: string
}

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

function writeSharedJson(fileName: string, value: unknown): void {
  try {
    writeSharedValue(fileName, JSON.stringify(value))
  } catch {
    // Best-effort persistence.
  }
}

function readSharedJson<T>(fileName: string): T | undefined {
  try {
    const raw = readSharedValue(fileName)
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function normalizeUpdateCache(value: unknown): UpdateCheckCache | undefined {
  const candidate = value as UpdateCheckCache | undefined
  const checkedAt = Number(candidate?.checkedAt)
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return undefined
  const latestVersion = String(candidate?.latestVersion || '').trim()
  if (!latestVersion) {
    return { checkedAt }
  }
  return { checkedAt, latestVersion }
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

export function persistSharedCliUpdateCache(cache: UpdateCheckCache): void {
  const normalized = normalizeUpdateCache(cache)
  if (!normalized) return
  writeSharedJson(UPDATE_CLI_CACHE_FILE, normalized)
}

export function readSharedCliUpdateCache(): UpdateCheckCache | undefined {
  const raw = readSharedJson<UpdateCheckCache>(UPDATE_CLI_CACHE_FILE)
  return normalizeUpdateCache(raw)
}

export function persistSharedExtensionUpdateCache(cache: UpdateCheckCache): void {
  const normalized = normalizeUpdateCache(cache)
  if (!normalized) return
  writeSharedJson(UPDATE_EXTENSION_CACHE_FILE, normalized)
}

export function readSharedExtensionUpdateCache(): UpdateCheckCache | undefined {
  const raw = readSharedJson<UpdateCheckCache>(UPDATE_EXTENSION_CACHE_FILE)
  return normalizeUpdateCache(raw)
}
