#!/usr/bin/env node
'use strict';

const { SessionWatcher } = require('../dist/core/watcher.js');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  orange: '\x1b[38;5;214m',
  cyan: '\x1b[36m',
};

function color(text, code) {
  return code + text + ANSI.reset;
}

function isCodeLikeName(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return true;
  if (/^[0-9a-f]{8}$/.test(s)) return true;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s)) return true;
  if (/^session[\s:_-]*[0-9a-f]{8,}$/.test(s)) return true;
  if (/^turn[\s:_-]*[0-9a-f]{8,}$/.test(s)) return true;
  if (/^rollout-\d{4}-\d{2}-\d{2}t\d{2}[-:]\d{2}[-:]\d{2}[-a-z0-9]+(?:\.jsonl)?$/.test(s)) return true;
  return false;
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + '...';
}

function pad(text, width) {
  const s = String(text || '');
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function visibleName(session) {
  const title = String(session.sessionTitle || '').trim();
  if (title && !isCodeLikeName(title)) return title;
  const project = String(session.projectName || '').trim();
  if (project && !isCodeLikeName(project)) return project;
  return `${session.agent} session`;
}

function agentLabel(agent) {
  const up = String(agent || '').toUpperCase();
  if (agent === 'codex') return color(up, ANSI.green);
  if (agent === 'claude') return color(up, ANSI.orange);
  return up;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function printHeader() {
  console.log(color('Kibitz Session Name Visual Check', ANSI.bold));
  console.log(color('Goal: NAME must be readable text, not an ID/code.', ANSI.dim));
  console.log('');
  console.log(
    color(pad('AGENT', 10), ANSI.cyan) + ' ' +
    color(pad('TIME', 10), ANSI.cyan) + ' ' +
    color(pad('PROJECT', 18), ANSI.cyan) + ' ' +
    color(pad('SESSION NAME', 56), ANSI.cyan) + ' ' +
    color(pad('RAW ID', 10), ANSI.cyan) + ' ' +
    color('CHECK', ANSI.cyan),
  );
}

function renderSessions(watcher) {
  const sessions = watcher.getActiveSessions().sort((a, b) => b.lastActivity - a.lastActivity);
  const active = sessions.filter((s) => s.agent === 'codex' || s.agent === 'claude');

  process.stdout.write('\x1Bc');
  printHeader();

  if (active.length === 0) {
    console.log(color('No active sessions found.', ANSI.dim));
    return;
  }

  let failed = 0;
  for (const s of active) {
    const name = visibleName(s);
    const bad = isCodeLikeName(name);
    if (bad) failed++;
    const check = bad ? color('FAIL', ANSI.red) : color('PASS', ANSI.green);

    console.log(
      pad(agentLabel(s.agent), 10) + ' ' +
      pad(formatTime(s.lastActivity), 10) + ' ' +
      pad(truncate(s.projectName || '', 18), 18) + ' ' +
      pad(truncate(name, 56), 56) + ' ' +
      pad(String(s.id || '').slice(0, 8), 10) + ' ' +
      check,
    );
  }

  console.log('');
  if (failed === 0) {
    console.log(color('Result: PASS (all visible session names are human-readable)', ANSI.green));
  } else {
    console.log(color(`Result: FAIL (${failed} session name(s) still look like IDs)`, ANSI.red));
  }
  console.log(color('Tip: run with --once for single snapshot.', ANSI.dim));
}

function main() {
  const once = process.argv.includes('--once');
  const watcher = new SessionWatcher();
  watcher.start();

  if (once) {
    setTimeout(() => {
      renderSessions(watcher);
      watcher.stop();
    }, 300);
    return;
  }

  renderSessions(watcher);
  const timer = setInterval(() => renderSessions(watcher), 1000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    watcher.stop();
    process.exit(0);
  });
}

main();
