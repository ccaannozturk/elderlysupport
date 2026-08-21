const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const ADMIN_EMAIL = 'can.ozturk1907@gmail.com';

/** Security Guard: Enforces single super-admin identity */
function assertAdmin(context) {
  if (!context.auth || !context.auth.token || context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
  }
}

/** 1. Set Gemini API Key (Validates against Google AI Studio, stores in config/gemini) */
exports.setGeminiKey = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const apiKey = (data && data.apiKey ? String(data.apiKey).trim() : '');
  if (!apiKey || apiKey.length < 10) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid Gemini API key is required.');
  }

  // Validate key by querying Google AI Studio models endpoint once
  const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  let testRes;
  try {
    testRes = await fetch(testUrl);
  } catch (err) {
    throw new functions.https.HttpsError('unavailable', `Network error validating key with Google AI Studio: ${err.message}`);
  }

  if (!testRes.ok) {
    let errMessage = 'Invalid API key.';
    if (testRes.status === 400 || testRes.status === 403 || testRes.status === 401) {
      errMessage = 'Google AI Studio rejected this API key. Please check the key and try again.';
    } else if (testRes.status === 429) {
      errMessage = 'Quota / rate limit reached on Google AI Studio. Please try again shortly.';
    }
    throw new functions.https.HttpsError('invalid-argument', errMessage);
  }

  const last4 = apiKey.slice(-4);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // 1. Write secret key to config/gemini (read/write: false in firestore.rules)
  await db.collection('config').doc('gemini').set({
    apiKey: apiKey,
    updatedAt: now,
    updatedBy: ADMIN_EMAIL
  });

  // 2. Read existing meta to preserve model selection
  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const existingModel = metaDoc.exists ? metaDoc.data().selectedModel : null;

  // 3. Write non-secret metadata to config/gemini_meta (admin-read only)
  await db.collection('config').doc('gemini_meta').set({
    last4: last4,
    updatedAt: now,
    selectedModel: existingModel || 'gemini-1.5-flash'
  }, { merge: true });

  return { ok: true, last4: last4 };
});

/** 2. Test Gemini Connection & Fetch Available Models */
exports.testGeminiConnection = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('not-found', 'No Gemini API key stored in settings. Please add an API key first.');
  }

  const apiKey = keyDoc.data().apiKey;
  const startTime = Date.now();
  const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(testUrl);
  } catch (err) {
    throw new functions.https.HttpsError('unavailable', `Connection failed: ${err.message}`);
  }

  const latencyMs = Date.now() - startTime;

  if (!res.ok) {
    let msg = `Gemini API error (${res.status}): ${res.statusText}`;
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      msg = 'API key rejected by Google AI Studio (401/403). Please re-enter your API key.';
    } else if (res.status === 429) {
      msg = 'Quota exhausted / rate limit (429) on Google AI Studio. Please wait a moment.';
    }
    throw new functions.https.HttpsError('unavailable', msg);
  }

  const json = await res.json();
  const rawModels = json.models || [];
  const models = rawModels
    .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      displayName: m.displayName || m.name.replace(/^models\//, ''),
      inputTokenLimit: m.inputTokenLimit || 0
    }));

  return { ok: true, latencyMs, models };
});

/** 3. Set Selected Gemini Model */
exports.setGeminiModel = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const modelId = data && data.modelId ? String(data.modelId).trim() : '';
  if (!modelId) {
    throw new functions.https.HttpsError('invalid-argument', 'Model ID is required.');
  }

  await db.collection('config').doc('gemini_meta').set({
    selectedModel: modelId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, selectedModel: modelId };
});

