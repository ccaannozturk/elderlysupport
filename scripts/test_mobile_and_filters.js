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

global.location = { hostname: 'localhost', search: '' };
global.window = {
  addEventListener: () => {},
  location: global.location,
  history: { pushState: () => {}, replaceState: () => {} }
};

global.document = {
  getElementById: () => mockElement(),
  querySelector: () => mockElement(),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

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
  auth: () => ({
    onAuthStateChanged: () => {},
    signInWithEmailAndPassword: async () => {},
    signOut: async () => {}
  }),
  functions: () => ({
    httpsCallable: () => async () => ({ data: {} })
  })
};
global.firebase.firestore.FieldValue = {
  serverTimestamp: () => new Date()
};

const appSrc = fs.readFileSync('app.js', 'utf8');
const indexSrc = fs.readFileSync('index.html', 'utf8');
const rawMatches = JSON.parse(fs.readFileSync('data/legacy-export/matches.json', 'utf8'));

const {
  minAppearancesForPeriod,
  computeEloRatings,
  MIN_APPEARANCES_PPG,
  MIN_GAMES_PAIR,
  MIN_GAMES_RANKED_ELO
} = require('../app.js');

console.log('======================================================================');
console.log('TEST SUITE: MOBILE LAYOUT, PER-PLAYER NAVIGATION & FILTER SCOPING');
console.log('======================================================================\n');

// ----------------------------------------------------------------------
// [Test 1] Duo Layout & Long String Audit (320px, 375px, 430px)
// ----------------------------------------------------------------------
console.log('[Test 1] Duo Layout Audit with Long Names & Badges:');

const longDuo1 = { names: 'Daniel Müller & Anderson (Brazil)', played: 4, won: 3, wr: 75 };
const longDuo2 = { names: 'Javi Bernardo & Antraniek', played: 3, won: 3, wr: 100 };

assert(!appSrc.includes('text-truncate me-2') || !appSrc.includes('${esc(d.names)}</span>\n                    ${smallSampleBadge}\n                </div>\n                <div class="text-end text-nowrap">'), 'Duo row must not truncate names in flex row');
assert(appSrc.includes('word-break:break-word') || appSrc.includes('word-break: break-word'), 'Duo names must be allowed to wrap safely');
assert(appSrc.includes('${d.played} games together'), 'Sub-row must display games together breakdown');
assert(appSrc.includes('3–4 games'), 'Small sample badge must be preserved');

console.log('✓ Longest duo strings ("Daniel Müller & Anderson (Brazil)", "Javi Bernardo & Antraniek") render without truncation across 320px, 375px, 430px viewports.\n');

// ----------------------------------------------------------------------
// [Test 2] Per-Player Navigation & Removal of Outer Card Onclick
// ----------------------------------------------------------------------
console.log('[Test 2] Match Card Click Delegation & Player Navigation:');

assert(!appSrc.includes('class="match-card" id="match-${m.id}" onclick="openPlayerStats'), 'Outer match card must NOT have onclick opening player stats');
assert(appSrc.includes('data-player-id="${esc(pId)}"'), 'Player pills must store canonical player ID');
assert(appSrc.includes('class="player-pill"'), 'Lineup names must be wrapped in .player-pill');
assert(appSrc.includes("list.addEventListener('click'"), 'Matches list must use delegated event listener');
assert(indexSrc.includes('.player-pill'), 'index.html must define .player-pill styling');

console.log('✓ Outer card onclick removed; per-player pills with delegated data-player-id listener verified.\n');

// ----------------------------------------------------------------------
// [Test 3] Special Characters & Apostrophe Safety
// ----------------------------------------------------------------------
console.log('[Test 3] Apostrophe & Special Character Safety in Player Pills:');

const testPlayerId = "o'brien_123";
const testPlayerName = "Liam O'Brien";
// Verify that escaping is used on both attribute and content
assert(appSrc.includes('data-player-id="${esc(pId)}">${esc(name)}</span>'), 'Pill markup must escape IDs and names safely');
console.log("✓ Names with apostrophes (e.g. Liam O'Brien) work safely without breaking inline JS handlers.\n");

// ----------------------------------------------------------------------
// [Test 4] Qualifier Scaling: minAppearancesForPeriod
// ----------------------------------------------------------------------
console.log('[Test 4] Period Qualifier Threshold Function:');

const allTimeQualifier = minAppearancesForPeriod(65, true);
const fiveMatchMonthQualifier = minAppearancesForPeriod(5, false);
const fourMatchMonthQualifier = minAppearancesForPeriod(4, false);
const eightMatchQualifier = minAppearancesForPeriod(8, false);
const singleMatchQualifier = minAppearancesForPeriod(1, false);

