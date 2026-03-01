#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');

function loadUpdatesModule(tempDir) {
  const entry = path.join(repoRoot, 'src', 'core', 'updates.ts');
  const bundlePath = path.join(tempDir, 'updates.cjs');

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

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-test-updates-'));
  try {
    const updates = loadUpdatesModule(tempDir);

    assert.strictEqual(updates.compareVersions('0.0.8', '0.0.8'), 0, 'equal versions should compare to 0');
    assert.strictEqual(updates.compareVersions('0.0.9', '0.0.8'), 1, 'higher patch should compare greater');
    assert.strictEqual(updates.compareVersions('1.2', '1.2.1'), -1, 'shorter numeric version should compare lower');
    assert.strictEqual(updates.compareVersions('1.0.0', '1.0.0-beta'), 1, 'release should compare higher than prerelease token');
    assert.strictEqual(updates.isRemoteNewer('0.0.8', '0.0.9'), true, 'remote higher version should be newer');
    assert.strictEqual(updates.isRemoteNewer('0.0.8', '0.0.8'), false, 'same version should not be newer');

    assert.strictEqual(
      updates.parseMarketplaceExtensionVersion({
        results: [{ extensions: [{ versions: [{ version: '0.0.9' }, { version: '0.0.8' }] }] }],
      }),
      '0.0.9',
      'marketplace parser should return first version',
    );
    assert.strictEqual(
      updates.parseMarketplaceExtensionVersion({ results: [{ extensions: [{}] }] }),
      undefined,
      'marketplace parser should tolerate missing versions',
    );
    assert.strictEqual(
      updates.parseMarketplaceExtensionVersion(null),
      undefined,
      'marketplace parser should tolerate malformed payload',
    );

    assert.strictEqual(updates.parseNpmLatestVersion({ latest: '0.0.9' }), '0.0.9', 'npm parser should read latest tag');
    assert.strictEqual(updates.parseNpmLatestVersion({ latest: '' }), undefined, 'npm parser should reject empty latest');
    assert.strictEqual(updates.parseNpmLatestVersion({}), undefined, 'npm parser should tolerate missing latest');

    process.stdout.write('updates tests passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`updates tests failed: ${message}\n`);
  process.exit(1);
}
