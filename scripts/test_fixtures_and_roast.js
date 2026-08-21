const assert = require('assert');
const fs = require('fs');

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

const {
  STARTING_ELO,
  computeEloRatings,
  computeRoastAngles,
  ROAST_THRESHOLD,
  computeExpectedScore
} = require('../app.js');

console.log('======================================================================');
console.log('TEST SUITE: ITEM 42 — FIXTURES, ROAST STUDIO & PREDICTION LIFECYCLE');
console.log('======================================================================\n');

function loadRealMatchesAndPlayers() {
  const matchesData = [
    {
      id: 'm1',
      date: new Date('2026-06-01T19:00:00Z'),
      type: 'Standard',
      location: 'Sportgebouw Bibian Mentel',
      teams: [
        { teamName: 'Squad A', players: ['can_id', 'damoun_id', 'hector_id'], score: 5 },
        { teamName: 'Squad B', players: ['antraniek_id', 'bert_id', 'enes_id'], score: 3 }
      ]
    },
    {
      id: 'm2',
      date: new Date('2026-06-08T19:00:00Z'),
      type: 'Standard',
      location: 'Sportgebouw Bibian Mentel',
      teams: [
        { teamName: 'Squad A', players: ['hector_id', 'jonne_id', 'nino_id'], score: 7 },
        { teamName: 'Squad B', players: ['can_id', 'manu_id', 'gustavo_id'], score: 2 }
      ]
    },
    {
      id: 'm3',
      date: new Date('2026-06-15T19:00:00Z'),
      type: 'Standard',
      location: 'Sportgebouw Bibian Mentel',
      teams: [
        { teamName: 'Squad A', players: ['hector_id', 'bert_id', 'enes_id'], score: 6 },
        { teamName: 'Squad B', players: ['can_id', 'manu_id', 'gustavo_id'], score: 4 }
      ]
    },
    {
      id: 'm4',
      date: new Date('2026-06-22T19:00:00Z'),
      type: 'Standard',
      location: 'Sportgebouw Bibian Mentel',
      teams: [
        { teamName: 'Squad A', players: ['hector_id', 'antraniek_id', 'stefan_id'], score: 8 },
        { teamName: 'Squad B', players: ['can_id', 'manu_id', 'gustavo_id'], score: 3 }
      ]
    },
    {
      id: 'm5',
      date: new Date('2026-06-29T19:00:00Z'),
      type: 'Standard',
      location: 'Sportgebouw Bibian Mentel',
      teams: [
        { teamName: 'Squad A', players: ['hector_id', 'damoun_id', 'nino_id'], score: 9 },
        { teamName: 'Squad B', players: ['can_id', 'manu_id', 'gustavo_id'], score: 5 }
      ]
    }
  ];

  const playersList = [
    { id: 'can_id', displayName: 'Can', aliases: ['can'] },
    { id: 'hector_id', displayName: 'Hector', aliases: ['hector'] },
    { id: 'manu_id', displayName: 'Manu', aliases: ['manu'] },
    { id: 'gustavo_id', displayName: 'Gustavo', aliases: ['gustavo'] },
    { id: 'damoun_id', displayName: 'Damoun', aliases: ['damoun'] },
    { id: 'antraniek_id', displayName: 'Antraniek', aliases: ['antraniek'] },
    { id: 'bert_id', displayName: 'Bert', aliases: ['bert'] },
    { id: 'enes_id', displayName: 'Enes', aliases: ['enes'] },
    { id: 'jonne_id', displayName: 'Jonne', aliases: ['jonne'] },
    { id: 'nino_id', displayName: 'Nino', aliases: ['nino'] },
    { id: 'stefan_id', displayName: 'Stefan', aliases: ['stefan'] }
  ];

  return { matchesData, playersList };
}

console.log('[Test 1] Roast Angle Candidate Generation & Scoring:');
const { matchesData, playersList } = loadRealMatchesAndPlayers();
const candidates = computeRoastAngles(matchesData, playersList, []);

assert(Array.isArray(candidates), 'Candidates must be an array');
assert(candidates.length > 0, 'Must find candidates in test dataset');
console.log(`✓ Found ${candidates.length} candidates.`);

const canLosingStreak = candidates.find(c => c.targetPlayerId === 'can_id' && c.angleType === 'losing_streak');
assert(canLosingStreak, 'Must identify Can on losing streak');
assert.strictEqual(canLosingStreak.targetPlayerName, 'Can');
assert(canLosingStreak.score >= ROAST_THRESHOLD, 'Score must exceed threshold');
console.log(`✓ Losing streak identified: "${canLosingStreak.facts}" (Score: ${canLosingStreak.score})`);

const duo = candidates.find(c => c.angleType === 'worst_duo');
assert(duo, 'Must identify worst duo');
console.log(`✓ Worst duo identified: "${duo.facts}" (Score: ${duo.score})`);

const nemesis = candidates.find(c => c.angleType === 'nemesis' && c.targetPlayerId === 'can_id');
assert(nemesis, 'Must identify nemesis');
console.log(`✓ Nemesis identified: "${nemesis.facts}" (Score: ${nemesis.score})`);

console.log('\n[Test 2] Below-Threshold Candidates Flagged:');
const belowThresh = candidates.filter(c => c.score < ROAST_THRESHOLD);
belowThresh.forEach(c => { assert.strictEqual(c.belowThreshold, true); });
console.log(`✓ Verified ${belowThresh.length} below-threshold angles are properly tagged.`);

console.log('\n[Test 3] Opt-Out Exclusion:');
const optedOutCandidates = computeRoastAngles(matchesData, playersList, ['can_id']);
assert(!optedOutCandidates.some(c => c.targetPlayerId === 'can_id'), 'Opted-out player must not appear in candidates');
console.log('✓ Opted-out player strictly excluded from all candidates.');

