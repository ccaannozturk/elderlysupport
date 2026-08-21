/**
 * Comprehensive Deterministic Test Suite for Stage E: Community Layer
 */

const assert = require('assert');
const fs = require('fs');

// Global mock DOM environment for app.js
const mockElement = () => ({
  addEventListener: () => {},
  value: '',
  classList: { add: () => {}, remove: () => {}, contains: () => false },
  innerHTML: '',
  disabled: false
});

global.firebase = {
  initializeApp: () => {},
  firestore: () => ({
    collection: () => ({
      get: async () => ({ docs: [], forEach: () => {} }),
      doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }),
      add: async () => {}
    }),
    enablePersistence: async () => {}
  }),
  auth: () => ({ onAuthStateChanged: () => {} }),
  functions: () => ({ httpsCallable: () => async () => ({ data: { ok: true } }) })
};
global.location = { hostname: 'example.com', search: '', pathname: '/' };
global.window = { location: global.location, addEventListener: () => {} };
global.document = {
  addEventListener: () => {},
  getElementById: (id) => mockElement(),
  querySelector: () => mockElement(),
  querySelectorAll: () => []
};
global.bootstrap = { Modal: function() { this.show = () => {}; }, Toast: { getOrCreateInstance: () => ({ show: () => {} }) } };

const app = require('../app.js');

console.log('======================================================================');
console.log('TEST SUITE: STAGE E COMMUNITY LAYER & DETERMINISTIC TESTS');
console.log('======================================================================\n');

// ----------------------------------------------------------------------
// [Test 1] Rank-Delta Calculation Across Simulated Timeline & Inactivity
// ----------------------------------------------------------------------
console.log('[Test 1] Weekly Power Rankings & Movement Badges:');

// Helper to create synthetic match
function makeMatch(id, dateStr, teamAPlayers, teamBPlayers, scoreA, scoreB) {
  const d = new Date(dateStr);
  return {
    id,
    date: { toDate: () => d },
    type: 'Standard',
    teams: [
      { score: scoreA, players: teamAPlayers },
      { score: scoreB, players: teamBPlayers }
    ]
  };
}

// Build a 6-week timeline
const matches = [];
// Week 1: 5 matches so Alice, Bob, Charlie, Dave, Eve, Frank hit 5 matches
for (let i = 1; i <= 5; i++) {
  matches.push(makeMatch(`m-w1-${i}`, `2026-07-0${i}T12:00:00Z`, ['alice', 'bob', 'charlie'], ['dave', 'eve', 'frank'], 5, 2));
}

// Week 2: Alice and Bob keep winning, Frank gets wins
matches.push(makeMatch('m-w2-1', '2026-07-10T12:00:00Z', ['alice', 'bob', 'frank'], ['charlie', 'dave', 'eve'], 10, 1));
matches.push(makeMatch('m-w2-2', '2026-07-12T12:00:00Z', ['frank', 'grace', 'heidi'], ['alice', 'bob', 'charlie'], 7, 3)); // Grace and Heidi have 1 match (provisional)

const latestDate = new Date('2026-07-13T00:00:00Z');
const cutoffDate = new Date('2026-07-06T00:00:00Z'); // 7 days prior

const rankingsResult = app.computeWeeklyPowerRankings(matches, cutoffDate, latestDate);
assert(rankingsResult.hasMatchesInWindow, 'Must detect matches in 7-day window');
assert(rankingsResult.rankings.length > 0, 'Rankings list must not be empty');

// Check provisional player handling
const graceRank = rankingsResult.rankings.find(r => r.id === 'grace');
assert(graceRank, 'Grace must be in rankings');
assert.strictEqual(graceRank.isProvisional, true, 'Grace (<5 matches) must be flagged provisional');
assert.strictEqual(graceRank.delta, null, 'Provisional player must NOT have a rank delta badge (excluded per correction 3)');

