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

function bundleWatcher(tempDir) {
  const entry = path.join(repoRoot, 'src', 'core', 'watcher.ts');
  const outfile = path.join(tempDir, 'watcher.cjs');
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-watcher-sessionid-'));
  const fakeHome = path.join(tempDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  try {
    const projectDir = path.join(fakeHome, '.claude', 'projects', '-Users-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, 'fallback-file-name.jsonl');

    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'real-session-id-1234',
      cwd: '/Users/test/project',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    fs.writeFileSync(filePath, `${line}\n`, 'utf8');

    const { SessionWatcher } = bundleWatcher(tempDir);
    const watcher = new SessionWatcher();
    watcher.start();
    await delay(400);

    const sessions = watcher.getActiveSessions();
    watcher.stop();

    assert(Array.isArray(sessions) && sessions.length === 1, 'watcher should detect one active claude session');
    assert(
      sessions[0].id === 'real-session-id-1234',
      `watcher should use sessionId from log content (actual: ${sessions[0].id})`,
    );
    assert(
      sessions[0].id !== 'fallback-file-name',
      'watcher should not keep fallback filename session id when log has sessionId',
    );

    process.stdout.write('watcher session-id test passed\n');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`watcher session-id test failed: ${message}\n`);
  process.exit(1);
});