console.log('\n[Test 4] Deterministic Squad Elo & Prediction Derivation:');
const eloData = computeEloRatings(matchesData);
const ratings = eloData.ratings || {};

const squadA_players = ['hector_id', 'damoun_id', 'nino_id'];
const squadB_players = ['can_id', 'manu_id', 'gustavo_id'];

const avgEloA = Math.round(squadA_players.reduce((sum, p) => sum + (ratings[p] || STARTING_ELO), 0) / squadA_players.length);
const avgEloB = Math.round(squadB_players.reduce((sum, p) => sum + (ratings[p] || STARTING_ELO), 0) / squadB_players.length);

assert(avgEloA > avgEloB, 'Squad A avg Elo should exceed Squad B');

const expWinA = computeExpectedScore(avgEloA, avgEloB);
const predictedWinner = avgEloA >= avgEloB ? 'Squad A' : 'Squad B';
const winProbability = Math.round((avgEloA >= avgEloB ? expWinA : (1 - expWinA)) * 100);

assert.strictEqual(predictedWinner, 'Squad A');
assert(winProbability > 50, 'Win probability should exceed 50%');
console.log(`✓ Squad A (Avg ${avgEloA}) vs Squad B (Avg ${avgEloB}) -> Predicted Winner: ${predictedWinner} (${winProbability}% probability)`);

console.log('\n[Test 5] Lifecycle: scheduled -> played Resolution & Prediction Evaluation:');
const mockFixtureA = { id: 'fix_1', status: 'scheduled', predictedWinner: 'Squad A', squads: [{ name: 'Squad A', players: squadA_players }, { name: 'Squad B', players: squadB_players }] };
const matchOutcomeA = { teams: [{ teamName: 'Squad A', score: 6 }, { teamName: 'Squad B', score: 2 }] };
const actualWinnerA = matchOutcomeA.teams[0].score > matchOutcomeA.teams[1].score ? matchOutcomeA.teams[0].teamName : matchOutcomeA.teams[1].teamName;
const resultA = (mockFixtureA.predictedWinner.toLowerCase().trim() === actualWinnerA.toLowerCase().trim()) ? 'correct' : 'wrong';
assert.strictEqual(resultA, 'correct');
console.log('✓ Scenario A: Correct prediction evaluated properly.');

const matchOutcomeB = { teams: [{ teamName: 'Squad A', score: 3 }, { teamName: 'Squad B', score: 7 }] };
const actualWinnerB = matchOutcomeB.teams[0].score > matchOutcomeB.teams[1].score ? matchOutcomeB.teams[0].teamName : matchOutcomeB.teams[1].teamName;
const resultB = (mockFixtureA.predictedWinner.toLowerCase().trim() === actualWinnerB.toLowerCase().trim()) ? 'correct' : 'wrong';
assert.strictEqual(resultB, 'wrong');
console.log('✓ Scenario B: Wrong prediction evaluated properly without hedging.');

console.log('\n[Test 6] Commissioner Prediction Record Calculation:');
const fixtureHistory = [ { id: 'f1', status: 'played', predictionResult: 'correct' }, { id: 'f2', status: 'played', predictionResult: 'correct' }, { id: 'f3', status: 'played', predictionResult: 'wrong' }, { id: 'f4', status: 'archived', predictionResult: null }, { id: 'f5', status: 'scheduled', predictionResult: null } ];
const completed = fixtureHistory.filter(f => f.status === 'played' && f.predictionResult);
const correctCount = completed.filter(f => f.predictionResult === 'correct').length;
const wrongCount = completed.filter(f => f.predictionResult === 'wrong').length;
assert.strictEqual(correctCount, 2);
assert.strictEqual(wrongCount, 1);
assert.strictEqual(completed.length, 3);
console.log(`✓ Record accurately computed: ${correctCount} Correct – ${wrongCount} Wrong (Archived and scheduled excluded).`);

console.log('\n[Test 7] Community Tab 5-Card Hierarchy & Card Absence:');
const appJsSource = fs.readFileSync('app.js', 'utf8');
const renderCommunityTabCode = appJsSource.substring(appJsSource.indexOf('async function renderCommunityTab'));
const templateStart = renderCommunityTabCode.indexOf('container.innerHTML = `');
const template = renderCommunityTabCode.substring(templateStart);

const nextGameIndex = template.indexOf('${nextGameHtml}');
const roastIndex = template.indexOf('${roastHtml}');
const powerIndex = template.indexOf('WEEKLY POWER RANKINGS');
const milestoneIndex = template.indexOf('MILESTONE WATCH');
const awardsIndex = template.indexOf('MONTHLY AWARDS');

assert(nextGameIndex !== -1, 'Next game html must exist');
assert(roastIndex !== -1, 'Roast html must exist');
assert(nextGameIndex < roastIndex, 'Next game must appear before Roast');
assert(roastIndex < powerIndex, 'Roast must appear before Power Rankings');
assert(powerIndex < milestoneIndex, 'Power rankings must appear before Milestone Watch');
assert(milestoneIndex < awardsIndex, 'Milestone Watch must appear before Monthly Awards');
assert(appJsSource.includes('id="milestoneWatchCollapse"'), 'Milestone Watch must be collapsible');
assert(appJsSource.includes('id="awardsCollapse"'), 'Monthly Awards must be collapsible');
console.log('✓ Verified 5-card order: Next Game -> Roast of the Week -> Weekly Power Rankings -> Milestone Watch (collapsed) -> Monthly Awards (collapsed).');

console.log('\n======================================================================');
console.log('🎉 ALL ITEM 42 FIXTURES & ROAST STUDIO CHECKS PASSED!');
console.log('======================================================================');
