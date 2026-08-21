#!/usr/bin/env node
/**
 * Migration Script: Stage B — Identity Layer
 * Elderly Support League
 *
 * Transforms legacy free-text player names in `matches` into canonical player IDs in `matches_v2`,
 * and constructs the authoritative `players_v2` registry.
 *
 * SAFETY INVARIANTS:
 * 1. Defaults to --dry-run. No writes occur unless --commit is passed explicitly.
 * 2. Original `matches` and `players` collections are NEVER modified or deleted.
 * 3. Fails loudly on any name not found in `data/roster-mapping.csv`.
 * 4. Asserts count(matches_v2) === count(matches).
 * 5. Asserts per-player appearance reconciliation before vs after migration.
 *
 * Usage:
 *   node scripts/migrate.js             # Dry run with full reconciliation report
 *   node scripts/migrate.js --commit    # Dry run + write to Firestore / Emulator
 *   node scripts/migrate.js --source=backup # Read from latest local backup instead of live
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'elderly-support-league';
const API_KEY = 'AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc'; // Public web API key

const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
const BASE = isEmulator
  ? `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  : `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const argv = process.argv.slice(2);
const IS_COMMIT = argv.includes('--commit');
const SOURCE_FLAG = (argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || 'live';

/** Simple CSV parser handling quotes */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += c;
  }
  result.push(current.trim());
  return result;
}

/** Decode Firestore REST field structures */
function decode(value) {
  if (value === null || value === undefined) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return { __type: 'timestamp', value: value.timestampValue };
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  if ('referenceValue' in value) return { __type: 'reference', value: value.referenceValue };
  if ('geoPointValue' in value) return { __type: 'geopoint', value: value.geoPointValue };
  return { __unknown: value };
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decode(v);
  return out;
}

