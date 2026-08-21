const firebaseConfig = {
    apiKey: "AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc",
    authDomain: "elderly-support-league.firebaseapp.com",
    projectId: "elderly-support-league",
    storageBucket: "elderly-support-league.firebasestorage.app",
    messagingSenderId: "973119844128",
    appId: "1:973119844128:web:0205ac9cdf912fa31ef145",
    measurementId: "G-101F2P233G"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const functions = firebase.functions();

if (location.hostname === 'localhost') {
    db.useEmulator('localhost', 8080);
    auth.useEmulator('http://localhost:9099');
    functions.useEmulator('localhost', 5001);
}

// STAGE B & C: Collection Configuration
const DB_CONFIG = {
    version: 'v2',
    collections: {
        matches: 'matches_v2',
        players: 'players_v2',
        geminiMeta: 'gemini_meta'
    }
};

let currentUser = null;
let selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
let allMatches = []; 
let playersRegistry = new Map(); // playerId -> { id, displayName, aliases, active }
let currentModalContext = null; // { teamKey, index, rawInput, candidates, top3 }
let activeTeamTarget = 'A'; // 'A' | 'B' | 'TournA' | 'TournB' | 'TournC'
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

// SORTING STATE
let currentSortCol = 'points';
let isSortDesc = true;

function safeText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }
function esc(value) { return (value ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeUrl(url) { return /^https?:\/\//i.test(url || '') ? url : ''; }

function getPlayerDisplayName(idOrName) {
    if (!idOrName) return '';
    if (playersRegistry.has(idOrName)) {
        return playersRegistry.get(idOrName).displayName;
    }
    for (const p of playersRegistry.values()) {
        if (p.displayName.toLowerCase() === idOrName.toLowerCase() || p.id === idOrName) {
            return p.displayName;
        }
    }
    return idOrName;
}

document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateAuthUI();
    });

    if(document.getElementById('filterYear')) document.getElementById('filterYear').addEventListener('change', renderData);
    if(document.getElementById('filterMonth')) document.getElementById('filterMonth').addEventListener('change', renderData);
    
    fetchPlayerNames();
    fetchMatches();
    
    const dDate = document.getElementById('matchDate');
    if(dDate) dDate.valueAsDate = new Date();
    
    setupEnterKeys();
    setupRosterSearch();
    setupGeminiKeyForm();

    const lb = document.getElementById('leaderboard-body');
    if(lb) lb.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-player]');
        if(row) window.openPlayerStats(row.dataset.player);
    });

    const disambiguateCreateBtn = document.getElementById('disambiguateCreateNewBtn');
    if(disambiguateCreateBtn) {
        disambiguateCreateBtn.addEventListener('click', () => {
            const modalEl = document.getElementById('disambiguateModal');
            if (modalEl) {
                const modal = bootstrap.Modal.getInstance(modalEl);
                if (modal) modal.hide();
            }
            if (currentModalContext) {
                openCreatePlayerModal(currentModalContext.item.rawInput, currentModalContext.teamKey, currentModalContext.index, currentModalContext.item.top3 || []);
            }
        });
    }

    const confirmCreateBtn = document.getElementById('confirmCreatePlayerBtn');
    if(confirmCreateBtn) {
        confirmCreateBtn.addEventListener('click', () => {
            const dispInput = document.getElementById('newPlayerDisplayName');
            const dispName = (dispInput ? dispInput.value : '').trim();
            if (!dispName) return alert('Display name is required.');

            const aliasInput = document.getElementById('newPlayerAliases');
            const aliasText = (aliasInput ? aliasInput.value : '').trim();
            const aliases = [dispName.toLowerCase()];
            if (aliasText) {
                aliasText.split(',').forEach(a => {
                    const clean = a.trim().toLowerCase();
                    if (clean && !aliases.includes(clean)) aliases.push(clean);
                });
            }

            const slug = dispName.toLowerCase()
                .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');

            const newPlayerId = slug || `player_${Date.now()}`;
            const newPlayer = {
                id: newPlayerId,
                displayName: dispName,
                aliases,
                active: true,
                isNew: true
            };

            playersRegistry.set(newPlayerId, newPlayer);

            if (currentModalContext) {
                const { teamKey, index, rawInput } = currentModalContext;
                const resolved = {
                    status: 'resolved',
                    id: newPlayerId,
                    displayName: dispName,
                    rawInput: rawInput || dispName,
                    isNew: true
                };
                if (index !== null && index !== undefined && selectedPlayers[teamKey] && selectedPlayers[teamKey][index]) {
                    selectedPlayers[teamKey][index] = resolved;
                } else if (teamKey && selectedPlayers[teamKey]) {
                    selectedPlayers[teamKey].push(resolved);
                }
                renderList(teamKey);
                renderRosterGrid();
            }

            const modalEl = document.getElementById('createPlayerModal');
            if (modalEl) {
                const modal = bootstrap.Modal.getInstance(modalEl);
                if (modal) modal.hide();
            }
        });
    }
});

function updateAuthUI() {
    const navEntry = document.getElementById('navNewEntry');
    const authBtn = document.querySelector('.auth-icon');
    
    if (currentUser) {
        if(navEntry) navEntry.classList.remove('d-none');
        if(authBtn) authBtn.classList.add('active');
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('userInfo').classList.remove('d-none');
        safeText('userEmailDisplay', currentUser.email);
    } else {
        if(navEntry) navEntry.classList.add('d-none');
        if(authBtn) authBtn.classList.remove('active');
        document.getElementById('loginForm').classList.remove('d-none');
        document.getElementById('userInfo').classList.add('d-none');
    }
    renderData(); 
}

function fetchMatches() {
    db.collection(DB_CONFIG.collections.matches).orderBy("date", "desc").onSnapshot(snap => {
        allMatches = [];
        let uniqueYears = new Set(); 

        snap.forEach(doc => {
            const data = doc.data();
            if (!data.date || typeof data.date.toDate !== 'function') {
                console.warn(`Skipping match ${doc.id}: missing or invalid date`);
                return;
            }
            allMatches.push({ id: doc.id, ...data });
            uniqueYears.add(data.date.toDate().getFullYear());
        });
        
        const yearSelect = document.getElementById('filterYear');
        if (yearSelect && uniqueYears.size > 0) {
            const currentSelected = yearSelect.value;
            const sortedYears = Array.from(uniqueYears).sort((a, b) => b - a);
            yearSelect.innerHTML = `<option value="all">All Time</option>` +
                sortedYears.map(year => `<option value="${year}">${year}</option>`).join('');
            yearSelect.value = (currentSelected === 'all' || sortedYears.includes(parseInt(currentSelected)))
                ? currentSelected : sortedYears[0];
        }
        renderData();
        renderRosterGrid();
    });
}

function matchesFilter(m, year, month) {
    const d = m.date.toDate();
    const yMatch = year === 'all' || d.getFullYear() === year;
    const mMatch = month === 'all' || d.getMonth() === parseInt(month);
    return yMatch && mMatch;
}

function formatDate(dateObj) {
    if (!dateObj) return "";
    const d = new Date(dateObj);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

// SORTING LOGIC
window.sortTable = (col) => {
    if (currentSortCol === col) {
        isSortDesc = !isSortDesc;
    } else {
        currentSortCol = col;
        isSortDesc = true;
        if(col === 'name') isSortDesc = false;
    }
    renderData();
};

function levenshteinDistance(a, b) {
    const an = a.length, bn = b.length;
    if (an === 0) return bn;
    if (bn === 0) return an;
    const matrix = [];
    for (let i = 0; i <= bn; i++) matrix[i] = [i];
    for (let j = 0; j <= an; j++) matrix[0][j] = j;
    for (let i = 1; i <= bn; i++) {
        for (let j = 1; j <= an; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1] + 1
                );
            }
        }
    }
    return matrix[bn][an];
}

function getCurrentlyPlacedPlayerIds(excludeTeam = null) {
    const placed = new Set();
    for (const [k, list] of Object.entries(selectedPlayers)) {
        if (k === excludeTeam) continue;
        for (const item of list) {
            if (item && item.status === 'resolved' && item.id) {
                placed.add(item.id);
            }
        }
    }
    return placed;
}

function getPlacedTeamForPlayer(playerId) {
    for (const [k, list] of Object.entries(selectedPlayers)) {
        for (const item of list) {
            if (item && item.status === 'resolved' && item.id === playerId) {
                return k;
            }
        }
    }
    return null;
}

function resolvePlayerInput(rawInput, teamKey) {
    if (!rawInput) return null;
    // Strip role annotations: (Ref), (Referee), (GK), (c), etc.
    let clean = rawInput.replace(/\s*\((?:ref|referee|gk|keeper|c|captain|sub)\)/gi, '').trim();
    if (!clean) clean = rawInput.trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();

    const placedIds = getCurrentlyPlacedPlayerIds(teamKey);
    const availablePlayers = Array.from(playersRegistry.values()).filter(p => !placedIds.has(p.id));

    // 1. Exact alias match (case-insensitive)
    const exactMatches = availablePlayers.filter(p => {
        const aliases = (p.aliases || []).map(a => a.toLowerCase());
        return aliases.includes(lower) || p.displayName.toLowerCase() === lower || p.id.toLowerCase() === lower;
    });

    if (exactMatches.length === 1) {
        return {
            status: 'resolved',
            id: exactMatches[0].id,
            displayName: exactMatches[0].displayName,
            rawInput: clean
        };
    } else if (exactMatches.length > 1) {
        return {
            status: 'red',
            rawInput: clean,
            candidates: exactMatches.map(p => ({ id: p.id, displayName: p.displayName }))
        };
    }

    // 2. Initial / Nickname matching (e.g. "Dani G" -> Daniel Gomez, "Dani M" -> Daniel Müller)
    const nameTokens = lower.split(/\s+/).filter(Boolean);
    if (nameTokens.length === 2 && nameTokens[1].length <= 2) {
        const firstPrefix = nameTokens[0];
        const lastInitial = nameTokens[1].charAt(0);

        const initialMatches = availablePlayers.filter(p => {
            const pParts = p.displayName.toLowerCase().split(/\s+/).filter(Boolean);
            if (pParts.length < 2) return false;
            const pFirst = pParts[0];
            const pLast = pParts[pParts.length - 1];
            return (pFirst.startsWith(firstPrefix) || firstPrefix.startsWith(pFirst)) && pLast.startsWith(lastInitial);
        });

        if (initialMatches.length === 1) {
            return {
                status: 'resolved',
                id: initialMatches[0].id,
                displayName: initialMatches[0].displayName,
                rawInput: clean
            };
        } else if (initialMatches.length > 1) {
            return {
                status: 'amber',
                rawInput: clean,
                candidate: { id: initialMatches[0].id, displayName: initialMatches[0].displayName },
                candidates: initialMatches.map(p => ({ id: p.id, displayName: p.displayName })),
                top3: initialMatches.slice(0, 3).map(p => ({ id: p.id, displayName: p.displayName }))
            };
        }
    }

    // 3. Fuzzy match against available players
    const candidateDistances = [];
    for (const p of availablePlayers) {
        let minDist = Infinity;
        const allAliases = [p.displayName.toLowerCase(), p.id.toLowerCase(), ...(p.aliases || []).map(a => a.toLowerCase())];
        for (const a of allAliases) {
            // NEVER auto-snap a longer name to a shorter candidate
            if (lower.length > a.length + 2 && !a.startsWith(lower)) continue;
            const dist = levenshteinDistance(lower, a);
            if (dist < minDist) minDist = dist;
        }
        candidateDistances.push({ player: p, distance: minDist });
    }

    candidateDistances.sort((a, b) => a.distance - b.distance);
    const top3 = candidateDistances.slice(0, 3).map(c => ({ id: c.player.id, displayName: c.player.displayName }));
    const closeCandidates = candidateDistances.filter(c => c.distance <= 2);

    if (closeCandidates.length === 1) {
        return {
            status: 'amber',
            rawInput: clean,
            candidate: { id: closeCandidates[0].player.id, displayName: closeCandidates[0].player.displayName },
            top3
        };
    } else if (closeCandidates.length > 1) {
        return {
            status: 'red',
            rawInput: clean,
            candidates: closeCandidates.map(c => ({ id: c.player.id, displayName: c.player.displayName })),
            top3
        };
    } else {
        return {
            status: 'new',
            rawInput: clean,
            top3
        };
    }
}

