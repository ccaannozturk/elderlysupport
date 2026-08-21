#!/usr/bin/env node
/**
 * Syncs enriched aliases from data/roster-mapping.csv to players_v2
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'elderly-support-league';
const API_KEY = 'AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc';
const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
const BASE = isEmulator
  ? `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  : `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

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

async function run() {
  const csvPath = path.join(__dirname, '..', 'data', 'roster-mapping.csv');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const header = parseCsvLine(lines[0]);

  const rawIdx = header.indexOf('raw_name');
  const idIdx = header.indexOf('player_id');
  const dispIdx = header.indexOf('display_name');
  const notesIdx = header.indexOf('notes');

  const playersMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const raw = cols[rawIdx];
    const id = cols[idIdx];
    const disp = cols[dispIdx];
    const notes = cols[notesIdx] || '';

    if (!id) continue;

    if (!playersMap.has(id)) {
      playersMap.set(id, {
        id,
        displayName: disp,
        aliases: new Set([disp.toLowerCase(), id.toLowerCase(), raw.toLowerCase()])
      });
    } else {
      playersMap.get(id).aliases.add(raw.toLowerCase());
    }

    if (notes) {
      const aliasMatch = notes.match(/aliases?:\s*([^;]+)/i);
      if (aliasMatch) {
        aliasMatch[1].split(',').forEach(a => {
          const clean = a.trim().toLowerCase();
          if (clean) playersMap.get(id).aliases.add(clean);
        });
      }
    }
  }

  console.log(`Loaded ${playersMap.size} canonical players with enriched aliases.`);

  const argv = process.argv.slice(2);
  const IS_COMMIT = argv.includes('--commit');

  if (!IS_COMMIT) {
    console.log('Dry run complete. To write aliases to Firestore, run: node scripts/sync_aliases.js --commit');
    return;
  }

  let idToken = null;
  if (!isEmulator) {
    const email = (argv.find(a => a.startsWith('--email=')) || '').split('=')[1] || process.env.ADMIN_EMAIL || 'can.ozturk1907@gmail.com';
    let password = (argv.find(a => a.startsWith('--password=')) || '').split('=')[1] || process.env.ADMIN_PASSWORD;

    if (!password) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      password = await new Promise(resolve => {
        rl.question(`Enter Firebase admin password for ${email}: `, answer => {
          rl.close();
          resolve(answer.trim());
        });
      });
    }

    const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    if (!authRes.ok) throw new Error(`Auth failed (${authRes.status}): ${await authRes.text()}`);
    idToken = (await authRes.json()).idToken;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

  for (const p of playersMap.values()) {
    const aliasesArr = Array.from(p.aliases);
    const body = {
      fields: {
        displayName: { stringValue: p.displayName },
        aliases: { arrayValue: { values: aliasesArr.map(a => ({ stringValue: a })) } },
        active: { booleanValue: true }
      }
    };
    const url = new URL(`${BASE}/players_v2/${p.id}?updateMask.fieldPaths=displayName&updateMask.fieldPaths=aliases&updateMask.fieldPaths=active`);
    if (!isEmulator) url.searchParams.set('key', API_KEY);

    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) console.warn(`Failed ${p.id}:`, await res.text());
  }

  console.log('✓ All players_v2 aliases updated successfully.');
}

run();
