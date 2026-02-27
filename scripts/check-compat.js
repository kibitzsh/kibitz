#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`compat check failed while running ${path.basename(scriptPath)}`);
  }
}

function readFileOrFail(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`missing required file: ${relativePath}`);
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function assertContainsAll(label, text, required) {
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    fail(`${label} is missing required tokens: ${missing.join(', ')}`);
  }
}

function main() {
  runNodeScript(path.join(repoRoot, 'scripts', 'test-platform-dispatch.js'));

  const requiredTokens = ['macOS', 'Windows', 'VS Code panel', 'Terminal CLI'];

  const readme = readFileOrFail('README.md');
  const supportMatrix = readFileOrFail(path.join('docs', 'SUPPORT_MATRIX.md'));
  const checklist = readFileOrFail(path.join('docs', 'COMPAT_CHECKLIST.md'));

  assertContainsAll('README.md', readme, requiredTokens);
  assertContainsAll('docs/SUPPORT_MATRIX.md', supportMatrix, requiredTokens);
  assertContainsAll('docs/COMPAT_CHECKLIST.md', checklist, requiredTokens);

  process.stdout.write('compat check passed\n');
}

main();
