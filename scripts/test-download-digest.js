const assert = require('node:assert/strict');
const digest = require('./download-digest.js');

function testFirstRunBaseline() {
  const current = { marketplaceDownloadCount: 11, githubReleaseDownloadCount: 7 };
  const result = digest.evaluateSnapshot(undefined, current);
  assert.equal(result.isFirstRun, true);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 0);
}

function testMarketplaceIncrement() {
  const previous = { marketplaceDownloadCount: 10, githubReleaseDownloadCount: 7 };
  const current = { marketplaceDownloadCount: 13, githubReleaseDownloadCount: 7 };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.isFirstRun, false);
  assert.equal(result.marketplaceDelta, 3);
  assert.equal(result.githubDelta, 0);
  assert.equal(result.totalDelta, 3);
}

function testGithubIncrement() {
  const previous = { marketplaceDownloadCount: 20, githubReleaseDownloadCount: 9 };
  const current = { marketplaceDownloadCount: 20, githubReleaseDownloadCount: 14 };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 5);
  assert.equal(result.totalDelta, 5);
}

function testNoIncrement() {
  const previous = { marketplaceDownloadCount: 5, githubReleaseDownloadCount: 9 };
  const current = { marketplaceDownloadCount: 5, githubReleaseDownloadCount: 9 };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.hadCounterRollback, false);
}

function testCounterRollbackClamp() {
  const previous = { marketplaceDownloadCount: 17, githubReleaseDownloadCount: 12 };
  const current = { marketplaceDownloadCount: 16, githubReleaseDownloadCount: 9 };
  const result = digest.evaluateSnapshot(previous, current);
  assert.equal(result.marketplaceDelta, 0);
  assert.equal(result.githubDelta, 0);
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

function testGithubSumNoAssets() {
  const payload = [{ name: 'v0.0.9' }];
  assert.equal(digest.sumReleaseDownloadCounts(payload), 0);
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
  testNoIncrement();
  testCounterRollbackClamp();
  testMarketplaceParser();
  testMarketplaceParserMissingStat();
  testGithubSumNoAssets();
  testNineAmGuard();
  console.log('download-digest tests passed');
}

run();