/* ==========================================================================
   STAGE C: ROSTER GRID (TAP-TO-ADD CHIPS & ACTIVE TARGET)
   ========================================================================== */

window.setActiveTeamTarget = (target) => {
    activeTeamTarget = target;
    renderActiveTeamPills();
    renderRosterGrid();
};

function renderActiveTeamPills() {
    const container = document.getElementById('activeTeamTargetPills');
    if (!container) return;
    const isTourn = document.getElementById('typeTournament')?.checked;
    
    if (!isTourn) {
        if (!['A', 'B'].includes(activeTeamTarget)) activeTeamTarget = 'A';
        container.innerHTML = `
            <button type="button" class="btn btn-sm ${activeTeamTarget==='A'?'btn-primary':'btn-outline-primary'} py-0 px-2 fw-bold" onclick="setActiveTeamTarget('A')">+ Team A</button>
            <button type="button" class="btn btn-sm ${activeTeamTarget==='B'?'btn-danger':'btn-outline-danger'} py-0 px-2 fw-bold" onclick="setActiveTeamTarget('B')">+ Team B</button>
        `;
    } else {
        if (!['TournA', 'TournB', 'TournC'].includes(activeTeamTarget)) activeTeamTarget = 'TournA';
        container.innerHTML = `
            <button type="button" class="btn btn-sm ${activeTeamTarget==='TournA'?'btn-warning text-dark':'btn-outline-warning'} py-0 px-2 fw-bold" onclick="setActiveTeamTarget('TournA')">+ Yellow</button>
            <button type="button" class="btn btn-sm ${activeTeamTarget==='TournB'?'btn-primary':'btn-outline-primary'} py-0 px-2 fw-bold" onclick="setActiveTeamTarget('TournB')">+ Blue</button>
            <button type="button" class="btn btn-sm ${activeTeamTarget==='TournC'?'btn-danger':'btn-outline-danger'} py-0 px-2 fw-bold" onclick="setActiveTeamTarget('TournC')">+ Red</button>
        `;
    }
}

function setupRosterSearch() {
    const input = document.getElementById('rosterSearchInput');
    if (input) {
        input.addEventListener('input', () => {
            renderRosterGrid();
        });
    }
}

function renderRosterGrid() {
    const container = document.getElementById('rosterChipsContainer');
    if (!container) return;
    renderActiveTeamPills();

    const searchTerm = (document.getElementById('rosterSearchInput')?.value || '').trim().toLowerCase();

    // Compute player appearances to sort regulars first
    const appearanceCounts = new Map();
    allMatches.forEach(m => {
        (m.teams || []).forEach(t => {
            (t.players || []).forEach(p => {
                appearanceCounts.set(p, (appearanceCounts.get(p) || 0) + 1);
            });
        });
    });

    const allPlayers = Array.from(playersRegistry.values()).filter(p => p.active !== false);

    allPlayers.sort((a, b) => {
        const countA = appearanceCounts.get(a.id) || 0;
        const countB = appearanceCounts.get(b.id) || 0;
        if (countB !== countA) return countB - countA;
        return a.displayName.localeCompare(b.displayName);
    });

    const filtered = allPlayers.filter(p => {
        if (!searchTerm) return (appearanceCounts.get(p.id) || 0) >= 8; // Top ~26 regulars default
        const aliases = (p.aliases || []).join(' ').toLowerCase();
        return p.displayName.toLowerCase().includes(searchTerm) || p.id.toLowerCase().includes(searchTerm) || aliases.includes(searchTerm);
    });

    if (filtered.length === 0) {
        container.innerHTML = `<span class="small text-muted py-2">No players match "${esc(searchTerm)}". Use "+ Add player" box below for new names.</span>`;
        return;
    }

    container.innerHTML = filtered.map(p => {
        const placedTeam = getPlacedTeamForPlayer(p.id);
        let chipClass = '';
        let badge = '';

        if (placedTeam === 'A') { chipClass = 'placed-a'; badge = '<span class="badge bg-primary ms-1">A</span>'; }
        else if (placedTeam === 'B') { chipClass = 'placed-b'; badge = '<span class="badge bg-danger ms-1">B</span>'; }
        else if (placedTeam === 'TournA') { chipClass = 'placed-tourn-a'; badge = '<span class="badge bg-warning text-dark ms-1">Y</span>'; }
        else if (placedTeam === 'TournB') { chipClass = 'placed-tourn-b'; badge = '<span class="badge bg-primary ms-1">B</span>'; }
        else if (placedTeam === 'TournC') { chipClass = 'placed-tourn-c'; badge = '<span class="badge bg-danger ms-1">R</span>'; }

        return `
            <span class="roster-chip ${chipClass}" onclick="toggleRosterPlayer('${p.id}')" title="${esc(p.displayName)}">
                ${esc(p.displayName)}${badge}
            </span>
        `;
    }).join('');
}

window.toggleRosterPlayer = (playerId) => {
    const player = playersRegistry.get(playerId);
    if (!player) return;

    const placedTeam = getPlacedTeamForPlayer(playerId);
    if (placedTeam) {
        // Player is already on a team -> remove them
        removePlayer(placedTeam, playerId);
    } else {
        // Player is unplaced -> add to active target team
        const target = activeTeamTarget;
        selectedPlayers[target].push({
            status: 'resolved',
            id: player.id,
            displayName: player.displayName,
            rawInput: player.displayName
        });
        renderList(target);
    }
    renderRosterGrid();
};

/* ==========================================================================
   STAGE C: TOURNAMENT RANK BUTTONS (1st / 2nd / 3rd)
   ========================================================================== */

window.setTournRank = (teamKey, rank) => {
    const ptsMap = { 1: 3, 2: 1, 3: 0 };
    const pts = ptsMap[rank];
    
    const rankInput = document.getElementById(`rank${teamKey}`);
    const ptsInput = document.getElementById(`pts${teamKey}`);
    if (rankInput) rankInput.value = rank;
    if (ptsInput) ptsInput.value = pts;

    // Enforce uniqueness across TournA, TournB, TournC
    const allTournKeys = ['TournA', 'TournB', 'TournC'];
    const otherKeys = allTournKeys.filter(k => k !== teamKey);
    const usedRanks = [rank];

    otherKeys.forEach(k => {
        const otherRankInput = document.getElementById(`rank${k}`);
        if (otherRankInput && parseInt(otherRankInput.value) === rank) {
            const available = [1, 2, 3].filter(r => !usedRanks.includes(r));
            const newRank = available[0] || 3;
            usedRanks.push(newRank);
            otherRankInput.value = newRank;
            const otherPtsInput = document.getElementById(`pts${k}`);
            if (otherPtsInput) otherPtsInput.value = ptsMap[newRank];
        } else if (otherRankInput) {
            usedRanks.push(parseInt(otherRankInput.value));
        }
    });

    allTournKeys.forEach(k => {
        const rVal = parseInt(document.getElementById(`rank${k}`)?.value || '1');
        const grp = document.getElementById(`rankGroup${k}`);
        if (grp) {
            const btns = grp.querySelectorAll('button');
            const colorClass = k === 'TournA' ? 'btn-warning text-dark' : (k === 'TournB' ? 'btn-primary' : 'btn-danger');
            btns.forEach((btn, idx) => {
                const btnRank = idx + 1;
                if (btnRank === rVal) {
                    btn.className = `btn btn-sm ${colorClass} fw-bold py-0`;
                } else {
                    btn.className = `btn btn-sm btn-outline-secondary py-0`;
                }
            });
        }
    });
};

/* ==========================================================================
   STAGE C: GEMINI SETTINGS & CLOUD FUNCTIONS INTEGRATION
   ========================================================================== */

function setupGeminiKeyForm() {
    const form = document.getElementById('saveGeminiKeyForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!currentUser) return alert("Please log in as admin first.");

        const apiKeyInput = document.getElementById('inputGeminiApiKey');
        const apiKey = (apiKeyInput ? apiKeyInput.value : '').trim();
        if (!apiKey) return;

        const spinner = document.getElementById('saveKeySpinner');
        const btn = document.getElementById('saveGeminiKeyBtn');
        if (spinner) spinner.classList.remove('d-none');
        if (btn) btn.disabled = true;

        try {
            const setKeyFn = functions.httpsCallable('setGeminiKey');
            const res = await setKeyFn({ apiKey });
            if (res.data && res.data.ok) {
                alert(`✓ Gemini API key validated and saved successfully (ends in ...${res.data.last4}).`);
                if (apiKeyInput) apiKeyInput.value = '';
                openGeminiSettings();
            }
        } catch (err) {
            alert(`Error saving Gemini API key: ${err.message}`);
        } finally {
            if (spinner) spinner.classList.add('d-none');
            if (btn) btn.disabled = false;
        }
    });
}

window.openGeminiSettings = async () => {
    if (!currentUser) return;
    try {
        const docSnap = await db.collection('config').doc('gemini_meta').get();
        const maskedEl = document.getElementById('geminiKeyMasked');
        const lastUpEl = document.getElementById('geminiKeyLastUpdated');
        const modelSelect = document.getElementById('selectGeminiModel');

        if (docSnap.exists) {
            const data = docSnap.data();
            if (maskedEl) maskedEl.innerText = data.last4 ? `••••••••${data.last4}` : 'Not configured';
            if (lastUpEl) {
                const d = data.updatedAt ? data.updatedAt.toDate() : null;
                lastUpEl.innerText = d ? `Updated: ${formatDate(d)}` : '';
            }
            if (modelSelect && data.selectedModel) {
                modelSelect.value = data.selectedModel;
            }
        } else {
            if (maskedEl) maskedEl.innerText = 'Not configured';
            if (lastUpEl) lastUpEl.innerText = '';
        }
    } catch (err) {
        console.warn("Error reading gemini_meta:", err);
    }
};

