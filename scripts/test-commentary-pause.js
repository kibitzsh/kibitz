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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    projectName: 'pause-regression',
    sessionTitle: 'pause flow',
    agent: 'codex',
    source: 'cli',
    timestamp: Date.now(),
    type: 'tool_call',
    summary,
    details: {
      tool: 'bash',
      command: summary,
    },
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-commentary-pause-'));
  try {
    const { CommentaryEngine } = bundleCommentary(tempDir);
    const engine = new CommentaryEngine({ getKey: async () => undefined });

    let generateCalls = 0;
    let doneCount = 0;

    const fakeProvider = {
      generate: async () => {
        generateCalls += 1;
        await delay(120);
        return `generated-${generateCalls}`;
      },
    };

    // Private fields are runtime properties after TS transpilation.
    engine.providers = {
      anthropic: fakeProvider,
      openai: fakeProvider,
    };

    engine.on('commentary-done', () => {
      doneCount += 1;
    });

    engine.addEvent(makeToolCallEvent('session-a', 'npm test'));
    engine.requestFlush('codex:session-a', true);

    // Queue a second session while the first generation is in flight.
    await delay(15);
    engine.addEvent(makeToolCallEvent('session-b', 'npm run build'));
    engine.requestFlush('codex:session-b', true);

    engine.pause();
    await delay(320);

    assert(generateCalls === 1, `pause should cancel queued batches, got ${generateCalls} generations`);
    assert(doneCount === 1, `only in-flight commentary should complete while paused, got ${doneCount}`);
    assert(Array.isArray(engine.flushQueue) && engine.flushQueue.length === 0, 'flush queue should be cleared on pause');

    engine.resume();
    engine.addEvent(makeToolCallEvent('session-c', 'npm run test:all'));
    engine.requestFlush('codex:session-c', true);
    await delay(220);

    assert(generateCalls === 2, 'resume should allow commentary generation again');

    process.stdout.write('commentary pause test passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`commentary pause test failed: ${message}\n`);
  process.exit(1);
});
