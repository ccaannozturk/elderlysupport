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

/** 5. Item 33: Match Recap Blurbs */
exports.generateMatchRecap = functions.https.onCall(async (data, context) => {
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

  const matchDoc = await db.collection('matches_v2').doc(matchId).get();
  if (!matchDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Match document not found.');
  }
  const matchData = matchDoc.data();

  const metaDoc = await db.collection('config').doc('gemini_meta').get();
  const selectedModel = (metaDoc.exists && metaDoc.data().selectedModel) ? metaDoc.data().selectedModel : MODEL_FALLBACK_CHAIN[0];

  // Fetch players for display names
  const playersSnap = await db.collection('players_v2').get();
  const nameMap = new Map();
  playersSnap.forEach(d => {
    nameMap.set(d.id, d.data().displayName || d.id);
  });
  const getName = (id) => nameMap.get(id) || id;

  // Build factual summary for prompt
  const isStd = matchData.type === 'Standard';
  let outcomeText = '';
  let lineupsText = '';

  if (isStd) {
    const tA = matchData.teams[0] || { score: 0, players: [] };
    const tB = matchData.teams[1] || { score: 0, players: [] };
    const pA = (tA.players || []).map(getName).join(', ');
    const pB = (tB.players || []).map(getName).join(', ');
    const sA = tA.score || 0;
    const sB = tB.score || 0;

    outcomeText = `Final Score: ${tA.teamName || 'Team A'} ${sA} - ${sB} ${tB.teamName || 'Team B'}.`;
    lineupsText = `- ${tA.teamName || 'Team A'} (${tA.color || 'blue'}): ${pA}\n- ${tB.teamName || 'Team B'} (${tB.color || 'red'}): ${pB}`;
  } else {
    const ranks = (matchData.teams || []).map(t => {
      const pList = (t.players || []).map(getName).join(', ');
      return `Rank ${t.rank || 1}: ${t.teamName || 'Team'} (${t.points || 0} pts) - Players: ${pList}`;
    }).join('\n');
    outcomeText = 'Tournament Results:\n' + ranks;
    lineupsText = ranks;
  }

  const dObj = matchData.date ? (matchData.date.toDate ? matchData.date.toDate() : new Date(matchData.date)) : new Date();
  const dateStr = `${dObj.getDate()}/${dObj.getMonth() + 1}/${dObj.getFullYear()}`;
  const venueStr = matchData.location || 'Amsterdam';

  const prompt = `You are the official match reporter for the Elderly Support recreational football league in Amsterdam.
Write a warm, concise, factual TWO-SENTENCE match recap based strictly on the verified match data below.

VERIFIED MATCH DATA:
- Date: ${dateStr}
- Venue: ${venueStr}
- Format: ${matchData.type || 'Standard'}
- Outcome: ${outcomeText}
- Lineups:
${lineupsText}

STRICT FACTUAL RULES:
1. Exactly TWO sentences maximum.
2. Use ONLY the supplied facts above. Do NOT invent goals, player actions, storylines, or outside context.
3. Do NOT name any player who was not listed in the lineups above.
4. Tone: warm, friendly, factual, engaging. No cheesy hype-man voice, no corporate jargon, no roasting.
5. Return JSON with key "recap":
{"recap": "Sentence one. Sentence two."}
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

  // Store cached recap on the match document
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('matches_v2').doc(matchId).set({
    recap: recapText,
    recapGeneratedAt: now,
    recapModel: geminiRes.modelUsed
  }, { merge: true });

  return {
    ok: true,
    recap: recapText,
    modelUsed: geminiRes.modelUsed,
    fellBackFrom: geminiRes.fellBackFrom || null
  };
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
