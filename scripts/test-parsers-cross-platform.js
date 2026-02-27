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

function bundleRequire(entryFile, outFile) {
  buildSync({
    entryPoints: [entryFile],
    bundle: true,
    outfile: outFile,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(outFile);
}

function testCodexParserWindowsPath(parseCodexLine) {
  const line = JSON.stringify({
    timestamp: '2026-02-27T03:00:00.000Z',
    type: 'session_meta',
    payload: {
      cwd: 'C:\\Users\\vasily\\projects\\kibitz',
      model_provider: 'openai',
      cli_version: '1.0.0',
    },
  });
  const filePath = 'C:\\Users\\vasily\\.codex\\sessions\\2026\\02\\27\\rollout-2026-02-27T03-00-00-019c9c2c-be94-7653-8e7c-99686949d55e.jsonl';
  const events = parseCodexLine(line, filePath);
  assert(Array.isArray(events) && events.length > 0, 'codex parser should produce event for session_meta');
  const event = events[0];
  assert(event.sessionId === '019c9c2c-be94-7653-8e7c-99686949d55e', 'codex parser should extract UUID session id from Windows path');
  assert(event.projectName === 'kibitz', 'codex parser should extract project name from Windows cwd');
}

function testClaudeParserWindowsPath(parseClaudeLine) {
  const filePath = 'C:\\Users\\vasily\\.claude\\projects\\-Users-vasily-projects-room\\session-123.jsonl';

  const noCwdLine = JSON.stringify({
    timestamp: '2026-02-27T03:00:00.000Z',
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'hello from assistant' }],
    },
  });
  const noCwdEvents = parseClaudeLine(noCwdLine, filePath);
  assert(Array.isArray(noCwdEvents) && noCwdEvents.length > 0, 'claude parser should produce assistant text events');
  assert(noCwdEvents[0].sessionId === 'session-123', 'claude parser should extract session id from Windows file path');
  assert(noCwdEvents[0].projectName === 'room', 'claude parser should extract project name from encoded Windows project dir');

  const withCwdLine = JSON.stringify({
    timestamp: '2026-02-27T03:00:01.000Z',
    type: 'assistant',
    cwd: 'C:\\Users\\vasily\\projects\\kibitz',
    message: {
      content: [{ type: 'text', text: 'assistant with cwd' }],
    },
  });
  const withCwdEvents = parseClaudeLine(withCwdLine, filePath);
  assert(withCwdEvents[0].projectName === 'kibitz', 'claude parser should extract project from Windows cwd');

  const toolUseLine = JSON.stringify({
    timestamp: '2026-02-27T03:00:02.000Z',
    type: 'assistant',
    cwd: 'C:\\Users\\vasily\\projects\\kibitz',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: 'C:\\Users\\vasily\\projects\\kibitz\\src\\index.ts' },
      }],
    },
  });
  const toolEvents = parseClaudeLine(toolUseLine, filePath);
  assert(toolEvents[0].summary.includes('.../src/index.ts'), 'claude parser should shorten Windows paths in summaries');
}

function testCodexParserUnixPath(parseCodexLine) {
  const line = JSON.stringify({
    timestamp: '2026-02-27T03:00:00.000Z',
    type: 'session_meta',
    payload: {
      cwd: '/Users/vasily/projects/kibitz',
      model_provider: 'openai',
      cli_version: '1.0.0',
    },
  });
  const filePath = '/Users/vasily/.codex/sessions/2026/02/27/rollout-2026-02-27T03-00-00-019c9c2c-be94-7653-8e7c-99686949d55e.jsonl';
  const events = parseCodexLine(line, filePath);
  assert(events[0].sessionId === '019c9c2c-be94-7653-8e7c-99686949d55e', 'codex parser should extract UUID from Unix path');
  assert(events[0].projectName === 'kibitz', 'codex parser should extract project from Unix cwd');
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-parser-test-'));
  try {
    const codexMod = bundleRequire(
      path.join(repoRoot, 'src', 'core', 'parsers', 'codex.ts'),
      path.join(tempDir, 'codex-parser.cjs'),
    );
    const claudeMod = bundleRequire(
      path.join(repoRoot, 'src', 'core', 'parsers', 'claude.ts'),
      path.join(tempDir, 'claude-parser.cjs'),
    );

    assert(typeof codexMod.parseCodexLine === 'function', 'parseCodexLine should export');
    assert(typeof claudeMod.parseClaudeLine === 'function', 'parseClaudeLine should export');

    testCodexParserWindowsPath(codexMod.parseCodexLine);
    testClaudeParserWindowsPath(claudeMod.parseClaudeLine);
    testCodexParserUnixPath(codexMod.parseCodexLine);

    process.stdout.write('parser cross-platform tests passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`parser cross-platform tests failed: ${message}\n`);
  process.exit(1);
}
