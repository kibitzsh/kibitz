const assert = require('node:assert/strict');
const digest = require('./download-digest.js');

function testFirstRunBaseline() {
  const current = {
    marketplaceDownloadCount: 11,
    githubReleaseDownloadCount: 7,
    npmDownloadCount: 5,
    homebrewTapCloneCount: 3,
  };
  const result = digest.evaluateSnapshot(undefined, current);
  assert.equal(result.isFirstRun, true);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 0);
  assert.equal(result.npmDelta, 0);
  assert.equal(result.homebrewDelta, 0);
}

function testMarketplaceIncrement() {
  const previous = {
    marketplaceDownloadCount: 10,
    githubReleaseDownloadCount: 7,
    npmDownloadCount: 50,
    homebrewTapCloneCount: 5,
  };
  const current = {
    marketplaceDownloadCount: 13,
    githubReleaseDownloadCount: 7,
    npmDownloadCount: 50,
    homebrewTapCloneCount: 5,
  };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.isFirstRun, false);
  assert.equal(result.marketplaceDelta, 3);
  assert.equal(result.githubDelta, 0);
  assert.equal(result.npmDelta, 0);
  assert.equal(result.homebrewDelta, 0);
  assert.equal(result.totalDelta, 3);
}

function testGithubIncrement() {
  const previous = {
    marketplaceDownloadCount: 20,
    githubReleaseDownloadCount: 9,
    npmDownloadCount: 50,
    homebrewTapCloneCount: 5,
  };
  const current = {
    marketplaceDownloadCount: 20,
    githubReleaseDownloadCount: 14,
    npmDownloadCount: 50,
    homebrewTapCloneCount: 5,
  };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 5);
  assert.equal(result.npmDelta, 0);
  assert.equal(result.homebrewDelta, 0);
  assert.equal(result.totalDelta, 5);
}

function testNpmIncrement() {
  const previous = {
    marketplaceDownloadCount: 20,
    githubReleaseDownloadCount: 14,
    npmDownloadCount: 101,
    homebrewTapCloneCount: 5,
  };
  const current = {
    marketplaceDownloadCount: 20,
    githubReleaseDownloadCount: 14,
    npmDownloadCount: 140,
    homebrewTapCloneCount: 5,
  };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 0);
  assert.equal(result.npmDelta, 39);
  assert.equal(result.homebrewDelta, 0);
  assert.equal(result.totalDelta, 39);
}

function testNoIncrement() {
  const previous = {
    marketplaceDownloadCount: 5,
    githubReleaseDownloadCount: 9,
    npmDownloadCount: 100,
    homebrewTapCloneCount: 7,
  };
  const current = {
    marketplaceDownloadCount: 5,
    githubReleaseDownloadCount: 9,
    npmDownloadCount: 100,
    homebrewTapCloneCount: 7,
  };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.hadCounterRollback, false);
}

function testCounterRollbackClamp() {
  const previous = {
    marketplaceDownloadCount: 17,
    githubReleaseDownloadCount: 12,
    npmDownloadCount: 150,
    homebrewTapCloneCount: 10,
  };
  const current = {
    marketplaceDownloadCount: 16,
    githubReleaseDownloadCount: 9,
    npmDownloadCount: 149,
    homebrewTapCloneCount: 8,
  };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 0);
  assert.equal(result.npmDelta, 0);
  assert.equal(result.homebrewDelta, 0);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.hadCounterRollback, true);
}

function testMarketplaceParser() {
  const payload = {
    results: [{ extensions: [{ statistics: [{ statisticName: 'downloadCount', value: 43 }] }] }],
  };
  assert.equal(digest.parseMarketplaceDownloadCount(payload), 43);
}

function testMarketplaceParserMissingStat() {
  const payload = { results: [{ extensions: [{ statistics: [] }] }] };
  assert.throws(() => digest.parseMarketplaceDownloadCount(payload), /downloadCount/i);
}

function testNpmParser() {
  assert.equal(digest.parseNpmDownloadCount({ downloads: 168 }), 168);
}

function testNpmParserMissingDownloads() {
  assert.throws(() => digest.parseNpmDownloadCount({}), /npm downloads payload/i);
}

function testGithubSumNoAssets() {
  const payload = [{ name: 'v0.0.9' }];
  assert.equal(digest.sumReleaseDownloadCounts(payload), 0);
}

function testHomebrewCloneParser() {
  const payload = {
    clones: [
      { count: 3, timestamp: '2026-02-28T00:00:00Z' },
      { count: 1, timestamp: '2026-02-27T00:00:00Z' },
    ],
  };
  const entries = digest.parseHomebrewCloneEntries(payload);
  assert.deepEqual(entries, [
    { count: 1, timestamp: '2026-02-27T00:00:00.000Z' },
    { count: 3, timestamp: '2026-02-28T00:00:00.000Z' },
  ]);
}

function testHomebrewCumulativeBootstrap() {
  const cloneEntries = [
    { count: 1, timestamp: '2026-02-27T00:00:00.000Z' },
    { count: 3, timestamp: '2026-02-28T00:00:00.000Z' },
  ];
  const result = digest.computeHomebrewTapCumulative({
    previousTotal: undefined,
    previousLastProcessedAt: undefined,
    cloneEntries,
  });
  assert.equal(result.total, 4);
  assert.equal(result.detectedNewCount, 0);
  assert.equal(result.lastProcessedAt, '2026-02-28T00:00:00.000Z');
  assert.equal(result.bootstrapped, true);
}

function testHomebrewCumulativeIncremental() {
  const cloneEntries = [
    { count: 1, timestamp: '2026-02-27T00:00:00.000Z' },
    { count: 3, timestamp: '2026-02-28T00:00:00.000Z' },
  ];
  const result = digest.computeHomebrewTapCumulative({
    previousTotal: 10,
    previousLastProcessedAt: '2026-02-27T00:00:00.000Z',
    cloneEntries,
  });
  assert.equal(result.total, 13);
  assert.equal(result.detectedNewCount, 3);
  assert.equal(result.lastProcessedAt, '2026-02-28T00:00:00.000Z');
  assert.equal(result.bootstrapped, false);
}

function testNineAmGuard() {
  assert.equal(digest.shouldRunAtNineAmPt(new Date('2026-01-15T17:00:00.000Z')), true); // 09:00 PST
  assert.equal(digest.shouldRunAtNineAmPt(new Date('2026-07-15T16:00:00.000Z')), true); // 09:00 PDT
  assert.equal(digest.shouldRunAtNineAmPt(new Date('2026-07-15T17:00:00.000Z')), false); // 10:00 PDT
}

function run() {
  testFirstRunBaseline();
  testMarketplaceIncrement();
  testGithubIncrement();
  testNpmIncrement();
  testNoIncrement();
  testCounterRollbackClamp();
  testMarketplaceParser();
  testMarketplaceParserMissingStat();
  testNpmParser();
  testNpmParserMissingDownloads();
  testGithubSumNoAssets();
  testHomebrewCloneParser();
  testHomebrewCumulativeBootstrap();
  testHomebrewCumulativeIncremental();
  testNineAmGuard();
  console.log('download-digest tests passed');
}

run();
