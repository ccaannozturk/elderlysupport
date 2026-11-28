/**
 * Regression test for the local Magic Paste parser in app.js (fallbackLocalParser),
 * the one used when the parseLineup Cloud Function is unavailable.
 *
 *   node tests/magic-paste.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = src.indexOf('function fallbackLocalParser(');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.slice(start, src.indexOf('\n}\n', start) + 2), ctx);
const parse = ctx.fallbackLocalParser;

// Array.from: arrays made inside the vm context have another prototype, which deepStrictEqual rejects
const names = t => Array.from(t.players, p => p.rawName);

// Team name and players on separate lines, WhatsApp *bold*, a (ref) tag
const twoLine = parse(`*Ejackulators* 💦🥵
Can, Jack, Mark, Pranav, Santi

*Kentatainers* 🎮🎭
Damoun, Gus (ref), Jure, Kenta, Malaz `);
assert.strictEqual(twoLine.matchType, 'Standard');
assert.strictEqual(twoLine.teams[0].name, 'Ejackulators 💦🥵');
assert.deepStrictEqual(names(twoLine.teams[0]), ['Can', 'Jack', 'Mark', 'Pranav', 'Santi']);
assert.strictEqual(twoLine.teams[1].name, 'Kentatainers 🎮🎭');
assert.deepStrictEqual(names(twoLine.teams[1]), ['Damoun', 'Gus', 'Jure', 'Kenta', 'Malaz']);
assert.strictEqual(twoLine.teams[0].score, null, 'no score in the message -> blank, not 0');

// Name, players and shirt colour all on one line
const oneLine = parse(`*Ejackulators* 💦🥵 Can, Jack, Mark, Pranav, Santi 🔵 (blue shirts)

*Kentatainers* 🎮🎭 Damoun, Gus (ref), Jure, Kenta, Malaz 🟡 (yellow shirts)`);
assert.strictEqual(oneLine.matchType, 'Standard');
assert.strictEqual(oneLine.teams[0].name, 'Ejackulators 💦🥵');
assert.strictEqual(oneLine.teams[0].color, 'blue');
assert.deepStrictEqual(names(oneLine.teams[0]), ['Can', 'Jack', 'Mark', 'Pranav', 'Santi']);
assert.strictEqual(oneLine.teams[1].name, 'Kentatainers 🎮🎭');
assert.strictEqual(oneLine.teams[1].color, 'yellow');
assert.deepStrictEqual(names(oneLine.teams[1]), ['Damoun', 'Gus', 'Jure', 'Kenta', 'Malaz']);

// "Team: players" on one line, plus a score line; names ending in "in" survive
const colon = parse(`Reds 🔴: Kevin, Robin, Ali
Blues 🔵: Martin, Bo
3-2`);
assert.strictEqual(colon.teams[0].color, 'red');
assert.deepStrictEqual(names(colon.teams[0]), ['Kevin', 'Robin', 'Ali']);
assert.deepStrictEqual(names(colon.teams[1]), ['Martin', 'Bo']);
assert.strictEqual(colon.teams[0].score, 3);
assert.strictEqual(colon.teams[1].score, 2);

console.log('magic-paste: all checks passed');