window.testGeminiConnectionHandler = async () => {
    if (!currentUser) return alert("Please log in as admin first.");

    const spinner = document.getElementById('testConnSpinner');
    const icon = document.getElementById('testConnIcon');
    const btn = document.getElementById('testConnectionBtn');
    const resultDiv = document.getElementById('connResult');

    if (spinner) spinner.classList.remove('d-none');
    if (icon) icon.classList.add('d-none');
    if (btn) btn.disabled = true;
    if (resultDiv) resultDiv.classList.add('d-none');

    try {
        const testFn = functions.httpsCallable('testGeminiConnection');
        const res = await testFn();
        const data = res.data;

        if (data && data.ok) {
            if (resultDiv) {
                resultDiv.className = 'mb-3 p-2 rounded border border-success bg-success bg-opacity-10 small text-success';
                resultDiv.innerHTML = `<b>✓ Connection Successful</b> (${data.latencyMs} ms latency)<br>Retrieved ${data.models.length} generative models from Google AI Studio.`;
                resultDiv.classList.remove('d-none');
            }

            const modelSelect = document.getElementById('selectGeminiModel');
            if (modelSelect && data.models && data.models.length > 0) {
                const currentVal = modelSelect.value;
                modelSelect.innerHTML = data.models.map(m => `
                    <option value="${esc(m.id)}">${esc(m.displayName || m.id)}</option>
                `).join('');
                if (data.models.some(m => m.id === currentVal)) {
                    modelSelect.value = currentVal;
                }
            }
        }
    } catch (err) {
        if (resultDiv) {
            resultDiv.className = 'mb-3 p-2 rounded border border-danger bg-danger bg-opacity-10 small text-danger';
            resultDiv.innerHTML = `<b>Connection Failed:</b> ${esc(err.message)}`;
            resultDiv.classList.remove('d-none');
        }
    } finally {
        if (spinner) spinner.classList.add('d-none');
        if (icon) icon.classList.remove('d-none');
        if (btn) btn.disabled = false;
    }
};

window.onSelectModel = async (modelId) => {
    if (!currentUser || !modelId) return;
    try {
        const setModelFn = functions.httpsCallable('setGeminiModel');
        await setModelFn({ modelId });
    } catch (err) {
        console.warn("Failed to set model:", err);
    }
};

/* ==========================================================================
   STAGE C: AI MAGIC PASTE (LINEUP PARSER WITH REGEX FALLBACK)
   ========================================================================== */

window.parseMagicPaste = async () => {
    const text = document.getElementById('magicPaste').value.trim();
    if (!text) return alert("Please paste a WhatsApp message first.");

    const spinner = document.getElementById('magicPasteSpinner');
    const icon = document.getElementById('magicPasteIcon');
    const btn = document.getElementById('magicPasteBtn');
    const unparsedAlert = document.getElementById('unparsedAlert');
    const unparsedList = document.getElementById('unparsedList');

    if (spinner) spinner.classList.remove('d-none');
    if (icon) icon.classList.add('d-none');
    if (btn) btn.disabled = true;
    if (unparsedAlert) unparsedAlert.classList.add('d-none');

    window.cancelEditMode();

    try {
        // 1. Try Cloud Function AI Parser
        let parsed = null;
        try {
            const parseFn = functions.httpsCallable('parseLineup');
            const res = await parseFn({ rawText: text });
            parsed = res.data;
        } catch (aiErr) {
            console.warn("Cloud Function parseLineup unavailable or failed, falling back to local parser:", aiErr);
            parsed = fallbackLocalParser(text);
        }

        if (!parsed || !parsed.teams || parsed.teams.length < 2) {
            throw new Error("Could not parse match teams from the provided text.");
        }

        // 2. Set Date & Venue if found
        if (parsed.date) {
            const dateInput = document.getElementById('matchDate');
            if (dateInput) dateInput.value = parsed.date;
        }
        if (parsed.venue) {
            const locSelect = document.getElementById('matchLocation');
            if (locSelect) {
                const opts = Array.from(locSelect.options).map(o => o.value);
                if (opts.includes(parsed.venue)) locSelect.value = parsed.venue;
            }
        }

        // 3. Set Match Type
        const isTourn = parsed.matchType === 'Tournament' || parsed.teams.length >= 3;
        if (isTourn) {
            document.getElementById('typeTournament').click();
            const keys = ['TournA', 'TournB', 'TournC'];
            
            parsed.teams.slice(0, 3).forEach((t, i) => {
                const k = keys[i];
                const nameEl = document.getElementById(`name${k}`);
                if (nameEl) nameEl.value = t.name || (i === 0 ? 'Yellow' : (i === 1 ? 'Blue' : 'Red'));
                
                const rankVal = t.rank || (i + 1);
                setTournRank(k, rankVal);

                selectedPlayers[k] = [];
                (t.players || []).forEach(p => {
                    if (p.playerId && p.confidence >= 0.9 && playersRegistry.has(p.playerId)) {
                        selectedPlayers[k].push({
                            status: 'resolved',
                            id: p.playerId,
                            displayName: playersRegistry.get(p.playerId).displayName,
                            rawInput: p.rawName || playersRegistry.get(p.playerId).displayName
                        });
                    } else {
                        const resolved = resolvePlayerInput(p.rawName || p.playerId, k);
                        if (resolved) {
                            if (resolved.status === 'new') {
                                selectedPlayers[k].push({
                                    status: 'red',
                                    rawInput: p.rawName,
                                    candidates: resolved.top3,
                                    top3: resolved.top3
                                });
                            } else {
                                selectedPlayers[k].push(resolved);
                            }
                        }
                    }
                });
                renderList(k);
            });
        } else {
            document.getElementById('typeStandard').click();
            const tA = parsed.teams[0];
            const tB = parsed.teams[1];

            document.getElementById('nameTeamA').value = tA.name || 'Team A';
            document.getElementById('scoreA').value = tA.score !== null && tA.score !== undefined ? tA.score : 0;
            if (tA.color) {
                const rb = document.querySelector(`input[name="colorA"][value="${tA.color}"]`);
                if (rb) rb.checked = true;
            }

            selectedPlayers.A = [];
            (tA.players || []).forEach(p => {
                if (p.playerId && p.confidence >= 0.9 && playersRegistry.has(p.playerId)) {
                    selectedPlayers.A.push({
                        status: 'resolved',
                        id: p.playerId,
                        displayName: playersRegistry.get(p.playerId).displayName,
                        rawInput: p.rawName || playersRegistry.get(p.playerId).displayName
                    });
                } else {
                    const resolved = resolvePlayerInput(p.rawName || p.playerId, 'A');
                    if (resolved) {
                        if (resolved.status === 'new') {
                            selectedPlayers.A.push({ status: 'red', rawInput: p.rawName, candidates: resolved.top3, top3: resolved.top3 });
                        } else {
                            selectedPlayers.A.push(resolved);
                        }
                    }
                }
            });
            renderList('A');

            document.getElementById('nameTeamB').value = tB.name || 'Team B';
            document.getElementById('scoreB').value = tB.score !== null && tB.score !== undefined ? tB.score : 0;
            if (tB.color) {
                const rb = document.querySelector(`input[name="colorB"][value="${tB.color}"]`);
                if (rb) rb.checked = true;
            }

            selectedPlayers.B = [];
            (tB.players || []).forEach(p => {
                if (p.playerId && p.confidence >= 0.9 && playersRegistry.has(p.playerId)) {
                    selectedPlayers.B.push({
                        status: 'resolved',
                        id: p.playerId,
                        displayName: playersRegistry.get(p.playerId).displayName,
                        rawInput: p.rawName || playersRegistry.get(p.playerId).displayName
                    });
                } else {
                    const resolved = resolvePlayerInput(p.rawName || p.playerId, 'B');
                    if (resolved) {
                        if (resolved.status === 'new') {
                            selectedPlayers.B.push({ status: 'red', rawInput: p.rawName, candidates: resolved.top3, top3: resolved.top3 });
                        } else {
                            selectedPlayers.B.push(resolved);
                        }
                    }
                }
            });
            renderList('B');
        }

        // 4. Surface unparsed lines prominently
        if (parsed.unparsed && parsed.unparsed.length > 0 && unparsedAlert && unparsedList) {
            unparsedList.innerHTML = parsed.unparsed.map(l => `<li>${esc(l)}</li>`).join('');
            unparsedAlert.classList.remove('d-none');
        }

        renderRosterGrid();
        updateSaveButtonState();
    } catch (err) {
        alert(`Magic Paste failed: ${err.message}`);
    } finally {
        if (spinner) spinner.classList.add('d-none');
        if (icon) icon.classList.remove('d-none');
        if (btn) btn.disabled = false;
    }
};

function fallbackLocalParser(text) {
    const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const extractColor = (str) => {
        if (/🔴|🟥|\bred\b/i.test(str)) return 'red';
        if (/🔵|🟦|\bblue\b/i.test(str)) return 'blue';
        if (/🟡|🟨|\byellow\b/i.test(str)) return 'yellow';
        return null;
    };

    const cleanTeamName = (str) => {
        return str
            .replace(/\s*(?:in\s*)?(?:🔴|🟥|🔵|🟦|🟡|🟨|red|blue|yellow)\s*:?/gi, '')
            .replace(/:+$/, '')
            .trim();
    };

    const cleanPlayerToken = (p) => {
        return p.replace(/\s*\((?:ref|referee|gk|keeper|c|captain|sub)\)/gi, '').trim();
    };

    let outcomeScores = null;
    const remainingLines = [];

    for (const line of rawLines) {
        const outcomeMatch = line.match(/(.*?)(?:team\s*)?(?:won|beat|defeats?)\s*(\d+)\s*[-:]\s*(\d+)/i)
            || line.match(/^(\d+)\s*[-:]\s*(\d+)$/);
        if (outcomeMatch) {
            if (outcomeMatch[3]) {
                const winnerMention = (outcomeMatch[1] || '').toLowerCase();
                const scoreWin = parseInt(outcomeMatch[2]);
                const scoreLose = parseInt(outcomeMatch[3]);
                const winnerColor = extractColor(winnerMention) || (winnerMention.includes('red') ? 'red' : (winnerMention.includes('blue') ? 'blue' : null));
                outcomeScores = { winnerColor, scoreWin, scoreLose, rawLine: line };
            } else {
                outcomeScores = { scoreA: parseInt(outcomeMatch[1]), scoreB: parseInt(outcomeMatch[2]), rawLine: line };
            }
        } else {
            remainingLines.push(line);
        }
    }

    if (remainingLines.length >= 6) {
        let teams = [];
        for (let i = 0; i < 6; i += 2) {
            const h = remainingLines[i];
            const p = remainingLines[i+1] || '';
            const color = extractColor(h) || (i === 0 ? 'yellow' : (i === 1 ? 'blue' : 'red'));
            teams.push({
                name: cleanTeamName(h) || `Team ${i/2+1}`,
                color: color,
                score: null,
                rank: i / 2 + 1,
                players: p.split(',').map(cleanPlayerToken).filter(Boolean).map(n => ({ rawName: n, playerId: null, confidence: 0.5 }))
            });
        }
        return { matchType: 'Tournament', teams, unparsed: remainingLines.slice(6) };
    } else if (remainingLines.length >= 4) {
        const lineA = remainingLines[0];
        const playersA = (remainingLines[1] || '').split(',').map(cleanPlayerToken).filter(Boolean);
        const lineB = remainingLines[2];
        const playersB = (remainingLines[3] || '').split(',').map(cleanPlayerToken).filter(Boolean);

        const colorA = extractColor(lineA) || 'blue';
        const colorB = extractColor(lineB) || (colorA === 'blue' ? 'red' : 'blue');

        let scoreA = 0, scoreB = 0;
        if (outcomeScores) {
            if (outcomeScores.winnerColor) {
                if (colorA === outcomeScores.winnerColor) {
                    scoreA = outcomeScores.scoreWin;
                    scoreB = outcomeScores.scoreLose;
                } else {
                    scoreA = outcomeScores.scoreLose;
                    scoreB = outcomeScores.scoreWin;
                }
            } else if (outcomeScores.scoreA !== undefined) {
                scoreA = outcomeScores.scoreA;
                scoreB = outcomeScores.scoreB;
            }
        }

        return {
            matchType: 'Standard',
            teams: [
                {
                    name: cleanTeamName(lineA) || 'Team A',
                    color: colorA,
                    score: scoreA,
                    players: playersA.map(n => ({ rawName: n, playerId: null, confidence: 0.5 }))
                },
                {
                    name: cleanTeamName(lineB) || 'Team B',
                    color: colorB,
                    score: scoreB,
                    players: playersB.map(n => ({ rawName: n, playerId: null, confidence: 0.5 }))
                }
            ],
            unparsed: remainingLines.slice(4)
        };
    } else {
        return { matchType: 'Standard', teams: [], unparsed: rawLines };
    }
}

