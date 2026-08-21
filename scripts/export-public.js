#!/usr/bin/env node
/**
 * Public league export — Elderly Support League
 *
 * Produces ONE file, `public-data/league.json`, served by GitHub Pages. It is
 * the read-only contract for outside consumers (currently a WhatsApp chatbot).
 *
 * WHY THIS EXISTS INSTEAD OF HANDING OUT FIRESTORE ACCESS
 *   - Costs nothing. A consumer fetches one static file from Pages, so no
 *     matter how popular they get, they never touch the Firestore read quota.
 *   - No credentials change hands. Nothing here is secret.
 *   - Decouples the schema. `matches_v2` is free to become `matches_v3`
 *     without breaking anyone, as long as this file's shape stays stable.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *   - Roasts. Players opted out of being roasted (config/roast_settings), and
 *     that promise does not automatically travel to a third party. Roasts stay
 *     on the site where the opt-out list is actually enforced.
 *   - Anything non-public. This reads only collections that are already
 *     world-readable, over the public REST API, with no credentials. If this
 *     script ever needs a service account, something has gone wrong.
 *   - Elo, chemistry, streaks. Those are the site's opinionated models and
 *     would drift out of step if reimplemented here. Only plain counting
 *     stats are exported. See docs/PUBLIC-DATA.md.
 *
 * Requires Node 18+ (for global fetch).
 *
 * Usage:
 *   node scripts/export-public.js
 *   node scripts/export-public.js --out public-data/league.json
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'elderly-support-league';
const API_KEY = 'AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc'; // public by design
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Bump when the OUTPUT shape changes in a way a consumer would notice.
const SCHEMA_VERSION = 1;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* ---------- Firestore REST decoding ---------- */

function decode(value) {
  if (value === null || value === undefined) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decode(v);
  return out;
}