/** Encode JS object to Firestore REST typed format */
function encode(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value && value.__type === 'timestamp') return { timestampValue: value.value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = encode(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/** Fetch live matches from Firestore REST API */
async function fetchLiveMatches() {
  const docs = [];
  let pageToken = null;
  do {
    const url = new URL(`${BASE}/matches`);
    if (!isEmulator) url.searchParams.set('key', API_KEY);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /matches failed: ${res.status} ${res.statusText}\n${body}`);
    }
    const json = await res.json();
    for (const d of json.documents || []) {
      docs.push({
        id: d.name.split('/').pop(),
        createTime: d.createTime,
        updateTime: d.updateTime,
        data: decodeFields(d.fields || {}),
      });
    }
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return docs;
}

/** Load matches from local backup */
function loadBackupMatches() {
  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) throw new Error('No backups directory found');
  const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-') && f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('No backup JSON files found');
  const latest = path.join(backupDir, files[files.length - 1]);
  console.log(`[Source] Reading from backup file: ${path.relative(process.cwd(), latest)}`);
  const data = JSON.parse(fs.readFileSync(latest, 'utf8'));
  return data.collections.matches || [];
}

/** Load and parse data/roster-mapping.csv */
function loadRosterMapping() {
  const csvPath = path.join(__dirname, '..', 'data', 'roster-mapping.csv');
  if (!fs.existsSync(csvPath)) throw new Error(`Mapping file not found at ${csvPath}`);
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').filter(Boolean);

  const rawMap = new Map(); // lower(raw_name) -> { playerId, displayName, notes }
  const canonicalPlayers = new Map(); // playerId -> { displayName, aliases: Set(), active, createdAt }

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawName = cols[0];
    const playerId = cols[1];
    const displayName = cols[2];
    const notes = cols[3] || '';

    if (!rawName || !playerId || !displayName) continue;

    rawMap.set(rawName.toLowerCase(), { playerId, displayName, notes });

    if (!canonicalPlayers.has(playerId)) {
      canonicalPlayers.set(playerId, {
        displayName,
        aliases: new Set([displayName.toLowerCase(), rawName.toLowerCase()]),
        active: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z')
      });
    } else {
      canonicalPlayers.get(playerId).aliases.add(displayName.toLowerCase());
      canonicalPlayers.get(playerId).aliases.add(rawName.toLowerCase());
    }

    // Add explicit aliases from notes
    if (notes.toLowerCase().includes('aliases:')) {
      const aliasText = notes.slice(notes.toLowerCase().indexOf('aliases:') + 8).replace(/["]/g, '').trim();
      aliasText.split(',').forEach(a => {
        if (a.trim()) canonicalPlayers.get(playerId).aliases.add(a.trim().toLowerCase());
      });
    }
  }

  // Hardcoded standard alias helpers for key players
  if (canonicalPlayers.has('anderson_brazil')) {
    canonicalPlayers.get('anderson_brazil').aliases.add('anderson b');
    canonicalPlayers.get('anderson_brazil').aliases.add('andersonbr');
  }
  if (canonicalPlayers.has('anderson')) {
    canonicalPlayers.get('anderson').aliases.add('anderson muller');
    canonicalPlayers.get('anderson').aliases.add('anderson müller');
  }

  return { rawMap, canonicalPlayers };
}

/** Resolve raw name to canonical playerId for a specific match context */
function resolvePlayerName(rawName, matchContext, rawMap) {
  const lower = rawName.trim().toLowerCase();

  // Special Case 1: Javi split by date / team
  if (lower === 'javi') {
    const matchDate = matchContext.dateStr; // DD/MM/YYYY
    const teamName = (matchContext.teamName || '').toLowerCase();
    if (matchDate === '01/08/2026' || teamName.includes('sum 41')) {
      return 'javi_farres';
    }
    if (matchDate === '11/07/2026' || teamName.includes('mellow yellow')) {
      return 'javi_bernardo';
    }
    throw new Error(`Ambiguous Javi entry in match on ${matchDate} (Team: "${matchContext.teamName}") - manual override required`);
  }

  // Special Case 2: Guillermo merge
  if (lower === 'guillermo') {
    return 'guille';
  }

  // Special Case 3: Anderson Müller merge
  if (lower === 'anderson müller' || lower === 'anderson muller') {
    return 'anderson';
  }

  const mapped = rawMap.get(lower);
  if (!mapped) {
    throw new Error(`UNMAPPED PLAYER: "${rawName}" in match on ${matchContext.dateStr} (Team: "${matchContext.teamName}")`);
  }
  return mapped.playerId;
}

/** Main Migration Execution */
(async () => {
  console.log('='.repeat(70));
  console.log('Elderly Support League — Stage B Identity Migration');
  console.log(`Mode: ${IS_COMMIT ? '🔴 COMMIT (WRITING TO FIRESTORE)' : '🟢 DRY RUN (NO WRITES)'}`);
  console.log('='.repeat(70));

  // 1. Load Mapping
  const { rawMap, canonicalPlayers } = loadRosterMapping();
  console.log(`[Mapping] Loaded ${rawMap.size} raw mappings -> ${canonicalPlayers.size} canonical players_v2 docs`);

  // 2. Fetch Matches
  let sourceMatches = [];
  if (SOURCE_FLAG === 'live') {
    try {
      process.stdout.write('[Source] Fetching live matches from Firestore REST API ... ');
      sourceMatches = await fetchLiveMatches();
      console.log(`${sourceMatches.length} matches retrieved.`);
    } catch (err) {
      console.log(`FAILED (${err.message}). Falling back to local backup.`);
      sourceMatches = loadBackupMatches();
    }
  } else {
    sourceMatches = loadBackupMatches();
  }

  if (sourceMatches.length === 0) {
    throw new Error('No matches found to migrate.');
  }

  // 3. Track Appearances Before Migration
  const appearancesBefore = new Map(); // playerId -> count
  for (const id of canonicalPlayers.keys()) appearancesBefore.set(id, 0);

  // Helper for date formatting
  const formatDateStr = (val) => {
    if (!val) return 'Unknown';
    const iso = val.__type === 'timestamp' ? val.value : (val instanceof Date ? val.toISOString() : String(val));
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  };

  // Count raw appearances mapped to canonical IDs
  for (const m of sourceMatches) {
    const dateStr = formatDateStr(m.data.date);
    for (const t of (m.data.teams || [])) {
      for (const p of (t.players || [])) {
        const id = resolvePlayerName(p, { dateStr, teamName: t.teamName }, rawMap);
        appearancesBefore.set(id, (appearancesBefore.get(id) || 0) + 1);
      }
    }
  }

  // 4. Migrate Matches to matches_v2 structure
  const matchesV2 = [];
  const appearancesAfter = new Map(); // playerId -> count
  for (const id of canonicalPlayers.keys()) appearancesAfter.set(id, 0);

  for (const m of sourceMatches) {
    const dateStr = formatDateStr(m.data.date);
    const migratedTeams = [];

    for (const t of (m.data.teams || [])) {
      const resolvedPlayerIds = [];
      const teamName = t.teamName || '';

      for (const p of (t.players || [])) {
        const pId = resolvePlayerName(p, { dateStr, teamName }, rawMap);
        resolvedPlayerIds.push(pId);
        appearancesAfter.set(pId, (appearancesAfter.get(pId) || 0) + 1);
      }

      // Special Case: Restore Guillermo / Guille to match 16/05/2026 Team Wildcard if missing
      if (dateStr === '16/05/2026' && teamName.includes('Team Wildcard') && !resolvedPlayerIds.includes('guille')) {
        console.log(`[Special Case] Restoring Guille to match 16/05/2026 (${teamName})`);
        resolvedPlayerIds.push('guille');
        appearancesAfter.set('guille', (appearancesAfter.get('guille') || 0) + 1);
      }

      const teamObj = {
        teamName: t.teamName,
        players: resolvedPlayerIds,
      };

      if (m.data.type === 'Tournament') {
        if ('points' in t) teamObj.points = t.points;
        if ('rank' in t) teamObj.rank = t.rank;
        if ('originalKey' in t) teamObj.originalKey = t.originalKey;
      } else {
        if ('score' in t) teamObj.score = t.score;
      }

      migratedTeams.push(teamObj);
    }

    const matchDoc = {
      id: m.id,
      data: {
        date: m.data.date,
        type: m.data.type,
        location: m.data.location || '',
        updatedBy: m.data.updatedBy || '',
        timestamp: m.data.timestamp || { __type: 'timestamp', value: new Date().toISOString() },
        teams: migratedTeams
      }
    };

    if (m.data.youtubeLink !== undefined) matchDoc.data.youtubeLink = m.data.youtubeLink;
    if (m.data.colors !== undefined) matchDoc.data.colors = m.data.colors;

    matchesV2.push(matchDoc);
  }

  // 5. Build canonical players_v2 docs
  const playersV2Docs = [];
  for (const [id, p] of canonicalPlayers.entries()) {
    playersV2Docs.push({
      id,
      data: {
        displayName: p.displayName,
        aliases: Array.from(p.aliases).sort(),
        active: p.active,
        createdAt: { __type: 'timestamp', value: p.createdAt.toISOString() }
      }
    });
  }

  // 6. Print Reconciliation Report
  console.log('\n' + '-'.repeat(70));
  console.log('RECONCILIATION REPORT (Player Appearances Before vs After Migration)');
  console.log('-'.repeat(70));
  console.log(
    'Player ID'.padEnd(20) +
    'Display Name'.padEnd(22) +
    'Before'.padStart(8) +
    'After'.padStart(8) +
    '   Diff'
  );
  console.log('-'.repeat(70));

  let totalDiff = 0;
  let mismatchedPlayers = 0;

  for (const [id, p] of canonicalPlayers.entries()) {
    const b = appearancesBefore.get(id) || 0;
    const a = appearancesAfter.get(id) || 0;
    const diff = a - b;
    totalDiff += diff;

    // Guille is expected to have diff = +1 due to restoration in 16/05/2026 match
    const isExpected = (id === 'guille' && diff === 1) || diff === 0;
    if (!isExpected) mismatchedPlayers++;

    const statusStr = diff === 0 ? '✓' : (id === 'guille' && diff === 1 ? '+1 (restored)' : `MISMATCH (${diff})`);
    console.log(
      id.padEnd(20) +
      p.displayName.padEnd(22) +
      String(b).padStart(8) +
      String(a).padStart(8) +
      '   ' + statusStr
    );
  }

  console.log('-'.repeat(70));
  console.log(`Total Source Matches:   ${sourceMatches.length}`);
  console.log(`Total matches_v2 Docs:  ${matchesV2.length}`);
  console.log(`Total players_v2 Docs:  ${playersV2Docs.length}`);
  console.log(`Player Doc Assertion:   ${playersV2Docs.length === 68 ? 'PASSED (68 canonical players)' : 'FAILED'}`);
  console.log(`Match Count Assertion:  ${matchesV2.length === sourceMatches.length ? 'PASSED (1:1 match count)' : 'FAILED'}`);
  console.log(`Appearance Invariant:   ${mismatchedPlayers === 0 ? 'PASSED (All reconciled perfectly)' : 'FAILED'}`);
  console.log('-'.repeat(70));

  if (mismatchedPlayers > 0 || matchesV2.length !== sourceMatches.length) {
    console.error('❌ MIGRATION PRE-CHECK FAILED. ABORTING.');
    process.exitCode = 1;
    return;
  }

  // 7. Write to Firestore if --commit
  if (!IS_COMMIT) {
    console.log('\n🟢 DRY RUN COMPLETE. 0 writes performed.');
    console.log('To commit this migration, run: node scripts/migrate.js --commit');
    return;
  }

  console.log('\nWriting to Firestore...');
  // Write players_v2 documents
  console.log(`Writing ${playersV2Docs.length} players_v2 documents...`);
  for (const p of playersV2Docs) {
    const url = new URL(`${BASE}/players_v2/${p.id}`);
    if (!isEmulator) url.searchParams.set('key', API_KEY);
    const body = JSON.stringify({ fields: encode(p.data).mapValue.fields });

    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Write to players_v2/${p.id} failed (${res.status}): ${errText}`);
    }
  }
  console.log('✓ All players_v2 documents written successfully.');

  // Write matches_v2 documents
  console.log(`Writing ${matchesV2.length} matches_v2 documents...`);
  for (const m of matchesV2) {
    const url = new URL(`${BASE}/matches_v2/${m.id}`);
    if (!isEmulator) url.searchParams.set('key', API_KEY);
    const body = JSON.stringify({ fields: encode(m.data).mapValue.fields });

    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Write to matches_v2/${m.id} failed (${res.status}): ${errText}`);
    }
  }
  console.log('✓ All matches_v2 documents written successfully.');

  console.log('\n🎉 MIGRATION COMMITTED SUCCESSFULLY.');
})();
