#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bundleCommentary(tempDir) {
  const entry = path.join(repoRoot, 'src', 'core', 'commentary.ts');
  const outfile = path.join(tempDir, 'commentary.cjs');
  buildSync({
    entryPoints: [entry],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(outfile);
}

function makeToolCallEvent(sessionId, summary) {
  return {
    sessionId,
    projectName: 'interval-regression',
    sessionTitle: 'interval control',
    agent: 'codex',
    source: 'cli',
    timestamp: Date.now(),
    type: 'tool_call',
    summary,
    details: {
      tool: 'read_file',
      input: { path: 'src/index.ts' },
    },
  };
}

function timerDelay(timer) {
  if (!timer || typeof timer !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(timer, '_idleTimeout')) return null;
  return Number(timer._idleTimeout);
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-commentary-interval-'));
  try {
    const { CommentaryEngine } = bundleCommentary(tempDir);
    const engine = new CommentaryEngine({ getKey: async () => undefined });

    let emittedCount = 0;
    let emittedValue = 0;
    engine.on('summary-interval-changed', (value) => {
      emittedCount += 1;
      emittedValue = Number(value || 0);
    });

    engine.setSummaryIntervalMs(3600000);
    engine.addEvent(makeToolCallEvent('session-a', 'Reading src/index.ts'));

    const stateBefore = engine.sessions.get('codex:session-a');
    assert(stateBefore, 'session state should exist after adding event');
    assert(timerDelay(stateBefore.idleTimer) === 3600000, 'idle timer should use selected summary interval');
    assert(timerDelay(stateBefore.maxTimer) === 10800000, 'max timer should be 3x selected interval');

    engine.setSummaryIntervalMs(30000);
    const stateAfter = engine.sessions.get('codex:session-a');
    assert(stateAfter, 'session state should still exist after interval update');
    assert(timerDelay(stateAfter.idleTimer) === 30000, 'idle timer should rearm to updated summary interval');
    assert(timerDelay(stateAfter.maxTimer) === 90000, 'max timer should rearm to 3x updated interval');
    assert(emittedCount >= 2, 'summary-interval-changed should emit for each effective interval update');
    assert(emittedValue === 30000, 'summary-interval-changed should emit normalized updated value');

    engine.pause();
    process.stdout.write('commentary interval test passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`commentary interval test failed: ${message}\n`);
  process.exit(1);
}

