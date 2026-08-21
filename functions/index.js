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

const RECAP_SILENCE_THRESHOLD = 65;

function getMatchTime(m) {
  if (!m || !m.date) return 0;
  if (typeof m.date === 'number') return m.date;
  if (m.date.value) {
    const t = new Date(m.date.value).getTime();
    if (!isNaN(t)) return t;
  }
  if (typeof m.date.toMillis === 'function') {
    try { return m.date.toMillis(); } catch (e) {}
  }
  if (typeof m.date.toDate === 'function') {
    try { return m.date.toDate().getTime(); } catch (e) {}
  }
  if (typeof m.date._seconds === 'number') {
    return m.date._seconds * 1000 + Math.round((m.date._nanoseconds || 0) / 1000000);
  }
  if (typeof m.date.seconds === 'number') {
    return m.date.seconds * 1000 + Math.round((m.date.nanoseconds || 0) / 1000000);
  }
  const t = new Date(m.date).getTime();
  return isNaN(t) ? 0 : t;
}

function getMatchDate(m) {
  const ms = getMatchTime(m);
  return new Date(ms);
}

function computeExpectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function computeEloRatings(matchList) {
  const sorted = [...matchList].sort((a, b) => {
    const tA = getMatchTime(a);
    const tB = getMatchTime(b);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const ratings = {};
  const matchCounts = {};

  const getRating = (p) => ratings[p] !== undefined ? ratings[p] : STARTING_ELO;
  const getCount = (p) => matchCounts[p] !== undefined ? matchCounts[p] : 0;

  for (const m of sorted) {
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0], tB = m.teams[1];
      const pA = tA.players || [], pB = tB.players || [];
      const avgA = pA.length ? (pA.reduce((sum, p) => sum + getRating(p), 0) / pA.length) : STARTING_ELO;
      const avgB = pB.length ? (pB.reduce((sum, p) => sum + getRating(p), 0) / pB.length) : STARTING_ELO;
      const expA = computeExpectedScore(avgA, avgB);
      const expB = 1 - expA;
      let actA = 0.5, actB = 0.5;
      const sA = tA.score || 0, sB = tB.score || 0;
      if (sA > sB) { actA = 1; actB = 0; }
      else if (sB > sA) { actA = 0; actB = 1; }

      for (const p of pA) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        ratings[p] = getRating(p) + k * (actA - expA);
        matchCounts[p] = getCount(p) + 1;
      }
      for (const p of pB) {
        const k = getCount(p) < 10 ? K_STANDARD_NEW : K_STANDARD_REG;
        ratings[p] = getRating(p) + k * (actB - expB);
        matchCounts[p] = getCount(p) + 1;
      }
    } else if (m.type === 'Tournament' && m.teams.length >= 3) {
      const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
      const r2 = m.teams.find(t => t.rank === 2) || m.teams[1];
      const r3 = m.teams.find(t => t.rank === 3) || m.teams[2];

      const p1 = r1.players || [], p2 = r2.players || [], p3 = r3.players || [];
      const avg1 = p1.length ? (p1.reduce((sum, p) => sum + getRating(p), 0) / p1.length) : STARTING_ELO;
      const avg2 = p2.length ? (p2.reduce((sum, p) => sum + getRating(p), 0) / p2.length) : STARTING_ELO;
      const avg3 = p3.length ? (p3.reduce((sum, p) => sum + getRating(p), 0) / p3.length) : STARTING_ELO;

      const pairs = [
        { teamA: p1, teamB: p2, avgA: avg1, avgB: avg2, actA: 1, actB: 0 },
        { teamA: p1, teamB: p3, avgA: avg1, avgB: avg3, actA: 1, actB: 0 },
        { teamA: p2, teamB: p3, avgA: avg2, avgB: avg3, actA: 1, actB: 0 }
      ];

      const deltas = {};
      for (const { teamA, teamB, avgA, avgB, actA, actB } of pairs) {
        const expA = computeExpectedScore(avgA, avgB);
        const expB = 1 - expA;
        for (const p of teamA) {
          const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
          deltas[p] = (deltas[p] || 0) + k * (actA - expA);
        }
        for (const p of teamB) {
          const k = getCount(p) < 10 ? K_TOURN_NEW : K_TOURN_REG;
          deltas[p] = (deltas[p] || 0) + k * (actB - expB);
        }
      }

      for (const p of [...p1, ...p2, ...p3]) {
        ratings[p] = getRating(p) + (deltas[p] || 0);
        matchCounts[p] = getCount(p) + 1;
      }
    }
  }

  return { ratings, matchCounts };
}

