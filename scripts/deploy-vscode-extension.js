#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const distPath = path.join(repoRoot, 'dist');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    fail(`${label} not found: ${targetPath}`);
  }
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function copyIfExists(source, destination) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, destination);
  }
}

function deployToRoot(extensionsRoot, extensionDirName, extensionPrefix) {
  if (!fs.existsSync(extensionsRoot)) return null;

  const entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(extensionPrefix)) continue;
    removeIfExists(path.join(extensionsRoot, entry.name));
  }

  const targetDir = path.join(extensionsRoot, extensionDirName);
  fs.mkdirSync(targetDir, { recursive: true });

  const targetDist = path.join(targetDir, 'dist');
  removeIfExists(targetDist);
  fs.cpSync(distPath, targetDist, { recursive: true });
  fs.copyFileSync(pkgPath, path.join(targetDir, 'package.json'));

  copyIfExists(path.join(repoRoot, 'README.md'), path.join(targetDir, 'README.md'));
  copyIfExists(path.join(repoRoot, 'LICENSE'), path.join(targetDir, 'LICENSE'));
  copyIfExists(path.join(repoRoot, 'CHANGELOG.md'), path.join(targetDir, 'CHANGELOG.md'));

  return targetDir;
}

function main() {
  ensureExists(pkgPath, 'package.json');
  ensureExists(distPath, 'dist');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.publisher || !pkg.name || !pkg.version) {
    fail('package.json must define publisher, name, and version');
  }

  const extensionPrefix = `${pkg.publisher}.${pkg.name}-`;
  const extensionDirName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];

  const deployed = [];
  for (const root of roots) {
    const target = deployToRoot(root, extensionDirName, extensionPrefix);
    if (target) deployed.push(target);
  }

  if (deployed.length === 0) {
    fail('No VS Code/Cursor extensions directory found');
  }

  console.log('Deployed Kibitz extension to:');
  for (const dir of deployed) {
    console.log(`- ${dir}`);
  }
  console.log('Reload VS Code/Cursor window to activate the updated extension.');
}

main();
