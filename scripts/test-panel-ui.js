#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');

const repoRoot = path.resolve(__dirname, '..');

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupPanelModule(tempDir) {
  const panelEntry = path.join(repoRoot, 'src', 'vscode', 'panel.ts');
  const bundlePath = path.join(tempDir, 'panel.cjs');

  buildSync({
    entryPoints: [panelEntry],
    bundle: true,
    outfile: bundlePath,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    logLevel: 'silent',
  });

  const stubDir = path.join(tempDir, 'node_modules', 'vscode');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'module.exports = {}\n', 'utf8');

  const oldNodePath = process.env.NODE_PATH || '';
  process.env.NODE_PATH = [path.join(tempDir, 'node_modules'), oldNodePath].filter(Boolean).join(path.delimiter);
  Module._initPaths();

  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(bundlePath);
  if (!mod || typeof mod.getInlineHtml !== 'function') {
    throw new Error('Failed to load getInlineHtml from panel module');
  }
  return mod.getInlineHtml;
}

function lastPosted(posted, type) {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i] && posted[i].type === type) return posted[i];
  }
  return null;
}

function sendWindowMessage(window, payload) {
  window.dispatchEvent(new window.MessageEvent('message', { data: payload }));
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibitz-ui-test-'));
  try {
    const getInlineHtml = setupPanelModule(tempDir);

    const providers = [
      { provider: 'anthropic', label: 'Claude', available: true, version: '1.0.0' },
      { provider: 'openai', label: 'Codex', available: true, version: '1.0.0' },
    ];
    const html = getInlineHtml(providers, '0.0.3', 'gpt-4o', 'auto');

    const posted = [];
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.acquireVsCodeApi = () => ({
          postMessage: (msg) => posted.push(msg),
          setState: () => {},
          getState: () => null,
        });
      },
    });

    const { window } = dom;
    const document = window.document;

    await tick();

    const targetBadges = document.getElementById('target-badges');
    const composerInput = document.getElementById('composer-input');
    const composerSend = document.getElementById('composer-send');
    const styleMenuBtn = document.getElementById('style-menu-btn');
    const styleMenu = document.getElementById('style-menu');
    const summaryIntervalSelect = document.getElementById('summary-interval-select');
    const modelSelect = document.getElementById('model-select');
    const sessionsBadge = document.getElementById('sessions');
    const feed = document.getElementById('feed');

    assert(targetBadges, 'target badges should exist');
    assert(composerInput, 'composer input should exist');
    assert(composerSend, 'composer send should exist');
    assert(styleMenuBtn, 'style menu button should exist');
    assert(styleMenu, 'style menu should exist');
    assert(summaryIntervalSelect, 'summary interval select should exist');
    assert(modelSelect, 'model select should exist');

    function badgeTexts() {
      return Array.from(targetBadges.querySelectorAll('.target-badge')).map((node) => node.textContent.trim());
    }

    function clickBadgeByText(partial) {
      const nodes = Array.from(targetBadges.querySelectorAll('.target-badge'));
      const target = nodes.find((node) => (node.textContent || '').includes(partial));
      assert(target, `badge with text "${partial}" should exist`);
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }

    // New-session badge should exist and reflect current model provider.
    const initialBadges = badgeTexts();
    assert(initialBadges.length >= 1, 'should render at least one target badge');
    assert(initialBadges[0].includes('/1 New session (Codex)'), 'first badge should be new codex session for GPT model');
    assert((styleMenuBtn.textContent || '').includes('(8)'), 'style menu button should show default style count');
    assert.strictEqual(summaryIntervalSelect.value, '30000', 'summary interval default should be 30 seconds');

    // Interval dropdown should emit summary-interval updates.
    posted.length = 0;
    summaryIntervalSelect.value = '3600000';
    summaryIntervalSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    const intervalMsg = lastPosted(posted, 'summary-interval');
    assert(intervalMsg, 'changing summary interval should emit summary-interval');
    assert.strictEqual(intervalMsg.value, 3600000, 'summary interval payload should be milliseconds');

    // Style dropdown should emit selected style ids.
    posted.length = 0;
    styleMenuBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const tableStyle = styleMenu.querySelector('input[data-style-id="table"]');
    assert(tableStyle, 'table style checkbox should exist');
    tableStyle.checked = false;
    tableStyle.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    const stylesMsg = lastPosted(posted, 'format-styles');
    assert(stylesMsg, 'changing style checkbox should emit format-styles');
    assert(!stylesMsg.value.includes('table'), 'disabled style should be omitted from format-styles message');

    sendWindowMessage(window, { type: 'set-format-styles', value: ['bullets', 'table'] });
    await tick();
    assert((styleMenuBtn.textContent || '').includes('(2)'), 'style menu button should reflect extension-updated style count');

    const activeSessions = [
      {
        id: '019c9c16-f1db-7f51-8a5d-c41b7447eab4',
        projectName: 'kibitz',
        sessionTitle: 'Fix unclear prompt',
        agent: 'codex',
        source: 'cli',
        filePath: '/tmp/codex.jsonl',
        lastActivity: Date.now(),
      },
      {
        id: 'f7e1a2b3-c4d5-6789-abcd-0123456789ab',
        projectName: 'kibitz',
        sessionTitle: 'Improve support matrix docs',
        agent: 'claude',
        source: 'vscode',
        filePath: '/tmp/claude.jsonl',
        lastActivity: Date.now() - 10,
      },
    ];

    sendWindowMessage(window, { type: 'active-sessions', value: activeSessions });
    sendWindowMessage(window, { type: 'sessions', value: activeSessions.length });
    await tick();

    assert.strictEqual(sessionsBadge.textContent.trim(), '2 sessions', 'sessions badge should match active session count');

    const sessionBadges = badgeTexts();
    assert(sessionBadges.some((text) => text.includes('/2 ') && text.includes('CODEX')), 'badges should include codex existing session');
    assert(sessionBadges.some((text) => text.includes('/3 ') && text.includes('CLAUDE')), 'badges should include claude existing session');

    // While user is typing, active-session refresh must not reorder badges or counter.
    composerInput.value = 'draft in progress';
    composerInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const badgesBeforeTypingRefresh = badgeTexts();
    assert.strictEqual(sessionsBadge.textContent.trim(), '2 sessions', 'precondition: counter should still be 2');

    sendWindowMessage(window, {
      type: 'active-sessions',
      value: [
        {
          id: 'ccccdddd-eeee-ffff-aaaa-bbbbbbbbbbbb',
          projectName: 'room',
          sessionTitle: 'New live session',
          agent: 'codex',
          source: 'cli',
          filePath: '/tmp/new-codex.jsonl',
          lastActivity: Date.now() + 5000,
        },
        activeSessions[1],
        activeSessions[0],
      ],
    });
    await tick();
    assert.strictEqual(sessionsBadge.textContent.trim(), '2 sessions', 'counter should stay frozen while typing');
    assert.deepStrictEqual(badgeTexts(), badgesBeforeTypingRefresh, 'badge ordering should stay frozen while typing');

    composerInput.value = '';
    composerInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    composerInput.dispatchEvent(new window.Event('blur'));
    await tick();
    assert.strictEqual(sessionsBadge.textContent.trim(), '3 sessions', 'counter should update after typing stops');
    assert(badgeTexts().some((text) => text.includes('/4 ') && text.includes('New live session')), 'new session badge should appear after typing stops');

    // Clicking the #1 badge should target new codex session initially.
    posted.length = 0;
    clickBadgeByText('/1 New session (Codex)');
    await tick();

    const codexTargetMsg = lastPosted(posted, 'set-target');
    assert(codexTargetMsg, 'clicking new-session badge should post set-target');
    assert.strictEqual(codexTargetMsg.value.kind, 'new-codex', 'new-session badge should target codex for GPT model');

    // Selecting a Claude model should flip #1 to New session (Claude) only.
    posted.length = 0;
    modelSelect.value = 'claude-opus-4-6';
    modelSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();

    const modelMsg = lastPosted(posted, 'model');
    assert(modelMsg, 'changing model should post model message');
    assert.strictEqual(modelMsg.value, 'claude-opus-4-6', 'model payload should match selected value');

    const badgesAfterModelSwitch = badgeTexts();
    assert(badgesAfterModelSwitch[0].includes('/1 New session (Claude)'), 'first badge should switch to new claude session');
    assert(!badgesAfterModelSwitch.some((text) => text.includes('New session (Codex)')), 'should not show second-provider new-session badge');

    // Model list still contains all models.
    const claudeModelValues = Array.from(modelSelect.options).map((opt) => opt.value);
    assert(claudeModelValues.includes('claude-opus-4-6'), 'model options should include claude-opus-4-6');
    assert(claudeModelValues.includes('gpt-4o'), 'model options should include gpt-4o');

    // Click existing codex session badge.
    posted.length = 0;
    clickBadgeByText('CODEX');
    await tick();

    const codexModelValues = Array.from(modelSelect.options).map((opt) => opt.value);
    assert(codexModelValues.includes('gpt-4o'), 'model options should include gpt-4o');
    assert(codexModelValues.includes('claude-opus-4-6'), 'model options should include claude-opus-4-6');

    // Plain-text send should dispatch prompt to selected target.
    posted.length = 0;
    composerInput.value = 'Fix unclear prompt';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();

    const dispatchMsg = lastPosted(posted, 'dispatch-prompt');
    assert(dispatchMsg, 'plain text send should post dispatch-prompt');
    assert.strictEqual(dispatchMsg.value.prompt, 'Fix unclear prompt', 'dispatch prompt should match input');
    assert.strictEqual(dispatchMsg.value.target.kind, 'existing', 'dispatch target should be existing session');
    assert.strictEqual(dispatchMsg.value.target.agent, 'codex', 'dispatch target agent should be codex');
    assert.strictEqual(composerInput.value, '', 'composer should clear immediately after dispatch submit');
    const optimisticEntry = Array.from(feed.querySelectorAll('.entry')).slice(-1)[0];
    assert(optimisticEntry, 'plain text send should render optimistic local entry');
    const optimisticText = optimisticEntry.textContent || '';
    assert(optimisticText.includes('[you]'), 'optimistic entry should be marked as local user source');
    assert(optimisticText.includes('Fix unclear prompt'), 'optimistic entry should include submitted prompt text');
    assert.strictEqual(document.body.classList.contains('show-event-summary'), false, 'event summary should be hidden by default');

    // Slash commands via input composer should map to control messages.
    const slashExpectations = [
      ['/pause', 'pause'],
      ['/resume', 'resume'],
      ['/focus keep names clear', 'focus'],
      ['/model gpt-4o', 'model'],
      ['/preset newbie', 'preset'],
      ['/interval 1h', 'summary-interval'],
      ['/summary on', 'show-event-summary'],
    ];

    for (const [cmd, expectedType] of slashExpectations) {
      posted.length = 0;
      composerInput.value = cmd;
      composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await tick();
      const msg = lastPosted(posted, expectedType);
      assert(msg, `slash command ${cmd} should post ${expectedType}`);
    }

    // /help and /clear should not send dispatch-prompt.
    posted.length = 0;
    composerInput.value = '/help';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert(!lastPosted(posted, 'dispatch-prompt'), '/help should not dispatch prompt');

    posted.length = 0;
    composerInput.value = '/clear';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert(!lastPosted(posted, 'dispatch-prompt'), '/clear should not dispatch prompt');

    // Extension acknowledgment should toggle summary class in the UI.
    sendWindowMessage(window, { type: 'set-show-event-summary', value: true });
    await tick();
    assert.strictEqual(document.body.classList.contains('show-event-summary'), true, 'summary should be visible after set-show-event-summary true');

    sendWindowMessage(window, { type: 'set-show-event-summary', value: false });
    await tick();
    assert.strictEqual(document.body.classList.contains('show-event-summary'), false, 'summary should be hidden after set-show-event-summary false');

    sendWindowMessage(window, { type: 'set-summary-interval', value: 300000 });
    await tick();
    assert.strictEqual(summaryIntervalSelect.value, '300000', 'summary interval select should sync from extension message');

    // Simulated session entry should use canonical active-session title, not mismatched incoming title.
    sendWindowMessage(window, {
      type: 'commentary-start',
      value: {
        timestamp: Date.now(),
        sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4',
        projectName: 'kibitz',
        sessionTitle: 'WRONG TITLE FROM OTHER SESSION',
        agent: 'codex',
        source: 'cli',
        eventSummary: 'Simulated event',
        commentary: '',
      },
    });
    await tick();

    const firstEntry = feed.querySelector('.entry[data-agent][data-session]');
    assert(firstEntry, 'commentary-start should render entry');
    const firstEntryText = firstEntry.textContent || '';
    assert(firstEntryText.includes('Fix unclear prompt'), 'entry should render canonical session title from active sessions');
    assert(!firstEntryText.includes('WRONG TITLE FROM OTHER SESSION'), 'entry should not render mismatched incoming title');

    // Clicking feed entry should retarget dispatcher.
    posted.length = 0;
    firstEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const clickTargetMsg = lastPosted(posted, 'set-target');
    assert(clickTargetMsg, 'clicking entry should emit set-target');
    assert.strictEqual(clickTargetMsg.value.sessionId, '019c9c16-f1db-7f51-8a5d-c41b7447eab4', 'clicked session id should match set-target payload');

    // Failed status must preserve input; sent status must not wipe new typing.
    const statusEntriesBefore = feed.querySelectorAll('.system-entry, .error-entry').length;
    sendWindowMessage(window, {
      type: 'dispatch-status',
      value: {
        state: 'queued',
        message: 'queued message',
        timestamp: Date.now(),
        target: { kind: 'existing', agent: 'codex', sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4' },
      },
    });
    sendWindowMessage(window, {
      type: 'dispatch-status',
      value: {
        state: 'started',
        message: 'started message',
        timestamp: Date.now(),
        target: { kind: 'existing', agent: 'codex', sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4' },
      },
    });
    sendWindowMessage(window, {
      type: 'dispatch-status',
      value: {
        state: 'sent',
        message: 'sent message',
        timestamp: Date.now(),
        target: { kind: 'existing', agent: 'codex', sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4' },
      },
    });
    await tick();
    const statusEntriesAfter = feed.querySelectorAll('.system-entry, .error-entry').length;
    assert.strictEqual(statusEntriesAfter, statusEntriesBefore, 'queued/started/sent statuses should not create feed entries');

    composerInput.value = 'keep me for retry';
    sendWindowMessage(window, {
      type: 'dispatch-status',
      value: {
        state: 'failed',
        message: 'simulated failure',
        timestamp: Date.now(),
        target: { kind: 'existing', agent: 'codex', sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4' },
      },
    });
    await tick();
    assert.strictEqual(composerInput.value, 'keep me for retry', 'failed dispatch should keep composer text');
    const statusEntriesAfterFailed = feed.querySelectorAll('.system-entry, .error-entry').length;
    assert.strictEqual(statusEntriesAfterFailed, statusEntriesBefore + 1, 'failed status should create one feed entry');

    sendWindowMessage(window, {
      type: 'dispatch-status',
      value: {
        state: 'sent',
        message: 'simulated sent',
        timestamp: Date.now(),
        target: { kind: 'existing', agent: 'codex', sessionId: '019c9c16-f1db-7f51-8a5d-c41b7447eab4' },
      },
    });
    await tick();
    assert.strictEqual(composerInput.value, 'keep me for retry', 'sent dispatch should not clear composer if user already typed new text');

    // Slash numeric-only input should select target without dispatch and clear command text.
    posted.length = 0;
    const firstBadgeTextForSlash = badgeTexts()[0] || '';
    composerInput.value = '/1';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const slashNumericSelectMsg = lastPosted(posted, 'set-target');
    assert(slashNumericSelectMsg, 'slash numeric-only input should emit set-target');
    const expectedSlashKind = firstBadgeTextForSlash.includes('(Claude)') ? 'new-claude' : 'new-codex';
    assert.strictEqual(slashNumericSelectMsg.value.kind, expectedSlashKind, 'slash numeric-only input should target first badge');
    assert.strictEqual(composerInput.value, '/1 ', 'slash numeric-only input should keep slash target token');
    assert(!lastPosted(posted, 'dispatch-prompt'), 'slash numeric-only input should not dispatch prompt');

    // Slash numeric with prompt should dispatch to selected numbered target.
    posted.length = 0;
    composerInput.value = '/2 ship it';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const slashNumericDispatch = lastPosted(posted, 'dispatch-prompt');
    assert(slashNumericDispatch, 'slash numeric with prompt should dispatch');
    assert.strictEqual(slashNumericDispatch.value.prompt, 'ship it', 'slash numeric should strip target token from prompt');
    assert.strictEqual(slashNumericDispatch.value.target.kind, 'existing', 'slash numeric /2 should target existing badge');

    // Typing numeric slash should immediately retarget without sending.
    posted.length = 0;
    composerInput.value = '/2';
    composerInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    const slashTypingTarget = lastPosted(posted, 'set-target');
    assert(slashTypingTarget, 'typing /2 should immediately emit set-target');
    assert.strictEqual(slashTypingTarget.value.kind, 'existing', 'typing /2 should target existing badge');
    assert(!lastPosted(posted, 'dispatch-prompt'), 'typing /2 should not dispatch prompt');

    // Typing slash numeric with prompt should also immediately retarget.
    posted.length = 0;
    composerInput.value = '/2 please continue';
    composerInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    const slashTypingWithPromptTarget = lastPosted(posted, 'set-target');
    assert(slashTypingWithPromptTarget, 'typing /2 with prompt should emit set-target');
    assert.strictEqual(slashTypingWithPromptTarget.value.kind, 'existing', 'typing /2 with prompt should target existing badge');

    // Typing suffix form (2/) should also immediately retarget.
    posted.length = 0;
    composerInput.value = '2/';
    composerInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    const slashSuffixTypingTarget = lastPosted(posted, 'set-target');
    assert(slashSuffixTypingTarget, 'typing 2/ should immediately emit set-target');
    assert.strictEqual(slashSuffixTypingTarget.value.kind, 'existing', 'typing 2/ should target existing badge');

    // Numeric-only input should select target without dispatch and keep shortcut token.
    posted.length = 0;
    const firstBadgeTextBeforeNumeric = badgeTexts()[0] || '';
    composerInput.value = '1';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const numericSelectMsg = lastPosted(posted, 'set-target');
    assert(numericSelectMsg, 'numeric-only input should emit set-target');
    const expectedNewKind = firstBadgeTextBeforeNumeric.includes('(Claude)') ? 'new-claude' : 'new-codex';
    assert.strictEqual(numericSelectMsg.value.kind, expectedNewKind, 'numeric-only input should target first badge');
    assert.strictEqual(composerInput.value, '1 ', 'numeric-only input should keep badge token in input');
    assert(!lastPosted(posted, 'dispatch-prompt'), 'numeric-only input should not dispatch prompt');

    // Prompt + trailing number should dispatch to that numbered badge target.
    posted.length = 0;
    composerInput.value = 'run this now 2';
    composerSend.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    const numericDispatch = lastPosted(posted, 'dispatch-prompt');
    assert(numericDispatch, 'prompt with trailing number should dispatch');
    assert.strictEqual(numericDispatch.value.prompt, 'run this now', 'numeric suffix should be stripped from prompt');
    assert.strictEqual(numericDispatch.value.target.kind, 'existing', 'numeric suffix should target existing session badge');

    // History replay should render truncated long session names instead of full raw prompt-length titles.
    sendWindowMessage(window, {
      type: 'history',
      value: [
        {
          timestamp: Date.now(),
          sessionId: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
          projectName: 'kibitz',
          sessionTitle: 'this is a very long session name that should be truncated in the feed header to avoid breaking layout when prompts are huge',
          agent: 'codex',
          source: 'cli',
          eventSummary: 'history replay event',
          commentary: 'history replay commentary',
        },
      ],
    });
    await tick();
    const historyText = feed.textContent || '';
    assert(historyText.includes('this is a very long session name'), 'history render should include session title prefix');
    assert(historyText.includes('...'), 'history render should use ellipsis for long session title');
    assert(!historyText.includes('avoid breaking layout when prompts are huge'), 'history render should not include full long session title');

    dom.window.close();
    process.stdout.write('panel ui tests passed\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`panel ui tests failed: ${message}\n`);
  process.exit(1);
});
