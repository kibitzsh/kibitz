#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const DEFAULT_MARKETPLACE_EXTENSION_ID = 'kibitzsh.kibitz';
const DEFAULT_GITHUB_REPO = 'kibitzsh/kibitz';
const DEFAULT_NPM_PACKAGE = '@kibitzsh/kibitz';
const DEFAULT_HOMEBREW_TAP_REPO = 'kibitzsh/homebrew-kibitz';
const DEFAULT_STATE_FILE = path.join('.cache', 'download-digest', 'state.json');
const DEFAULT_FROM_EMAIL = 'stats@kibitz.sh';
const DEFAULT_TO_EMAIL = 'vasilytrofimchuk@gmail.com';
const LOS_ANGELES_TIMEZONE = 'America/Los_Angeles';
const USER_AGENT = 'kibitz-download-digest';
const REQUEST_TIMEOUT_MS = 10000;
const GITHUB_PAGE_SIZE = 100;
const GITHUB_MAX_PAGES = 20;
const NPM_RANGE_START = '2000-01-01';

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.floor(numeric);
}

function normalizeBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function readLosAngelesHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOS_ANGELES_TIMEZONE,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return parts.find((part) => part.type === 'hour')?.value || '';
}

function shouldRunAtNineAmPt(date = new Date()) {
  return readLosAngelesHour(date) === '09';
}

function formatDatePt(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOS_ANGELES_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseIsoTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  const parsedMs = Date.parse(text);
  if (!Number.isFinite(parsedMs)) return undefined;
  return new Date(parsedMs).toISOString();
}

async function requestJson({
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const serializedBody = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const requestHeaders = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...headers,
  };
  if (serializedBody && requestHeaders['Content-Type'] == null) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (serializedBody && requestHeaders['Content-Length'] == null) {
    requestHeaders['Content-Length'] = String(Buffer.byteLength(serializedBody));
  }

  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers: requestHeaders }, (response) => {
      if (!response) {
        reject(new Error(`No response received from ${url}`));
        return;
      }

      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode < 200 || statusCode >= 300) {
          const snippet = data.trim().slice(0, 300);
          reject(new Error(`Request failed (${statusCode}) for ${url}: ${snippet}`));
          return;
        }
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (error) {
          reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    });

    request.on('error', (error) => {
      reject(error);
    });

    if (serializedBody) request.write(serializedBody);
    request.end();
  });
}

function parseMarketplaceDownloadCount(payload) {
  const statistics = payload?.results?.[0]?.extensions?.[0]?.statistics;
  if (!Array.isArray(statistics)) {
    throw new Error('Marketplace payload missing extension statistics');
  }

  const downloadCountEntry = statistics.find(
    (entry) => String(entry?.statisticName || '').toLowerCase() === 'downloadcount',
  );
  if (!downloadCountEntry) {
    throw new Error('Marketplace payload missing downloadCount statistic');
  }

  const parsed = toNonNegativeInteger(downloadCountEntry.value);
  if (parsed == null) {
    throw new Error(`Marketplace downloadCount is invalid: ${String(downloadCountEntry.value)}`);
  }
  return parsed;
}

function parseNpmDownloadCount(payload) {
  const parsed = toNonNegativeInteger(payload?.downloads);
  if (parsed == null) {
    throw new Error(`npm downloads payload is invalid: ${JSON.stringify(payload)}`);
  }
  return parsed;
}

function sumReleaseDownloadCounts(releasesPayload) {
  if (!Array.isArray(releasesPayload)) {
    throw new Error('GitHub releases payload must be an array');
  }

  let total = 0;
  for (const release of releasesPayload) {
    if (!Array.isArray(release?.assets)) continue;
    for (const asset of release.assets) {
      const parsed = toNonNegativeInteger(asset?.download_count);
      if (parsed == null) {
        if (asset?.download_count == null) continue;
        throw new Error(`GitHub asset download_count is invalid: ${String(asset.download_count)}`);
      }
      total += parsed;
    }
  }
  return total;
}

function parseHomebrewCloneEntries(payload) {
  const clones = payload?.clones;
  if (!Array.isArray(clones)) {
    throw new Error('Homebrew tap clones payload missing clones array');
  }

  const entries = clones.map((clone) => {
    const count = toNonNegativeInteger(clone?.count);
    const timestamp = parseIsoTimestamp(clone?.timestamp);
    if (count == null || !timestamp) {
      throw new Error(`Invalid Homebrew clone entry: ${JSON.stringify(clone)}`);
    }
    return { count, timestamp };
  });

  entries.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return entries;
}

