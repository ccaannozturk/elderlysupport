/**
 * Regression test for match-entry player matching in app.js (resolvePlayerInput,
 * newPlayerIdFor, jsq). Pulls those functions out of app.js by name and runs them
 * against the roster in data/roster-mapping.csv — no browser, no Firebase.
 *
 *   node tests/player-resolve.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// Top-level `function name(...) {` up to the first line that is just `}`
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found in app.js`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 2);
}

const names = ['esc', 'jsq', 'levenshteinDistance', 'getCurrentlyPlacedPlayerIds', 'getPlacedTeamForPlayer',
    'pastedPlayerChip', 'newPlayerIdFor', 'resolvePlayerInput'];
// esc/jsq are one-liners: grab the line
const oneLine = n => src.split('\n').find(l => l.startsWith(`function ${n}(`));

const registry = new Map();
for (const line of fs.readFileSync(path.join(root, 'data/roster-mapping.csv'), 'utf8').trim().split('\n').slice(1)) {
    const [raw, id, displayName] = line.split(',');
    if (!id) continue;
    const p = registry.get(id) || { id, displayName, aliases: [], active: true };
    const a = raw.trim().toLowerCase();
    if (a && !p.aliases.includes(a)) p.aliases.push(a);
    registry.set(id, p);
}

const ctx = { playersRegistry: registry, selectedPlayers: null };
vm.createContext(ctx);
vm.runInContext(names.map(n => (n === 'esc' || n === 'jsq') ? oneLine(n) : extract(n)).join('\n\n'), ctx);

const reset = () => { ctx.selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] }; };
const place = (k, id) => ctx.selectedPlayers[k].push({ status: 'resolved', id, displayName: registry.get(id).displayName });
const resolve = (input, k = 'B') => ctx.resolvePlayerInput(input, k);

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`ok   ${label}`); }
    catch (e) { failures++; console.log(`FAIL ${label}\n     ${e.message}`); }
}

check('exact name resolves', () => {
    reset();
    const r = resolve('Alex');
    assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.id, 'alex');
});

check('name of a player already on the other team says so (not a lookalike)', () => {
    reset(); place('A', 'alex');
    const r = resolve('Alex');
    assert.strictEqual(r.status, 'placed'); assert.strictEqual(r.id, 'alex'); assert.strictEqual(r.placedTeam, 'A');
});

check('name of a player already on the SAME team is also caught', () => {
    reset(); place('B', 'tom');
    assert.strictEqual(resolve('Tom').status, 'placed');
});

check('unique prefix needs a tap to confirm (amber), never auto-accepted', () => {
    reset();
    const r = resolve('Jon');
    assert.strictEqual(r.status, 'amber'); assert.strictEqual(r.candidate.id, 'jonne');
});

check('prefix shared by several players offers all of them', () => {
    reset();
    const r = resolve('Daniel');
    assert.strictEqual(r.status, 'red');
    const ids = r.candidates.map(c => c.id);
    assert.ok(ids.includes('daniel_gomez') && ids.includes('daniel_muller'), ids.join(','));
});

check('role annotation is stripped from the name', () => {
    reset();
    const r = resolve('Can (GK)');
    assert.strictEqual(r.status, 'resolved'); assert.strictEqual(r.id, 'can'); assert.strictEqual(r.rawInput, 'Can');
});

check('typo gets a real near-match, not alphabetical filler', () => {
    reset();
    const r = resolve('Ahmd');
    assert.ok(['amber', 'red'].includes(r.status), r.status);
    const ids = r.candidate ? [r.candidate.id] : r.candidates.map(c => c.id);
    assert.ok(ids.includes('ahmed'), ids.join(','));
});

check('unknown name is new with no junk suggestions', () => {
    reset();
    const r = resolve('Pranavkumar');
    assert.strictEqual(r.status, 'new');
    assert.ok(!r.top3.some(c => ['adri', 'ahmed', 'alan_peralta'].includes(c.id)), JSON.stringify(r.top3));
});

check('pasted high-confidence AI id is not trusted if already placed', () => {
    reset(); place('A', 'mark');
    const c = ctx.pastedPlayerChip({ playerId: 'mark', confidence: 0.99, rawName: 'Mark' }, 'B');
    assert.notStrictEqual(c.status, 'resolved');
});

check('new player with an existing name gets a fresh id', () => {
    reset();
    assert.strictEqual(ctx.newPlayerIdFor('Mark'), 'mark_2');
    assert.strictEqual(ctx.newPlayerIdFor('Zebedee Öztürk'), 'zebedee_ozturk');
});

check('jsq makes a value safe inside an inline onclick', () => {
    const out = ctx.jsq(`x');alert(1);//`);
    assert.ok(!out.includes("'") && !out.includes('"'), out);
    // what the browser hands to the JS engine after decoding the attribute
    const decoded = out.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.strictEqual(JSON.parse(decoded), `x');alert(1);//`);
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nPASS: player matching behaves');