/* ==========================================================================
   STATISTICS ENGINE (STAGE C: GOALS FIX FOR TOURNAMENTS)
   ========================================================================== */

function processTeamStats(stats, playerArr, gf, ga, pts, isStandard = false) {
    if(!playerArr) return; 
    playerArr.forEach(idOrName => {
        const displayName = getPlayerDisplayName(idOrName);
        const key = idOrName;
        if(!stats[key]) {
            stats[key] = { 
                id: key, 
                name: displayName, 
                played: 0, 
                standardPlayed: 0, 
                won: 0, 
                drawn: 0, 
                lost: 0, 
                gf: 0, 
                ga: 0, 
                gd: 0, 
                points: 0, 
                form: [] 
            };
        }
        stats[key].played++; 
        stats[key].points += pts;

        if (isStandard) {
            stats[key].standardPlayed++;
            stats[key].gf += gf;
            stats[key].ga += ga;
            stats[key].gd = stats[key].gf - stats[key].ga;
        }
        
        if(pts >= 3) stats[key].won++; 
        else if(pts === 1) stats[key].drawn++; 
        else if(pts === 0) stats[key].lost++;
    });
}

function renderData() {
    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const year = fYear ? (fYear.value === 'all' ? 'all' : parseInt(fYear.value)) : 2026;
    const month = fMonth ? fMonth.value : 'all';

    const filtered = allMatches.filter(m => matchesFilter(m, year, month));

    const list = document.getElementById('match-history-list');
    if(list) {
        list.innerHTML = "";
        
        if(filtered.length === 0) {
            list.innerHTML = "<div class='text-center py-5 text-muted small'>No matches found.</div>";
        } else {
            filtered.forEach(m => {
                const dateStr = formatDate(m.date.toDate());
                let adminBtns = "";
                if (currentUser && currentUser.email.toLowerCase() === SUPER_ADMIN.toLowerCase()) {
                    adminBtns = `<div class="admin-actions">
                        <button class="btn btn-sm btn-outline-light border-secondary py-0 me-2" onclick="editMatch('${m.id}', event)">Edit</button> 
                        <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteMatch('${m.id}', event)">Delete</button>
                    </div>`;
                }
                const ytLink = m.youtubeLink ? `<a href="${esc(safeUrl(m.youtubeLink))}" target="_blank" onclick="event.stopPropagation()" style="color:#fa7970; text-decoration:none; font-size:0.75rem; font-weight:600;"><i class="fab fa-youtube"></i> Watch</a>` : '';

                let html = "";
                if(m.type === 'Standard') {
                    const tA=m.teams[0], tB=m.teams[1];
                    const cA=m.colors?.[0]||'blue', cB=m.colors?.[1]||'red';
                    const winA = tA.score > tB.score ? 'text-white' : 't-loser';
                    const winB = tB.score > tA.score ? 'text-white' : 't-loser';
                    const pA = esc((tA.players||[]).map(p => getPlayerDisplayName(p)).join(', '));
                    const pB = esc((tB.players||[]).map(p => getPlayerDisplayName(p)).join(', '));

                    html = `
                    <div class="match-card" onclick="openMatchModal('${m.id}')">
                        <div class="card-top"><span><i class="far fa-calendar me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${esc(m.location)}</span> ${ytLink}</div>
                        <div class="card-body-strip">
                            <div class="team-block">
                                <div class="team-row mb-2"><div class="t-name ${winA}"><span class="dot bg-${cA.charAt(0)}"></span>${esc(tA.teamName||'A')}</div><div class="t-score ${winA}">${tA.score}</div></div>
                                <div class="team-players text-muted small" style="font-size:0.75rem">${pA}</div>
                            </div>
                            <div class="match-meta"><span class="ft-badge">FT</span></div>
                            <div class="team-block text-end">
                                <div class="team-row mb-2 justify-content-end"><div class="t-score ${winB} me-2">${tB.score}</div><div class="t-name justify-content-end ${winB}">${esc(tB.teamName||'B')}<span class="dot bg-${cB.charAt(0)} ms-2"></span></div></div>
                                <div class="team-players text-end text-muted small" style="font-size:0.75rem">${pB}</div>
                            </div>
                        </div>
                        ${adminBtns}
                    </div>`;
                } else {
                    const r1 = m.teams.find(t=>t.rank===1)||m.teams[0];
                    const r2 = m.teams.find(t=>t.rank===2)||m.teams[1];
                    const r3 = m.teams.find(t=>t.rank===3)||m.teams[2];
                    
                    const getCol = (t) => { 
                        if (t.originalKey === 'A') return 'y';
                        if (t.originalKey === 'B') return 'b';
                        if (t.originalKey === 'C') return 'r';
                        const idx = m.teams.indexOf(t); return idx === 0 ? 'y' : (idx === 1 ? 'b' : 'r'); 
                    };
                    
                    const pts1 = r1.points !== undefined ? `${r1.points} pts` : '';
                    const pts2 = r2.points !== undefined ? `${r2.points} pts` : '';
                    const pts3 = r3.points !== undefined ? `${r3.points} pts` : '';

                    html = `
                    <div class="match-card" onclick="openMatchModal('${m.id}')" style="border-left: 3px solid #ffea00;">
                        <div class="card-top"><span><i class="fas fa-trophy text-warning me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${esc(m.location)}</span> ${ytLink}</div>
                        <div class="p-3 bg-card">
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-white fw-bold"><span class="rank-badge rank-1">1</span> <span class="dot bg-${getCol(r1)}"></span> ${esc(r1.teamName)} <span class="text-warning ms-1" style="font-size:0.75rem">${pts1}</span></span></div><div style="font-size:0.75rem; color:#8b949e; margin-left:32px">${esc((r1.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted"><span class="rank-badge bg-secondary">2</span> <span class="dot bg-${getCol(r2)}"></span> ${esc(r2.teamName)} <span class="text-muted ms-1" style="font-size:0.75rem">${pts2}</span></span></div><div style="font-size:0.75rem; color:#666; margin-left:32px">${esc((r2.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted opacity-50"><span class="rank-badge bg-secondary">3</span> <span class="dot bg-${getCol(r3)}"></span> ${esc(r3.teamName)} <span class="text-muted opacity-50 ms-1" style="font-size:0.75rem">${pts3}</span></span></div><div style="font-size:0.75rem; color:#555; margin-left:32px">${esc((r3.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</div></div>
                        </div>
                        ${adminBtns}
                    </div>`;
                }
                list.innerHTML += html;
            });
        }
    }

    let stats = {};
    filtered.forEach(m => {
        if (!m.teams || m.teams.length < 2) return; 

        if(m.type === 'Standard') {
            const tA=m.teams[0], tB=m.teams[1];
            const ptsA = tA.score > tB.score ? 3 : (tA.score == tB.score ? 1 : 0);
            const ptsB = tB.score > tA.score ? 3 : (tB.score == tA.score ? 1 : 0);
            processTeamStats(stats, tA.players||[], tA.score, tB.score, ptsA, true);
            processTeamStats(stats, tB.players||[], tB.score, tA.score, ptsB, true);
        } else {
            m.teams.forEach(t => {
                const pts = t.points !== undefined ? t.points : (t.rank===1 ? 3 : (t.rank===2 ? 1 : 0));
                processTeamStats(stats, t.players||[], 0, 0, pts, false);
            });
        }
    });

    const tbody = document.getElementById('leaderboard-body');
    if(tbody) {
        tbody.innerHTML = "";
        
        const players = Object.values(stats).sort((a,b) => {
            let valA = a[currentSortCol];
            let valB = b[currentSortCol];
            
            if(currentSortCol === 'ppg') { valA = a.points/a.played; valB = b.points/b.played; }
            if(currentSortCol === 'name') {
                return isSortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
            }
            
            if (valA === valB) return b.won - a.won;
            return isSortDesc ? valB - valA : valA - valB;
        });

        if(players.length === 0) tbody.innerHTML = "<tr><td colspan='8' class='text-center py-4 text-muted small'>No stats available.</td></tr>";

        const MIN_APPEARANCES = 10;
        const qualified = players.filter(p => p.played >= MIN_APPEARANCES);
        const unqualified = players.filter(p => p.played < MIN_APPEARANCES);

        const rowHtml = (p, rankLabel, i, greyed) => {
            const ppg = (p.points / p.played).toFixed(2);
            const rowClass = (greyed ? 'text-muted opacity-50 ' : '') + (i%2===0 ? "" : "bg-white bg-opacity-5");
            const isGoldRank = !greyed && i===0 && currentSortCol==='points' && isSortDesc;
            return `<tr data-player="${esc(p.id || p.name)}" style="cursor:pointer" class="${rowClass}">
                <td class="ps-3 fw-bold text-start"><span class="rank-circle ${isGoldRank?'r-1':''}">${rankLabel}</span></td>
                <td class="fw-bold text-start ${greyed ? '' : 'text-light'}">${esc(p.name)}</td>
                <td>${p.played}</td>
                <td>${p.won}</td>
                <td>${p.drawn}</td>
                <td>${p.lost}</td>
                <td class="${greyed ? '' : 'fw-bold text-white'}">${p.points}</td>
                <td class="pe-3 ${greyed ? '' : 'fw-bold text-info'}">${ppg}</td>
            </tr>`;
        };

        qualified.forEach((p, i) => { tbody.innerHTML += rowHtml(p, i + 1, i, false); });

        if(unqualified.length) {
            tbody.innerHTML += `<tr><td colspan="8" class="text-center text-muted small py-2 border-top border-secondary" style="letter-spacing:1px">FEWER THAN ${MIN_APPEARANCES} APPEARANCES</td></tr>`;
            unqualified.forEach((p, i) => { tbody.innerHTML += rowHtml(p, '-', i, true); });
        }
    }

    generateInsights(filtered);
}