async function queryMarketplaceDownloadCount(extensionId) {
  const safeExtensionId = String(extensionId || '').trim();
  if (!safeExtensionId.includes('.')) {
    throw new Error(`Invalid marketplace extension id: ${safeExtensionId}`);
  }

  const payload = await requestJson({
    url: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    method: 'POST',
    headers: {
      Accept: 'application/json;api-version=7.1-preview.1;excludeUrls=true',
      'Content-Type': 'application/json',
    },
    body: {
      filters: [
        {
          criteria: [
            { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
            { filterType: 7, value: safeExtensionId },
          ],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 914,
    },
  });

  return parseMarketplaceDownloadCount(payload);
}

async function queryGitHubReleaseDownloadCount(repo, token) {
  const safeRepo = String(repo || '').trim();
  if (!safeRepo.includes('/')) {
    throw new Error(`Invalid GitHub repo slug: ${safeRepo}`);
  }

  const requestHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let page = 1;
  let total = 0;
  while (page <= GITHUB_MAX_PAGES) {
    const payload = await requestJson({
      url: `https://api.github.com/repos/${safeRepo}/releases?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      method: 'GET',
      headers: requestHeaders,
    });
    if (!Array.isArray(payload)) {
      throw new Error('GitHub releases API did not return an array');
    }

    total += sumReleaseDownloadCounts(payload);
    if (payload.length < GITHUB_PAGE_SIZE) break;
    page += 1;
  }

  if (page > GITHUB_MAX_PAGES) {
    throw new Error(`GitHub releases pagination exceeded ${GITHUB_MAX_PAGES} pages`);
  }

  return total;
}

async function queryNpmDownloadCount(packageName, date = new Date()) {
  const safePackageName = String(packageName || '').trim();
  if (!safePackageName) {
    throw new Error('npm package name cannot be empty');
  }
  const encodedPackageName = encodeURIComponent(safePackageName);
  const rangeEnd = utcDateString(date);
  const payload = await requestJson({
    url: `https://api.npmjs.org/downloads/point/${NPM_RANGE_START}:${rangeEnd}/${encodedPackageName}`,
    method: 'GET',
  });
  return parseNpmDownloadCount(payload);
}

async function queryHomebrewTapCloneEntries(tapRepo, token) {
  const safeTapRepo = String(tapRepo || '').trim();
  if (!safeTapRepo.includes('/')) {
    throw new Error(`Invalid Homebrew tap repo slug: ${safeTapRepo}`);
  }

  const safeToken = String(token || '').trim();
  if (!safeToken) {
    throw new Error('HOMEBREW_TAP_TOKEN (or GITHUB_TOKEN) is required for Homebrew tap clone metrics');
  }

  const payload = await requestJson({
    url: `https://api.github.com/repos/${safeTapRepo}/traffic/clones`,
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${safeToken}`,
    },
  });
  return parseHomebrewCloneEntries(payload);
}

function computeHomebrewTapCumulative({
  previousTotal,
  previousLastProcessedAt,
  cloneEntries,
}) {
  const normalizedPreviousTotal = toNonNegativeInteger(previousTotal);
  const normalizedPreviousLastProcessedAt = parseIsoTimestamp(previousLastProcessedAt);
  const latestTimestamp = cloneEntries.length > 0 ? cloneEntries[cloneEntries.length - 1].timestamp : '';

  if (cloneEntries.length === 0) {
    return {
      total: normalizedPreviousTotal || 0,
      lastProcessedAt: normalizedPreviousLastProcessedAt || '',
      detectedNewCount: 0,
      bootstrapped: normalizedPreviousTotal == null || !normalizedPreviousLastProcessedAt,
    };
  }

  if (normalizedPreviousTotal == null || !normalizedPreviousLastProcessedAt) {
    const bootstrapTotal = normalizedPreviousTotal != null
      ? normalizedPreviousTotal
      : cloneEntries.reduce((sum, entry) => sum + entry.count, 0);
    return {
      total: bootstrapTotal,
      lastProcessedAt: latestTimestamp,
      detectedNewCount: 0,
      bootstrapped: true,
    };
  }

  let detectedNewCount = 0;
  const previousTimestampMs = Date.parse(normalizedPreviousLastProcessedAt);
  for (const entry of cloneEntries) {
    if (Date.parse(entry.timestamp) > previousTimestampMs) {
      detectedNewCount += entry.count;
    }
  }

  return {
    total: normalizedPreviousTotal + detectedNewCount,
    lastProcessedAt: Date.parse(latestTimestamp) > previousTimestampMs
      ? latestTimestamp
      : normalizedPreviousLastProcessedAt,
    detectedNewCount,
    bootstrapped: false,
  };
}

function calculateDelta(previousValue, currentValue) {
  const previous = toNonNegativeInteger(previousValue);
  const current = toNonNegativeInteger(currentValue);
  if (current == null) {
    throw new Error(`Current metric value must be non-negative: ${String(currentValue)}`);
  }
  if (previous == null) {
    return { delta: 0, rollback: false, initialized: false };
  }
  if (current < previous) {
    return { delta: 0, rollback: true, initialized: true };
  }
  return { delta: current - previous, rollback: false, initialized: true };
}

function evaluateSnapshot(previousState, currentState) {
  if (!previousState) {
    return {
      isFirstRun: true,
      marketplaceDelta: 0,
      githubDelta: 0,
      npmDelta: 0,
      homebrewDelta: 0,
      totalDelta: 0,
      hadCounterRollback: false,
    };
  }

  const marketplace = calculateDelta(previousState.marketplaceDownloadCount, currentState.marketplaceDownloadCount);
  const github = calculateDelta(previousState.githubReleaseDownloadCount, currentState.githubReleaseDownloadCount);
  const npm = calculateDelta(previousState.npmDownloadCount, currentState.npmDownloadCount);
  const homebrew = calculateDelta(previousState.homebrewTapCloneCount, currentState.homebrewTapCloneCount);

  return {
    isFirstRun: false,
    marketplaceDelta: marketplace.delta,
    githubDelta: github.delta,
    npmDelta: npm.delta,
    homebrewDelta: homebrew.delta,
    totalDelta: marketplace.delta + github.delta + npm.delta + homebrew.delta,
    hadCounterRollback: marketplace.rollback || github.rollback || npm.rollback || homebrew.rollback,
  };
}

function parseState(payload) {
  if (!payload || typeof payload !== 'object') return undefined;

  const marketplaceDownloadCount = toNonNegativeInteger(payload.marketplaceDownloadCount);
  const githubReleaseDownloadCount = toNonNegativeInteger(payload.githubReleaseDownloadCount);
  if (marketplaceDownloadCount == null || githubReleaseDownloadCount == null) return undefined;

  const state = {
    lastRunAt: typeof payload.lastRunAt === 'string' ? payload.lastRunAt : '',
    marketplaceDownloadCount,
    githubReleaseDownloadCount,
  };

  const npmDownloadCount = toNonNegativeInteger(payload.npmDownloadCount);
  if (npmDownloadCount != null) state.npmDownloadCount = npmDownloadCount;

  const homebrewTapCloneCount = toNonNegativeInteger(payload.homebrewTapCloneCount);
  if (homebrewTapCloneCount != null) state.homebrewTapCloneCount = homebrewTapCloneCount;

  const homebrewLastProcessedAt = parseIsoTimestamp(payload.homebrewLastProcessedAt);
  if (homebrewLastProcessedAt) state.homebrewLastProcessedAt = homebrewLastProcessedAt;

  return state;
}

async function readState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    return parseState(JSON.parse(raw));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) {
      return undefined;
    }
    throw error;
  }
}

async function writeState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const formatted = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(stateFile, formatted, 'utf8');
}

function formatPreviousCount(value) {
  const parsed = toNonNegativeInteger(value);
  return parsed == null ? 'n/a (newly tracked)' : String(parsed);
}

function buildDigestEmailText({
  extensionId,
  githubRepo,
  npmPackage,
  homebrewTapRepo,
  now,
  evaluation,
  currentState,
  previousState,
}) {
  const lines = [
    'Kibitz daily download digest',
    '',
    `Date (PT): ${formatDatePt(now)}`,
    `Snapshot time (UTC): ${currentState.lastRunAt}`,
    '',
    `New downloads since last snapshot: +${evaluation.totalDelta}`,
    `- VS Marketplace (${extensionId}): +${evaluation.marketplaceDelta} (total ${currentState.marketplaceDownloadCount})`,
    `- GitHub Releases (${githubRepo}): +${evaluation.githubDelta} (total ${currentState.githubReleaseDownloadCount})`,
    `- npm (${npmPackage}): +${evaluation.npmDelta} (total ${currentState.npmDownloadCount})`,
    `- Homebrew tap clones proxy (${homebrewTapRepo}): +${evaluation.homebrewDelta} (total ${currentState.homebrewTapCloneCount})`,
    '',
    `Previous totals: marketplace=${formatPreviousCount(previousState.marketplaceDownloadCount)}, github=${formatPreviousCount(previousState.githubReleaseDownloadCount)}, npm=${formatPreviousCount(previousState.npmDownloadCount)}, homebrew=${formatPreviousCount(previousState.homebrewTapCloneCount)}`,
  ];
  if (evaluation.hadCounterRollback) {
    lines.push('');
    lines.push('Note: one or more counters moved backwards and were clamped to delta=0.');
  }
  return lines.join('\n');
}

async function sendResendEmail({ apiKey, from, to, subject, text }) {
  const trimmedApiKey = String(apiKey || '').trim();
  const trimmedFrom = String(from || '').trim();
  const trimmedTo = String(to || '').trim();
  if (!trimmedApiKey) throw new Error('RESEND_API_KEY is required to send digest email');
  if (!trimmedFrom) throw new Error('RESEND_FROM_EMAIL is required to send digest email');
  if (!trimmedTo) throw new Error('ALERT_EMAIL_TO is required to send digest email');

  await requestJson({
    url: 'https://api.resend.com/emails',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${trimmedApiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      from: trimmedFrom,
      to: [trimmedTo],
      subject,
      text,
    },
  });
}

async function run() {
  const extensionId = String(process.env.MARKETPLACE_EXTENSION_ID || DEFAULT_MARKETPLACE_EXTENSION_ID).trim();
  const githubRepo = String(process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO).trim();
  const npmPackage = String(process.env.NPM_PACKAGE || DEFAULT_NPM_PACKAGE).trim();
  const homebrewTapRepo = String(process.env.HOMEBREW_TAP_REPO || DEFAULT_HOMEBREW_TAP_REPO).trim();
  const stateFile = String(process.env.DOWNLOAD_DIGEST_STATE_FILE || DEFAULT_STATE_FILE).trim();
  const enforceNineAmPt = normalizeBoolean(process.env.ENFORCE_9AM_PT, false);

  const now = new Date();
  if (enforceNineAmPt && !shouldRunAtNineAmPt(now)) {
    const localHour = readLosAngelesHour(now);
    console.log(`[download-digest] Skipping run outside 9AM PT window (current PT hour: ${localHour}).`);
    return;
  }

  const previousState = await readState(stateFile);

  const [marketplaceDownloadCount, githubReleaseDownloadCount, npmDownloadCount, homebrewCloneEntries] = await Promise.all([
    queryMarketplaceDownloadCount(extensionId),
    queryGitHubReleaseDownloadCount(githubRepo, process.env.GITHUB_TOKEN),
    queryNpmDownloadCount(npmPackage, now),
    queryHomebrewTapCloneEntries(
      homebrewTapRepo,
      process.env.HOMEBREW_TAP_TOKEN || process.env.GITHUB_TOKEN,
    ),
  ]);

  const homebrewCumulative = computeHomebrewTapCumulative({
    previousTotal: previousState?.homebrewTapCloneCount,
    previousLastProcessedAt: previousState?.homebrewLastProcessedAt,
    cloneEntries: homebrewCloneEntries,
  });

  const currentState = {
    lastRunAt: now.toISOString(),
    marketplaceDownloadCount,
    githubReleaseDownloadCount,
    npmDownloadCount,
    homebrewTapCloneCount: homebrewCumulative.total,
    homebrewLastProcessedAt: homebrewCumulative.lastProcessedAt,
  };
  const evaluation = evaluateSnapshot(previousState, currentState);

  if (evaluation.isFirstRun) {
    await writeState(stateFile, currentState);
    console.log('[download-digest] Baseline initialized (first run), no email sent.');
    return;
  }

  if (evaluation.totalDelta <= 0) {
    await writeState(stateFile, currentState);
    if (evaluation.hadCounterRollback) {
      console.log('[download-digest] Counter rollback detected; baseline reset with delta clamped to zero.');
      return;
    }
    console.log('[download-digest] No new downloads since last snapshot; no email sent.');
    return;
  }

  const subject = `Kibitz downloads: +${evaluation.totalDelta}`;
  const text = buildDigestEmailText({
    extensionId,
    githubRepo,
    npmPackage,
    homebrewTapRepo,
    now,
    evaluation,
    currentState,
    previousState,
  });

  await sendResendEmail({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL,
    to: process.env.ALERT_EMAIL_TO || DEFAULT_TO_EMAIL,
    subject,
    text,
  });

  await writeState(stateFile, currentState);
  console.log(`[download-digest] Digest sent (+${evaluation.totalDelta}).`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[download-digest] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MARKETPLACE_EXTENSION_ID,
  DEFAULT_GITHUB_REPO,
  DEFAULT_NPM_PACKAGE,
  DEFAULT_HOMEBREW_TAP_REPO,
  DEFAULT_STATE_FILE,
  DEFAULT_FROM_EMAIL,
  DEFAULT_TO_EMAIL,
  readLosAngelesHour,
  shouldRunAtNineAmPt,
  parseMarketplaceDownloadCount,
  parseNpmDownloadCount,
  parseHomebrewCloneEntries,
  sumReleaseDownloadCounts,
  computeHomebrewTapCumulative,
  evaluateSnapshot,
  parseState,
  buildDigestEmailText,
  normalizeBoolean,
  toNonNegativeInteger,
};