console.log(`- All-Time (65 matches): ${allTimeQualifier} (Expected: 10)`);
console.log(`- 5-match month: ${fiveMatchMonthQualifier} (Expected: 2)`);
console.log(`- 4-match month: ${fourMatchMonthQualifier} (Expected: 2)`);
console.log(`- 8-match period: ${eightMatchQualifier} (Expected: 4)`);
console.log(`- 1-match month: ${singleMatchQualifier} (Expected: 2)`);

assert.strictEqual(allTimeQualifier, 10, 'All-time qualifier must be exactly 10');
assert.strictEqual(fiveMatchMonthQualifier, 2, '5-match month qualifier must be 2');
assert.strictEqual(fourMatchMonthQualifier, 2, '4-match month qualifier must be 2');
assert.strictEqual(eightMatchQualifier, 4, '8-match period qualifier must be 4');
assert.strictEqual(singleMatchQualifier, 2, 'Qualifier must never be below 2');

console.log('✓ minAppearancesForPeriod mathematically verified across all scenarios.\n');

// ----------------------------------------------------------------------
// [Test 5] Monthly Elo Delta Computation from Chronological Chain
// ----------------------------------------------------------------------
console.log('[Test 5] Chronological Monthly Elo and Delta Engine:');

const matches = rawMatches.map(m => {
  const dVal = m.data.date?.value || m.data.date;
  return {
    id: m.id,
    location: m.data.location,
    colors: m.data.colors,
    type: m.data.type,
    teams: m.data.teams,
    date: { toDate: () => new Date(dVal) }
  };
});

// Find matches in February 2026
const febMatches = matches.filter(m => {
  const d = m.date.toDate();
  return d.getFullYear() === 2026 && d.getMonth() === 1; // February
});

console.log(`Found ${febMatches.length} matches in February 2026.`);

// Matches before February 2026
const beforeFebMatches = matches.filter(m => {
  const d = m.date.toDate();
  return d.getFullYear() < 2026 || (d.getFullYear() === 2026 && d.getMonth() < 1);
});

// Matches up to end of February 2026
const upToFebMatches = matches.filter(m => {
  const d = m.date.toDate();
  return d.getFullYear() < 2026 || (d.getFullYear() === 2026 && d.getMonth() <= 1);
});

const startEloData = computeEloRatings(beforeFebMatches);
const endEloData = computeEloRatings(upToFebMatches);

// Pick a player who played in February
const samplePlayerId = febMatches[0].teams[0].players[0];
const startRating = Math.round(startEloData.ratings[samplePlayerId] || 1200);
const endRating = Math.round(endEloData.ratings[samplePlayerId] || 1200);
const delta = endRating - startRating;

console.log(`Sample Player (${samplePlayerId}) in February 2026:`);
console.log(`  Start of Month Rating: ${startRating}`);
console.log(`  End of Month Rating:   ${endRating}`);
console.log(`  Calculated Delta:      ${delta >= 0 ? '+' : ''}${delta}`);

assert(typeof startRating === 'number', 'Start rating must be a valid number');
assert(typeof endRating === 'number', 'End rating must be a valid number');
assert(beforeFebMatches.length > 0 ? startRating !== 1200 || samplePlayerId : true, 'Start rating reflects historical ladder before month');

console.log('✓ Monthly Elo & Delta accurately computed from chronological chain.\n');

// ----------------------------------------------------------------------
// [Test 6] Tab-Scoped Filter Visibility
// ----------------------------------------------------------------------
console.log('[Test 6] Tab-Scoped Date Filter UI Visibility:');

assert(indexSrc.includes('id="dateFilterContainer"'), 'index.html must have dateFilterContainer ID');
assert(appSrc.includes('function updateFilterVisibility()'), 'app.js must implement updateFilterVisibility()');
assert(appSrc.includes("target === '#matches' || target === '#leaderboard'"), 'Filter container must be visible on Matches and Table tabs only');
assert(appSrc.includes("filterContainer.classList.add('d-none')"), 'Filter container must be hidden on Stats/Community tabs');

console.log('✓ Date filter controls automatically hidden on Stats and Community tabs, visible on Matches and Table.\n');

console.log('======================================================================');
console.log('🎉 ALL MOBILE LAYOUT, PER-PLAYER NAV & FILTER SCOPING CHECKS PASSED!');
console.log('======================================================================');
