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
 *   Elo, chemistry and streaks ARE exported, and are computed by requiring
 *   stats-core.js — the same file index.html loads. They are never
 *   reimplemented here; if they were, this export would quietly disagree with
 *   the website, which is worse than omitting them. See docs/PUBLIC-DATA.md.
 *
 * Requires Node 18+ (for global fetch).
 *
 * Usage:
 *   node scripts/export-public.js
 *   node scripts/export-public.js --out public-data/league.json
 */

const fs = require('fs');
const path = require('path');

// The website's own engines — not a reimplementation. Whatever the Stats tab
// says, this file says, because it is literally the same code.
const core = require(path.join(__dirname, '..', 'stats-core.js'));

const PROJECT_ID = 'elderly-support-league';
const API_KEY = 'AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc'; // public by design
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Bump when the OUTPUT shape changes in a way a consumer would notice.
const SCHEMA_VERSION = 2;

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

  const playersOut = [...stats.values()]
    .map(s => ({
      ...s,
      pointsPerGame: s.appearances ? Number((s.points / s.appearances).toFixed(2)) : 0,
      winRate: s.appearances ? Math.round((s.won / s.appearances) * 100) : 0,
      goalDifference: s.goalsFor - s.goalsAgainst
    }))
    .sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

  const venues = [...new Set(matches.map(m => m.venue).filter(Boolean))].sort();

  /* ---- the site's own models, via stats-core.js ---- */

  // The engines expect Firestore-ish documents keyed by player id, so feed them
  // the raw docs and resolve to display names on the way out.
  core.setNameResolver(resolve);
  const engineMatches = matchDocs
    .map(m => {
      const d = m.data || {};
      const iso = d.date;
      if (!iso || !Array.isArray(d.teams) || d.teams.length < 2) return null;
      return { ...d, id: m.id, date: { toDate: () => new Date(iso), toMillis: () => new Date(iso).getTime() } };
    })
    .filter(Boolean);

  const eloData = core.computeEloRatings(engineMatches);
  const eloById = eloData.ratings || {};
  const eloMeta = new Map((eloData.sortedList || []).map(p => [p.id, p]));

  const chem = core.computeChemistryMatrix(engineMatches);
  const attendance = core.computeAttendanceAndMilestones(engineMatches);
  const lineup = core.computeOptimalLineupAndCurse(engineMatches, eloMeta);

  // Attach per-player model output to the counting stats already built.
  const byName = new Map(playersOut.map(p => [p.name, p]));
  Object.keys(eloById).forEach(id => {
    const p = byName.get(resolve(id));
    if (!p) return;
    const meta = eloMeta.get(id);
    p.elo = Math.round(eloById[id]);
    p.eloProvisional = meta ? !!meta.isProvisional : (p.appearances < core.MIN_GAMES_RANKED_ELO);

    const s = core.computePlayerStreaksAndForm(engineMatches, id);
    if (s) {
      p.streaks = {
        currentWin: s.curW || 0,
        currentLoss: s.curL || 0,
        currentUnbeaten: s.curU || 0,
        longestWin: s.maxW || 0,
        longestLoss: s.maxL || 0,
        longestUnbeaten: s.maxU || 0
      };
      p.recentForm = Array.isArray(s.form5) ? s.form5 : [];   // oldest to newest
    }

    const att = attendance && attendance.attendanceStats ? attendance.attendanceStats[id] : null;
    if (att) {
      p.debutDate = att.debutDate || null;
      p.attendanceRate = att.attendanceRate;          // percent of games since debut
      p.gamesSinceDebut = att.possibleSinceDebut;
    }

    const n = core.computeNemesisAndRivalry(engineMatches, id);
    if (n && n.nemesis) {
      p.nemesis = {
        name: resolve(n.nemesis.id),
        playedAgainst: n.nemesis.played,
        won: n.nemesis.won, drawn: n.nemesis.drawn, lost: n.nemesis.lost
      };
    }
    // Record with a partner vs. against them — the site's duo split.
    if (n && Array.isArray(n.duoSplits)) {
      p.duoSplits = n.duoSplits.slice(0, 5).map(d => ({
        name: resolve(d.id),
        together: d.together,
        opposed: d.opposed
      }));
    }
  });

  // Every pair with at least one game together, named not id-keyed.
  const pairs = Object.values(chem.allDuos || {})
    .map(d => ({
      players: [resolve(d.p1), resolve(d.p2)].sort(),
      played: d.played,
      won: d.won, drawn: d.drawn, lost: d.lost,
      winRate: d.played ? Math.round((d.won / d.played) * 100) : 0,
      pointsPerGame: d.played ? Number((d.pts / d.played).toFixed(2)) : 0
    }))
    .sort((a, b) => b.played - a.played || a.players[0].localeCompare(b.players[0]));

  const eloLeaderboard = (eloData.sortedList || [])
    .filter(p => !p.isProvisional)
    .map(p => ({ name: resolve(p.id), elo: Math.round(p.rawRating !== undefined ? p.rawRating : p.rating), appearances: p.matches }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'https://github.com/ccaannozturk/elderlysupport',
    notes: [
      'Read-only snapshot of the Elderly Support League. Regenerated manually.',
      'Goal statistics cover Standard matches only; Tournament matches record no goals.',
      'Elo, chemistry, streaks and nemesis come from stats-core.js, the same code the website runs, so these numbers always match the site. Do not compute your own rating.',
      'Roasts are deliberately excluded: some players opted out of being roasted.'
    ],
    counts: { matches: matches.length, players: playersOut.length, venues: venues.length, pairs: pairs.length },
    dateRange: matches.length
      ? { first: matches[matches.length - 1].date, last: matches[0].date }
      : { first: null, last: null },
    venues,
    players: playersOut,
    eloLeaderboard,
    pairs,
    optimalLineup: (lineup && lineup.optimal5) ? lineup.optimal5.map(p => ({
      name: resolve(p.id), elo: p.rating, appearances: p.matches
    })) : [],
    oneCapWonders: (attendance && attendance.oneCapWonders || []).map(x => resolve(x.id)),
    ironMen: (attendance && attendance.ironMen || []).map(x => ({
      name: resolve(x.id), appearances: x.played, attendanceRate: x.attendanceRate
    })),
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

      // Written minified: the consumer is a program, and a scheduled job that
      // rewrites a pretty-printed file every few hours bloats the repo for no
      // one's benefit. Pages gzips it on the way out regardless.
      const json = JSON.stringify(out);

      // Skip the write when nothing but the timestamp changed, so the scheduled
      // workflow does not produce an empty commit every single run.
      if (fs.existsSync(file)) {
        try {
          const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
          const strip = (o) => { const c = { ...o }; delete c.generatedAt; return JSON.stringify(c); };
          if (strip(prev) === strip(out)) {
            console.log(`\nNo change since the last export — ${outRel} left untouched.`);
            return;
          }
        } catch (e) { /* unreadable or malformed: fall through and rewrite */ }
      }

      fs.writeFileSync(file, json, 'utf8');
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`\nWrote ${out.counts.matches} matches, ${out.counts.players} players and ${out.counts.pairs} pairs to ${outRel} (${kb} KB)`);
      console.log(`Date range: ${out.dateRange.first} to ${out.dateRange.last}`);
      console.log('\nCommit and push it. Pages will serve it within a minute or two.');
    } catch (err) {
      console.error('\nExport failed:', err.message);
      process.exitCode = 1;
    }
  })();
}