function computeMatchAngles(allMatches, targetMatchId, nameResolver = (id) => id) {
  const sorted = [...allMatches].sort((a, b) => {
    const tA = getMatchTime(a);
    const tB = getMatchTime(b);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const targetIndex = sorted.findIndex(m => m.id === targetMatchId);
  if (targetIndex === -1) return { topAngle: null, highestScore: 0, isSilent: true, silenceReason: "Match not found" };

  const targetMatch = sorted[targetIndex];
  const priorMatches = sorted.slice(0, targetIndex);

  const preEloData = computeEloRatings(priorMatches);
  const getPreElo = (pId) => (preEloData.ratings && preEloData.ratings[pId]) ? preEloData.ratings[pId] : STARTING_ELO;

  const preCaps = {};
  const preStreaks = {};
  const lastPlayedDate = {};
  const venueStats = {};
  const duoRecords = {};
  const h2hHistory = {};

  for (const m of priorMatches) {
    const mDate = getMatchDate(m);
    const mVenue = m.location || '';
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0], tB = m.teams[1];
      const pA = tA.players || [], pB = tB.players || [];
      const sA = tA.score || 0, sB = tB.score || 0;
      const resA = sA > sB ? 'W' : (sA === sB ? 'D' : 'L');
      const resB = sB > sA ? 'W' : (sB === sA ? 'D' : 'L');

      [...pA, ...pB].forEach(p => {
        preCaps[p] = (preCaps[p] || 0) + 1;
        lastPlayedDate[p] = mDate;
      });

      pA.forEach(p => {
        if (!venueStats[p]) venueStats[p] = {};
        if (!venueStats[p][mVenue]) venueStats[p][mVenue] = { played: 0, won: 0 };
        venueStats[p][mVenue].played++;
        if (resA === 'W') venueStats[p][mVenue].won++;
      });
      pB.forEach(p => {
        if (!venueStats[p]) venueStats[p] = {};
        if (!venueStats[p][mVenue]) venueStats[p][mVenue] = { played: 0, won: 0 };
        venueStats[p][mVenue].played++;
        if (resB === 'W') venueStats[p][mVenue].won++;
      });

      pA.forEach(p => {
        if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
        if (resA === 'W') { preStreaks[p].w++; preStreaks[p].u++; }
        else if (resA === 'D') { preStreaks[p].w = 0; preStreaks[p].u++; }
        else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
      });
      pB.forEach(p => {
        if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
        if (resB === 'W') { preStreaks[p].w++; preStreaks[p].u++; }
        else if (resB === 'D') { preStreaks[p].w = 0; preStreaks[p].u++; }
        else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
      });

      [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
        const sortedP = [...team].sort();
        for (let i = 0; i < sortedP.length; i++) {
          for (let j = i + 1; j < sortedP.length; j++) {
            const key = `${sortedP[i]}__${sortedP[j]}`;
            if (!duoRecords[key]) duoRecords[key] = { played: 0, won: 0 };
            duoRecords[key].played++;
            if (res === 'W') duoRecords[key].won++;
          }
        }
      });

      pA.forEach(p1 => {
        pB.forEach(p2 => {
          const key1 = `${p1}__${p2}`;
          const key2 = `${p2}__${p1}`;
          if (!h2hHistory[key1]) h2hHistory[key1] = [];
          if (!h2hHistory[key2]) h2hHistory[key2] = [];
          h2hHistory[key1].push(resA);
          h2hHistory[key2].push(resB);
        });
      });
    } else if (m.type === 'Tournament') {
      const r1 = m.teams.find(t => t.rank === 1) || m.teams[0];
      m.teams.forEach(t => {
        const isWin = (t === r1 || t.rank === 1);
        (t.players || []).forEach(p => {
          preCaps[p] = (preCaps[p] || 0) + 1;
          lastPlayedDate[p] = mDate;
          if (!preStreaks[p]) preStreaks[p] = { w: 0, u: 0 };
          if (isWin) { preStreaks[p].w++; preStreaks[p].u++; }
          else { preStreaks[p].w = 0; preStreaks[p].u = 0; }
        });
      });
    }
  }

  const candidates = [];
  const targetDate = getMatchDate(targetMatch);
  const targetVenue = targetMatch.location || '';
  const isStd = targetMatch.type === 'Standard';

  if (isStd && targetMatch.teams && targetMatch.teams.length >= 2) {
    const tA = targetMatch.teams[0];
    const tB = targetMatch.teams[1];
    const pA = tA.players || [];
    const pB = tB.players || [];
    const sA = tA.score || 0;
    const sB = tB.score || 0;
    const resA = sA > sB ? 'W' : (sA === sB ? 'D' : 'L');
    const resB = sB > sA ? 'W' : (sB === sA ? 'D' : 'L');
    const isDraw = sA === sB;

    const avgEloA = pA.length ? Math.round(pA.reduce((sum, p) => sum + getPreElo(p), 0) / pA.length) : STARTING_ELO;
    const avgEloB = pB.length ? Math.round(pB.reduce((sum, p) => sum + getPreElo(p), 0) / pB.length) : STARTING_ELO;

    // Angle 1: Upset
    if (!isDraw) {
      const winningTeam = resA === 'W' ? tA : tB;
      const losingTeam = resA === 'W' ? tB : tA;
      const winElo = resA === 'W' ? avgEloA : avgEloB;
      const loseElo = resA === 'W' ? avgEloB : avgEloA;
      const eloGap = loseElo - winElo;

      if (eloGap >= 25) {
        const score = Math.min(100, Math.round(45 + eloGap * 0.6));
        candidates.push({
          type: 'upset',
          score,
          winnerTeamName: winningTeam.teamName || 'Underdog',
          loserTeamName: losingTeam.teamName || 'Favorites',
          winnerElo: winElo,
          loserElo: loseElo,
          eloGap,
          winnerScore: winningTeam.score,
          loserScore: losingTeam.score,
          facts: `${winningTeam.teamName || 'Underdog'} (${winElo} Elo) defeated higher-rated ${losingTeam.teamName || 'Opponents'} (${loseElo} Elo, gap: ${eloGap} points)`
        });
      }
    }

    // Angle 2: Blowout (Margin >= 5)
    const margin = Math.abs(sA - sB);
    if (margin >= 5) {
      const winningTeam = sA > sB ? tA : tB;
      const losingTeam = sA > sB ? tB : tA;
      const score = Math.min(95, 45 + (margin - 4) * 15);
      candidates.push({
        type: 'blowout',
        score,
        winnerTeamName: winningTeam.teamName || 'Winners',
        loserTeamName: losingTeam.teamName || 'Losers',
        winnerScore: winningTeam.score,
        loserScore: losingTeam.score,
        margin,
        facts: `${winningTeam.teamName || 'Winners'} won by a commanding ${margin}-goal margin (${winningTeam.score}-${losingTeam.score})`
      });
    }

    // Angle 3: High Scoring (Combined Goals >= 12)
    const totalGoals = sA + sB;
    if (totalGoals >= 12) {
      const score = Math.min(95, 50 + (totalGoals - 11) * 12);
      candidates.push({
        type: 'high_scoring',
        score,
        totalGoals,
        teamAName: tA.teamName || 'Team A',
        teamBName: tB.teamName || 'Team B',
        scoreA: sA,
        scoreB: sB,
        facts: `High-scoring encounter featuring ${totalGoals} combined goals (${tA.teamName || 'Team A'} ${sA}-${sB} ${tB.teamName || 'Team B'})`
      });
    }

    // Angle 4: Streaks Broken & Extended
    [ { team: pA, res: resA, oppTeam: pB }, { team: pB, res: resB, oppTeam: pA } ].forEach(({ team, res }) => {
      team.forEach(p => {
        const prior = preStreaks[p] || { w: 0, u: 0 };
        const pName = nameResolver(p);

        if (res !== 'W' && prior.w >= 3) {
          const score = Math.min(100, 45 + prior.w * 12);
          candidates.push({
            type: 'streak_broken',
            score,
            playerName: pName,
            playerId: p,
            streakLength: prior.w,
            streakType: 'winning run',
            facts: `${pName}'s ${prior.w}-game winning streak ended with this result`
          });
        } else if (res === 'L' && prior.u >= 4) {
          const score = Math.min(100, 45 + prior.u * 10);
          candidates.push({
            type: 'streak_broken',
            score,
            playerName: pName,
            playerId: p,
            streakLength: prior.u,
            streakType: 'unbeaten run',
            facts: `${pName}'s ${prior.u}-game unbeaten streak was snapped`
          });
        }

        if (res === 'W' && (prior.w + 1) >= 4) {
          const newLen = prior.w + 1;
          const score = Math.min(95, 40 + newLen * 10);
          candidates.push({
            type: 'streak_extended',
            score,
            playerName: pName,
            playerId: p,
            streakLength: newLen,
            streakType: 'consecutive wins',
            facts: `${pName} won their ${newLen}th consecutive match`
          });
        }
      });
    });

    // Angle 5: Milestones Hit
    [...pA, ...pB].forEach(p => {
      const priorC = preCaps[p] || 0;
      const currentC = priorC + 1;
      const pName = nameResolver(p);
      const won = (pA.includes(p) && resA === 'W') || (pB.includes(p) && resB === 'W');

      if (currentC % 25 === 0) {
        const baseScore = currentC === 100 ? 95 : (currentC === 50 ? 85 : 75);
        const score = won ? baseScore + 5 : baseScore;
        candidates.push({
          type: 'milestone_hit',
          score,
          playerName: pName,
          playerId: p,
          caps: currentC,
          won,
          facts: `${pName} reached ${currentC} career caps (${won ? 'celebrated with a win' : 'marked in this match'})`
        });
      }
    });

    // Angle 6: Nemesis Broken
    [ { team: pA, oppTeam: pB, res: resA }, { team: pB, oppTeam: pA, res: resB } ].forEach(({ team, oppTeam, res }) => {
      if (res === 'W') {
        team.forEach(p1 => {
          oppTeam.forEach(p2 => {
            const h2h = h2hHistory[`${p1}__${p2}`] || [];
            let trailingLosses = 0;
            for (let i = h2h.length - 1; i >= 0; i--) {
              if (h2h[i] === 'L') trailingLosses++;
              else break;
            }
            if (trailingLosses >= 3) {
              const score = Math.min(95, 50 + trailingLosses * 12);
              candidates.push({
                type: 'nemesis_broken',
                score,
                winnerName: nameResolver(p1),
                loserName: nameResolver(p2),
                priorLosses: trailingLosses,
                facts: `${nameResolver(p1)} earned their first victory over ${nameResolver(p2)} after ${trailingLosses} straight losses against them`
              });
            }
          });
        });
      }
    });

    // Angle 7: Notable Duo
    [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
      const sortedP = [...team].sort();
      for (let i = 0; i < sortedP.length; i++) {
        for (let j = i + 1; j < sortedP.length; j++) {
          const key = `${sortedP[i]}__${sortedP[j]}`;
          const prior = duoRecords[key] || { played: 0, won: 0 };
          const newPlayed = prior.played + 1;
          const newWon = prior.won + (res === 'W' ? 1 : 0);

          if (newPlayed >= 4) {
            const winRate = Math.round((newWon / newPlayed) * 100);
            if (winRate >= 80 && res === 'W') {
              const score = Math.min(90, 45 + newPlayed * 7);
              candidates.push({
                type: 'duo_notable',
                score,
                player1Name: nameResolver(sortedP[i]),
                player2Name: nameResolver(sortedP[j]),
                played: newPlayed,
                won: newWon,
                winRatePct: winRate,
                status: 'dominant partners',
                facts: `${nameResolver(sortedP[i])} and ${nameResolver(sortedP[j])} have now won ${newWon} of their ${newPlayed} matches as teammates (${winRate}%)`
              });
            }
          }
        }
      }
    });

    // Angle 8: Return after Long Absence
    [...pA, ...pB].forEach(p => {
      const caps = preCaps[p] || 0;
      const lastDate = lastPlayedDate[p];
      if (caps >= 5 && lastDate && targetDate) {
        const diffMs = targetDate.getTime() - lastDate.getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 60) {
          const months = Math.round(diffDays / 30);
          const score = Math.min(90, 40 + Math.round(diffDays / 20) * 6);
          candidates.push({
            type: 'return',
            score,
            playerName: nameResolver(p),
            daysAbsent: diffDays,
            monthsAbsent: months,
            facts: `${nameResolver(p)} returned to the league after ${diffDays} days (${months} months) since their last match`
          });
        }
      }
    });

    // Angle 9: First Time Teammates (Both >= 10 caps, 0 prior games together)
    [ { team: pA }, { team: pB } ].forEach(({ team }) => {
      const sortedP = [...team].sort();
      for (let i = 0; i < sortedP.length; i++) {
        for (let j = i + 1; j < sortedP.length; j++) {
          const p1 = sortedP[i], p2 = sortedP[j];
          const c1 = preCaps[p1] || 0, c2 = preCaps[p2] || 0;
          const key = `${p1}__${p2}`;
          const prior = duoRecords[key] || { played: 0, won: 0 };
          if (c1 >= 10 && c2 >= 10 && prior.played === 0) {
            const score = Math.min(85, 45 + Math.min(c1, c2) * 1.5);
            candidates.push({
              type: 'first_together',
              score: Math.round(score),
              player1Name: nameResolver(p1),
              player2Name: nameResolver(p2),
              p1Caps: c1 + 1,
              p2Caps: c2 + 1,
              facts: `Veterans ${nameResolver(p1)} (${c1 + 1} caps) and ${nameResolver(p2)} (${c2 + 1} caps) shared a team for the first time in league history`
            });
          }
        }
      }
    });

    // Angle 10: Venue Mastery
    [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
      if (res === 'W' && targetVenue) {
        team.forEach(p => {
          const vData = (venueStats[p] && venueStats[p][targetVenue]) ? venueStats[p][targetVenue] : { played: 0, won: 0 };
          const newPlayed = vData.played + 1;
          const newWon = vData.won + 1;
          if (newPlayed >= 4) {
            const rate = Math.round((newWon / newPlayed) * 100);
            if (rate >= 80) {
              const score = Math.min(85, 40 + newWon * 8);
              candidates.push({
                type: 'venue',
                score,
                playerName: nameResolver(p),
                venueName: targetVenue,
                venueWins: newWon,
                venuePlayed: newPlayed,
                venueWinRatePct: rate,
                facts: `${nameResolver(p)} has won ${newWon} of ${newPlayed} games at ${targetVenue} (${rate}% win rate)`
              });
            }
          }
        });
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const topAngle = candidates.length > 0 ? candidates[0] : null;
  const isSilent = !topAngle || topAngle.score < RECAP_SILENCE_THRESHOLD;

  return {
    matchId: targetMatchId,
    date: targetDate,
    topAngle: isSilent ? null : topAngle,
    highestScore: topAngle ? topAngle.score : 0,
    isSilent,
    silenceReason: isSilent ? (topAngle ? `Highest angle score (${topAngle.score} for ${topAngle.type}) below silence threshold (${RECAP_SILENCE_THRESHOLD})` : 'No qualifying angles detected') : null,
    allCandidates: candidates
  };
}

/** 5. Item 33: Match Recap Blurbs */
exports.generateMatchRecap = functions.https.onCall(async (data, context) => {
  try {
    assertAdmin(context);

    const matchId = data && data.matchId ? String(data.matchId).trim() : '';
    if (!matchId) {
      throw new functions.https.HttpsError('invalid-argument', 'Match ID is required.');
    }

    const keyDoc = await db.collection('config').doc('gemini').get();
    if (!keyDoc.exists || !keyDoc.data().apiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured.');
    }
    const apiKey = keyDoc.data().apiKey;

    const metaDoc = await db.collection('config').doc('gemini_meta').get();
    const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

    // Fetch all matches and players for deterministic timeline & stats
    const matchesSnap = await db.collection('matches_v2').get();
    const allMatches = [];
    matchesSnap.forEach(d => {
      allMatches.push({ id: d.id, ...d.data() });
    });

    const targetMatch = allMatches.find(m => m.id === matchId);
    if (!targetMatch) {
      throw new functions.https.HttpsError('not-found', 'Match document not found.');
    }

    const playersSnap = await db.collection('players_v2').get();
    const nameMap = new Map();
    playersSnap.forEach(d => {
      nameMap.set(d.id, d.data().displayName || d.id);
    });
    const getName = (id) => nameMap.get(id) || id;

    // Compute deterministic angle
    const angleRes = computeMatchAngles(allMatches, matchId, getName);

    // Step 2: Silence Threshold - if no angle cleared threshold, store null recap
    if (angleRes.isSilent || !angleRes.topAngle) {
      await db.collection('matches_v2').doc(matchId).set({
        recap: null,
        recapAngle: null,
        recapScore: angleRes.highestScore,
        recapModel: null,
        recapGeneratedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return {
        ok: true,
        recap: null,
        angle: null,
        score: angleRes.highestScore,
        isSilent: true,
        reason: angleRes.silenceReason
      };
    }

    const topAngle = angleRes.topAngle;
    const teamAName = (targetMatch.teams && targetMatch.teams[0] && targetMatch.teams[0].teamName) || 'Team A';
    const teamBName = (targetMatch.teams && targetMatch.teams[1] && targetMatch.teams[1].teamName) || 'Team B';

    // Step 3: Minimal 1-Sentence Prompt
    const prompt = `You are the official match reporter for the Elderly Support recreational football league in Amsterdam.
Write a single, compelling ONE-SENTENCE match recap highlighting the specific angle and verified facts below.

TEAM NAMES (playful group in-jokes):
- ${teamAName} vs ${teamBName}

SELECTED MATCH ANGLE (${topAngle.type}):
${topAngle.facts}

STRICT FACTUAL RULES:
1. Exactly ONE sentence. Never write two sentences.
2. Focus ONLY on the specified angle and figures above. Do NOT invent goals, player actions, storylines, or outside context.
3. NEVER mention jersey, team marker, or shirt colors (e.g. do not mention "blue team", "red-clad", "yellow", etc.).
4. NEVER open with the match date or location/venue.
5. NEVER list full lineups or players not mentioned in the angle above.
6. NEVER restate the full scoreline unless the scoreline is the angle itself.
7. Tone: natural, engaging, witty, concise. Play along with playful team names if fitting.
8. Return strict JSON:
{"recap": "Single sentence recap text."}
`;

    const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);
    let recapText = '';
    try {
      const cleaned = geminiRes.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      recapText = parsed.recap || cleaned;
    } catch (e) {
      recapText = geminiRes.text.replace(/[{}"]/g, '').trim();
    }

    // Enforce strict 1-sentence cap
    if (recapText) {
      const sentenceMatch = recapText.match(/^.*?[.!?](?:\s|$)/);
      if (sentenceMatch && sentenceMatch[0] && sentenceMatch[0].trim().length > 10) {
        recapText = sentenceMatch[0].trim();
      }
    }

    // Store cached recap, angle, score, model on match document
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('matches_v2').doc(matchId).set({
      recap: recapText,
      recapAngle: topAngle.type,
      recapScore: topAngle.score,
      recapModel: geminiRes.modelUsed,
      recapGeneratedAt: now
    }, { merge: true });

    return {
      ok: true,
      recap: recapText,
      angle: topAngle.type,
      score: topAngle.score,
      modelUsed: geminiRes.modelUsed,
      fellBackFrom: geminiRes.fellBackFrom || null
    };
  } catch (err) {
    console.error('generateMatchRecap error:', err);
    if (err instanceof functions.https.HttpsError) {
      throw err;
    }
    throw new functions.https.HttpsError('internal', err.message || 'Failed to generate recap.');
  }
});

/** 6. Item 34: Natural Language Stats Query */
exports.queryStats = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const question = data && data.question ? String(data.question).trim() : '';
  if (!question) {
    throw new functions.https.HttpsError('invalid-argument', 'Question cannot be empty.');
  }

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured.');
  }
  const apiKey = keyDoc.data().apiKey;

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  // Fetch match and player database to compute authoritative stats
  const [matchesSnap, playersSnap] = await Promise.all([
    db.collection('matches_v2').get(),
    db.collection('players_v2').get()
  ]);

  const nameMap = new Map();
  const playersRegistry = new Map();
  playersSnap.forEach(d => {
    const p = d.data();
    nameMap.set(d.id, p.displayName || d.id);
    playersRegistry.set(d.id, { id: d.id, displayName: p.displayName || d.id, aliases: p.aliases || [] });
  });

  const getName = (id) => nameMap.get(id) || id;

  // 1. Sort matches chronologically for Elo and Streaks
  const allMatchesList = [];
  matchesSnap.forEach(doc => {
    const d = doc.data();
    if (d.teams && d.teams.length >= 2) {
      allMatchesList.push({ id: doc.id, ...d });
    }
  });

  allMatchesList.sort((a, b) => {
    const tA = a.date ? (a.date.toDate ? a.date.toDate().getTime() : new Date(a.date).getTime()) : 0;
    const tB = b.date ? (b.date.toDate ? b.date.toDate().getTime() : new Date(b.date).getTime()) : 0;
    if (tA !== tB) return tA - tB;
    return a.id.localeCompare(b.id);
  });

  // 2. Compute Elo Ratings, H2H, Streaks, and Duos
  const playerStats = {};
  const duos = {};
  const h2h = {}; // h2h[p1][p2] = { against: 0, wonAgainst: 0, lostTo: 0, drawn: 0 }
  const streaks = {}; // streaks[pId] = { current: { type: 'W'|'L'|'D', count: 0 }, maxW: 0, maxUnbeaten: 0, maxL: 0, currentUnbeaten: 0 }
  const eloMap = {}; // eloMap[pId] = { rating: 1200, matches: 0 }
  const stdMatches = [];
  let totalStdGoals = 0;
  const venuesStats = {};

  const initPlayer = (pId) => {
    if (!playerStats[pId]) {
      playerStats[pId] = { id: pId, name: getName(pId), played: 0, won: 0, drawn: 0, lost: 0, pts: 0, gf: 0, ga: 0, stdPlayed: 0 };
    }
    if (!eloMap[pId]) {
      eloMap[pId] = { rating: 1200, matches: 0 };
    }
    if (!streaks[pId]) {
      streaks[pId] = { currentType: '', currentCount: 0, maxW: 0, maxUnbeaten: 0, maxL: 0, curW: 0, curUnbeaten: 0, curL: 0 };
    }
    if (!h2h[pId]) {
      h2h[pId] = {};
    }
  };

  allMatchesList.forEach(m => {
    const loc = m.location || 'Unknown';
    if (!venuesStats[loc]) venuesStats[loc] = { matches: 0, stdMatches: 0, totalGoals: 0 };
    venuesStats[loc].matches++;

    if (m.type === 'Standard') {
      stdMatches.push(m);
      const tA = m.teams[0], tB = m.teams[1];
      const sA = tA.score || 0, sB = tB.score || 0;
      totalStdGoals += sA + sB;
      venuesStats[loc].stdMatches++;
      venuesStats[loc].totalGoals += sA + sB;

      const pA = tA.players || [];
      const pB = tB.players || [];

      pA.forEach(initPlayer);
      pB.forEach(initPlayer);

      // Elo update
      const avgA = pA.length ? (pA.reduce((s, p) => s + eloMap[p].rating, 0) / pA.length) : 1200;
      const avgB = pB.length ? (pB.reduce((s, p) => s + eloMap[p].rating, 0) / pB.length) : 1200;
      const expA = 1 / (1 + Math.pow(10, (avgB - avgA) / 400));
      const expB = 1 - expA;
      const actA = sA > sB ? 1.0 : (sA === sB ? 0.5 : 0.0);
      const actB = 1.0 - actA;

      pA.forEach(p => {
        const k = eloMap[p].matches < 5 ? 48 : 32;
        eloMap[p].rating += k * (actA - expA);
        eloMap[p].matches++;
      });
      pB.forEach(p => {
        const k = eloMap[p].matches < 5 ? 48 : 32;
        eloMap[p].rating += k * (actB - expB);
        eloMap[p].matches++;
      });

      // Basic stats & streaks
      [ { team: tA, opp: tB, myS: sA, opS: sB, myP: pA, opP: pB },
        { team: tB, opp: tA, myS: sB, opS: sA, myP: pB, opP: pA }
      ].forEach(({ myS, opS, myP, opP }) => {
        const pts = myS > opS ? 3 : (myS === opS ? 1 : 0);
        const res = myS > opS ? 'W' : (myS === opS ? 'D' : 'L');

        myP.forEach(p => {
          playerStats[p].played++;
          playerStats[p].stdPlayed++;
          playerStats[p].pts += pts;
          playerStats[p].gf += myS;
          playerStats[p].ga += opS;
          if (pts === 3) playerStats[p].won++;
          else if (pts === 1) playerStats[p].drawn++;
          else playerStats[p].lost++;

          // Streaks
          const st = streaks[p];
          if (res === 'W') {
            st.curW++;
            st.curUnbeaten++;
            st.curL = 0;
            if (st.curW > st.maxW) st.maxW = st.curW;
            if (st.curUnbeaten > st.maxUnbeaten) st.maxUnbeaten = st.curUnbeaten;
          } else if (res === 'D') {
            st.curW = 0;
            st.curUnbeaten++;
            st.curL = 0;
            if (st.curUnbeaten > st.maxUnbeaten) st.maxUnbeaten = st.curUnbeaten;
          } else {
            st.curW = 0;
            st.curUnbeaten = 0;
            st.curL++;
            if (st.curL > st.maxL) st.maxL = st.curL;
          }
          if (st.currentType === res) st.currentCount++;
          else { st.currentType = res; st.currentCount = 1; }

          // Head-to-head vs Opponents
          opP.forEach(op => {
            if (!h2h[p][op]) h2h[p][op] = { against: 0, wonAgainst: 0, lostTo: 0, drawn: 0 };
            h2h[p][op].against++;
            if (pts === 3) h2h[p][op].wonAgainst++;
            else if (pts === 0) h2h[p][op].lostTo++;
            else h2h[p][op].drawn++;
          });
        });

        // Duos
        const sortedP = [...myP].sort();
        for (let i = 0; i < sortedP.length; i++) {
          for (let j = i + 1; j < sortedP.length; j++) {
            const key = `${sortedP[i]}__${sortedP[j]}`;
            if (!duos[key]) duos[key] = { p1: getName(sortedP[i]), p2: getName(sortedP[j]), played: 0, won: 0 };
            duos[key].played++;
            if (pts === 3) duos[key].won++;
          }
        }
      });
    } else {
      // Tournament format
      const teams = m.teams || [];
      teams.forEach(t => (t.players || []).forEach(initPlayer));

      teams.forEach((t, i) => {
        const pts = t.points !== undefined ? t.points : (t.rank === 1 ? 3 : (t.rank === 2 ? 1 : 0));
        const rank = t.rank || (i + 1);
        const res = rank === 1 ? 'W' : (rank === 2 ? 'D' : 'L');

        (t.players || []).forEach(p => {
          playerStats[p].played++;
          playerStats[p].pts += pts;
          if (rank === 1) playerStats[p].won++;
          else if (rank === 2) playerStats[p].drawn++;
          else playerStats[p].lost++;

          // H2H against other tournament teams
          teams.forEach((otherT, otherIdx) => {
            if (otherIdx === i) return;
            const otherRank = otherT.rank || (otherIdx + 1);
            (otherT.players || []).forEach(op => {
              if (!h2h[p][op]) h2h[p][op] = { against: 0, wonAgainst: 0, lostTo: 0, drawn: 0 };
              h2h[p][op].against++;
              if (rank < otherRank) h2h[p][op].wonAgainst++;
              else if (rank > otherRank) h2h[p][op].lostTo++;
              else h2h[p][op].drawn++;
            });
          });
        });
      });
    }
  });

  const leagueAvgGF = (stdMatches.length > 0) ? (totalStdGoals / (stdMatches.length * 2)) : 0;

  const playerList = Object.values(playerStats).map(p => {
    const ppg = p.played > 0 ? (p.pts / p.played).toFixed(2) : '0.00';
    const wr = p.played > 0 ? Math.round((p.won / p.played) * 100) : 0;
    const avgGF = p.stdPlayed > 0 ? (p.gf / p.stdPlayed).toFixed(2) : '0.00';
    const deltaGF = (Number(avgGF) - leagueAvgGF).toFixed(2);
    const elo = eloMap[p.id] ? Math.round(eloMap[p.id].rating) : 1200;
    const isProvisional = eloMap[p.id] ? eloMap[p.id].matches < 5 : true;
    const st = streaks[p.id] || { maxW: 0, maxUnbeaten: 0, currentType: 'W', currentCount: 0 };

    // Find top nemesis (opponent lost to most often, min 2 games against)
    const opponents = Object.entries(h2h[p.id] || {})
      .map(([opId, rec]) => ({
        opponent: getName(opId),
        playedAgainst: rec.against,
        lostTo: rec.lostTo,
        wonAgainst: rec.wonAgainst,
        drawn: rec.drawn,
        lossRate: rec.against > 0 ? Math.round((rec.lostTo / rec.against) * 100) : 0
      }))
      .sort((a, b) => (b.lostTo !== a.lostTo ? b.lostTo - a.lostTo : b.lossRate - a.lossRate));

    const topNemesis = opponents.length > 0 ? opponents[0] : null;

    return {
      name: p.name,
      played: p.played,
      won: p.won,
      drawn: p.drawn,
      lost: p.lost,
      points: p.pts,
      ppg,
      winRate: `${wr}%`,
      eloRating: elo,
      isProvisionalElo: isProvisional,
      currentStreak: `${st.currentCount} ${st.currentType}`,
      longestWinStreak: st.maxW,
      longestUnbeatenStreak: st.maxUnbeaten,
      goalsForPerGame: avgGF,
      curseImpactDeltaGF: deltaGF,
      topNemesis: topNemesis ? `${topNemesis.opponent} (Lost ${topNemesis.lostTo} of ${topNemesis.playedAgainst} games opposed)` : 'None',
      detailedHeadToHeadVsOpponents: opponents.slice(0, 8)
    };
  }).sort((a, b) => b.points - a.points);

  const duoList = Object.values(duos)
    .filter(d => d.played >= 3)
    .map(d => ({
      pair: `${d.p1} & ${d.p2}`,
      played: d.played,
      won: d.won,
      winRate: `${Math.round((d.won / d.played) * 100)}%`
    })).sort((a, b) => b.played - a.played);

  // Curse Stat ranking (players with >= 5 standard matches)
  const curseRankings = [...playerList]
    .filter(p => p.played >= 5)
    .sort((a, b) => Number(a.curseImpactDeltaGF) - Number(b.curseImpactDeltaGF));

  const mostCursedPlayer = curseRankings.length > 0 ? curseRankings[0] : null;
  const mostBlessedPlayer = curseRankings.length > 0 ? curseRankings[curseRankings.length - 1] : null;

  const statsContext = {
    totalMatchesRecorded: matchesSnap.size,
    standardMatches: stdMatches.length,
    leagueAverageGoalsPerTeamMatch: leagueAvgGF.toFixed(2),
    mostCursedPlayer: mostCursedPlayer ? `${mostCursedPlayer.name} (${mostCursedPlayer.curseImpactDeltaGF} team GF/game vs league avg)` : null,
    mostBlessedPlayer: mostBlessedPlayer ? `${mostBlessedPlayer.name} (+${mostBlessedPlayer.curseImpactDeltaGF} team GF/game vs league avg)` : null,
    eloLeaderboard: [...playerList].filter(p => !p.isProvisionalElo).sort((a, b) => b.eloRating - a.eloRating).slice(0, 10).map(p => `${p.name}: ${p.eloRating} Elo (${p.played} games)`),
    playersSummary: playerList,
    topDuosByGamesTogether: duoList.slice(0, 15),
    bestDuosByWinRate: [...duoList].sort((a, b) => parseInt(b.winRate) - parseInt(a.winRate)).slice(0, 10),
    worstDuosByWinRate: [...duoList].sort((a, b) => parseInt(a.winRate) - parseInt(b.winRate)).slice(0, 10),
    venues: Object.entries(venuesStats).map(([v, s]) => ({ venue: v, matches: s.matches, avgGoals: s.stdMatches > 0 ? (s.totalGoals / s.stdMatches).toFixed(1) : 'N/A' }))
  };

  const prompt = `You are the stats assistant for the Elderly Support recreational football league in Amsterdam.
Answer the question accurately using ONLY the official computed figures below.

OFFICIAL COMPUTED LEAGUE DATA:
${JSON.stringify(statsContext, null, 2)}

STRICT RULES:
1. Answer ONLY using facts and figures explicitly present in the data above.
2. Quote exact numbers, win rates, and records verbatim.
3. If the user presents two hypothetical lineups or asks who would win a matchup between specific teams/players:
   - Identify each player in the data (resolving nicknames/aliases like Dani G -> Daniel Gomez, Dani M -> Daniel Müller, Patrick (Ref) -> Patrick).
   - Compare the two teams using their players' official Elo ratings, win rates, and points per game from the data.
   - Give an analytical prediction explaining which team has the statistical advantage based on those numbers.
4. If the data does not contain the answer (e.g. height, age, player positions, weather), state clearly that the official league data does not track that information.
5. Keep your response concise (2-4 sentences max), friendly, and direct.
6. Output strict JSON with key "answer":
{"answer": "Your direct response here."}

USER QUESTION:
"""${question}"""
`;

  const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);
  let answerText = geminiRes.text;
  try {
    const cleaned = geminiRes.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    answerText = parsed.answer || parsed.response || parsed.text || cleaned;
  } catch (e) {
    answerText = geminiRes.text.replace(/^\{.*"answer":\s*"(.*)"\s*\}$/s, '$1').trim();
  }

  return {
    ok: true,
    answer: answerText,
    modelUsed: geminiRes.modelUsed,
    fellBackFrom: geminiRes.fellBackFrom || null
  };
});

