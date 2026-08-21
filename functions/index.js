const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const ADMIN_EMAIL = 'can.ozturk1907@gmail.com';

// Ordered by preference. Free-tier eligibility changes without notice —
// each entry is tried in order until one succeeds.
const MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash',       // primary: free tier as of mid-2026
  'gemini-3.1-flash-lite',  // free tier, higher RPM, lower capability
  'gemini-2.5-flash',       // long-standing free tier workhorse
  'gemini-2.5-flash-lite',  // last resort
];
exports.MODEL_FALLBACK_CHAIN = MODEL_FALLBACK_CHAIN;

// Explicit paid models list — must never be in MODEL_FALLBACK_CHAIN
const KNOWN_PAID_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-1.5-pro',
  'gemini-2.0-pro',
  'gemini-2.5-pro',
  'gemini-3.0-pro',
  'gemini-3.5-pro',
  'gemini-3.7-pro'
];
exports.KNOWN_PAID_MODELS = KNOWN_PAID_MODELS;

function isPaidModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase().trim();
  if (KNOWN_PAID_MODELS.some(p => id === p || id.endsWith('/' + p))) return true;
  if (id.includes('-pro') || id.includes('pro-') || id.includes('ultra') || id.includes('advanced')) return true;
  if (id === 'gemini-3.6-flash' || id === 'gemini-3.7-flash') return true;
  return false;
}
exports.isPaidModel = isPaidModel;

/** Security Guard: Enforces single super-admin identity */
function assertAdmin(context) {
  if (!context.auth || !context.auth.token || context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
  }
}

/**
 * Core model execution engine with strict error-discriminated fallback chain.
 *
 * Fallback triggers: 404 (model not found), 403 on model, 400 (unsupported parameters / deprecated).
 * DO NOT fallback on: 429 (rate limit), missing/invalid API key, network timeout, safety blocks.
 */
async function callGeminiWithFallback(apiKey, prompt, preferredModel) {
  const candidates = [];
  if (preferredModel && typeof preferredModel === 'string' && preferredModel.trim()) {
    candidates.push(preferredModel.trim());
  }
  for (const m of MODEL_FALLBACK_CHAIN) {
    if (!candidates.includes(m)) {
      candidates.push(m);
    }
  }

  const attempts = [];
  let lastUsedModel = null;
  let fellBackFrom = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidateModel = candidates[i];
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let res;
    try {
      res = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json'
            // Universal compatibility: NO temperature, top_p, top_k, or thinking parameters
          }
        })
      });
    } catch (netErr) {
      throw new functions.https.HttpsError('unavailable', `Network error contacting Gemini API: ${netErr.message}`);
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        const blockReason = data?.candidates?.[0]?.finishReason || 'empty response';
        throw new functions.https.HttpsError('internal', `Gemini returned empty response (${blockReason}).`);
      }

      lastUsedModel = candidateModel;
      if (preferredModel && candidateModel !== preferredModel) {
        fellBackFrom = preferredModel;
      }

      try {
        db.collection('config').doc('gemini_meta').set({
          lastUsedModel: candidateModel,
          lastFallbackFrom: fellBackFrom || null,
          lastCallTimestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(metaErr => {
          console.warn('Failed to update gemini_meta lastUsedModel:', metaErr.message);
        });
      } catch (metaErr) {
        console.warn('Failed to update gemini_meta lastUsedModel:', metaErr.message);
      }

      return {
        text,
        modelUsed: candidateModel,
        fellBackFrom,
        attempts
      };
    }

    const status = res.status;
    const errBody = await res.text();

    // 1. Rate Limit (429): DO NOT WALK CHAIN
    if (status === 429) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        `Gemini rate limit reached on model "${candidateModel}" (HTTP 429). Please wait a moment and try again.`
      );
    }

    // 2. Invalid API Key: DO NOT WALK CHAIN
    if (status === 401 || (status === 400 && errBody.toLowerCase().includes('api_key_invalid'))) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Gemini API key is invalid or rejected by Google AI Studio. Please re-enter your API key in Settings.'
      );
    }

    // 3. Model-level failures: 404 (not found), 403 (model-specific permissions), 400 (deprecated / parameter reject)
    const isModelError = status === 404 || status === 403 || status === 400 || (status >= 500 && status < 600);
    if (isModelError) {
      attempts.push({ model: candidateModel, status, reason: errBody.slice(0, 300) });
      console.warn(`Gemini model "${candidateModel}" failed with HTTP ${status} (falling back): ${errBody.slice(0, 200)}`);
      continue;
    }

    attempts.push({ model: candidateModel, status, reason: errBody.slice(0, 300) });
    throw new functions.https.HttpsError('internal', `Gemini API error (${status}) on model "${candidateModel}": ${errBody}`);
  }

  const failureSummary = attempts.map(a => `[${a.model}: HTTP ${a.status}]`).join(', ');
  throw new functions.https.HttpsError(
    'failed-precondition',
    `All Gemini models in fallback chain failed (${failureSummary}). Please check Google AI Studio service status or update settings.`
  );
}
exports.callGeminiWithFallback = callGeminiWithFallback;

