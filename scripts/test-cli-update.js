#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');

function loadCliModule(tempDir) {
  const entry = path.join(repoRoot, 'src', 'cli', 'index.ts');
  const bundlePath = path.join(tempDir, 'cli.cjs');

  buildSync({
    entryPoints: [entry],
    bundle: true,
    outfile: bundlePath,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });

  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(bundlePath);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-test-cli-update-'));
  try {
    const cli = loadCliModule(tempDir);
    const now = Date.now();
    const ttlMs = 24 * 60 * 60 * 1000;

    let fetchCalls = 0;
    let lastWrittenCache = null;

    const statusFromFreshCache = await cli.resolveCliUpdateStatus({
      currentVersion: '0.0.8',
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return '0.0.9';
      },
      forceFresh: false,
      now,
      readCache: () => ({ checkedAt: now - 1_000, latestVersion: '0.0.9' }),
      ttlMs,
      writeCache: (cache) => {
        lastWrittenCache = cache;
      },
    });
    assert.strictEqual(statusFromFreshCache.state, 'update-available', 'fresh cache should still report update');
    assert.strictEqual(statusFromFreshCache.source, 'cache', 'fresh cache should be used');
    assert.strictEqual(fetchCalls, 0, 'fresh cache should avoid network call');
    assert.strictEqual(lastWrittenCache, null, 'fresh cache should not rewrite cache');

    const statusFromStaleCache = await cli.resolveCliUpdateStatus({
      currentVersion: '0.0.8',
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return '0.1.0';
      },
      forceFresh: false,
      now,
      readCache: () => ({ checkedAt: now - ttlMs - 1, latestVersion: '0.0.8' }),
      ttlMs,
      writeCache: (cache) => {
        lastWrittenCache = cache;
      },
    });
    assert.strictEqual(statusFromStaleCache.state, 'update-available', 'stale cache should refresh and find update');
    assert.strictEqual(statusFromStaleCache.source, 'network', 'stale cache should use network');
    assert.strictEqual(fetchCalls, 1, 'stale cache should trigger exactly one network call');
    assert(lastWrittenCache, 'stale cache path should write cache');
    assert.strictEqual(lastWrittenCache.latestVersion, '0.1.0', 'written cache should store fetched latest');

    const statusForceFresh = await cli.resolveCliUpdateStatus({
      currentVersion: '0.1.0',
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return '0.1.0';
      },
      forceFresh: true,
      now,
      readCache: () => ({ checkedAt: now - 500, latestVersion: '9.9.9' }),
      ttlMs,
      writeCache: () => {},
    });
    assert.strictEqual(statusForceFresh.state, 'up-to-date', 'force fresh should ignore cache and compare fetched value');
    assert.strictEqual(statusForceFresh.source, 'network', 'force fresh should use network');
    assert.strictEqual(fetchCalls, 2, 'force fresh should trigger network call');

    const statusUnavailable = await cli.resolveCliUpdateStatus({
      currentVersion: '0.1.0',
      fetchLatestVersion: async () => undefined,
      forceFresh: true,
      now,
      readCache: () => undefined,
      ttlMs,
      writeCache: () => {},
    });
    assert.strictEqual(statusUnavailable.state, 'unavailable', 'missing fetched version should be unavailable');

    process.stdout.write('cli update tests passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`cli update tests failed: ${message}\n`);
  process.exit(1);
});