// Check non-provisional player movement
const frankRank = rankingsResult.rankings.find(r => r.id === 'frank');
assert(frankRank, 'Frank must be in rankings');
assert.strictEqual(frankRank.isProvisional, false, 'Frank (7 matches) must be non-provisional');
assert(typeof frankRank.rank === 'number', 'Non-provisional player must have numeric rank');
console.log('✓ Weekly power rankings calculated correctly with provisional movement exclusion.');

// Test week with NO matches
const inactiveLatest = new Date('2026-07-30T00:00:00Z');
const inactiveCutoff = new Date('2026-07-23T00:00:00Z');
const inactiveResult = app.computeWeeklyPowerRankings(matches, inactiveCutoff, inactiveLatest);
assert.strictEqual(inactiveResult.hasMatchesInWindow, false, 'Must identify 0 matches in inactive 7-day window');
console.log('✓ Inactive week correctly flagged (hasMatchesInWindow: false).\n');

// ----------------------------------------------------------------------
// [Test 2] Milestone Detection at 24->25, 49->50, 124->125 Caps
// ----------------------------------------------------------------------
console.log('[Test 2] Milestone Watchlist (25-Cap Intervals):');

const milestoneMatches = [];
// Player 1: 24 caps (1 away from 25)
for (let i = 0; i < 24; i++) milestoneMatches.push(makeMatch(`m-p1-${i}`, '2026-01-01', ['p24'], ['other'], 1, 0));
// Player 2: 48 caps (2 away from 50)
for (let i = 0; i < 48; i++) milestoneMatches.push(makeMatch(`m-p2-${i}`, '2026-01-01', ['p48'], ['other'], 1, 0));
// Player 3: 124 caps (1 away from 125)
for (let i = 0; i < 124; i++) milestoneMatches.push(makeMatch(`m-p3-${i}`, '2026-01-01', ['p124'], ['other'], 1, 0));
// Player 4: 25 caps (0 away / hit milestone -> not on watchlist)
for (let i = 0; i < 25; i++) milestoneMatches.push(makeMatch(`m-p4-${i}`, '2026-01-01', ['p25'], ['other'], 1, 0));
// Player 5: 20 caps (5 away -> not on watchlist)
for (let i = 0; i < 20; i++) milestoneMatches.push(makeMatch(`m-p5-${i}`, '2026-01-01', ['p20'], ['other'], 1, 0));

const watchlist = app.computeMilestoneWatch(milestoneMatches, app.MILESTONE_INTERVAL);

const p24 = watchlist.find(w => w.playerId === 'p24');
const p48 = watchlist.find(w => w.playerId === 'p48');
const p124 = watchlist.find(w => w.playerId === 'p124');
const p25 = watchlist.find(w => w.playerId === 'p25');
const p20 = watchlist.find(w => w.playerId === 'p20');

assert(p24, 'p24 must be on watchlist');
assert.strictEqual(p24.caps, 24);
assert.strictEqual(p24.nextMilestone, 25);
assert.strictEqual(p24.away, 1);

assert(p48, 'p48 must be on watchlist');
assert.strictEqual(p48.caps, 48);
assert.strictEqual(p48.nextMilestone, 50);
assert.strictEqual(p48.away, 2);

assert(p124, 'p124 must be on watchlist');
assert.strictEqual(p124.caps, 124);
assert.strictEqual(p124.nextMilestone, 125);
assert.strictEqual(p124.away, 1);

assert.strictEqual(p25, undefined, 'p25 must NOT be on watchlist (already reached 25, 25 away from 50)');
assert.strictEqual(p20, undefined, 'p20 must NOT be on watchlist (5 away from 25)');
console.log('✓ Milestone watch accurately flags 1-2 games away from 25, 50, 125 caps.\n');

// ----------------------------------------------------------------------
// [Test 3] Monthly Awards & Qualification Thresholds (min 3 games)
// ----------------------------------------------------------------------
console.log('[Test 3] Monthly Awards Qualification Thresholds:');

