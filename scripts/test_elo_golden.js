#!/usr/bin/env node
/**
 * Golden Output Assertions: Elo & Power Ranking Engine (Item 16)
 * Elderly Support League — Stage D
 *
 * Asserts the Elo calculation engine against a 5-match hand-calculated fixture
 * containing standard wins, draws, newcomer K (48), regular K (32), and a 3-way tournament.
 */

const assert = require('assert');

// Constants
const STARTING_ELO = 1200;
const K_STANDARD_REG = 32;
const K_STANDARD_NEW = 48;
const K_TOURN_REG = 16;
const K_TOURN_NEW = 24;
const MIN_GAMES_RANKED_ELO = 5;

function computeExpectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function computeEloRatings(matches) {
  // Sort deterministically: date ascending, document id ascending
  const sorted = [...matches].sort((a, b) => {
    const parseTime = (val) => {
      if (!val) return 0;
      if (typeof val === 'number') return val;
      if (val.__type === 'timestamp') return new Date(val.value).getTime();
      if (val.toMillis && typeof val.toMillis === 'function') return val.toMillis();
      if (val.toDate && typeof val.toDate === 'function') return val.toDate().getTime();
      return new Date(val).getTime();
    };
    const tA = parseTime(a.date);
    const tB = parseTime(b.date);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const ratings = {}; // playerId -> current rating
  const matchCounts = {}; // playerId -> matches count prior to current match
  const ratingHistory = {}; // playerId -> array of { matchId, date, rating, delta }

  const getRating = (id) => ratings[id] !== undefined ? ratings[id] : STARTING_ELO;
  const getCount = (id) => matchCounts[id] || 0;

  for (const m of sorted) {
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0];
      const tB = m.teams[1];
      const pA = tA.players || [];
      const pB = tB.players || [];

      const avgA = pA.length ? (pA.reduce((sum, p) => sum + getRating(p), 0) / pA.length) : STARTING_ELO;
      const avgB = pB.length ? (pB.reduce((sum, p) => sum + getRating(p), 0) / pB.length) : STARTING_ELO;

      const expA = computeExpectedScore(avgA, avgB);
      const expB = 1 - expA;

      let actA = 0.5, actB = 0.5;
      const sA = tA.score || 0;
      const sB = tB.score || 0;
      if (sA > sB) { actA = 1; actB = 0; }
      else if (sB > sA) { actA = 0; actB = 1; }

      for (const p of pA) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        const delta = k * (actA - expA);
        const newR = getRating(p) + delta;
        ratings[p] = newR;
        matchCounts[p] = getCount(p) + 1;
        if (!ratingHistory[p]) ratingHistory[p] = [];
        ratingHistory[p].push({ matchId: m.id, delta, rating: newR });
      }

      for (const p of pB) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        const delta = k * (actB - expB);
        const newR = getRating(p) + delta;
        ratings[p] = newR;
        matchCounts[p] = getCount(p) + 1;
        if (!ratingHistory[p]) ratingHistory[p] = [];
        ratingHistory[p].push({ matchId: m.id, delta, rating: newR });
      }
    } else if (m.type === 'Tournament' && m.teams.length >= 3) {
      // 3 teams ranked 1st, 2nd, 3rd
      const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
      const r2 = m.teams.find(t => t.rank === 2) || m.teams[1];
      const r3 = m.teams.find(t => t.rank === 3) || m.teams[2];

      const p1 = r1.players || [];
      const p2 = r2.players || [];
      const p3 = r3.players || [];

      const avg1 = p1.length ? (p1.reduce((sum, p) => sum + getRating(p), 0) / p1.length) : STARTING_ELO;
      const avg2 = p2.length ? (p2.reduce((sum, p) => sum + getRating(p), 0) / p2.length) : STARTING_ELO;
      const avg3 = p3.length ? (p3.reduce((sum, p) => sum + getRating(p), 0) / p3.length) : STARTING_ELO;

      // 3 pairwise comparisons at start of match
      const exp1_2 = computeExpectedScore(avg1, avg2);
      const exp2_1 = 1 - exp1_2;

      const exp1_3 = computeExpectedScore(avg1, avg3);
      const exp3_1 = 1 - exp1_3;

      const exp2_3 = computeExpectedScore(avg2, avg3);
      const exp3_2 = 1 - exp2_3;

      for (const p of p1) {
        const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
        const delta = (k * (1 - exp1_2)) + (k * (1 - exp1_3));
        const newR = getRating(p) + delta;
        ratings[p] = newR;
        matchCounts[p] = getCount(p) + 1;
        if (!ratingHistory[p]) ratingHistory[p] = [];
        ratingHistory[p].push({ matchId: m.id, delta, rating: newR });
      }

      for (const p of p2) {
        const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
        const delta = (k * (0 - exp2_1)) + (k * (1 - exp2_3));
        const newR = getRating(p) + delta;
        ratings[p] = newR;
        matchCounts[p] = getCount(p) + 1;
        if (!ratingHistory[p]) ratingHistory[p] = [];
        ratingHistory[p].push({ matchId: m.id, delta, rating: newR });
      }

      for (const p of p3) {
        const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
        const delta = (k * (0 - exp3_1)) + (k * (0 - exp3_2));
        const newR = getRating(p) + delta;
        ratings[p] = newR;
        matchCounts[p] = getCount(p) + 1;
        if (!ratingHistory[p]) ratingHistory[p] = [];
        ratingHistory[p].push({ matchId: m.id, delta, rating: newR });
      }
    }
  }

  return { ratings, matchCounts, ratingHistory };
}

