#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const DEFAULT_MARKETPLACE_EXTENSION_ID = 'kibitzsh.kibitz';
const DEFAULT_GITHUB_REPO = 'kibitzsh/kibitz';
const DEFAULT_STATE_FILE = path.join('.cache', 'download-digest', 'state.json');
const DEFAULT_FROM_EMAIL = 'stats@kibitz.sh';
const DEFAULT_TO_EMAIL = 'vasilytrofimchuk@gmail.com';
const LOS_ANGELES_TIMEZONE = 'America/Los_Angeles';
const USER_AGENT = 'kibitz-download-digest';
const REQUEST_TIMEOUT_MS = 10000;
const GITHUB_PAGE_SIZE = 100;
const GITHUB_MAX_PAGES = 20;

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

function evaluateSnapshot(previousState, currentState) {
  if (!previousState) {
    return {
      isFirstRun: true,
      marketplaceDelta: 0,
      githubDelta: 0,
      totalDelta: 0,
      hadCounterRollback: false,
    };
  }

  const marketplaceDelta = Math.max(0, currentState.marketplaceDownloadCount - previousState.marketplaceDownloadCount);
  const githubDelta = Math.max(0, currentState.githubReleaseDownloadCount - previousState.githubReleaseDownloadCount);
  const hadCounterRollback = (
    currentState.marketplaceDownloadCount < previousState.marketplaceDownloadCount
    || currentState.githubReleaseDownloadCount < previousState.githubReleaseDownloadCount
  );

  return {
    isFirstRun: false,
    marketplaceDelta,
    githubDelta,
    totalDelta: marketplaceDelta + githubDelta,
    hadCounterRollback,
  };
}

function parseState(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const marketplaceDownloadCount = toNonNegativeInteger(payload.marketplaceDownloadCount);
  const githubReleaseDownloadCount = toNonNegativeInteger(payload.githubReleaseDownloadCount);
  if (marketplaceDownloadCount == null || githubReleaseDownloadCount == null) return undefined;
  return {
    lastRunAt: typeof payload.lastRunAt === 'string' ? payload.lastRunAt : '',
    marketplaceDownloadCount,
    githubReleaseDownloadCount,
  };
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

function buildDigestEmailText({
  extensionId,
  githubRepo,
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
    '',
    `Previous totals: marketplace=${previousState.marketplaceDownloadCount}, github=${previousState.githubReleaseDownloadCount}`,
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
  const stateFile = String(process.env.DOWNLOAD_DIGEST_STATE_FILE || DEFAULT_STATE_FILE).trim();
  const enforceNineAmPt = normalizeBoolean(process.env.ENFORCE_9AM_PT, false);

  const now = new Date();
  if (enforceNineAmPt && !shouldRunAtNineAmPt(now)) {
    const localHour = readLosAngelesHour(now);
    console.log(`[download-digest] Skipping run outside 9AM PT window (current PT hour: ${localHour}).`);
    return;
  }

  const [marketplaceDownloadCount, githubReleaseDownloadCount] = await Promise.all([
    queryMarketplaceDownloadCount(extensionId),
    queryGitHubReleaseDownloadCount(githubRepo, process.env.GITHUB_TOKEN),
  ]);

  const previousState = await readState(stateFile);
  const currentState = {
    lastRunAt: now.toISOString(),
    marketplaceDownloadCount,
    githubReleaseDownloadCount,
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
  DEFAULT_STATE_FILE,
  DEFAULT_FROM_EMAIL,
  DEFAULT_TO_EMAIL,
  readLosAngelesHour,
  shouldRunAtNineAmPt,
  parseMarketplaceDownloadCount,
  sumReleaseDownloadCounts,
  evaluateSnapshot,
  parseState,
  buildDigestEmailText,
  normalizeBoolean,
  toNonNegativeInteger,
};