function getCombinations(arr, k) {
    let result = [];
    function combine(start, combo) {
        if (combo.length === k) { result.push([...combo]); return; }
        for (let i = start; i < arr.length; i++) {
            combo.push(arr[i]); combine(i + 1, combo); combo.pop();
        }
    }
    combine(0, []);
    return result;
}

function generateInsights(matches) {
    let duos = {}, trios = {}, fullTeams = {};
    let colorStats = { 'yellow': {p:0, w:0}, 'blue': {p:0, w:0}, 'red': {p:0, w:0} };
    
    let venueGoals = {};
    let biggestBlowout = null;
    let highestScoring = null;
    let draws = 0;

    matches.forEach(m => {
        if (!m.teams || m.teams.length < 2) return;

        if (m.type === 'Standard') {
            const tA = m.teams[0], tB = m.teams[1];
            const total = (tA.score||0) + (tB.score||0);
            const margin = Math.abs((tA.score||0) - (tB.score||0));

            if(!venueGoals[m.location]) venueGoals[m.location] = {games:0, goals:0};
            venueGoals[m.location].games++;
            venueGoals[m.location].goals += total;

            if(tA.score === tB.score) draws++;
            if(!highestScoring || total > highestScoring.total) highestScoring = {total, m};
            if(!biggestBlowout || margin > biggestBlowout.margin) biggestBlowout = {margin, m};
        }

        m.teams.forEach(t => {
            let isWin = false;
            let pts = 0;
            if(m.type === 'Standard') {
                const opp = m.teams.find(other => other !== t);
                if(t.score > opp.score) { isWin = true; pts = 3; }
                else if(t.score === opp.score) { pts = 1; }
            } else {
                pts = t.points !== undefined ? t.points : (t.rank===1 ? 3 : (t.rank===2 ? 1 : 0));
                if(pts >= 3) isWin = true;
            }

            let color = '';
            if (m.type === 'Standard') {
                color = t === m.teams[0] ? (m.colors?.[0]||'blue') : (m.colors?.[1]||'red');
            } else {
                color = t.originalKey === 'A' ? 'yellow' : (t.originalKey === 'B' ? 'blue' : 'red');
            }
            if(colorStats[color]) {
                colorStats[color].p++;
                if(isWin) colorStats[color].w++;
            }

            const cleanPlayers = (t.players||[]).map(p => getPlayerDisplayName(p)).sort();
            
            if (cleanPlayers.length >= 2) {
                getCombinations(cleanPlayers, 2).forEach(pair => {
                    const key = pair.join(" & ");
                    if(!duos[key]) duos[key] = {p:0, w:0, pts:0};
                    duos[key].p++; duos[key].pts += pts;
                    if(isWin) duos[key].w++;
                });
            }

            if (cleanPlayers.length >= 3) {
                getCombinations(cleanPlayers, 3).forEach(trio => {
                    const key = trio.join(", ");
                    if(!trios[key]) trios[key] = {p:0, w:0, pts:0};
                    trios[key].p++; trios[key].pts += pts;
                    if(isWin) trios[key].w++;
                });
            }

            if (cleanPlayers.length >= 4) {
                const key = cleanPlayers.join(", ");
                if(!fullTeams[key]) fullTeams[key] = {p:0, w:0, pts:0};
                fullTeams[key].p++; fullTeams[key].pts += pts;
                if(isWin) fullTeams[key].w++;
            }
        });
    });

    const calcInsights = (recordObj, minGames) => {
        let bestWR = null, worstWR = null, mostPlayed = null;
        Object.entries(recordObj).forEach(([names, data]) => {
            const wr = (data.w / data.p) * 100;
            const ppg = data.pts / data.p;
            const item = { names, ...data, wr, ppg };

            if(data.p >= minGames) {
                if(!bestWR || wr > bestWR.wr || (wr === bestWR.wr && data.p > bestWR.p)) bestWR = item;
                if(!worstWR || wr < worstWR.wr || (wr === worstWR.wr && data.p > worstWR.p)) worstWR = item;
            }
            if(!mostPlayed || data.p > mostPlayed.p) mostPlayed = item;
        });
        return { bestWR, worstWR, mostPlayed };
    };

    const duoStats = calcInsights(duos, 4);
    const trioStats = calcInsights(trios, 3);
    const fullTeamStats = calcInsights(fullTeams, 2);

    const formatCard = (title, icon, data, type="wr") => {
        if(!data) return `<div class="col-12 col-md-4 mb-3"><div class="card bg-dark border-secondary p-3 h-100"><div class="text-muted small fw-bold">${title}</div><div class="small text-muted my-2">Not enough matches yet</div></div></div>`;
        
        let statDisplay = "";
        if (type === "wr") {
            statDisplay = `<div class="fs-4 fw-bold text-success">${Math.round(data.wr)}% <span class="fs-6 text-muted font-monospace">(${data.w}W/${data.p}P)</span></div>`;
        } else if (type === "worst") {
            statDisplay = `<div class="fs-4 fw-bold text-danger">${Math.round(data.wr)}% <span class="fs-6 text-muted font-monospace">(${data.w}W/${data.p}P)</span></div>`;
        } else {
            statDisplay = `<div class="fs-4 fw-bold text-info">${data.p} <span class="fs-6 text-muted">Matches</span></div><div class="small text-muted">${data.w} Wins (${Math.round(data.wr)}% WR)</div>`;
        }

        return `
        <div class="col-12 col-md-4 mb-3">
            <div class="card bg-dark border-secondary p-3 h-100">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="text-muted small fw-bold" style="letter-spacing:0.5px">${title}</span>
                    <i class="${icon} text-warning opacity-75"></i>
                </div>
                <div class="fw-bold text-white small mb-1 text-truncate" title="${esc(data.names)}">${esc(data.names)}</div>
                ${statDisplay}
            </div>
        </div>`;
    };

    let venueCards = Object.entries(venueGoals).map(([v, d]) => {
        const avg = (d.goals / d.games).toFixed(1);
        return `<div class="col-6 col-md-3 mb-2"><div class="bg-dark border border-secondary rounded p-2 text-center"><div class="text-white small fw-bold text-truncate">${esc(v)}</div><div class="fs-5 fw-bold text-info my-1">${avg}</div><small class="text-muted" style="font-size:0.65rem">${d.goals} Goals / ${d.games} Games</small></div></div>`;
    }).join('');

    const insightsContainer = document.getElementById('insightsContainer');
    if(!insightsContainer) return;

    insightsContainer.innerHTML = `
        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-user-friends text-primary me-2"></i>DUOS & COMBOS</h6>
        <div class="row mb-3">
            ${formatCard("DEADLIEST DUO (MIN 4P)", "fas fa-skull-crossbones", duoStats.bestWR, "wr")}
            ${formatCard("WORST DUO (MIN 4P)", "fas fa-heart-broken", duoStats.worstWR, "worst")}
            ${formatCard("MOST FREQUENT DUO", "fas fa-link", duoStats.mostPlayed, "played")}
        </div>

        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-users text-warning me-2"></i>TRIOS</h6>
        <div class="row mb-3">
            ${formatCard("BEST TRIO (MIN 3P)", "fas fa-crown", trioStats.bestWR, "wr")}
            ${formatCard("WORST TRIO (MIN 3P)", "fas fa-poo", trioStats.worstWR, "worst")}
            ${formatCard("MOST FREQUENT TRIO", "fas fa-fire", trioStats.mostPlayed, "played")}
        </div>

        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-shield-alt text-info me-2"></i>FULL SQUADS</h6>
        <div class="row mb-4">
            ${formatCard("BEST RECURRING SQUAD", "fas fa-award", fullTeamStats.bestWR, "wr")}
            ${formatCard("MOST FREQUENT SQUAD", "fas fa-history", fullTeamStats.mostPlayed, "played")}
        </div>

        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-map-marker-alt text-danger me-2"></i>VENUE GOAL AVERAGES (STANDARD MATCHES ONLY)</h6>
        <div class="row mb-4">${venueCards || '<div class="small text-muted">No venue goal stats.</div>'}</div>
    `;
}

