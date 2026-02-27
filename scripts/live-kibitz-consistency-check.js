#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionWatcher } = require('../dist/core/watcher.js');
const { CommentaryEngine } = require('../dist/core/commentary.js');

const DURATION_MS = Number(process.argv[2] || 5 * 60 * 1000);
const TICK_MS = 15000;

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseRowTitle(raw) {
  const text = normalize(raw);
  if (!text) return '';
  return text.toLowerCase();
}

function loadCodexThreadTitles() {
  const statePath = path.join(os.homedir(), '.codex', '.codex-global-state.json');
  try {
    const json = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const titles = json?.['thread-titles']?.titles || {};
    const out = new Map();
    for (const [k, v] of Object.entries(titles)) {
      const key = String(k || '').trim().toLowerCase();
      const value = normalize(v);
      if (!key || !value) continue;
      out.set(key, value);
    }
    return out;
  } catch {
    return new Map();
  }
}

function isCommandLikeTitle(text) {
  const t = parseRowTitle(text);
  if (!t) return false;
  if (t.length > 140) return false;
  if (/^(read|cat|rg|grep|ls|sed|awk|find|git|npm|pnpm|yarn|node|python|pytest|cargo|go|cp|mv|rm|touch|open|cd)\b/.test(t)) {
    return true;
  }
  if (t.startsWith('use only these tags')
    || t.startsWith('include 3-5 rows max')
    || t.startsWith('each label should have')
    || t.startsWith('explain for non-developers')
    || t.startsWith('agent rewrote ')
    || t.startsWith('agent investigated ')
    || t.startsWith('still reading code after')
    || t.startsWith('solid approach.')
    || t.startsWith('not great.')
    || t.includes('verdict sentence')
    || t.includes('short bullets')
    || /^\d+\.\s+read the existing code/.test(t)) {
    return true;
  }
  return false;
}

function extractFirstCodexPromptTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type === 'event_msg' && obj?.payload?.type === 'user_message') {
        const msg = normalize(String(obj.payload?.message || ''));
        if (!msg) continue;
        const first = normalize(msg.split('\n')[0]);
        if (first) return first;
      }
      if (obj?.type === 'response_item'
        && obj?.payload?.type === 'message'
        && obj?.payload?.role === 'user'
        && Array.isArray(obj?.payload?.content)) {
        for (const block of obj.payload.content) {
          const text = normalize(typeof block?.text === 'string' ? block.text : block?.input_text);
          if (!text) continue;
          const first = normalize(text.split('\n')[0]);
          if (first) return first;
        }
      }
    }
  } catch {
    return '';
  }
  return '';
}

function splitSummary(summary) {
  return normalize(summary)
    .split(' → ')
    .map((part) => normalize(part))
    .filter(Boolean);
}

const keyResolver = {
  async getKey() {
    return 'subscription';
  },
};

const watcher = new SessionWatcher();
const engine = new CommentaryEngine(keyResolver);

const stubProvider = {
  async generate(_systemPrompt, userPrompt, _apiKey, _model, onChunk) {
    const actionMatch = String(userPrompt || '').match(/Actions \((\d+)\):/);
    const actionCount = actionMatch ? Number(actionMatch[1]) : 0;
    const text = `Observed ${actionCount} actions in this session.`;
    if (typeof onChunk === 'function') onChunk(text);
    return text;
  },
};
engine.providers = { anthropic: stubProvider, openai: stubProvider };

const stateBySession = new Map();
const anomalies = [];
let commentaryStarts = 0;
let commentaryDones = 0;
let watcherEvents = 0;

function ensureSessionState(sessionId) {
  if (!stateBySession.has(sessionId)) {
    stateBySession.set(sessionId, {
      summaries: [],
      firstCommentaryTitle: '',
      commentaryCount: 0,
      latestFilePath: '',
    });
  }
  return stateBySession.get(sessionId);
}

watcher.on('event', (event) => {
  watcherEvents++;
  const sessionId = String(event.sessionId || '').toLowerCase();
  if (!sessionId) return;
  const state = ensureSessionState(sessionId);
  const summary = normalize(event.summary);
  if (summary) {
    state.summaries.push(summary);
    if (state.summaries.length > 200) state.summaries.shift();
  }
  engine.addEvent(event);
});

engine.on('commentary-start', (entry) => {
  commentaryStarts++;
  const sessionId = String(entry.sessionId || '').toLowerCase();
  if (!sessionId) return;
  const state = ensureSessionState(sessionId);
  state.commentaryCount += 1;

  const observedTitle = normalize(entry.sessionTitle);
  const observedTitleNorm = parseRowTitle(observedTitle);

  const activeSessions = watcher.getActiveSessions();
  const current = activeSessions.find((s) => String(s.id || '').toLowerCase() === sessionId);
  if (current?.filePath) state.latestFilePath = current.filePath;

  if (!state.firstCommentaryTitle && observedTitle) {
    state.firstCommentaryTitle = observedTitle;
  } else if (state.firstCommentaryTitle && observedTitle && parseRowTitle(state.firstCommentaryTitle) !== observedTitleNorm) {
    anomalies.push({
      type: 'session_title_changed',
      sessionId,
      before: state.firstCommentaryTitle,
      after: observedTitle,
    });
  }

  const threadTitles = loadCodexThreadTitles();
  const explicitTitle = threadTitles.get(sessionId);
  if (explicitTitle && observedTitle && parseRowTitle(explicitTitle) !== observedTitleNorm) {
    anomalies.push({
      type: 'explicit_title_mismatch',
      sessionId,
      expected: explicitTitle,
      observed: observedTitle,
    });
  }

  if (!explicitTitle && state.latestFilePath) {
    const rawPromptTitle = extractFirstCodexPromptTitle(state.latestFilePath);
    if (rawPromptTitle && isCommandLikeTitle(rawPromptTitle) && observedTitle && !isCommandLikeTitle(observedTitle)) {
      anomalies.push({
        type: 'borrowed_nonlocal_title',
        sessionId,
        promptTitle: rawPromptTitle,
        observed: observedTitle,
      });
    }
  }

  const summaryParts = splitSummary(entry.eventSummary);
  for (const part of summaryParts) {
    if (!state.summaries.includes(part)) {
      anomalies.push({
        type: 'event_summary_not_in_session',
        sessionId,
        summaryPart: part,
      });
      break;
    }
  }
});

engine.on('commentary-done', () => {
  commentaryDones++;
});

engine.on('error', (err) => {
  anomalies.push({
    type: 'engine_error',
    message: String(err && err.message ? err.message : err),
  });
});

watcher.start();

const startTs = Date.now();
const tickTimer = setInterval(() => {
  const elapsedSec = Math.round((Date.now() - startTs) / 1000);
  const sessionCount = watcher.getActiveSessions().length;
  process.stdout.write(
    `[live-check] t=${elapsedSec}s sessions=${sessionCount} watcherEvents=${watcherEvents} starts=${commentaryStarts} done=${commentaryDones} anomalies=${anomalies.length}\n`,
  );
}, TICK_MS);

setTimeout(() => {
  clearInterval(tickTimer);
  watcher.stop();

  const sessions = watcher.getActiveSessions();
  const summary = {
    durationMs: DURATION_MS,
    watcherEvents,
    commentaryStarts,
    commentaryDones,
    activeSessionsAtEnd: sessions.length,
    uniqueSessionsSeen: stateBySession.size,
    anomalies,
  };

  process.stdout.write(`[live-check] summary ${JSON.stringify(summary, null, 2)}\n`);
  process.exit(anomalies.length > 0 ? 1 : 0);
}, DURATION_MS);