const augustMatches = [
  // 4 matches in August 2026
  makeMatch('aug-1', '2026-08-01T12:00:00Z', ['sam', 'hector', 'two_game_guy'], ['can', 'damoun', 'desi'], 10, 5),
  makeMatch('aug-2', '2026-08-08T12:00:00Z', ['sam', 'hector', 'two_game_guy'], ['can', 'damoun', 'desi'], 8, 4),
  makeMatch('aug-3', '2026-08-15T12:00:00Z', ['sam', 'hector', 'miguel'], ['can', 'damoun', 'desi'], 9, 3),
  makeMatch('aug-4', '2026-08-22T12:00:00Z', ['sam', 'hector', 'miguel'], ['can', 'damoun', 'desi'], 7, 2),
];

const awards = app.computeMonthlyAwards(augustMatches, 2026, 7); // month index 7 = August

// Check POTM
assert(awards.potm, 'POTM must be selected');
assert(awards.potm.name.toLowerCase().includes('sam') || awards.potm.name.toLowerCase().includes('hector'), 'Sam or Hector must win POTM');
assert.strictEqual(awards.potm.played >= app.MIN_GAMES_IMPROVED, true, 'POTM must have >= 3 games in month');

// Check exclusion of 2-game player
const twoGameCheck = awards.potm.id === 'two_game_guy';
assert.strictEqual(twoGameCheck, false, 'Player with only 2 games in month must be EXCLUDED from POTM');

// Check Iron Men (100% attendance = 4 of 4 games)
const ironMenIds = awards.ironMen.map(p => p.id);
assert(ironMenIds.includes('sam'), 'Sam (4 of 4) is Iron Man');
assert(ironMenIds.includes('hector'), 'Hector (4 of 4) is Iron Man');
assert(!ironMenIds.includes('two_game_guy'), 'two_game_guy (2 of 4) is NOT Iron Man');
assert(!ironMenIds.includes('miguel'), 'miguel (2 of 4) is NOT Iron Man');

// Check Worst Duo (Sam + Hector 4 wins, Can + Damoun 0 wins from 4 games)
assert(awards.worstDuo, 'Worst Duo must be computed');
assert.strictEqual(awards.worstDuo.played >= app.MIN_GAMES_PAIR, true, 'Worst duo must have >= 3 games together');
console.log('✓ Monthly awards correctly enforce MIN_GAMES_IMPROVED (3) and MIN_GAMES_PAIR (3).\n');

// ----------------------------------------------------------------------
// [Test 4] Deep Link Identifier Resolution
// ----------------------------------------------------------------------
console.log('[Test 4] Deep Link Identifier Resolution:');

const testRegistry = new Map();
testRegistry.set('anderson-brazil', { id: 'anderson-brazil', displayName: 'Anderson (Brazil)', aliases: ['anderson', 'anders'] });
testRegistry.set('daniel-muller', { id: 'daniel-muller', displayName: 'Daniel Müller', aliases: ['dani m', 'muller', 'daniel m'] });
testRegistry.set('sam', { id: 'sam', displayName: 'Sam', aliases: ['sammy'] });

// 1. Valid ID
assert.strictEqual(app.resolvePlayerIdentifier('anderson-brazil', testRegistry), 'anderson-brazil', 'Must resolve exact ID');
// 2. Valid Display Name (case-insensitive)
assert.strictEqual(app.resolvePlayerIdentifier('daniel müller', testRegistry), 'daniel-muller', 'Must resolve Display Name');
// 3. Valid Alias
assert.strictEqual(app.resolvePlayerIdentifier('dani m', testRegistry), 'daniel-muller', 'Must resolve Alias');
assert.strictEqual(app.resolvePlayerIdentifier('sammy', testRegistry), 'sam', 'Must resolve Alias');
// 4. Unknown Value
assert.strictEqual(app.resolvePlayerIdentifier('unknown-ghost-player', testRegistry), null, 'Must return null for unknown identifier');

console.log('✓ Deep link resolution successfully resolves ID, Display Name, and Aliases, returning null on unknown values.\n');

console.log('======================================================================');
console.log('🎉 ALL STAGE E DETERMINISTIC VERIFICATION CHECKS PASSED!');
console.log('======================================================================');