/** 7. Item 35: Award & Milestone Citation Copy */
exports.generateAwardsCopy = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const awardType = data && data.awardType ? String(data.awardType).trim() : 'Player of the Month';
  const recipient = data && data.recipientName ? String(data.recipientName).trim() : 'Player';
  const metric = data && data.metricValue ? String(data.metricValue).trim() : '';
  const period = data && data.period ? String(data.period).trim() : '';

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured.');
  }
  const apiKey = keyDoc.data().apiKey;

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  const prompt = `Write a warm, engaging, ONE-SENTENCE award citation for a recreational football league player.

AWARD DETAILS:
- Award: ${awardType}
- Recipient: ${recipient}
- Metric: ${metric}
- Period: ${period}

RULES:
1. Exactly ONE sentence.
2. Factual, appreciative, warm tone.
3. Quote the metric accurately.
4. Return JSON: {"citation": "Sentence here."}
`;

  const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);
  let citation = '';
  try {
    const cleaned = geminiRes.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    citation = parsed.citation || cleaned;
  } catch (e) {
    citation = geminiRes.text.replace(/[{}"]/g, '').trim();
  }

  return {
    ok: true,
    citation,
    modelUsed: geminiRes.modelUsed
  };
});

/** 8. Item 36: Alias Suggestion on Player Creation */
exports.suggestAliases = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const displayName = data && data.displayName ? String(data.displayName).trim() : '';
  if (!displayName || displayName.length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid display name is required.');
  }

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured.');
  }
  const apiKey = keyDoc.data().apiKey;

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  // Fetch all existing aliases to prevent collisions
  const playersSnap = await db.collection('players_v2').get();
  const existingAliases = new Set();
  playersSnap.forEach(d => {
    const p = d.data();
    if (p.displayName) existingAliases.add(p.displayName.toLowerCase());
    (p.aliases || []).forEach(a => existingAliases.add(String(a).toLowerCase()));
  });

  const prompt = `Given the football player display name "${displayName}", suggest up to 8 common alias variations (shortened first names, initial forms like "Dani G", common spelling variations, accent-free versions).

EXISTING USED ALIASES IN THE LEAGUE (DO NOT SUGGEST ANY OF THESE):
${JSON.stringify(Array.from(existingAliases).slice(0, 150))}

RULES:
1. Return strict JSON with key "suggestions" containing an array of lowercase strings.
2. Do not include any name from the existing aliases list.
3. Example format: {"suggestions": ["dani", "dani g", "daniel g"]}
`;

  const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);
  let suggestions = [];
  try {
    const cleaned = geminiRes.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  } catch (e) {
    suggestions = [];
  }

  // Server-side validation: ensure lowercase, no collisions with existing aliases
  const validated = suggestions
    .map(s => String(s).toLowerCase().trim())
    .filter(s => s.length >= 2 && s.length <= 30 && !existingAliases.has(s));

  return {
    ok: true,
    suggestions: validated,
    modelUsed: geminiRes.modelUsed
  };
});

