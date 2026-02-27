import * as fs from 'fs'
import * as path from 'path'
import { COMMENTARY_STYLE_OPTIONS, CommentaryStyleId, MODELS, ModelId } from '../core/types'

export const MODEL_STATE_FILENAME = 'kibitz.model'
export const PRESET_STATE_FILENAME = 'kibitz.preset'
export const FORMAT_STYLES_STATE_FILENAME = 'kibitz.format-styles'

export function isValidModelId(value: string): value is ModelId {
  return MODELS.some(model => model.id === value)
}

function stateFilePath(storageDir: string, fileName: string, ensureDir = false): string {
  if (ensureDir && !fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true })
  }
  return path.join(storageDir, fileName)
}

function readStateValue(storageDir: string, fileName: string): string | undefined {
  try {
    const filePath = stateFilePath(storageDir, fileName)
    if (!fs.existsSync(filePath)) return undefined
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

function writeStateValue(storageDir: string, fileName: string, value: string): void {
  try {
    const filePath = stateFilePath(storageDir, fileName, true)
    fs.writeFileSync(filePath, value, 'utf8')
  } catch {
    // Best-effort crash-safe persistence.
  }
}

export function persistModel(storageDir: string, model: ModelId): void {
  writeStateValue(storageDir, MODEL_STATE_FILENAME, model)
}

export function persistPreset(storageDir: string, preset: string): void {
  writeStateValue(storageDir, PRESET_STATE_FILENAME, preset)
}

export function persistFormatStyles(storageDir: string, styleIds: readonly CommentaryStyleId[]): void {
  const allStyleIds = new Set(COMMENTARY_STYLE_OPTIONS.map((option) => option.id))
  const normalized: CommentaryStyleId[] = []
  for (const styleId of styleIds) {
    if (!allStyleIds.has(styleId)) continue
    if (normalized.includes(styleId)) continue
    normalized.push(styleId)
  }
  writeStateValue(storageDir, FORMAT_STYLES_STATE_FILENAME, JSON.stringify(normalized))
}

export function readPersistedModel(storageDir: string, fallback?: ModelId): ModelId | undefined {
  const diskModel = readStateValue(storageDir, MODEL_STATE_FILENAME)
  if (diskModel && isValidModelId(diskModel)) return diskModel

  if (fallback && isValidModelId(fallback)) {
    return fallback
  }
  return undefined
}

export function readPersistedPreset(storageDir: string, fallback = 'auto'): string {
  return readStateValue(storageDir, PRESET_STATE_FILENAME) || fallback
}

export function readPersistedFormatStyles(
  storageDir: string,
  fallback?: readonly CommentaryStyleId[],
): CommentaryStyleId[] {
  const known = new Set(COMMENTARY_STYLE_OPTIONS.map((option) => option.id))
  const raw = readStateValue(storageDir, FORMAT_STYLES_STATE_FILENAME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const valid = parsed
          .map((value) => String(value || '').trim() as CommentaryStyleId)
          .filter((value): value is CommentaryStyleId => known.has(value))
        if (valid.length > 0) return valid
      }
    } catch {
      // Ignore malformed saved state.
    }
  }

  if (fallback && fallback.length > 0) {
    const deduped: CommentaryStyleId[] = []
    for (const value of fallback) {
      if (!known.has(value)) continue
      if (deduped.includes(value)) continue
      deduped.push(value)
    }
    if (deduped.length > 0) return deduped
  }

  return COMMENTARY_STYLE_OPTIONS.map((option) => option.id)
}