/** 1. Set Gemini API Key */
exports.setGeminiKey = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const apiKey = (data && data.apiKey ? String(data.apiKey).trim() : '');
  if (!apiKey || apiKey.length < 10) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid Gemini API key is required.');
  }

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

  await db.collection('config').doc('gemini').set({
    apiKey: apiKey,
    updatedAt: now,
    updatedBy: ADMIN_EMAIL
  });

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const existingModel = metaDoc.exists ? metaDoc.data().selectedModel : null;

  await db.collection('config').doc('gemini_meta').set({
    last4: last4,
    updatedAt: now,
    selectedModel: existingModel || MODEL_FALLBACK_CHAIN[0]
  }, { merge: true });

  return { ok: true, last4: last4 };
});

/** 2. Test Gemini Connection & Fetch Filtered Available Models */
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
  
  const excludedKeywords = ['embedding', 'aqa', 'imagen', 'banana', 'lyria', 'tts', 'audio', 'robotics', 'computer'];
  const models = rawModels
    .filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const id = (m.name || '').toLowerCase();
      if (!methods.includes('generateContent')) return false;
      if (excludedKeywords.some(kw => id.includes(kw))) return false;
      return true;
    })
    .map(m => {
      const id = m.name.replace(/^models\//, '');
      return {
        id,
        displayName: m.displayName || id,
        inputTokenLimit: m.inputTokenLimit || 0,
        isPaid: isPaidModel(id)
      };
    });

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const preferredModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  let probeResult;
  try {
    probeResult = await callGeminiWithFallback(apiKey, 'Return JSON: {"status":"ok"}', preferredModel);
  } catch (probeErr) {
    throw new functions.https.HttpsError('unavailable', `Model test failed: ${probeErr.message}`);
  }

  const latencyMs = Date.now() - startTime;

  return {
    ok: true,
    latencyMs,
    models,
    testedModel: probeResult.modelUsed,
    fellBackFrom: probeResult.fellBackFrom || null
  };
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

  if (rawText.length > 5000) {
    throw new functions.https.HttpsError('invalid-argument', 'Message exceeds 5,000 characters limit.');
  }

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured. Please add an API key in Admin Settings.');
  }
  const apiKey = keyDoc.data().apiKey;

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

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

  const prompt = `You are an expert football match lineup parser for the Elderly Support League in Amsterdam.
Parse the following raw match announcement / WhatsApp lineup message into strict JSON.

AUTHORITATIVE PLAYER REGISTRY:
${JSON.stringify(rosterContext)}

PARSING INSTRUCTIONS & EXAMPLES:
1. "matchType": "Standard" (2 teams, goals scored) or "Tournament" (3 teams, ranked 1st/2nd/3rd with 3/1/0 points).
2. "date": Extract match date in YYYY-MM-DD format if mentioned, otherwise null.
3. "venue": Extract match location if mentioned (one of: "Sporthal ROC Europaboulevard", "Sporthal Calvijn", "Sportgebouw Bibian Mentel", "Sporthallen Zuid", "Zeeburgereiland - Outdoor"), otherwise null.
4. "teams": Array of team objects with:
   - "name": Clean team name (remove color mentions like "in 🔴:", "in blue:", trailing colons). E.g. "The Fifantinos 🤑 in 🔴:" -> "The Fifantinos 🤑".
   - "color": "red" | "blue" | "yellow" | null (detect from emojis 🔴, 🟥, 🔵, 🟦, 🟡, 🟨 or words like "in red", "blue team").
   - "score": integer goals scored for Standard match, otherwise null.
   - "rank": 1, 2, or 3 for Tournament match, otherwise null.
   - "players": Array of player objects:
     - "rawName": cleaned player name (strip role tags like "(Ref)", "(GK)", "(c)"). E.g. "Patrick (Ref)" -> "Patrick".
     - "playerId": exact matching "id" from the Authoritative Player Registry if confident, otherwise null. NEVER invent player IDs.
     - "confidence": number from 0.0 to 1.0 (1.0 = exact hit in registry/aliases, 0.95 = clear initial/nickname match, 0.0 = unknown).
5. PLAYER NICKNAME & INITIAL RULES:
   - "Antra" -> antraniek
   - "Gus" -> gustavo
   - "Dani G" or "Daniel G" -> daniel_gomez
   - "Dani M" or "Daniel M" -> daniel_muller
   - "Javi F" -> javi_farres
   - "Javi B" -> javi_bernardo
   - "Anderson B" -> anderson_brazil
   - "Alex Chavista" / "Alex Venezuela" -> alex_chavista
   - "Gui" / "Guillermo" -> guille
   - "Pat" -> patrick
   - Suffixes like "(Ref)", "(Referee)", "(GK)", "(Keeper)", "(c)", "(Captain)" are roles and MUST be removed from rawName.
6. SEPARATORS & VS LINES:
   - Standalone lines containing "Vs", "VS", "vs.", "versus", or "/" are team separators and NOT team names or players.
7. SCORE & OUTCOME RULES:
   - Natural language outcomes like "red team won 3-2" or "Fifantinos won 3-2" mean the red/winning team scored 3 goals, and the other team scored 2 goals. Assign scores to respective teams accordingly.
8. "unparsed": Array of raw lines from the input that could not be parsed as team headers, scores, or players.

RAW INPUT:
"""
${rawText}
"""
`;

  const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);
  const rawOutputText = geminiRes.text;

  let parsed;
  try {
    const cleanedText = rawOutputText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleanedText);
  } catch (parseErr) {
    throw new functions.https.HttpsError('internal', `Failed to parse AI output as JSON: ${parseErr.message}`);
  }

  const validatedTeams = [];
  for (const t of (parsed.teams || [])) {
    const validatedPlayers = [];
    for (const p of (t.players || [])) {
      let rawName = (p.rawName || '').replace(/\s*\((?:ref|referee|gk|keeper|c|captain|sub)\)/gi, '').trim();
      let pId = p.playerId;
      let conf = typeof p.confidence === 'number' ? p.confidence : 0.5;

      if (pId && !knownPlayersMap.has(pId)) {
        pId = null;
        conf = 0.4;
      }

      validatedPlayers.push({
        rawName: rawName || p.rawName,
        playerId: pId,
        confidence: conf
      });
    }

    let teamColor = t.color ? String(t.color).toLowerCase() : null;
    if (teamColor && !['red', 'blue', 'yellow'].includes(teamColor)) teamColor = null;

    validatedTeams.push({
      name: t.name || null,
      color: teamColor,
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
    unparsed: Array.isArray(parsed.unparsed) ? parsed.unparsed : [],
    modelUsed: geminiRes.modelUsed,
    fellBackFrom: geminiRes.fellBackFrom || null
  };
});