// -------------------------------------------------------------
// 5-Match Hand-Calculated Fixture
// -------------------------------------------------------------
const fixtureMatches = [
  // Match 1: Standard win, all fresh players (K=48)
  {
    id: 'm1',
    date: '2026-01-01T00:00:00Z',
    type: 'Standard',
    teams: [
      { score: 5, players: ['p1', 'p2'] },
      { score: 3, players: ['p3', 'p4'] }
    ]
  },
  // Match 2: Standard draw (4 - 4)
  {
    id: 'm2',
    date: '2026-01-02T00:00:00Z',
    type: 'Standard',
    teams: [
      { score: 4, players: ['p1', 'p3'] },
      { score: 4, players: ['p2', 'p4'] }
    ]
  },
  // Match 3: Standard win with newcomers P5, P6 (2 - 4)
  {
    id: 'm3',
    date: '2026-01-03T00:00:00Z',
    type: 'Standard',
    teams: [
      { score: 2, players: ['p1', 'p5'] },
      { score: 4, players: ['p3', 'p6'] }
    ]
  },
  // Match 4: 3-Way Tournament
  // Team 1 (Rank 1): p1, p2
  // Team 2 (Rank 2): p3, p5
  // Team 3 (Rank 3): p4, p6
  {
    id: 'm4',
    date: '2026-01-04T00:00:00Z',
    type: 'Tournament',
    teams: [
      { rank: 1, players: ['p1', 'p2'] },
      { rank: 2, players: ['p3', 'p5'] },
      { rank: 3, players: ['p4', 'p6'] }
    ]
  },
  // Match 5: Standard win involving veteran dummy matches to test K=32
  // We add 10 dummy matches for p7 beforehand, then match 5 has p1 vs p7
  // Let's create an explicit 5th match where p1 plays p7
  {
    id: 'm5',
    date: '2026-01-05T00:00:00Z',
    type: 'Standard',
    teams: [
      { score: 3, players: ['p1'] },
      { score: 1, players: ['p7'] }
    ]
  }
];

// Add 10 dummy matches on 2025-12-01 for p7 and p8 (all draws) so p7 has count=10, rating=1200
const fullFixture = [];
for (let i = 1; i <= 10; i++) {
  fullFixture.push({
    id: `dummy_${i}`,
    date: `2025-12-${String(i).padStart(2, '0')}T00:00:00Z`,
    type: 'Standard',
    teams: [
      { score: 0, players: ['p7'] },
      { score: 0, players: ['p8'] }
    ]
  });
}
fullFixture.push(...fixtureMatches);

console.log('='.repeat(60));
console.log('RUNNING GOLDEN ELO FIXTURE VERIFICATION');
console.log('='.repeat(60));

const result = computeEloRatings(fullFixture);

// Expected ratings worked out by hand:
// After Match 1:
// p1, p2: 1200 + 48*(1 - 0.5) = 1224.0
// p3, p4: 1200 + 48*(0 - 0.5) = 1176.0

