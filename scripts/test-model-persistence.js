#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const mod = require('../dist/vscode/persistence.js');
const {
  MODEL_STATE_FILENAME,
  PRESET_STATE_FILENAME,
  persistModel,
  persistPreset,
  readPersistedModel,
  readPersistedPreset,
} = mod;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-persistence-'));

try {
  assert(readPersistedModel(tempDir) === undefined, 'empty storage should have no model');

  persistModel(tempDir, 'gpt-4o');
  assert(fs.existsSync(path.join(tempDir, MODEL_STATE_FILENAME)), 'model file should be created');
  assert(
    readPersistedModel(tempDir, 'claude-opus-4-6') === 'gpt-4o',
    'disk model should override fallback',
  );

  fs.writeFileSync(path.join(tempDir, MODEL_STATE_FILENAME), 'not-a-real-model', 'utf8');
  assert(
    readPersistedModel(tempDir, 'claude-sonnet-4-6') === 'claude-sonnet-4-6',
    'fallback should be used when disk value is invalid',
  );

  persistPreset(tempDir, 'critical-coder');
  assert(fs.existsSync(path.join(tempDir, PRESET_STATE_FILENAME)), 'preset file should be created');
  assert(
    readPersistedPreset(tempDir, 'auto') === 'critical-coder',
    'preset should be restored from disk',
  );

  console.log('Model persistence smoke test: PASS');
  process.exit(0);
} catch (error) {
  console.error('Model persistence smoke test: FAIL');
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
