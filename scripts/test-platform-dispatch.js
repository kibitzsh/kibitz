#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getProviderCliCommand,
  resolveCmdNodeScript,
} = require('../dist/core/platform-support.js');
const {
  buildExistingDispatchCommand,
  buildInteractiveDispatchCommand,
} = require('../dist/core/session-dispatch.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual:   ${actual}`);
  }
}

function assertArrayEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message}\nExpected: ${b}\nActual:   ${a}`);
  }
}

function testProviderCommandMapping() {
  assertEqual(getProviderCliCommand('codex', 'win32'), 'codex.cmd', 'codex on win32 must use .cmd');
  assertEqual(getProviderCliCommand('claude', 'win32'), 'claude.cmd', 'claude on win32 must use .cmd');
  assertEqual(getProviderCliCommand('codex', 'darwin'), 'codex', 'codex on darwin must not use .cmd');
  assertEqual(getProviderCliCommand('claude', 'darwin'), 'claude', 'claude on darwin must not use .cmd');
}

function testExistingDispatchArgs() {
  const codex = buildExistingDispatchCommand(
    {
      kind: 'existing',
      agent: 'codex',
      sessionId: 'abc-session',
    },
    'Fix unclear prompt',
    'darwin',
  );

  assertEqual(codex.command, 'codex', 'codex existing dispatch should use codex on darwin');
  assertArrayEqual(
    codex.args,
    ['exec', 'resume', '--json', '--skip-git-repo-check', 'abc-session', 'Fix unclear prompt'],
    'codex existing dispatch args mismatch',
  );

  const claude = buildExistingDispatchCommand(
    {
      kind: 'existing',
      agent: 'claude',
      sessionId: 'claude-session',
    },
    'Fix unclear prompt',
    'win32',
  );

  assertEqual(claude.command, 'claude.cmd', 'claude existing dispatch should use claude.cmd on win32');
  assertArrayEqual(
    claude.args,
    ['-p', 'Fix unclear prompt', '--verbose', '--output-format', 'stream-json', '--resume', 'claude-session'],
    'claude existing dispatch args mismatch',
  );
}

function testInteractiveArgs() {
  const codexWin = buildInteractiveDispatchCommand('codex', 'Create new session', 'win32');
  assertEqual(codexWin.command, 'codex.cmd', 'interactive codex command should use .cmd on win32');
  assertArrayEqual(codexWin.args, ['Create new session'], 'interactive codex args mismatch');

  const claudeMac = buildInteractiveDispatchCommand('claude', 'Create new session', 'darwin');
  assertEqual(claudeMac.command, 'claude', 'interactive claude command should use unix binary on darwin');
  assertArrayEqual(claudeMac.args, ['Create new session'], 'interactive claude args mismatch');
}

function testCmdToScriptResolution() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-cmd-test-'));
  const cmdPath = path.join(tempDir, 'codex.cmd');
  const jsPath = path.join(tempDir, 'codex.js');

  fs.writeFileSync(jsPath, 'console.log("ok")\n', 'utf8');
  fs.writeFileSync(
    cmdPath,
    '@echo off\r\nset dp0=%~dp0\r\n"%dp0%\\codex.js" %*\r\n',
    'utf8',
  );

  const resolved = resolveCmdNodeScript(cmdPath);
  assert(resolved && resolved.endsWith('codex.js'), 'resolveCmdNodeScript should return underlying .js path');

  const unresolved = resolveCmdNodeScript(path.join(tempDir, 'not-a-wrapper.cmd'));
  assertEqual(unresolved, null, 'resolveCmdNodeScript should return null for unknown wrapper');

  fs.rmSync(tempDir, { recursive: true, force: true });
}

function main() {
  testProviderCommandMapping();
  testExistingDispatchArgs();
  testInteractiveArgs();
  testCmdToScriptResolution();
  process.stdout.write('platform dispatch tests passed\n');
}

try {
  main();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`platform dispatch tests failed: ${message}\n`);
  process.exit(1);
}
