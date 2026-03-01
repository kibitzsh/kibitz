#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-shared-settings-'));

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;

try {
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;

  const bundlePath = path.join(tempDir, 'shared-settings.cjs');
  buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'core', 'shared-settings.ts')],
    bundle: true,
    outfile: bundlePath,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });

  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(bundlePath);
  const {
    readSharedSummaryIntervalMs,
    persistSharedSummaryIntervalMs,
  } = mod;

  assert(readSharedSummaryIntervalMs() === 30000, 'default shared summary interval should be 30 seconds');

  persistSharedSummaryIntervalMs(3600000);
  const intervalPath = path.join(tempDir, '.kibitz', 'summary-interval');
  assert(fs.existsSync(intervalPath), 'shared summary interval file should be created');
  assert(readSharedSummaryIntervalMs() === 3600000, 'shared summary interval should restore persisted value');

  fs.writeFileSync(intervalPath, '1234', 'utf8');
  assert(readSharedSummaryIntervalMs() === 30000, 'invalid persisted interval should fall back to default');
  assert(readSharedSummaryIntervalMs(900000) === 900000, 'invalid persisted interval should respect valid fallback');

  process.stdout.write('summary interval shared persistence test passed\n');
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`summary interval shared persistence test failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (prevHome == null) delete process.env.HOME;
  else process.env.HOME = prevHome;

  if (prevUserProfile == null) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;

  fs.rmSync(tempDir, { recursive: true, force: true });
}