async function fetchCollection(name) {
  const docs = [];
  let pageToken = null;
  do {
    const url = new URL(`${BASE}/${name}`);
    url.searchParams.set('key', API_KEY);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`GET ${name} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
    }
    const json = await res.json();
    for (const d of json.documents || []) {
      docs.push({ id: d.name.split('/').pop(), data: decodeFields(d.fields || {}) });
    }
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return docs;
}

/* ---------- Transform ---------- */

function isoDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Build the export. Exported separately from the fetch so it can be unit
 * tested without touching the network.
 */
function buildExport(matchDocs, playerDocs) {
  // playerId -> display name. Consumers should never have to resolve ids.
  const nameOf = new Map();
  playerDocs.forEach(p => {
    const dn = (p.data && p.data.displayName) ? p.data.displayName : p.id;
    nameOf.set(p.id, dn);
  });
  const resolve = id => nameOf.get(id) || id;

  const matches = matchDocs
    .map(m => {
      const d = m.data || {};
      const date = isoDate(d.date);
      if (!date || !Array.isArray(d.teams) || d.teams.length < 2) return null;

      const isStandard = d.type === 'Standard';
      const teams = d.teams.map(t => {
        const players = (t.players || []).map(resolve);
        const base = { name: t.teamName || null, players };
        if (isStandard) {
          base.score = typeof t.score === 'number' ? t.score : null;
        } else {
          base.rank = typeof t.rank === 'number' ? t.rank : null;
          base.points = typeof t.points === 'number' ? t.points : null;
          base.shirtColour = { A: 'yellow', B: 'blue', C: 'red' }[t.originalKey] || null;
        }
        return base;
      });

      let result = null;
      if (isStandard && teams.length === 2 && teams[0].score !== null && teams[1].score !== null) {
        if (teams[0].score > teams[1].score) result = teams[0].name;
        else if (teams[1].score > teams[0].score) result = teams[1].name;
        else result = 'draw';
      } else if (!isStandard) {
        const winner = teams.find(t => t.rank === 1);
        result = winner ? winner.name : null;
      }

      return {
        id: m.id,
        date,
        venue: d.location || null,
        type: isStandard ? 'Standard' : 'Tournament',
        teams,
        result,
        youtube: typeof d.youtubeLink === 'string' && /^https?:\/\//i.test(d.youtubeLink)
          ? d.youtubeLink : null
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first

  // Plain counting stats only — nothing modelled, nothing to drift.
  const stats = new Map();
  const bump = (name) => {
    if (!stats.has(name)) {
      stats.set(name, {
        name, appearances: 0, won: 0, drawn: 0, lost: 0, points: 0,
        standardAppearances: 0, goalsFor: 0, goalsAgainst: 0,
        firstAppearance: null, lastAppearance: null
      });
    }
    return stats.get(name);
  };

  // Oldest first so first/last appearance come out right.
  [...matches].reverse().forEach(m => {
    const standard = m.type === 'Standard';
    m.teams.forEach((t, idx) => {
      let pts = 0;
      if (standard) {
        const opp = m.teams[idx === 0 ? 1 : 0];
        if (t.score !== null && opp.score !== null) {
          pts = t.score > opp.score ? 3 : (t.score === opp.score ? 1 : 0);
        }
      } else {
        pts = t.points !== null ? t.points : (t.rank === 1 ? 3 : (t.rank === 2 ? 1 : 0));
      }
      t.players.forEach(name => {
        const s = bump(name);
        s.appearances++;
        s.points += pts;
        if (pts >= 3) s.won++; else if (pts === 1) s.drawn++; else s.lost++;
        if (standard) {
          const opp = m.teams[idx === 0 ? 1 : 0];
          s.standardAppearances++;
          s.goalsFor += t.score || 0;
          s.goalsAgainst += opp.score || 0;
        }
        if (!s.firstAppearance) s.firstAppearance = m.date;
        s.lastAppearance = m.date;
      });
    });
  });

  const players = [...stats.values()]
    .map(s => ({
      ...s,
      pointsPerGame: s.appearances ? Number((s.points / s.appearances).toFixed(2)) : 0,
      winRate: s.appearances ? Math.round((s.won / s.appearances) * 100) : 0,
      goalDifference: s.goalsFor - s.goalsAgainst
    }))
    .sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

  const venues = [...new Set(matches.map(m => m.venue).filter(Boolean))].sort();

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'https://github.com/ccaannozturk/elderlysupport',
    notes: [
      'Read-only snapshot of the Elderly Support League. Regenerated manually.',
      'Goal statistics cover Standard matches only; Tournament matches record no goals.',
      'Elo ratings, chemistry and streaks are NOT included — those are computed on the site and would drift if reimplemented. Ask the maintainer before inventing a different rating.',
      'Roasts are deliberately excluded: some players opted out of being roasted.'
    ],
    counts: { matches: matches.length, players: players.length, venues: venues.length },
    dateRange: matches.length
      ? { first: matches[matches.length - 1].date, last: matches[0].date }
      : { first: null, last: null },
    venues,
    players,
    matches
  };
}

module.exports = { buildExport };

/* ---------- CLI ---------- */

if (require.main === module) {
  (async () => {
    const outRel = flag('out', 'public-data/league.json');
    try {
      process.stdout.write('Fetching matches_v2 ... ');
      const matchDocs = await fetchCollection('matches_v2');
      console.log(`${matchDocs.length} documents`);

      process.stdout.write('Fetching players_v2 ... ');
      const playerDocs = await fetchCollection('players_v2');
      console.log(`${playerDocs.length} documents`);

      const out = buildExport(matchDocs, playerDocs);
      const file = path.join(__dirname, '..', outRel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`\nWrote ${out.counts.matches} matches and ${out.counts.players} players to ${outRel} (${kb} KB)`);
      console.log(`Date range: ${out.dateRange.first} to ${out.dateRange.last}`);
      console.log('\nCommit and push it. Pages will serve it within a minute or two.');
    } catch (err) {
      console.error('\nExport failed:', err.message);
      process.exitCode = 1;
    }
  })();
}
