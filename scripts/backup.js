#!/usr/bin/env node
/**
 * Firestore backup — Elderly Support League
 *
 * Dumps every document from the given collections to a timestamped JSON file
 * in ./backups/. This is the real safety net before any migration. The CSV
 * export from the admin panel is NOT sufficient: it loses document IDs,
 * originalKey, server timestamps, and youtubeLink.
 *
 * No credentials required. The `matches` and `players` collections are
 * publicly readable by design (`allow read: if true`), so this uses the
 * public web API key over the REST API. Nothing secret lives in this file.
 *
 * Requires Node 18+ (for global fetch).
 *
 * Usage:
 *   node scripts/backup.js
 *   node scripts/backup.js --collections matches,players,matches_v2,players_v2
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'elderly-support-league';
const API_KEY = 'AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc'; // public by design
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const COLLECTIONS = flag('collections', 'matches,players').split(',').map(s => s.trim());

/** Convert Firestore REST typed values into plain JS. */
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
      const body = await res.text();
      throw new Error(`GET ${name} failed: ${res.status} ${res.statusText}\n${body}`);
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

(async () => {
  const backup = {
    project: PROJECT_ID,
    takenAt: new Date().toISOString(),
    collections: {},
  };

  for (const name of COLLECTIONS) {
    process.stdout.write(`Fetching ${name} ... `);
    try {
      const docs = await fetchCollection(name);
      backup.collections[name] = docs;
      console.log(`${docs.length} documents`);
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');

  const total = Object.values(backup.collections).reduce((n, d) => n + d.length, 0);
  console.log(`\nWrote ${total} documents to ${path.relative(process.cwd(), file)}`);
  console.log('Commit this file. It is your rollback point.');
})();