// After Match 2 (Draw):
// AvgA (p1, p3) = 1200, AvgB (p2, p4) = 1200 -> Exp=0.5 -> Delta=0.
// Ratings remain: p1=1224, p2=1224, p3=1176, p4=1176.

// After Match 3:
// Team A (p1=1224, p5=1200) -> AvgA=1212. Team B (p3=1176, p6=1200) -> AvgB=1188.
// ExpA = 1 / (1 + 10^(-24/400)) = 0.5344840
// ExpB = 1 - ExpA = 0.4655160
// Team B wins -> DeltaA = 48*(0 - 0.5344840) = -25.655232
//               DeltaB = 48*(1 - 0.4655160) = +25.655232
// p1: 1224 - 25.655232 = 1198.344768
// p5: 1200 - 25.655232 = 1174.344768
// p3: 1176 + 25.655232 = 1201.655232
// p6: 1200 + 25.655232 = 1225.655232

// After Match 4 (Tournament):
// Avg1 (p1=1198.344768, p2=1224) = 1211.172384
// Avg2 (p3=1201.655232, p5=1174.344768) = 1188.000000
// Avg3 (p4=1176, p6=1225.655232) = 1200.827616
// T1 vs T2: Exp1_2 = 0.5332938, Exp2_1 = 0.4667062
// T1 vs T3: Exp1_3 = 0.5148816, Exp3_1 = 0.4851184
// T2 vs T3: Exp2_3 = 0.4815486, Exp3_2 = 0.5184514
// Deltas (K=24):
// T1 (p1, p2): 24*(1 - 0.5332938) + 24*(1 - 0.5148816) = +22.8437904
// T2 (p3, p5): 24*(0 - 0.4667062) + 24*(1 - 0.4815486) = +1.2418848
// T3 (p4, p6): 24*(0 - 0.4851184) + 24*(0 - 0.5184514) = -24.0856752
// Ratings:
// p1: 1198.344768 + 22.8437904 = 1221.1885584
// p2: 1224 + 22.8437904 = 1246.8437904
// p3: 1201.655232 + 1.2418848 = 1202.8971168
// p5: 1174.344768 + 1.2418848 = 1175.5866528
// p4: 1176 - 24.0856752 = 1151.9143248
// p6: 1225.655232 - 24.0856752 = 1201.5695568

// After Match 5:
// p1 (1221.1885584, count=4, K=48) vs p7 (1200.0, count=10, K=32). Score: 3 - 1 (p1 wins).
// Diff = 1200 - 1221.1885584 = -21.1885584 -> ExpA = 0.5304388, ExpB = 0.4695612.
// Delta p1 = 48 * (1 - 0.5304388) = +22.5389376 -> p1: 1243.7274960
// Delta p7 = 32 * (0 - 0.4695612) = -15.0259584 -> p7: 1184.9740416

const expected = {
  p1: 1243.727496,
  p2: 1246.843790,
  p3: 1202.897117,
  p4: 1151.914325,
  p5: 1175.586653,
  p6: 1201.569557,
  p7: 1184.974042,
  p8: 1200.000000
};

let allPassed = true;
for (const [p, expVal] of Object.entries(expected)) {
  const actualVal = result.ratings[p];
  const diff = Math.abs(actualVal - expVal);
  const passed = diff < 0.001;
  if (!passed) allPassed = false;
  console.log(
    `Player ${p.padEnd(4)}: Expected ${expVal.toFixed(6)} | Actual ${actualVal.toFixed(6)} | Diff: ${diff.toFixed(6)} -> ${passed ? '✓ PASSED' : '✗ FAILED'}`
  );
}

// Assert provisional status
assert.strictEqual(result.matchCounts['p1'] < MIN_GAMES_RANKED_ELO, false, 'p1 should not be provisional (5 matches)');
assert.strictEqual(result.matchCounts['p2'] < MIN_GAMES_RANKED_ELO, true, 'p2 should be provisional (3 matches)');
assert.strictEqual(result.matchCounts['p5'] < MIN_GAMES_RANKED_ELO, true, 'p5 should be provisional (2 matches)');

console.log('='.repeat(60));
if (allPassed) {
  console.log('🎉 ALL GOLDEN ELO FIXTURE TESTS PASSED PERFECTLY!');
  process.exit(0);
} else {
  console.error('❌ SOME ELO TESTS FAILED');
  process.exit(1);
}