window.openPlayerStats = (targetIdOrName) => {
    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const year = fYear ? (fYear.value === 'all' ? 'all' : parseInt(fYear.value)) : 2026;
    const month = fMonth ? fMonth.value : 'all';

    const matchesPlayer = (p) => {
        if (!p) return false;
        if (p === targetIdOrName) return true;
        if (playersRegistry.has(targetIdOrName)) {
            const reg = playersRegistry.get(targetIdOrName);
            if (p === reg.id || p.toLowerCase() === reg.displayName.toLowerCase()) return true;
            if ((reg.aliases || []).map(a => a.toLowerCase()).includes(p.toLowerCase())) return true;
        }
        return p.toLowerCase() === targetIdOrName.toLowerCase();
    };

    const pMatches = allMatches.filter(m => matchesFilter(m, year, month)).filter(m => 
        (m.teams||[]).some(t => (t.players||[]).some(matchesPlayer))
    );

    if(pMatches.length === 0) return;

    let w=0, played=0, standardPlayed=0, pts=0, totalGF=0, totalGA=0;
    let monthly = {}, recentForm = [];
    let teammates = {};
    let colorStats = { 'yellow': {p:0, w:0}, 'blue': {p:0, w:0}, 'red': {p:0, w:0} };
    let venueStats = {};

    pMatches.forEach(m => {
        played++;
        const monthIdx = m.date.toDate().getMonth();
        if(!monthly[monthIdx]) monthly[monthIdx] = {p:0, w:0, pts:0};
        
        let matchPts=0, result='L', matchGF=0, matchGA=0, myColor='';
        let myTeamMates = [];

        if(m.type==='Standard') {
            standardPlayed++;
            const tA=m.teams[0]; const inA=(tA.players||[]).some(matchesPlayer);
            const myS=inA?tA.score:m.teams[1].score;
            const opS=inA?m.teams[1].score:tA.score;
            matchGF = myS; matchGA = opS;
            myColor = inA ? (m.colors?.[0]||'blue') : (m.colors?.[1]||'red');
            myTeamMates = inA ? tA.players : m.teams[1].players;
            
            if(myS>opS) {w++; matchPts=3; result='W';} else if(myS==opS) {matchPts=1; result='D';}
        } else {
            const myTeam = m.teams.find(t=>(t.players||[]).some(matchesPlayer));
            myTeamMates = myTeam.players || [];
            matchPts = myTeam.points !== undefined ? myTeam.points : (myTeam.rank===1 ? 3 : (myTeam.rank===2 ? 1 : 0));
            
            let ogKey = myTeam.originalKey || ''; 
            if(ogKey) myColor = ogKey === 'A' ? 'yellow' : (ogKey === 'B' ? 'blue' : 'red');
            else myColor = (myTeam.teamName||'').toLowerCase().includes('y') ? 'yellow' : ((myTeam.teamName||'').toLowerCase().includes('b') ? 'blue' : 'red');

            if(matchPts >= 3) {w++; result='W';} else if(matchPts === 1) {result='D';} else {result='L';}
        }

        myTeamMates.forEach(mate => {
            if(!matchesPlayer(mate)) {
                const mateName = getPlayerDisplayName(mate);
                if(!teammates[mateName]) teammates[mateName] = {p:0, w:0};
                teammates[mateName].p++;
                if(result === 'W') teammates[mateName].w++;
            }
        });

        if(colorStats[myColor]) {
            colorStats[myColor].p++;
            if(result === 'W') colorStats[myColor].w++;
        }

        if(!venueStats[m.location]) venueStats[m.location] = {p:0, w:0};
        venueStats[m.location].p++;
        if(result === 'W') venueStats[m.location].w++;

        pts += matchPts; totalGF += matchGF; totalGA += matchGA;
        monthly[monthIdx].p++; monthly[monthIdx].pts += matchPts; if(result==='W') monthly[monthIdx].w++;
        if(recentForm.length < 5) recentForm.push(result);
    });

    const winRate = Math.round((w/played)*100);
    const goalsPerGame = standardPlayed > 0 ? (totalGF / standardPlayed).toFixed(2) : '0.00';
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    
    const formDisplay = recentForm.reverse().map(r => r==='W' ? '<i class="fas fa-check text-success mx-1"></i>' : (r==='D' ? '<i class="far fa-circle text-warning mx-1"></i>' : '<i class="fas fa-times text-danger mx-1"></i>')).join('');

    let monthRows = "";
    Object.keys(monthly).sort((a,b)=>a-b).forEach(mIdx => {
        const d = monthly[mIdx];
        monthRows += `<div class="d-flex justify-content-between py-2 border-bottom border-secondary small"><div style="width:40px" class="text-muted">${months[mIdx]}</div><div style="width:30px" class="text-center">${d.p}</div><div style="width:30px" class="text-center">${d.w}</div><div style="width:30px" class="text-center fw-bold text-white">${d.pts}</div></div>`;
    });

    const topMates = Object.entries(teammates).sort((a,b) => b[1].p - a[1].p || b[1].w - a[1].w).slice(0,3);
    let matesHtml = topMates.map(t => `<div class="d-flex justify-content-between small text-muted mb-1 border-bottom border-secondary pb-1"><span><i class="fas fa-user-friends me-2 opacity-50"></i>${esc(t[0])}</span><span class="text-white">${t[1].p} Matches <span class="ms-1 text-success">(${Math.round(t[1].w/t[1].p*100)}% W)</span></span></div>`).join('');
    if(!matesHtml) matesHtml = "<div class='small text-muted'>Not enough data yet.</div>";

    const colMap = { 'yellow': 'text-warning', 'blue': 'text-primary', 'red': 'text-danger' };
    let colorsHtml = Object.entries(colorStats).filter(c => c[1].p > 0).sort((a,b) => b[1].w/b[1].p - a[1].w/a[1].p).map(c => {
        const wr = Math.round(c[1].w/c[1].p * 100);
        return `<div class="col p-1"><div class="border border-secondary rounded p-2 text-center bg-dark"><div class="fw-bold ${colMap[c[0]]} small">${c[0].toUpperCase()}</div><div class="fw-bold text-white fs-6">${wr}%</div><div style="font-size:0.6rem" class="text-muted mt-1">${c[1].w}W - ${c[1].p}P</div></div></div>`;
    }).join('');

    let venuesHtml = Object.entries(venueStats).filter(v => v[1].p > 0).sort((a,b) => (b[1].w/b[1].p) - (a[1].w/a[1].p)).map(v => {
        const wr = Math.round(v[1].w/v[1].p * 100);
        return `<div class="d-flex justify-content-between small text-muted mb-1 border-bottom border-secondary pb-1"><span>${esc(v[0])}</span><span class="text-white">${wr}% <span class="text-muted">(${v[1].w}W-${v[1].p}P)</span></span></div>`;
    }).join('');
    if(!venuesHtml) venuesHtml = "<div class='small text-muted'>Not enough data yet.</div>";

    const displayName = getPlayerDisplayName(targetIdOrName);
    safeText('psName', displayName.toUpperCase());
    const psBody = document.getElementById('psBody');
    if(psBody) {
        psBody.innerHTML = `
        <div class="text-center mb-3"><div class="mb-2 text-muted small" style="letter-spacing:1px">CURRENT FORM</div><div class="fs-5">${formDisplay}</div></div>
        <div class="row text-center mb-3 g-0 border border-secondary rounded overflow-hidden shadow-sm">
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${played}</div><small class="text-muted" style="font-size:0.6rem">PLAYED</small></div>
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${w}</div><small class="text-muted" style="font-size:0.6rem">WON</small></div>
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${winRate}%</div><small class="text-muted" style="font-size:0.6rem">RATE</small></div>
            <div class="col-3 bg-dark p-2"><div class="fw-bold text-info">${goalsPerGame}</div><small class="text-muted" style="font-size:0.6rem">G/G (STD)</small></div>
        </div>
        <div class="mb-3 p-2 rounded bg-body border border-secondary small text-muted">
            <div class="d-flex justify-content-between"><span>Goals (Standard Matches Only):</span><span class="text-white fw-bold">${totalGF} GF / ${totalGA} GA (GD: ${totalGF - totalGA})</span></div>
            <div class="d-flex justify-content-between mt-1"><span>Standard Matches:</span><span class="text-white">${standardPlayed}</span></div>
        </div>
        <h6 class="small fw-bold text-muted mb-2">WIN RATE BY COLOR</h6>
        <div class="row g-1 mb-4">${colorsHtml}</div>
        <h6 class="small fw-bold text-muted mb-2">WIN RATE BY VENUE</h6>
        <div class="bg-dark p-2 rounded border border-secondary mb-4">${venuesHtml}</div>
        <h6 class="small fw-bold text-muted mb-2">MOST PLAYED WITH</h6>
        <div class="bg-dark p-2 rounded border border-secondary mb-4">${matesHtml}</div>
        <h6 class="small fw-bold text-muted border-bottom border-secondary pb-2 mb-0">MONTHLY BREAKDOWN</h6>
        <div class="d-flex justify-content-between py-1 text-muted small" style="font-size:0.7rem"><div style="width:40px">MO</div><div class="text-center" style="width:30px">P</div><div class="text-center" style="width:30px">W</div><div class="text-center" style="width:30px">PTS</div></div>
        ${monthRows}`;
    }
    const modalEl = document.getElementById('playerStatsModal');
    if(modalEl) new bootstrap.Modal(modalEl).show();
};

function updateSaveButtonState() {
    const saveBtn = document.getElementById('saveBtn');
    if (!saveBtn) return;
    const isTourn = document.getElementById('typeTournament')?.checked;
    const activeTeams = isTourn ? ['TournA', 'TournB', 'TournC'] : ['A', 'B'];

    let hasUnresolved = false;
    let hasEmpty = false;

    for (const k of activeTeams) {
        const list = selectedPlayers[k] || [];
        if (list.length === 0) hasEmpty = true;
        for (const item of list) {
            if (item.status !== 'resolved') {
                hasUnresolved = true;
                break;
            }
        }
    }

    if (hasUnresolved || hasEmpty) {
        saveBtn.disabled = true;
        saveBtn.classList.add('opacity-50');
        saveBtn.style.cursor = 'not-allowed';
        if (hasUnresolved) {
            saveBtn.title = 'Please resolve all player chips (confirm amber / select red) before saving.';
        } else {
            saveBtn.title = 'Please add players to all teams.';
        }
    } else {
        saveBtn.disabled = false;
        saveBtn.classList.remove('opacity-50');
        saveBtn.style.cursor = 'pointer';
        saveBtn.title = '';
    }
}

window.confirmAmberChip = (k, idx) => {
    const item = selectedPlayers[k][idx];
    if (!item || item.status !== 'amber') return;
    selectedPlayers[k][idx] = {
        status: 'resolved',
        id: item.candidate.id,
        displayName: item.candidate.displayName,
        rawInput: item.rawInput
    };
    renderList(k);
    renderRosterGrid();
};

window.openDisambiguateModal = (k, idx) => {
    const item = selectedPlayers[k][idx];
    if (!item) return;
    currentModalContext = { teamKey: k, index: idx, item };

    safeText('disambiguatePrompt', `Multiple player matches found for "${item.rawInput}". Tap one to select:`);
    const container = document.getElementById('disambiguateCandidates');
    if (container) {
        const candidates = item.candidates || item.top3 || [];
        container.innerHTML = candidates.map(c => `
            <button type="button" class="btn btn-outline-light text-start py-2 px-3 fw-bold" onclick="selectDisambiguatedPlayer('${c.id}')">
                <i class="fas fa-user me-2 text-warning"></i>${esc(c.displayName)} <small class="text-muted opacity-75">(${esc(c.id)})</small>
            </button>
        `).join('');
    }

    const modalEl = document.getElementById('disambiguateModal');
    if (modalEl) new bootstrap.Modal(modalEl).show();
};

window.selectDisambiguatedPlayer = (playerId) => {
    if (!currentModalContext) return;
    const { teamKey, index, item } = currentModalContext;
    const player = playersRegistry.get(playerId);
    if (!player) return;

    selectedPlayers[teamKey][index] = {
        status: 'resolved',
        id: player.id,
        displayName: player.displayName,
        rawInput: item.rawInput
    };
    renderList(teamKey);
    renderRosterGrid();

    const modalEl = document.getElementById('disambiguateModal');
    if (modalEl) {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
    }
};

window.openCreatePlayerModal = (rawInput, teamKey, index = null, top3 = []) => {
    currentModalContext = { teamKey, index, rawInput, top3 };

    const dispInput = document.getElementById('newPlayerDisplayName');
    if (dispInput) dispInput.value = rawInput;
    const aliasInput = document.getElementById('newPlayerAliases');
    if (aliasInput) aliasInput.value = rawInput.toLowerCase();

    const candidatesList = document.getElementById('closestCandidatesList');
    if (candidatesList) {
        if (top3 && top3.length > 0) {
            document.getElementById('closestCandidatesSection').classList.remove('d-none');
            candidatesList.innerHTML = top3.map(c => `
                <button type="button" class="btn btn-outline-warning text-start py-2 px-3 fw-bold" onclick="selectClosestCandidate('${c.id}')">
                    <i class="fas fa-user-check me-2"></i>Use Existing: <b>${esc(c.displayName)}</b> <small class="text-muted">(${esc(c.id)})</small>
                </button>
            `).join('');
        } else {
            document.getElementById('closestCandidatesSection').classList.add('d-none');
        }
    }

    const modalEl = document.getElementById('createPlayerModal');
    if (modalEl) new bootstrap.Modal(modalEl).show();
};

window.selectClosestCandidate = (playerId) => {
    if (!currentModalContext) return;
    const { teamKey, index, rawInput } = currentModalContext;
    const player = playersRegistry.get(playerId);
    if (!player) return;

    const resolved = {
        status: 'resolved',
        id: player.id,
        displayName: player.displayName,
        rawInput: rawInput || player.displayName
    };

    if (index !== null && index !== undefined && selectedPlayers[teamKey] && selectedPlayers[teamKey][index]) {
        selectedPlayers[teamKey][index] = resolved;
    } else {
        selectedPlayers[teamKey].push(resolved);
    }
    renderList(teamKey);
    renderRosterGrid();

    const modalEl = document.getElementById('createPlayerModal');
    if (modalEl) {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
    }
};

