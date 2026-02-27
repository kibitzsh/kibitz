#!/usr/bin/env node
// Publishes the CLI as @kibitzsh/kibitz on npm.
// vsce requires name="kibitz" (no scope), so we swap temporarily.

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
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
