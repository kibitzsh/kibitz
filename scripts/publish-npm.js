#!/usr/bin/env node
// Publishes the CLI as @kibitzsh/kibitz on npm.
// vsce requires name="kibitz" (no scope), so we swap temporarily.

const { readFileSync, writeFileSync } = require('fs');
const { execSync } = require('child_process');
const { resolve } = require('path');

const pkgPath = resolve(__dirname, '../package.json');
const original = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);

const scoped = {
  ...pkg,
  name: '@kibitzsh/kibitz',
  publishConfig: { access: 'public' },
  files: ['dist/cli', 'dist/core', 'package.json'],
};

try {
  writeFileSync(pkgPath, JSON.stringify(scoped, null, 2) + '\n');
  console.log('→ Publishing as @kibitzsh/kibitz …');
  execSync('npm publish', { stdio: 'inherit' });
  console.log('✓ Published');
} finally {
  writeFileSync(pkgPath, original);
  console.log('→ package.json restored');
}