/** 9. Item 37: Data Health Audit */
exports.auditDataHealth = functions.https.onCall(async (data, context) => {
  assertAdmin(context);

  const keyDoc = await db.collection('config').doc('gemini').get();
  if (!keyDoc.exists || !keyDoc.data().apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API key is not configured.');
  }
  const apiKey = keyDoc.data().apiKey;

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  const matchesSnap = await db.collection('matches_v2').get();
  const rawMatches = [];
  matchesSnap.forEach(d => rawMatches.push({ id: d.id, ...d.data() }));

  const summary = {
    totalMatches: rawMatches.length,
    standardMatches: rawMatches.filter(m => m.type === 'Standard').length,
    tournamentMatches: rawMatches.filter(m => m.type === 'Tournament').length,
    missingDates: rawMatches.filter(m => !m.date).map(m => m.id),
    missingVenues: rawMatches.filter(m => !m.location).map(m => m.id),
    unusualLineupSizes: rawMatches.filter(m => (m.teams || []).some(t => !t.players || t.players.length < 3 || t.players.length > 8)).map(m => ({ id: m.id, date: m.date })),
    highScores: rawMatches.filter(m => m.type === 'Standard' && (m.teams || []).some(t => t.score >= 15)).map(m => ({ id: m.id, scores: m.teams.map(t => t.score) }))
  };

  const prompt = `You are a database integrity auditor for the Elderly Support recreational football league.
Review the following aggregated summary of the match database and provide 3-5 concise, advisory diagnostic bullet points on data health, potential anomalies, and consistency observations.

DATABASE SUMMARY:
${JSON.stringify(summary, null, 2)}

Output plain text advisory bullet points for the league administrator.
`;

  const geminiRes = await callGeminiWithFallback(apiKey, prompt, selectedModel);

  return {
    ok: true,
    report: geminiRes.text.trim(),
    modelUsed: geminiRes.modelUsed
  };
});

