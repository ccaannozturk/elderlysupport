/**
 * Drift guard: the website's Elo engine vs. the Cloud Functions' copy.
 *
 * functions/index.js carries its own computeEloRatings because Cloud Functions
 * only upload the functions/ directory, so it cannot require ../stats-core.js.
 * That second copy is exactly the kind of duplication that silently diverges —
 * tune a K-factor in one file and the Stats tab starts disagreeing with the AI
 * answers in the admin panel.
 *
 * This test runs both against the same dataset and fails if any player's
 * rating differs. If it fails, the fix is to make functions/index.js match
 * stats-core.js, not to relax the test.
 *
 *   node tests/elo-parity.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'stats-core.js'));
core.setNameResolver(x => x);

// Pull the functions' private copy out without executing the whole module
// (it calls admin.initializeApp() at load).
const fnSrc = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
const grab = (name) => {
  const m = fnSrc.match(new RegExp('\\nfunction ' + name + '\\s*\\([\\s\\S]*?\\n}', 'm'));
  if (!m) throw new Error('functions/index.js is missing ' + name);
  return m.group === undefined ? m[0] : m[0];
};
const consts = fnSrc.match(/const STARTING_ELO[\s\S]*?const MIN_GAMES_PAIR\s*=\s*\d+;/);
if (!consts) throw new Error('functions/index.js: Elo constants not found');
eval(consts[0].replace(/^const\s+(\w+)\s*=/gm, 'globalThis.$1 ='));
eval([
  grab('getMatchTime'),
  grab('computeExpectedScore'),
  grab('computeEloRatings'),
  grab('computePlayerStreaksAndForm'),
  grab('computeNemesisAndRivalry')
].join('\n')
  .replace('function computeEloRatings', 'function computeEloRatingsFN')
  .replace('function computePlayerStreaksAndForm', 'function computePlayerStreaksAndFormFN')
  .replace('function computeNemesisAndRivalry', 'function computeNemesisAndRivalryFN')
);

// Constants must agree before the outputs can be trusted.
const constMismatches = [
  ['STARTING_ELO', core.STARTING_ELO, globalThis.STARTING_ELO],
  ['K_STANDARD_REG', core.K_STANDARD_REG, globalThis.K_STANDARD_REG],
  ['K_STANDARD_NEW', core.K_STANDARD_NEW, globalThis.K_STANDARD_NEW],
  ['K_TOURN_REG', core.K_TOURN_REG, globalThis.K_TOURN_REG],
  ['K_TOURN_NEW', core.K_TOURN_NEW, globalThis.K_TOURN_NEW],
  ['MIN_GAMES_RANKED_ELO', core.MIN_GAMES_RANKED_ELO, globalThis.MIN_GAMES_RANKED_ELO],
  ['MIN_GAMES_PAIR', core.MIN_GAMES_PAIR, globalThis.MIN_GAMES_PAIR]
].filter(([, a, b]) => a !== b);

// Newest backup as the dataset, reshaped into v2 form (player ids).
const dir = path.join(ROOT, 'backups');
const file = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().pop();
const backup = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const raw = backup.collections.matches_v2 || backup.collections.matches;
const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const matches = raw.map(m => {
  const d = JSON.parse(JSON.stringify(m.data));
  const iso = d.date && d.date.value ? d.date.value : d.date;
  d.id = m.id;
  d.date = { toDate: () => new Date(iso), toMillis: () => new Date(iso).getTime() };
  (d.teams || []).forEach(t => { t.players = (t.players || []).map(slug); });
  return d;
}).filter(m => m.teams && m.teams.length >= 2);

const a = core.computeEloRatings(matches).ratings;
const b = computeEloRatingsFN(matches).ratings;
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const diffs = keys
  .map(k => [k, Math.round(a[k] ?? NaN), Math.round(b[k] ?? NaN)])
  .filter(([, x, y]) => x !== y);

console.log(`dataset: ${file} (${matches.length} matches, ${keys.length} players)`);
constMismatches.forEach(([n, x, y]) => console.log(`  CONSTANT MISMATCH ${n}: stats-core=${x} functions=${y}`));
if (diffs.length) {
  console.log(`\n${diffs.length} rating(s) disagree between stats-core.js and functions/index.js:`);
  diffs.slice(0, 15).forEach(([k, x, y]) => console.log(`  ${k.padEnd(22)} site=${x}  functions=${y}  (${y - x > 0 ? '+' : ''}${y - x})`));
}

// Check streaks & nemesis parity across all players
let streakFails = 0;
let nemesisFails = 0;
keys.forEach(playerId => {
  const sCore = core.computePlayerStreaksAndForm(matches, playerId);
  const sFn = computePlayerStreaksAndFormFN(matches, playerId);
  if (sCore.curW !== sFn.curW || sCore.maxW !== sFn.maxW || sCore.curU !== sFn.curU || sCore.maxU !== sFn.maxU || sCore.curL !== sFn.curL || sCore.maxL !== sFn.maxL) {
    streakFails++;
    console.log(`  STREAK MISMATCH for ${playerId}: core=${JSON.stringify(sCore)} fn=${JSON.stringify(sFn)}`);
  }

  const nCore = core.computeNemesisAndRivalry(matches, playerId);
  const nFn = computeNemesisAndRivalryFN(matches, playerId);
  const nemCoreId = nCore.nemesis ? nCore.nemesis.id : null;
  const nemFnId = nFn.nemesis ? nFn.nemesis.id : null;
  if (nemCoreId !== nemFnId) {
    nemesisFails++;
    console.log(`  NEMESIS MISMATCH for ${playerId}: core=${nemCoreId} fn=${nemFnId}`);
  }
});

const failed = diffs.length > 0 || constMismatches.length > 0 || streakFails > 0 || nemesisFails > 0;
console.log(failed
  ? '\nFAIL: engines have drifted. Make functions/index.js match stats-core.js.'
  : '\nPASS: stats-core.js and functions/index.js agree on every rating, streak, and nemesis.');
process.exit(failed ? 1 : 0);