/* ==========================================================================
   MATCH SAVE & DUPLICATE GUARD
   ========================================================================== */

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!currentUser) return alert("Login needed");

    const isTourn = document.getElementById('typeTournament').checked;
    const activeTeams = isTourn ? ['TournA', 'TournB', 'TournC'] : ['A', 'B'];

    for (const k of activeTeams) {
        for (const item of (selectedPlayers[k] || [])) {
            if (item.status !== 'resolved') {
                return alert(`Please resolve player "${item.rawInput}" on Team ${k} before saving.`);
            }
        }
    }

    if (!isTourn) {
        const countA = selectedPlayers.A.length;
        const countB = selectedPlayers.B.length;
        if (Math.abs(countA - countB) >= 2) {
            if (!confirm(`Notice: Team sizes are imbalanced (${countA} vs ${countB} players). Do you want to proceed?`)) {
                return;
            }
        }
    }

    const dVal = document.getElementById('matchDate').value;
    const locVal = document.getElementById('matchLocation').value;
    const isEdit = document.getElementById('editMatchId').value !== "";
    const editingId = document.getElementById('editMatchId').value;

    // STAGE C: Duplicate Match Guard
    const dateFormatted = dVal;
    const existingDuplicate = allMatches.find(m => {
        if (isEdit && m.id === editingId) return false;
        const mDate = m.date.toDate().toISOString().split('T')[0];
        return mDate === dateFormatted && m.location === locVal;
    });

    if (existingDuplicate) {
        if (!confirm(`Warning: A match on ${dateFormatted} at "${locVal}" already exists in records. Do you still want to save this match?`)) {
            return;
        }
    }

    const load = document.getElementById('loadingOverlay'); 
    if(load) load.classList.remove('d-none');

    try {
        const type = isTourn ? 'Tournament' : 'Standard';
        const common = { 
            date: new Date(dVal), 
            location: locVal, 
            youtubeLink: document.getElementById('matchYoutube').value || null, 
            type: type, 
            updatedBy: currentUser.email, 
            timestamp: firebase.firestore.FieldValue.serverTimestamp() 
        };
        let matchData = { ...common };
        
        if(type === 'Standard') {
            const sA=parseInt(document.getElementById('scoreA').value)||0, sB=parseInt(document.getElementById('scoreB').value)||0;
            const pA=selectedPlayers.A.map(p => p.id);
            const pB=selectedPlayers.B.map(p => p.id);
            if(!pA.length || !pB.length) throw new Error("Add players to both teams!");
            const caEl = document.querySelector('input[name="colorA"]:checked'); 
            const cbEl = document.querySelector('input[name="colorB"]:checked');
            const cA = caEl ? caEl.value : 'blue'; 
            const cB = cbEl ? cbEl.value : 'red';
            matchData.colors = [cA, cB];
            matchData.teams = [
                {teamName: document.getElementById('nameTeamA').value || 'Team A', score:sA, players:pA}, 
                {teamName: document.getElementById('nameTeamB').value || 'Team B', score:sB, players:pB}
            ];
        } else {
            const pA=selectedPlayers.TournA.map(p => p.id);
            const pB=selectedPlayers.TournB.map(p => p.id);
            const pC=selectedPlayers.TournC.map(p => p.id);
            if(!pA.length||!pB.length||!pC.length) throw new Error("Add players to all tournament teams!");
            
            const ptsA = parseInt(document.getElementById('ptsTournA').value) || 0;
            const ptsB = parseInt(document.getElementById('ptsTournB').value) || 0;
            const ptsC = parseInt(document.getElementById('ptsTournC').value) || 0;
            
            let tArr = [
                {teamName: document.getElementById('nameTournA').value || 'Yellow', players: pA, points: ptsA, originalKey: 'A', rank: parseInt(document.getElementById('rankTournA')?.value || '1')},
                {teamName: document.getElementById('nameTournB').value || 'Blue', players: pB, points: ptsB, originalKey: 'B', rank: parseInt(document.getElementById('rankTournB')?.value || '2')},
                {teamName: document.getElementById('nameTournC').value || 'Red', players: pC, points: ptsC, originalKey: 'C', rank: parseInt(document.getElementById('rankTournC')?.value || '3')}
            ];
            
            tArr.sort((a,b) => (a.rank || 1) - (b.rank || 1));
            matchData.teams = tArr;
        }
        
        const docRef = isEdit ? db.collection(DB_CONFIG.collections.matches).doc(editingId) : db.collection(DB_CONFIG.collections.matches).doc();
        await docRef.set(matchData);

        // Save newly created players to players registry
        const allSelected = activeTeams.flatMap(k => selectedPlayers[k] || []);
        const newPlayersToSave = allSelected.filter(p => p.isNew && p.id);
        if (newPlayersToSave.length > 0) {
            const batch = db.batch();
            for (const np of newPlayersToSave) {
                const pDoc = playersRegistry.get(np.id);
                if (pDoc) {
                    batch.set(db.collection(DB_CONFIG.collections.players).doc(np.id), {
                        displayName: pDoc.displayName,
                        aliases: pDoc.aliases || [pDoc.displayName.toLowerCase()],
                        active: true,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            }
            await batch.commit();
        }

        fetchPlayerNames();
        cancelEditMode();
        if(load) load.classList.add('d-none');
        const matchesTab = document.querySelector('button[data-bs-target="#matches"]');
        if(matchesTab) bootstrap.Tab.getInstance(matchesTab).show();
    } catch (err) { 
        if(load) load.classList.add('d-none'); 
        alert("Error: " + err.message); 
    }
});

document.getElementById('loginForm').addEventListener('submit', (e) => { 
    e.preventDefault(); 
    auth.signInWithEmailAndPassword(document.getElementById('loginEmail').value, document.getElementById('loginPass').value)
        .then(()=>bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide())
        .catch(e=>alert(e.message)); 
});

document.getElementById('logoutBtn').addEventListener('click', ()=>auth.signOut().then(()=>bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide()));

window.editMatch = (id, e) => {
    e.stopPropagation();
    const m = allMatches.find(x=>x.id===id); if(!m)return;
    const adminTab = document.querySelector('button[data-bs-target="#admin"]'); if(adminTab) new bootstrap.Tab(adminTab).show();
    safeText('formTitle', "EDIT MATCH"); safeText('saveBtn', "UPDATE");
    const saveBtn = document.getElementById('saveBtn'); if(saveBtn) saveBtn.classList.replace('btn-light', 'btn-warning');
    const cancelBtn = document.getElementById('cancelEditBtn'); if(cancelBtn) cancelBtn.classList.remove('d-none');
    document.getElementById('editMatchId').value = id;
    document.getElementById('matchDate').value = m.date.toDate().toISOString().split('T')[0];
    document.getElementById('matchLocation').value = m.location;
    document.getElementById('matchYoutube').value = m.youtubeLink||"";
    selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]};

    const toResolvedChip = (pIdOrName) => ({
        status: 'resolved',
        id: pIdOrName,
        displayName: getPlayerDisplayName(pIdOrName),
        rawInput: getPlayerDisplayName(pIdOrName)
    });
    
    if(m.type==='Standard') {
        document.getElementById('typeStandard').click();
        document.getElementById('nameTeamA').value=m.teams[0].teamName; document.getElementById('scoreA').value=m.teams[0].score;
        document.getElementById('nameTeamB').value=m.teams[1].teamName; document.getElementById('scoreB').value=m.teams[1].score;
        const r1=document.querySelector(`input[name="colorA"][value="${m.colors?.[0]||'blue'}"]`); if(r1)r1.checked=true;
        const r2=document.querySelector(`input[name="colorB"][value="${m.colors?.[1]||'red'}"]`); if(r2)r2.checked=true;
        selectedPlayers.A = (m.teams[0].players||[]).map(toResolvedChip);
        selectedPlayers.B = (m.teams[1].players||[]).map(toResolvedChip);
        renderList('A'); renderList('B');
    } else {
        const rb = document.getElementById('typeTournament'); if(rb){rb.checked=true; toggleMatchType();}
        if(m.teams && m.teams.length >= 3) {
            const tY = m.teams.find(t=>t.originalKey==='A') || m.teams[0];
            const tB = m.teams.find(t=>t.originalKey==='B') || m.teams[1];
            const tR = m.teams.find(t=>t.originalKey==='C') || m.teams[2];
            
            document.getElementById('nameTournA').value=tY.teamName; 
            setTournRank('TournA', tY.rank || 1);
            selectedPlayers.TournA = (tY.players||[]).map(toResolvedChip);
            
            document.getElementById('nameTournB').value=tB.teamName; 
            setTournRank('TournB', tB.rank || 2);
            selectedPlayers.TournB = (tB.players||[]).map(toResolvedChip);
            
            document.getElementById('nameTournC').value=tR.teamName; 
            setTournRank('TournC', tR.rank || 3);
            selectedPlayers.TournC = (tR.players||[]).map(toResolvedChip);
        }
        renderList('TournA'); renderList('TournB'); renderList('TournC');
    }
    renderRosterGrid();
};

/* ==========================================================================
   STAGE C: DETAILED DELETE CONFIRMATION MODAL
   ========================================================================== */

window.deleteMatch = (id, e) => { 
    e.stopPropagation(); 
    const m = allMatches.find(x => x.id === id);
    if (!m) return;

    const summaryEl = document.getElementById('deleteMatchSummary');
    const targetInput = document.getElementById('deleteMatchTargetId');
    if (targetInput) targetInput.value = id;

    if (summaryEl) {
        const dateStr = formatDate(m.date.toDate());
        let teamsInfo = '';
        if (m.type === 'Standard') {
            const tA = m.teams[0];
            const tB = m.teams[1];
            teamsInfo = `
                <div class="d-flex justify-content-between mb-1"><b>${esc(tA.teamName || 'Team A')}</b> <span>${tA.score} goals (${(tA.players||[]).length} players)</span></div>
                <div class="d-flex justify-content-between"><b>${esc(tB.teamName || 'Team B')}</b> <span>${tB.score} goals (${(tB.players||[]).length} players)</span></div>
            `;
        } else {
            teamsInfo = (m.teams || []).map((t, idx) => `
                <div class="d-flex justify-content-between mb-1"><b>${idx+1}. ${esc(t.teamName)}</b> <span>${t.points || 0} pts (${(t.players||[]).length} players)</span></div>
            `).join('');
        }

        summaryEl.innerHTML = `
            <div class="mb-2"><b>Date:</b> ${dateStr}</div>
            <div class="mb-2"><b>Location:</b> ${esc(m.location)}</div>
            <div class="mb-2"><b>Type:</b> ${esc(m.type)}</div>
            <div class="border-top border-secondary pt-2 mt-2">${teamsInfo}</div>
        `;
    }

    const modalEl = document.getElementById('deleteMatchModal');
    if (modalEl) new bootstrap.Modal(modalEl).show();
};

