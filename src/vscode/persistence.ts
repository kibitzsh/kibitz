import * as fs from 'fs'
import * as path from 'path'
import { MODELS, ModelId } from '../core/types'

export const MODEL_STATE_FILENAME = 'kibitz.model'
export const PRESET_STATE_FILENAME = 'kibitz.preset'

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