/** 4. AI Magic Lineup Parser */
exports.parseLineup = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const rawText = data && data.rawText ? String(data.rawText).trim() : '';
  if (!rawText) {
    throw new functions.https.HttpsError('invalid-argument', 'Lineup message text is empty.');
  }

  // Cost guard: cap message length
  if (rawText.length > 5000) {
    throw new functions.https.HttpsError('invalid-argument', 'Message exceeds 5,000 characters limit.');
  }

  // 1. Fetch Gemini API Key
  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured. Please add an API key in Admin Settings.');
  }
  const apiKey = keyDoc.data().apiKey;

  // 2. Fetch Selected Model
  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : 'gemini-1.5-flash';

  // 3. Fetch Active Player Registry for Roster Context
  const playersSnap = await db.collection('players_v2').get();
  const knownPlayersMap = new Map();
  const rosterContext = [];

  playersSnap.forEach(doc => {
    const pData = doc.data();
    const id = doc.id;
    const displayName = pData.displayName || id;
    const aliases = Array.isArray(pData.aliases) ? pData.aliases : [displayName.toLowerCase()];
    knownPlayersMap.set(id, { id, displayName, aliases });
    if (pData.active !== false) {
      rosterContext.push({ id, displayName, aliases });
    }
  });

  // 4. Construct Prompt
  const prompt = `You are an expert football match lineup parser for the Elderly Support League in Amsterdam.
Parse the following raw match announcement / WhatsApp lineup message into strict JSON.

AUTHORITATIVE PLAYER REGISTRY:
${JSON.stringify(rosterContext)}

PARSING RULES:
1. "matchType": "Standard" (2 teams, goals scored) or "Tournament" (3 teams, ranked 1st/2nd/3rd with 3/1/0 points).
2. "date": Extract match date in YYYY-MM-DD format if mentioned, otherwise null.
3. "venue": Extract match location if mentioned (one of: "Sporthal ROC Europaboulevard", "Sporthal Calvijn", "Sportgebouw Bibian Mentel", "Sporthallen Zuid", "Zeeburgereiland - Outdoor"), otherwise null.
4. "teams": Array of team objects:
   - "name": Team name string or null
   - "score": integer goals scored for Standard match, otherwise null
   - "rank": 1, 2, or 3 for Tournament match, otherwise null
   - "players": Array of player items:
     - "rawName": original string as typed in the message
     - "playerId": exact matching "id" from the Authoritative Player Registry if confident, otherwise null. NEVER invent player IDs.
     - "confidence": number from 0.0 to 1.0 (1.0 = exact hit in registry/aliases, 0.7-0.9 = close spelling, 0.0 = completely new/unknown).
5. "unparsed": Array of raw lines from the input that could not be parsed as team headers, scores, or players.

RAW INPUT:
"""
${rawText}
"""
`;

  // 5. Call Gemini API
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let geminiRes;
  try {
    geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      })
    });
  } catch (err) {
    throw new functions.https.HttpsError('unavailable', `Failed to contact Gemini API: ${err.message}`);
  }

  if (!geminiRes.ok) {
    if (geminiRes.status === 429) {
      throw new functions.https.HttpsError('resource-exhausted', 'Gemini free-tier rate limit reached. Please wait a moment and try again.');
    }
    const errBody = await geminiRes.text();
    throw new functions.https.HttpsError('internal', `Gemini API error (${geminiRes.status}): ${errBody}`);
  }

  const geminiData = await geminiRes.json();
  const rawOutputText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawOutputText) {
    throw new functions.https.HttpsError('internal', 'No response received from Gemini.');
  }

  // 6. Defensively Parse JSON Output
  let parsed;
  try {
    const cleanedText = rawOutputText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleanedText);
  } catch (parseErr) {
    throw new functions.https.HttpsError('internal', `Failed to parse AI output as JSON: ${parseErr.message}`);
  }

  // 7. Server-Side Validation: Ensure IDs exist in players_v2
  const validatedTeams = [];
  for (const t of (parsed.teams || [])) {
    const validatedPlayers = [];
    for (const p of (t.players || [])) {
      const rawName = p.rawName || '';
      let pId = p.playerId;
      let conf = typeof p.confidence === 'number' ? p.confidence : 0.5;

      if (pId && !knownPlayersMap.has(pId)) {
        pId = null;
        conf = 0.4;
      }

      validatedPlayers.push({
        rawName,
        playerId: pId,
        confidence: conf
      });
    }

    validatedTeams.push({
      name: t.name || null,
      score: typeof t.score === 'number' ? t.score : null,
      rank: typeof t.rank === 'number' ? t.rank : null,
      players: validatedPlayers
    });
  }

  return {
    matchType: parsed.matchType === 'Tournament' ? 'Tournament' : 'Standard',
    date: parsed.date || null,
    venue: parsed.venue || null,
    teams: validatedTeams,
    unparsed: Array.isArray(parsed.unparsed) ? parsed.unparsed : []
  };
});