/** 10. Item 39: Scheduled & On-Demand Firestore Backup to Cloud Storage */
async function performFirestoreBackup() {
  const collectionsToBackup = ['matches_v2', 'players_v2', 'locations', 'config', 'awards'];
  const backupData = {
    project: 'elderly-support-league',
    takenAt: new Date().toISOString(),
    collections: {}
  };

  for (const coll of collectionsToBackup) {
    const snap = await db.collection(coll).get();
    backupData.collections[coll] = [];
    snap.forEach(doc => {
      backupData.collections[coll].push({ id: doc.id, ...doc.data() });
    });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backups/backup-${timestamp}.json`;
  const jsonContent = JSON.stringify(backupData, null, 2);

  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(filename);
    await file.save(jsonContent, {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'no-cache',
        metadata: {
          matchesCount: String(backupData.collections.matches_v2.length),
          playersCount: String(backupData.collections.players_v2.length)
        }
      }
    });
  } catch (storageErr) {
    console.warn('Storage save fallback:', storageErr.message);
  }

  return {
    filename,
    sizeBytes: Buffer.byteLength(jsonContent, 'utf8'),
    matchesCount: backupData.collections.matches_v2.length,
    playersCount: backupData.collections.players_v2.length,
    locationsCount: (backupData.collections.locations || []).length,
    takenAt: backupData.takenAt
  };
}

exports.triggerBackup = functions.https.onCall(async (data, context) => {
  assertAdmin(context);
  const result = await performFirestoreBackup();
  return { ok: true, ...result };
});

exports.scheduledBackup = functions.pubsub.schedule('every sunday 03:00').timeZone('Europe/Amsterdam').onRun(async (context) => {
  const result = await performFirestoreBackup();
  console.log('Weekly automated Firestore backup complete:', result.filename, `(${result.sizeBytes} bytes)`);
  return null;
});