window.executeDeleteMatch = async () => {
    const targetInput = document.getElementById('deleteMatchTargetId');
    const id = targetInput ? targetInput.value : '';
    if (!id) return;

    const modalEl = document.getElementById('deleteMatchModal');
    if (modalEl) {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
    }

    const load = document.getElementById('loadingOverlay');
    if (load) load.classList.remove('d-none');

    try {
        await db.collection(DB_CONFIG.collections.matches).doc(id).delete();
    } catch (err) {
        alert("Delete failed: " + err.message);
    } finally {
        if (load) load.classList.add('d-none');
    }
};

window.cancelEditMode = () => { 
    safeText('formTitle', "NEW MATCH ENTRY"); safeText('saveBtn', "SAVE RECORD");
    const saveBtn = document.getElementById('saveBtn'); if(saveBtn) saveBtn.classList.replace('btn-warning','btn-light');
    const cancelBtn = document.getElementById('cancelEditBtn'); if(cancelBtn) cancelBtn.classList.add('d-none');
    document.getElementById('editMatchId').value=""; document.getElementById('addMatchForm').reset(); 
    selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]}; ['A','B','TournA','TournB','TournC'].forEach(k=>renderList(k)); 
    document.querySelectorAll('.border input[type="number"]').forEach(i=>i.value="");
    renderRosterGrid();
};

window.openMatchModal = (id) => { openMatchModalLogic(id); }; 

function openMatchModalLogic(id) { 
    const m=allMatches.find(x=>x.id===id); 
    if (!m) return;
    const body=document.getElementById('modalBody');
    const date=formatDate(m.date.toDate());
    if(m.type==='Standard') {
        const tA=m.teams[0], tB=m.teams[1];
        const pA = esc((tA.players||[]).map(p => getPlayerDisplayName(p)).join(', '));
        const pB = esc((tB.players||[]).map(p => getPlayerDisplayName(p)).join(', '));
        body.innerHTML=`<div class="text-center mb-3 text-muted small letter-spacing-1">${date}</div><div class="d-flex justify-content-center align-items-center mb-4"><div class="text-center w-50"><span class="badge bg-${m.colors?.[0]||'blue'} mb-1">${esc(tA.teamName||'A')}</span><div class="display-4 fw-bold text-white">${tA.score}</div></div><div class="text-muted">-</div><div class="text-center w-50"><span class="badge bg-${m.colors?.[1]||'red'} mb-1">${esc(tB.teamName||'B')}</span><div class="display-4 fw-bold text-white">${tB.score}</div></div></div><div class="row text-center small text-light"><div class="col-6">${pA}</div><div class="col-6">${pB}</div></div>`;
    } else {
        const r1=m.teams.find(t=>t.rank===1)||m.teams[0];
        const r2=m.teams.find(t=>t.rank===2)||m.teams[1];
        const r3=m.teams.find(t=>t.rank===3)||m.teams[2];
        const pts1 = r1.points !== undefined ? `(${r1.points} pts)` : '';
        const pts2 = r2.points !== undefined ? `(${r2.points} pts)` : '';
        const pts3 = r3.points !== undefined ? `(${r3.points} pts)` : '';
        
        body.innerHTML=`<div class="text-center mb-3 text-muted small">${date} (Tourn)</div><div class="text-center mb-3"><span class="badge bg-warning text-dark mb-2">WINNER</span><h3 class="fw-bold text-white">${esc(r1.teamName)} <span class="text-warning fs-6">${pts1}</span></h3><small class="text-light">${esc((r1.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</small></div><ul class="list-group list-group-flush bg-dark small"><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>2. ${esc(r2.teamName)} <span class="text-muted">${pts2}</span></span><span>${esc((r2.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</span></li><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>3. ${esc(r3.teamName)} <span class="text-muted">${pts3}</span></span><span>${esc((r3.players||[]).map(p => getPlayerDisplayName(p)).join(', '))}</span></li></ul>`;
    }
    const mEl = document.getElementById('matchDetailModal'); if(mEl) new bootstrap.Modal(mEl).show(); 
}

function fetchPlayerNames() { 
    db.collection(DB_CONFIG.collections.players).get().then(snap => { 
        playersRegistry.clear();
        const listEl = document.getElementById('playerList'); 
        if(listEl) listEl.innerHTML = ""; 
        snap.forEach(doc => {
            const data = doc.data();
            const id = doc.id;
            const displayName = data.displayName || id;
            const aliases = Array.isArray(data.aliases) ? data.aliases : [displayName.toLowerCase(), id.toLowerCase()];
            playersRegistry.set(id, {
                id,
                displayName,
                aliases,
                active: data.active !== false
            });
            if(listEl) listEl.appendChild(new Option(displayName, displayName));
        });
        renderData();
        renderRosterGrid();
    }).catch(err => {
        console.warn("Fetch players error:", err);
    }); 
}

function setupEnterKeys() { 
    ['inputPlayerA','inputPlayerB','inputPlayerTournA','inputPlayerTournB','inputPlayerTournC'].forEach(id => { 
        const el = document.getElementById(id); 
        if(el) { 
            el.addEventListener('keypress', e => {
                if(e.key==='Enter') {
                    e.preventDefault();
                    addPlayer(id.replace('inputPlayer',''));
                }
            }); 
            el.addEventListener('input', e => { 
                const listId = el.getAttribute('list'); 
                const listEl = document.getElementById(listId); 
                if (listEl) { 
                    const options = Array.from(listEl.options).map(opt => opt.value); 
                    if (options.includes(el.value.trim())) { 
                        addPlayer(id.replace('inputPlayer','')); 
                    } 
                } 
            }); 
        } 
    }); 
}

function addPlayer(k) { 
    const i = document.getElementById(`inputPlayer${k}`); 
    let v = i.value.trim(); 
    if(!v) return; 
    i.value = "";

    const placedIds = getCurrentlyPlacedPlayerIds();
    const result = resolvePlayerInput(v, k);
    if(!result) return;

    if(result.status === 'resolved') {
        if (placedIds.has(result.id)) {
            alert(`Player "${result.displayName}" is already placed on a team.`);
            return;
        }
        selectedPlayers[k].push(result);
        renderList(k);
    } else if(result.status === 'amber') {
        selectedPlayers[k].push(result);
        renderList(k);
    } else if(result.status === 'red') {
        selectedPlayers[k].push(result);
        renderList(k);
        openDisambiguateModal(k, selectedPlayers[k].length - 1);
    } else if(result.status === 'new') {
        openCreatePlayerModal(v, k, null, result.top3);
    }
    renderRosterGrid();
    i.focus(); 
}

function removePlayer(k, idx) { 
    if (typeof idx === 'number') {
        selectedPlayers[k].splice(idx, 1);
    } else {
        selectedPlayers[k] = selectedPlayers[k].filter(x => x.id !== idx && x.displayName !== idx && x.rawInput !== idx);
    }
    renderList(k); 
    renderRosterGrid();
}

function renderList(k) { 
    const el = document.getElementById(`listTeam${k}`); 
    if(!el) return; 
    el.innerHTML = selectedPlayers[k].map((p, idx) => {
        if (p.status === 'resolved') {
            return `<span class="player-tag player-chip chip-green" data-team="${k}" data-idx="${idx}" title="Resolved: ${esc(p.displayName)}">
                <span class="chip-status-dot"></span>
                <span>${esc(p.displayName)}</span>
                <i class="fas fa-times chip-remove" onclick="removePlayer('${k}', ${idx})"></i>
            </span>`;
        } else if (p.status === 'amber') {
            return `<span class="player-tag player-chip chip-amber" data-team="${k}" data-idx="${idx}" onclick="confirmAmberChip('${k}', ${idx})" title="Tap to accept ${esc(p.candidate.displayName)}">
                <span class="chip-status-dot"></span>
                <span>${esc(p.rawInput)} → <b>${esc(p.candidate.displayName)}</b>?</span>
                <i class="fas fa-check text-success ms-1 me-1" title="Accept"></i>
                <i class="fas fa-times chip-remove" onclick="event.stopPropagation(); removePlayer('${k}', ${idx})" title="Remove"></i>
            </span>`;
        } else {
            return `<span class="player-tag player-chip chip-red" data-team="${k}" data-idx="${idx}" onclick="openDisambiguateModal('${k}', ${idx})" title="Ambiguous. Tap to choose candidate.">
                <span class="chip-status-dot"></span>
                <span>${esc(p.rawInput)} <b>(Pick Player)</b></span>
                <i class="fas fa-chevron-down ms-1 me-1"></i>
                <i class="fas fa-times chip-remove" onclick="event.stopPropagation(); removePlayer('${k}', ${idx})" title="Remove"></i>
            </span>`;
        }
    }).join(''); 
    updateSaveButtonState();
}

window.exportToCSV = () => {
    let csvContent = "\uFEFF";
    csvContent += "Date,Type,Location,Score,Team A,Players A,Team B,Players B,Team C,Players C\n";
    allMatches.forEach(m => {
        const date = formatDate(m.date.toDate());
        const type = m.type;
        const escCsv = (text) => `"${(text || "").toString().replace(/"/g, '""')}"`;
        const loc = escCsv(m.location);
        let score = "", tA = "", pA = "", tB = "", pB = "", tC = "", pC = "";

        if (type === 'Standard') {
            const teamA = m.teams[0]; const teamB = m.teams[1];
            score = escCsv(`${teamA.score}-${teamB.score}`);
            tA = escCsv(teamA.teamName); pA = escCsv((teamA.players || []).map(p => getPlayerDisplayName(p)).join(", "));
            tB = escCsv(teamB.teamName); pB = escCsv((teamB.players || []).map(p => getPlayerDisplayName(p)).join(", "));
        } else {
            const sorted = [...m.teams].sort((a,b) => (a.rank || 1) - (b.rank || 1));
            score = escCsv("Tournament"); 
            if(sorted[0]) { tA = escCsv(`1. ${sorted[0].teamName} (${sorted[0].points}pts)`); pA = escCsv((sorted[0].players || []).map(p => getPlayerDisplayName(p)).join(", ")); }
            if(sorted[1]) { tB = escCsv(`2. ${sorted[1].teamName} (${sorted[1].points}pts)`); pB = escCsv((sorted[1].players || []).map(p => getPlayerDisplayName(p)).join(", ")); }
            if(sorted[2]) { tC = escCsv(`3. ${sorted[2].teamName} (${sorted[2].points}pts)`); pC = escCsv((sorted[2].players || []).map(p => getPlayerDisplayName(p)).join(", ")); }
        }
        csvContent += `${date},${type},${loc},${score},${tA},${pA},${tB},${pB},${tC},${pC}\n`;
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Elderly_League_Data_${new Date().toISOString().split('T')[0]}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

window.toggleMatchType = () => { 
    const isTourn = document.getElementById('typeTournament').checked; 
    document.getElementById('standardSection').classList.toggle('d-none', isTourn); 
    document.getElementById('tournamentSection').classList.toggle('d-none', !isTourn); 
    activeTeamTarget = isTourn ? 'TournA' : 'A';
    renderActiveTeamPills();
    renderRosterGrid();
    updateSaveButtonState();
};
