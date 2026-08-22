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

// Offline IndexedDB Persistence (Item 32)
try {
    db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code === 'failed-precondition') {
            console.warn('Firestore persistence warning: Multiple tabs open');
        } else if (err.code === 'unimplemented') {
            console.warn('Firestore persistence not supported in this browser');
        }
    });
} catch (e) {}

if (location.hostname === 'localhost' && window.location.search.includes('useEmulator=true')) {
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

const DEFAULT_LOCATIONS = [
    'Sporthal ROC Europaboulevard',
    'Sporthal Calvijn',
    'Sportgebouw Bibian Mentel',
    'Sporthallen Zuid',
    'Zeeburgereiland - Outdoor'
];
let locationsRegistry = new Set(DEFAULT_LOCATIONS);

let currentUser = null;
let selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
let allMatches = []; 
let allFixtures = [];
let allRoasts = [];
let activeLinkedFixtureId = null;
let activeRoastCandidates = [];
let activeSelectedRoastAngle = null;
let currentParsedFixtureSquads = null;
let roastSettingsState = { intensity: 3, allowProfanity: false, optedOutPlayerIds: [] };
let unsubFixtures = null;
let unsubRoasts = null;
let communityListenersMode = null; // 'public' | 'admin' — resubscribed on auth change
let communityFeedErrors = { fixtures: null, roasts: null };

let playersRegistry = new Map(); // playerId -> { id, displayName, aliases, active }
let currentModalContext = null; // { teamKey, index, rawInput, candidates, top3 }
let activeTeamTarget = 'A'; // 'A' | 'B' | 'TournA' | 'TournB' | 'TournC'
// TWO TIERS — must stay in step with firestore.rules and functions/index.js.
// This is presentation only; the rules and the Cloud Functions are what
// actually enforce it. Keeping it in step just means an organizer never sees a
// button that is going to fail on them.
const SUPER_ADMIN = "can.ozturk1907@gmail.com";        // owner
const ORGANIZERS = [
    SUPER_ADMIN,
    "elderly.group.futsal@gmail.com"
];

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

/* ==========================================================================
   LOCATIONS MANAGEMENT
   ========================================================================== */

async function fetchLocations() {
    try {
        const snap = await db.collection('locations').get();
        snap.forEach(doc => {
            const data = doc.data();
            if (data && data.name) locationsRegistry.add(data.name.trim());
            else if (doc.id) locationsRegistry.add(doc.id.trim());
        });
    } catch (e) {
        console.warn("Could not fetch locations collection:", e);
    }
    if (allMatches) {
        allMatches.forEach(m => { if (m.location) locationsRegistry.add(m.location.trim()); });
    }
    renderLocationsSelect();
}

function renderLocationsSelect(selectedVal) {
    const select = document.getElementById('matchLocation');
    if (!select) return;
    const current = selectedVal || select.value;
    const sorted = Array.from(locationsRegistry).sort((a, b) => a.localeCompare(b));
    let html = '<option value="" disabled ' + (!current ? 'selected' : '') + '>Select Location</option>';
    sorted.forEach(loc => {
        const isSel = (loc === current) ? 'selected' : '';
        html += `<option value="${esc(loc)}" ${isSel}>${esc(loc)}</option>`;
    });
    select.innerHTML = html;
}

window.openAddLocationModal = () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");
    const input = document.getElementById('newLocationName');
    if (input) input.value = '';
    const modalEl = document.getElementById('addLocationModal');
    if (modalEl) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
        setTimeout(() => input?.focus(), 300);
    }
};

window.saveNewLocation = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");
    const input = document.getElementById('newLocationName');
    const name = (input ? input.value : '').trim();
    if (!name) return alert("Please enter a location / hall name.");

    const btn = document.getElementById('saveLocationBtn');
    if (btn) btn.disabled = true;

    try {
        await db.collection('locations').add({
            name: name,
            active: true,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        locationsRegistry.add(name);
        renderLocationsSelect(name);
        
        const modalEl = document.getElementById('addLocationModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    } catch (err) {
        alert(`Failed to save location: ${err.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateAuthUI();
    });

    if(document.getElementById('filterYear')) document.getElementById('filterYear').addEventListener('change', renderData);
    if(document.getElementById('filterMonth')) document.getElementById('filterMonth').addEventListener('change', renderData);
    
    // stats-core.js owns the statistical engines. Hand it the registry (by
    // reference — app.js only ever mutates that Map, never reassigns it) and the
    // name resolver, so the site and the public JSON export compute from
    // identical code rather than two copies that can drift.
    setPlayerRegistry(playersRegistry);
    setNameResolver(getPlayerDisplayName);

    fetchPlayerNames();
    fetchMatches();
    fetchLocations();
    // Opens the public (rules-compatible) listeners now; updateAuthUI swaps them
    // for the unconstrained admin listeners once auth resolves.
    subscribeCommunityCollections();
    
    const dDate = document.getElementById('matchDate');
    if(dDate) dDate.valueAsDate = new Date();
    
    setupEnterKeys();
    setupRosterSearch();
    setupGeminiKeyForm();
    setupRoastVariantHandlers();
    setupChemistryHandlers();
    setupCommunityHandlers();
    setupRoastAdminHandlers();

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

// Anything marked data-owner-only is hidden from organizers. Presentation only:
// firestore.rules and the Cloud Functions are what actually refuse the write.
function applyOwnerOnlyVisibility(isOwner) {
    document.querySelectorAll('[data-owner-only]').forEach(el => {
        el.classList.toggle('d-none', !isOwner);
    });
}

function updateAuthUI() {
    const navEntry = document.getElementById('navNewEntry');
    const authBtn = document.querySelector('.auth-icon');
    
    if (currentUser) {
        // Organizers get the entry tab; a signed-in stranger does not, since
        // every write they attempted would be rejected server-side anyway.
        if(navEntry) navEntry.classList.toggle('d-none', !isOrganizer(currentUser));
        if(authBtn) authBtn.classList.add('active');
        applyOwnerOnlyVisibility(isSuperAdmin(currentUser));
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('userInfo').classList.remove('d-none');
        safeText('userEmailDisplay', currentUser.email);
    } else {
        if(navEntry) navEntry.classList.add('d-none');
        if(authBtn) authBtn.classList.remove('active');
        applyOwnerOnlyVisibility(false);
        document.getElementById('loginForm').classList.remove('d-none');
        document.getElementById('userInfo').classList.add('d-none');
    }
    subscribeCommunityCollections();
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

// Callers pass `year` as a number (renderData) or as a raw select value string
// (renderCommunityTab). Compare numerically so '2026' and 2026 behave the same.
function matchesFilter(m, year, month) {
    const d = m && m.date && m.date.toDate ? m.date.toDate() : null;
    if (!d || isNaN(d.getTime())) return false;
    const yMatch = year === 'all' || year === undefined || year === null || d.getFullYear() === parseInt(year, 10);
    const mMatch = month === 'all' || month === undefined || month === null || d.getMonth() === parseInt(month, 10);
    return yMatch && mMatch;
}

// Most recent season present in the data, as a string. Falls back to the current
// calendar year when there is nothing to read.
function latestYearInMatches(matches) {
    let latest = null;
    (matches || []).forEach(m => {
        const d = m && m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : null;
        if (!d || isNaN(d.getTime())) return;
        const y = d.getFullYear();
        if (latest === null || y > latest) latest = y;
    });
    return String(latest !== null ? latest : new Date().getFullYear());
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
    // Strip role annotations: (R), (Ref), (Referee), (GK), (c), etc.
    let clean = rawInput.replace(/\s*\((?:r|ref|referee|gk|keeper|c|captain|sub)\)/gi, '').trim();
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

    // 3. Prefix matching (e.g. "Antra" -> "Antraniek", "Gus" -> "Gustavo")
    if (lower.length >= 3) {
        const prefixMatches = availablePlayers.filter(p => {
            const pDisp = p.displayName.toLowerCase();
            const pId = p.id.toLowerCase();
            return pDisp.startsWith(lower) || pId.startsWith(lower);
        });
        if (prefixMatches.length === 1) {
            return {
                status: 'resolved',
                id: prefixMatches[0].id,
                displayName: prefixMatches[0].displayName,
                rawInput: clean
            };
        }
    }

    // 4. Fuzzy match against available players
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

const MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash',       // primary: free tier as of mid-2026
  'gemini-3.1-flash-lite',  // free tier, higher RPM, lower capability
  'gemini-2.5-flash',       // long-standing free tier workhorse
  'gemini-2.5-flash-lite',  // last resort
];

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

function isPaidModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase().trim();
  if (KNOWN_PAID_MODELS.some(p => id === p || id.endsWith('/' + p))) return true;
  if (id.includes('-pro') || id.includes('pro-') || id.includes('ultra') || id.includes('advanced')) return true;
  if (id === 'gemini-3.6-flash' || id === 'gemini-3.7-flash') return true;
  return false;
}

function updatePaidWarning(modelId) {
    const warnEl = document.getElementById('paidModelWarning');
    if (warnEl) {
        if (isPaidModel(modelId)) {
            warnEl.classList.remove('d-none');
        } else {
            warnEl.classList.add('d-none');
        }
    }
}

function setupGeminiKeyForm() {
    const form = document.getElementById('saveGeminiKeyForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!isOrganizer(currentUser)) return alert("Organizer access required.");

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
    if (!isSuperAdmin(currentUser)) return alert("The AI key and model are owner-only.");
    try {
        const docSnap = await db.collection('config').doc('gemini_meta').get();
        const maskedEl = document.getElementById('geminiKeyMasked');
        const lastUpEl = document.getElementById('geminiKeyLastUpdated');
        const modelSelect = document.getElementById('selectGeminiModel');
        const lastStatusEl = document.getElementById('geminiLastUsedStatus');

        if (docSnap.exists) {
            const data = docSnap.data();
            if (maskedEl) maskedEl.innerText = data.last4 ? `••••••••${data.last4}` : 'Not configured';
            if (lastUpEl) {
                const d = data.updatedAt ? data.updatedAt.toDate() : null;
                lastUpEl.innerText = d ? `Updated: ${formatDate(d)}` : '';
            }

            const targetModel = data.selectedModel || MODEL_FALLBACK_CHAIN[0];
            if (modelSelect) {
                let exists = Array.from(modelSelect.options).some(opt => opt.value === targetModel);
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = targetModel;
                    opt.text = targetModel + (isPaidModel(targetModel) ? ' [Paid]' : '');
                    modelSelect.appendChild(opt);
                }
                modelSelect.value = targetModel;
                updatePaidWarning(targetModel);
            }

            if (lastStatusEl) {
                if (data.lastUsedModel) {
                    lastStatusEl.classList.remove('d-none');
                    if (data.lastFallbackFrom) {
                        lastStatusEl.innerHTML = `<i class="fas fa-info-circle text-warning me-1"></i> Last call used <b>${esc(data.lastUsedModel)}</b> <span class="text-warning">(fell back from ${esc(data.lastFallbackFrom)})</span>`;
                    } else {
                        lastStatusEl.innerHTML = `<i class="fas fa-check-circle text-success me-1"></i> Last call used <b>${esc(data.lastUsedModel)}</b>`;
                    }
                } else {
                    lastStatusEl.classList.add('d-none');
                }
            }
        } else {
            if (maskedEl) maskedEl.innerText = 'Not configured';
            if (lastUpEl) lastUpEl.innerText = '';
            if (lastStatusEl) lastStatusEl.classList.add('d-none');
        }
    } catch (err) {
        console.warn("Error reading gemini_meta:", err);
    }
};

window.testGeminiConnectionHandler = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");

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
            const fallbackNote = data.fellBackFrom ? `<br><span class="text-warning">Fell back from ${esc(data.fellBackFrom)} to ${esc(data.testedModel)}</span>` : '';
            if (resultDiv) {
                resultDiv.className = 'mb-3 p-2 rounded border border-success bg-success bg-opacity-10 small text-success';
                resultDiv.innerHTML = `<b>✓ Connection & Model Test Successful</b> (${data.latencyMs} ms latency)<br>Tested model: <b>${esc(data.testedModel)}</b>${fallbackNote}<br>Retrieved ${data.models.length} text generation models from Google AI Studio.`;
                resultDiv.classList.remove('d-none');
            }

            const modelSelect = document.getElementById('selectGeminiModel');
            if (modelSelect && data.models && data.models.length > 0) {
                const currentVal = modelSelect.value || data.testedModel;
                modelSelect.innerHTML = data.models.map(m => `
                    <option value="${esc(m.id)}">${esc(m.displayName || m.id)}${m.isPaid ? ' [Paid]' : ''}</option>
                `).join('');
                
                if (data.models.some(m => m.id === currentVal)) {
                    modelSelect.value = currentVal;
                } else if (data.testedModel) {
                    modelSelect.value = data.testedModel;
                }
                updatePaidWarning(modelSelect.value);
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
    updatePaidWarning(modelId);
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

        const badgeEl = document.getElementById('magicPasteBadge');
        if (badgeEl) {
            if (parsed.modelUsed) {
                if (parsed.fellBackFrom) {
                    badgeEl.innerText = `${parsed.modelUsed} (fallback)`;
                    badgeEl.className = 'badge bg-warning text-dark';
                    badgeEl.title = `Fell back from ${parsed.fellBackFrom}`;
                } else {
                    badgeEl.innerText = parsed.modelUsed;
                    badgeEl.className = 'badge bg-success';
                    badgeEl.title = 'AI parsed successfully';
                }
            } else {
                badgeEl.innerText = 'Regex Fallback';
                badgeEl.className = 'badge bg-secondary';
                badgeEl.title = 'Local parser used';
            }
        }

        // 2. Set Date & Venue if found
        if (parsed.date) {
            const dateInput = document.getElementById('matchDate');
            if (dateInput) dateInput.value = parsed.date;
        }
        if (parsed.venue) {
            const v = parsed.venue.trim();
            locationsRegistry.add(v);
            renderLocationsSelect(v);
        }

        // 3. Set Match Type
        const isTourn = parsed.matchType === 'Tournament' || parsed.teams.length >= 3;
        if (isTourn) {
            document.getElementById('typeTournament').click();
            
            // Map tournament teams to slots based on detected colors:
            // TournA = Yellow, TournB = Blue, TournC = Red
            const colorSlotMap = {
                yellow: 'TournA',
                blue: 'TournB',
                red: 'TournC'
            };
            const defaultSlotNames = {
                TournA: 'Yellow',
                TournB: 'Blue',
                TournC: 'Red'
            };
            const defaultRanks = {
                TournA: 1,
                TournB: 2,
                TournC: 3
            };
            const allKeys = ['TournA', 'TournB', 'TournC'];
            const availableKeys = ['TournA', 'TournB', 'TournC'];
            const teamSlotAssignments = new Array(Math.min(3, parsed.teams.length));

            // Pass 1: Assign teams with explicit matching color to their dedicated slot
            parsed.teams.slice(0, 3).forEach((t, i) => {
                const c = (t.color || '').toLowerCase().trim();
                const targetKey = colorSlotMap[c];
                if (targetKey && availableKeys.includes(targetKey)) {
                    teamSlotAssignments[i] = targetKey;
                    availableKeys.splice(availableKeys.indexOf(targetKey), 1);
                }
            });

            // Pass 2: Assign remaining teams to unused slots in order
            parsed.teams.slice(0, 3).forEach((t, i) => {
                if (!teamSlotAssignments[i]) {
                    teamSlotAssignments[i] = availableKeys.shift() || allKeys[i];
                }
            });

            parsed.teams.slice(0, 3).forEach((t, i) => {
                const k = teamSlotAssignments[i];
                const nameEl = document.getElementById(`name${k}`);
                if (nameEl) nameEl.value = t.name || defaultSlotNames[k];
                
                const rankVal = t.rank || defaultRanks[k];
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
    const rawLines = text.split('\n')
        .map(l => l.trim())
        .filter(l => l && !/^(?:vs\.?|v|against|\/)$/i.test(l));

    const COLOR_EMOJIS_RED = '🔴|🟥|🛑|❤️|🍎|🌹|🚨|🔻|🔺|🩸|🍷|🌶️|🥊|🍒|♦️|🎈|🚩';
    const COLOR_EMOJIS_BLUE = '🔵|🟦|💙|🔹|🔷|🐬|🌊|🫐|👖|🥶|🧊|🧢|🌐';
    const COLOR_EMOJIS_YELLOW = '🟡|🟨|💛|☀️|⭐|🌟|🍌|🍋|🧀|🐣|🐥|🌻|🔸|🔶|🌕|👑|⚡|🎗️';
    const ALL_COLOR_SYMBOLS = `${COLOR_EMOJIS_RED}|${COLOR_EMOJIS_BLUE}|${COLOR_EMOJIS_YELLOW}|red|blue|yellow|rood|blauw|geel|amarillo|azul|rouge|bleu|jaune`;

    const extractColor = (str) => {
        if (!str) return null;
        const s = String(str);
        if (new RegExp(`${COLOR_EMOJIS_RED}|\\breds?\\b|\\brood\\b|\\brode\\b|\\brojo\\b|\\broja\\b|\\brouge\\b|\\bvermelho\\b`, 'i').test(s)) return 'red';
        if (new RegExp(`${COLOR_EMOJIS_BLUE}|\\bblues?\\b|\\bblauw\\b|\\bblauwe\\b|\\bazul\\b|\\bbleu\\b`, 'i').test(s)) return 'blue';
        if (new RegExp(`${COLOR_EMOJIS_YELLOW}|\\byellows?\\b|\\bgeel\\b|\\bgele\\b|\\bamarillo\\b|\\bamarilla\\b|\\bjaune\\b|\\bamarelo\\b`, 'i').test(s)) return 'yellow';
        return null;
    };

    const cleanTeamName = (str) => {
        if (!str) return '';
        return str
            .replace(new RegExp(`\\[\\s*(?:in\\s*)?(?:${ALL_COLOR_SYMBOLS})(?:\\s*team|\\s*shirts?)?\\s*\\]`, 'gi'), '')
            .replace(new RegExp(`\\(\\s*(?:in\\s*)?(?:${ALL_COLOR_SYMBOLS})(?:\\s*team|\\s*shirts?)?\\s*\\)`, 'gi'), '')
            .replace(new RegExp(`\\s*(?:in\\s*)?(?:${COLOR_EMOJIS_RED}|${COLOR_EMOJIS_BLUE}|${COLOR_EMOJIS_YELLOW})+\\s*:?`, 'gi'), '')
            .replace(/\s+in\s+(?:red|blue|yellow|rood|blauw|geel|amarillo|azul|rouge|bleu|jaune)(?:\s+team|\s+shirts?)?\s*:?/gi, '')
            .replace(/\s*:\s*$/, '')
            .trim();
    };

    const cleanPlayerToken = (p) => {
        return p.replace(/\s*\((?:r|ref|referee|gk|keeper|c|captain|sub)\)/gi, '').trim();
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
   STAGE D: STATISTICS & ANALYTICS ENGINE
   ========================================================================== */

// Named Constants & Thresholds (Agreed across Stage D)






/**
 * Render SVG Rolling 5-game PPG sparkline chart
 */
function renderRollingPpgSvg(rollingHistory) {
    if (!rollingHistory || rollingHistory.length < 2) {
        return `<div class="small text-muted text-center py-2">Play 2 or more matches to unlock your career PPG line chart.</div>`;
    }
    const width = 320;
    const height = 80;
    const padding = 14;
    const drawW = width - padding * 2;
    const drawH = height - padding * 2;
    const maxVal = 3.0;

    const points = rollingHistory.map((item, idx) => {
        const x = padding + (idx / (rollingHistory.length - 1)) * drawW;
        const val = Math.max(0, Math.min(3, item.ppg));
        const y = height - padding - (val / maxVal) * drawH;
        return { x, y, ppg: item.ppg, date: item.dateStr };
    });

    const polylinePts = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const firstP = points[0];
    const lastP = points[points.length - 1];
    const areaPts = `${polylinePts} ${lastP.x.toFixed(1)},${(height - padding)} ${firstP.x.toFixed(1)},${(height - padding)}`;

    const guideY1 = (height - padding - (1.0 / 3.0) * drawH).toFixed(1);
    const guideY2 = (height - padding - (2.0 / 3.0) * drawH).toFixed(1);

    const circles = points.map(p => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#2f81f7" stroke="#ffffff" stroke-width="1.5">
            <title>${p.ppg.toFixed(2)} PPG (${p.date})</title>
        </circle>
    `).join('');

    return `
    <div class="bg-dark p-2 rounded border border-secondary mb-3">
        <div class="d-flex justify-content-between align-items-center mb-1">
            <small class="text-muted" style="font-size:0.7rem; font-weight:700; letter-spacing:0.5px;">ROLLING 5-GAME PPG CAREER TREND</small>
            <small class="text-info font-monospace" style="font-size:0.75rem; font-weight:700;">Latest: ${lastP.ppg.toFixed(2)} PPG</small>
        </div>
        <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:80px; overflow:visible;">
            <defs>
                <linearGradient id="ppgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#2f81f7" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="#2f81f7" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#30363d" stroke-width="1" />
            <line x1="${padding}" y1="${guideY1}" x2="${width - padding}" y2="${guideY1}" stroke="#30363d" stroke-dasharray="3,3" stroke-width="1" />
            <line x1="${padding}" y1="${guideY2}" x2="${width - padding}" y2="${guideY2}" stroke="#30363d" stroke-dasharray="3,3" stroke-width="1" />
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="#30363d" stroke-dasharray="3,3" stroke-width="1" />
            
            <text x="${padding}" y="${padding + 7}" fill="#666" font-size="8" font-family="sans-serif">3.0</text>
            <text x="${padding}" y="${Number(guideY2) + 3}" fill="#666" font-size="8" font-family="sans-serif">2.0</text>
            <text x="${padding}" y="${Number(guideY1) + 3}" fill="#666" font-size="8" font-family="sans-serif">1.0</text>

            <polygon points="${areaPts}" fill="url(#ppgGrad)" />
            <polyline points="${polylinePts}" fill="none" stroke="#2f81f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            ${circles}
        </svg>
    </div>`;
}




/**
 * Item 18: Most Improved Player Calculation
 */
function computeMostImproved(matches, filterYear, filterMonth) {
    // Current/active month
    let targetYear = filterYear === 'all' ? new Date().getFullYear() : parseInt(filterYear);
    let targetMonth = filterMonth === 'all' ? new Date().getMonth() : parseInt(filterMonth);

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    const allTimeStats = {}; // pId -> { pts: 0, games: 0 }
    const monthStats = {}; // pId -> { pts: 0, games: 0 }

    matches.forEach(m => {
        const d = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : new Date();
        const mYear = d.getFullYear();
        const mMonth = d.getMonth();
        const inTargetMonth = mYear === targetYear && mMonth === targetMonth;

        (m.teams || []).forEach(t => {
            let pts = 0;
            if (m.type === 'Standard') {
                const opp = m.teams.find(other => other !== t);
                if (t.score > opp.score) pts = 3;
                else if (t.score === opp.score) pts = 1;
            } else {
                pts = t.points !== undefined ? t.points : (t.rank === 1 ? 3 : (t.rank === 2 ? 1 : 0));
            }

            (t.players || []).forEach(p => {
                if (!allTimeStats[p]) allTimeStats[p] = { pts: 0, games: 0 };
                allTimeStats[p].pts += pts;
                allTimeStats[p].games++;

                if (inTargetMonth) {
                    if (!monthStats[p]) monthStats[p] = { pts: 0, games: 0 };
                    monthStats[p].pts += pts;
                    monthStats[p].games++;
                }
            });
        });
    });

    const candidates = [];
    Object.keys(monthStats).forEach(pId => {
        const mData = monthStats[pId];
        if (mData.games >= MIN_GAMES_IMPROVED) {
            const mPpg = mData.pts / mData.games;
            const aData = allTimeStats[pId];
            const aPpg = aData && aData.games > 0 ? (aData.pts / aData.games) : mPpg;
            const delta = mPpg - aPpg;

            candidates.push({
                id: pId,
                name: getPlayerDisplayName(pId),
                monthGames: mData.games,
                monthPpg: mPpg.toFixed(2),
                allTimePpg: aPpg.toFixed(2),
                delta: delta.toFixed(2),
                rawDelta: delta
            });
        }
    });

    candidates.sort((a, b) => b.rawDelta - a.rawDelta);

    return {
        candidates,
        monthLabel: `${monthNames[targetMonth]} ${targetYear}`
    };
}


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

function minAppearancesForPeriod(matchesInPeriod, isAllTime = false) {
    if (isAllTime) return MIN_APPEARANCES_PPG; // 10
    return Math.max(2, Math.ceil(matchesInPeriod * 0.4));
}

function updateFilterVisibility() {
    const filterContainer = document.getElementById('dateFilterContainer');
    if (!filterContainer) return;
    const activeTab = document.querySelector('#myTab .nav-link.active');
    const target = activeTab ? activeTab.getAttribute('data-bs-target') : '#matches';
    if (target === '#matches' || target === '#leaderboard') {
        filterContainer.classList.remove('d-none');
    } else {
        filterContainer.classList.add('d-none');
    }
}

function renderData() {
    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const year = fYear ? (fYear.value === 'all' ? 'all' : parseInt(fYear.value)) : 2026;
    const month = fMonth ? fMonth.value : 'all';

    const filtered = allMatches.filter(m => matchesFilter(m, year, month));

    // Recompute All-Time Elo Ratings from scratch
    computeEloRatings(allMatches);

    renderMatchesList(filtered);
}

function renderMatchesList(filtered) {
    const list = document.getElementById('match-history-list');
    if(list) {
        list.innerHTML = "";
        
        if(filtered.length === 0) {
            list.innerHTML = "<div class='text-center py-5 text-muted small'>No matches found.</div>";
        } else {
            const renderPlayerPills = (playerIds) => {
                if (!playerIds || playerIds.length === 0) return '';
                return playerIds.map(pId => {
                    const name = getPlayerDisplayName(pId);
                    return `<span class="player-pill" data-player-id="${esc(pId)}">${esc(name)}</span>`;
                }).join(', ');
            };

            filtered.forEach(m => {
                const dateStr = formatDate(m.date.toDate());
                let adminBtns = "";
                if (isOrganizer(currentUser)) {
                    adminBtns = `<div class="admin-actions">
                        <button class="btn btn-sm btn-outline-warning py-0 me-2" onclick="regenerateRecap('${m.id}', event)" title="Regenerate AI Match Recap"><i class="fas fa-redo-alt me-1"></i>Recap</button>
                        <button class="btn btn-sm btn-outline-light border-secondary py-0 me-2" onclick="editMatch('${m.id}', event)">Edit</button> 
                        ${isSuperAdmin(currentUser) ? `<button class="btn btn-sm btn-outline-danger py-0" onclick="deleteMatch('${m.id}', event)">Delete</button>` : ''}
                    </div>`;
                }
                const ytLink = m.youtubeLink ? `<a href="${esc(safeUrl(m.youtubeLink))}" target="_blank" onclick="event.stopPropagation()" style="color:#fa7970; text-decoration:none; font-size:0.75rem; font-weight:600;"><i class="fab fa-youtube"></i> Watch</a>` : '';
                const shareBtn = `<button type="button" class="btn btn-sm btn-link text-muted p-0 ms-2 text-decoration-none" onclick="copyShareLink('match', '${m.id}', 'Match on ${dateStr}', event)" title="Share Match Link" style="font-size:0.75rem;"><i class="fas fa-share-alt"></i></button>`;

                const previewHtml = (m.preview || m.predictedWinner) ? `
                <div class="p-2 border-top border-secondary border-opacity-25 bg-black bg-opacity-35 small text-light" style="font-size:0.75rem;">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <span class="text-warning fw-bold"><i class="fas fa-feather-alt me-1"></i>Commissioner Preview</span>
                        ${m.predictionResult ? (m.predictionResult === 'correct' 
                            ? `<span class="badge bg-success bg-opacity-25 text-success fw-bold font-monospace" style="font-size:0.7rem;">🎯 Pick: ${esc(m.predictedWinner || 'Favorite')} (✓ Correct)</span>` 
                            : `<span class="badge bg-danger bg-opacity-25 text-danger fw-bold font-monospace" style="font-size:0.7rem;">💀 Pick: ${esc(m.predictedWinner || 'Favorite')} (✗ Wrong)</span>`) 
                            : (m.predictedWinner ? `<span class="badge bg-secondary font-monospace" style="font-size:0.7rem;">Pick: ${esc(m.predictedWinner)}</span>` : '')}
                    </div>
                    ${m.preview ? `<div class="fst-italic opacity-90">${esc(m.preview)}</div>` : ''}
                </div>` : '';

                const recapHtml = m.recap ? `
                <div class="p-2 border-top border-secondary border-opacity-25 bg-black bg-opacity-25 small text-light opacity-90" style="font-size:0.75rem; font-style:italic;">
                    <i class="fas fa-quote-left text-warning me-1 opacity-75" style="font-size:0.65rem;"></i>
                    ${esc(m.recap)}
                </div>` : '';

                let html = "";
                if(m.type === 'Standard') {
                    const tA=m.teams[0], tB=m.teams[1];
                    const cA=m.colors?.[0]||'blue', cB=m.colors?.[1]||'red';
                    const winA = tA.score > tB.score ? 'text-white' : 't-loser';
                    const winB = tB.score > tA.score ? 'text-white' : 't-loser';
                    const pA = renderPlayerPills(tA.players);
                    const pB = renderPlayerPills(tB.players);

                    html = `
                    <div class="match-card" id="match-${m.id}">
                        <div class="card-top d-flex justify-content-between align-items-center">
                            <span><i class="far fa-calendar me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${esc(m.location)}</span> 
                            <div class="d-flex align-items-center">${ytLink}${shareBtn}</div>
                        </div>
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
                        ${previewHtml}
                        ${recapHtml}
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
                    <div class="match-card" id="match-${m.id}" style="border-left: 3px solid #ffea00;">
                        <div class="card-top d-flex justify-content-between align-items-center">
                            <span><i class="fas fa-trophy text-warning me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${esc(m.location)}</span> 
                            <div class="d-flex align-items-center">${ytLink}${shareBtn}</div>
                        </div>
                        <div class="p-3 bg-card">
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-white fw-bold"><span class="rank-badge rank-1">1</span> <span class="dot bg-${getCol(r1)}"></span> ${esc(r1.teamName)} <span class="text-warning ms-1" style="font-size:0.75rem">${pts1}</span></span></div><div style="font-size:0.75rem; color:#8b949e; margin-left:32px">${renderPlayerPills(r1.players)}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted"><span class="rank-badge bg-secondary">2</span> <span class="dot bg-${getCol(r2)}"></span> ${esc(r2.teamName)} <span class="text-muted ms-1" style="font-size:0.75rem">${pts2}</span></span></div><div style="font-size:0.75rem; color:#666; margin-left:32px">${renderPlayerPills(r2.players)}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted opacity-50"><span class="rank-badge bg-secondary">3</span> <span class="dot bg-${getCol(r3)}"></span> ${esc(r3.teamName)} <span class="text-muted opacity-50 ms-1" style="font-size:0.75rem">${pts3}</span></span></div><div style="font-size:0.75rem; color:#555; margin-left:32px">${renderPlayerPills(r3.players)}</div></div>
                        </div>
                        ${previewHtml}
                        ${recapHtml}
                        ${adminBtns}
                    </div>`;
                }
                list.innerHTML += html;
            });

            // Delegated click listener for player pills
            if (!list.dataset.delegatedBound) {
                list.dataset.delegatedBound = 'true';
                list.addEventListener('click', (e) => {
                    const pill = e.target.closest('[data-player-id]');
                    if (pill) {
                        e.stopPropagation();
                        const pId = pill.getAttribute('data-player-id');
                        if (pId) openPlayerStats(pId);
                    }
                });
            }
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

    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const isMonthFiltered = (fMonth && fMonth.value !== 'all');
    const isAllTime = !isMonthFiltered;
    const activeQualifier = isAllTime ? MIN_APPEARANCES_PPG : minAppearancesForPeriod(filtered.length, false);

    let startEloRatings = {};
    let endEloRatings = {};
    let endEloMatchCounts = {};

    if (isMonthFiltered && filtered.length > 0) {
        const selectedYear = fYear && fYear.value !== 'all' ? parseInt(fYear.value) : 2026;
        const selectedMonth = parseInt(fMonth.value);

        // Matches strictly before this month
        const matchesBeforeMonth = allMatches.filter(m => {
            const d = m.date && m.date.toDate ? m.date.toDate() : new Date(m.date);
            const y = d.getFullYear();
            const mo = d.getMonth();
            if (y < selectedYear) return true;
            if (y === selectedYear && mo < selectedMonth) return true;
            return false;
        });

        // Matches up to and including this month
        const matchesUpToMonthEnd = allMatches.filter(m => {
            const d = m.date && m.date.toDate ? m.date.toDate() : new Date(m.date);
            const y = d.getFullYear();
            const mo = d.getMonth();
            if (y < selectedYear) return true;
            if (y === selectedYear && mo <= selectedMonth) return true;
            return false;
        });

        const startEloData = computeEloRatings(matchesBeforeMonth);
        const endEloData = computeEloRatings(matchesUpToMonthEnd);
        startEloRatings = startEloData.ratings || {};
        endEloRatings = endEloData.ratings || {};
        endEloMatchCounts = endEloData.matchCounts || {};
    }

    const tbody = document.getElementById('leaderboard-body');
    if(tbody) {
        tbody.innerHTML = "";
        
        const players = Object.values(stats).map(p => {
            let displayElo = STARTING_ELO;
            let rawEloVal = STARTING_ELO;
            let eloBadge = '';

            if (isMonthFiltered) {
                const endR = Math.round(endEloRatings[p.id] !== undefined ? endEloRatings[p.id] : STARTING_ELO);
                const startR = Math.round(startEloRatings[p.id] !== undefined ? startEloRatings[p.id] : STARTING_ELO);
                const delta = endR - startR;
                const careerCapsAtEnd = endEloMatchCounts[p.id] || 0;
                const isProv = careerCapsAtEnd < MIN_GAMES_RANKED_ELO;

                displayElo = endR;
                rawEloVal = endR;

                let deltaBadge = '';
                if (delta > 0) {
                    deltaBadge = `<span class="badge bg-success bg-opacity-25 text-success ms-1 fw-bold" style="font-size:0.72rem">+${delta}</span>`;
                } else if (delta < 0) {
                    deltaBadge = `<span class="badge bg-danger bg-opacity-25 text-danger ms-1 fw-bold" style="font-size:0.72rem">${delta}</span>`;
                } else {
                    deltaBadge = `<span class="badge bg-secondary bg-opacity-25 text-muted ms-1" style="font-size:0.72rem">0</span>`;
                }

                const provTag = isProv ? `<span class="badge-provisional ms-1" title="Provisional — ${careerCapsAtEnd}/${MIN_GAMES_RANKED_ELO} career games">?</span>` : '';
                eloBadge = `${deltaBadge}${provTag}`;
            } else {
                const eloObj = latestEloMap.get(p.id);
                displayElo = eloObj ? eloObj.rating : STARTING_ELO;
                rawEloVal = eloObj ? eloObj.rawRating : STARTING_ELO;
                const isProv = eloObj ? eloObj.isProvisional : (p.played < MIN_GAMES_RANKED_ELO);
                const provTag = isProv ? `<span class="badge-provisional ms-1" title="Provisional — ${(eloObj ? eloObj.matches : p.played)} of ${MIN_GAMES_RANKED_ELO} games">?</span>` : '';
                eloBadge = provTag;
            }

            return {
                ...p,
                elo: displayElo,
                rawElo: rawEloVal,
                eloBadge
            };
        }).sort((a,b) => {
            let valA = a[currentSortCol];
            let valB = b[currentSortCol];
            
            if(currentSortCol === 'ppg') { valA = a.points/a.played; valB = b.points/b.played; }
            if(currentSortCol === 'elo') { valA = a.rawElo; valB = b.rawElo; }
            if(currentSortCol === 'name') {
                return isSortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
            }
            
            if (valA === valB) return b.won - a.won;
            return isSortDesc ? valB - valA : valA - valB;
        });

        if(players.length === 0) {
            tbody.innerHTML = "<tr><td colspan='9' class='text-center py-4 text-muted small'>No stats available for this period.</td></tr>";
        } else {
            const qualified = players.filter(p => p.played >= activeQualifier);
            const unqualified = players.filter(p => p.played < activeQualifier);

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
                    <td class="${greyed ? '' : 'fw-bold text-warning'}">${p.elo}${p.eloBadge}</td>
                    <td class="pe-3 ${greyed ? '' : 'fw-bold text-info'}">${ppg}</td>
                </tr>`;
            };

            if(qualified.length === 0 && unqualified.length > 0) {
                tbody.innerHTML += `<tr><td colspan="9" class="text-center text-muted small py-3 border-bottom border-secondary">No players met the qualification threshold (${activeQualifier}+ appearances) for this period.</td></tr>`;
            }

            qualified.forEach((p, i) => { tbody.innerHTML += rowHtml(p, i + 1, i, false); });

            if(unqualified.length) {
                const dividerLabel = isAllTime ? `FEWER THAN 10 APPEARANCES (ALL-TIME)` : `FEWER THAN ${activeQualifier} APPEARANCES THIS MONTH`;
                tbody.innerHTML += `<tr><td colspan="9" class="text-center text-muted small py-2 border-top border-secondary" style="letter-spacing:1px">${dividerLabel}</td></tr>`;
                unqualified.forEach((p, i) => { tbody.innerHTML += rowHtml(p, '-', i, true); });
            }
        }
    }

    generateInsights(allMatches);
    renderCommunityTab(allMatches);
    updateFilterVisibility();
}

function generateInsights(matches) {
    const insightsContainer = document.getElementById('insightsContainer');
    if(!insightsContainer) return;

    // Filter context
    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const year = fYear ? fYear.value : '2026';
    const month = fMonth ? fMonth.value : 'all';

    // 1. Elo Ratings & Optimal Lineup (Item 16 & 22)
    const eloData = computeEloRatings(allMatches); // All-time chronological
    const lineupData = computeOptimalLineupAndCurse(allMatches, latestEloMap);

    // 2. Chemistry & Duos (Item 19) - All-time dataset
    const chemData = computeChemistryMatrix(allMatches);

    // 3. Streaks, Form & Most Improved (Item 18)
    const improvedData = computeMostImproved(allMatches, year, month);

    // 4. Attendance & Milestones (Item 20)
    const attendData = computeAttendanceAndMilestones(allMatches);

    // 5. Venue Goals (Standard matches only)
    const venueGoals = {};
    let biggestBlowout = null;
    let highestScoring = null;
    let draws = 0;

    allMatches.forEach(m => {
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
    });

    // --- HTML RENDERERS ---

    // A. Optimal Lineup Card
    const optimalLineupHtml = lineupData.optimal5.length >= 5 ? `
    <div class="col-12 mb-4">
        <div class="lineup-hero">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                <div style="min-width:0">
                    <h6 class="fw-bold text-white mb-0"><i class="fas fa-crown text-warning me-2"></i>OPTIMAL 5-PLAYER LINEUP</h6>
                    <small class="text-muted">Highest-rated buildable 5-player squad (Min ${MIN_GAMES_RANKED_ELO} appearances)</small>
                </div>
                <div class="text-end">
                    <span class="badge bg-primary fs-6 px-3 py-2">Avg Elo: ${lineupData.avgElo}</span>
                </div>
            </div>
            <div class="lineup-grid">
                ${lineupData.optimal5.map((p, idx) => `
                    <div class="lineup-tile${idx === 0 ? ' is-top' : ''}">
                        <div class="lineup-tile-inner" onclick="openPlayerStats('${esc(p.id)}')">
                            <span class="badge bg-secondary">#${idx + 1}</span>
                            <div class="lineup-name text-truncate">${esc(p.name)}</div>
                            <div class="lineup-rating">${p.rating}</div>
                            <div class="lineup-caps">${p.matches} Matches</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>` : '';

    // B. Power Rankings (Elo) Leaderboard
    const powerRankingsRows = eloData.sortedList.slice(0, 10).map((p, idx) => {
        const provBadge = p.isProvisional ? `<span class="badge-provisional ms-2">? Provisional (${p.matches}/${MIN_GAMES_RANKED_ELO})</span>` : '';
        return `
        <tr style="cursor:pointer" onclick="openPlayerStats('${p.id}')">
            <td class="ps-3 text-start fw-bold"><span class="rank-circle ${idx===0?'r-1':''}">${idx + 1}</span></td>
            <td class="text-start fw-bold text-white">${esc(p.name)} ${provBadge}</td>
            <td class="fw-bold text-warning">${p.rating}</td>
            <td class="pe-3 text-muted">${p.matches}</td>
        </tr>`;
    }).join('');

    // C. Duo Leaderboard Tables (Responsive Stacked Layout for 320px+)
    const renderDuoList = (list) => {
        if (!list || list.length === 0) return `<div class="small text-muted p-3 text-center">Needs at least ${MIN_GAMES_PAIR} games together</div>`;
        return list.map((d, i) => {
            const smallSampleBadge = (d.played >= 3 && d.played <= 4) ? `<span class="badge-small-sample ms-1" style="font-size:0.65rem; padding: 1px 4px; display:inline-block; vertical-align:middle;">3–4 games</span>` : '';
            return `
            <div class="py-2 border-bottom border-secondary border-opacity-50">
                <div class="d-flex justify-content-between align-items-start gap-2">
                    <div class="flex-grow-1" style="min-width:0; word-break:break-word;">
                        <span class="text-muted small me-1 font-monospace">#${i + 1}</span>
                        <span class="fw-bold text-white small">${esc(d.names)}</span>
                        ${smallSampleBadge}
                    </div>
                    <div class="text-end text-nowrap flex-shrink-0">
                        <span class="fw-bold fs-6 ${d.wr >= 60 ? 'text-success' : (d.wr <= 35 ? 'text-danger' : 'text-white')}">${Math.round(d.wr)}%</span>
                    </div>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1 text-muted small font-monospace" style="font-size:0.72rem; padding-left:18px;">
                    <span>${d.played} games together</span>
                    <span>${d.won}W – ${d.played - d.won}L</span>
                </div>
            </div>`;
        }).join('');
    };

    // D. Regulars Chemistry Matrix (Items 10-12).
    // Only a mount point here: the section re-renders itself from chemContext
    // whenever a control changes, so changing a filter does not rebuild — and
    // re-scroll — the whole Stats tab.
    const regularIds = Object.values(eloData.sortedList).filter(p => p.matches >= 10).map(p => p.id).slice(0, 26);
    chemContext = { chemData, regularIds, eloOrder: eloData.sortedList.map(p => p.id) };
    const heatmapRows = regularIds.length >= 4
        ? `<div class="col-12 mb-4"><div class="stat-card-custom" id="chemistryMatrixMount"></div></div>`
        : '';

    // E. Curse & Scoring Impact Cards
    const curseCardHtml = lineupData.cursed ? `
    <div class="col-12 col-md-4 mb-3">
        <div class="stat-card-custom border-danger border-opacity-50">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-muted small fw-bold" style="letter-spacing:0.5px">THE CURSE STAT (MIN 5 STD)</span>
                <i class="fas fa-ghost text-danger"></i>
            </div>
            <div class="fw-bold text-white fs-6 mb-1">${esc(lineupData.cursed.name)}</div>
            <div class="fs-4 fw-bold text-danger">${lineupData.cursed.avgGF} <span class="fs-6 text-muted">GF/game</span></div>
            <div class="small text-danger opacity-75 mt-1">${lineupData.cursed.deltaGF} vs league avg (${lineupData.leagueAvgGF} GF)</div>
            <small class="text-muted d-block mt-2" style="font-size:0.7rem">Lowers team scored goals regardless of result (${lineupData.cursed.games} games)</small>
        </div>
    </div>` : `<div class="col-12 col-md-4 mb-3"><div class="stat-card-custom"><div class="small text-muted">Needs at least 5 standard matches</div></div></div>`;

    const blessedCardHtml = lineupData.blessed ? `
    <div class="col-12 col-md-4 mb-3">
        <div class="stat-card-custom border-success border-opacity-50">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-muted small fw-bold" style="letter-spacing:0.5px">THE BLESSED STAT (MIN 5 STD)</span>
                <i class="fas fa-fire text-success"></i>
            </div>
            <div class="fw-bold text-white fs-6 mb-1">${esc(lineupData.blessed.name)}</div>
            <div class="fs-4 fw-bold text-success">${lineupData.blessed.avgGF} <span class="fs-6 text-muted">GF/game</span></div>
            <div class="small text-success opacity-75 mt-1">+${lineupData.blessed.deltaGF} vs league avg (${lineupData.leagueAvgGF} GF)</div>
            <small class="text-muted d-block mt-2" style="font-size:0.7rem">Highest team scored goals impact (${lineupData.blessed.games} games)</small>
        </div>
    </div>` : `<div class="col-12 col-md-4 mb-3"><div class="stat-card-custom"><div class="small text-muted">Needs at least 5 standard matches</div></div></div>`;

    const diffCardHtml = lineupData.topGD ? `
    <div class="col-12 col-md-4 mb-3">
        <div class="stat-card-custom border-info border-opacity-50">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-muted small fw-bold" style="letter-spacing:0.5px">GOAL DIFFERENTIAL (PLUS/MINUS)</span>
                <i class="fas fa-arrows-alt-v text-info"></i>
            </div>
            <div class="fw-bold text-white fs-6 mb-1">${esc(lineupData.topGD.name)}</div>
            <div class="fs-4 fw-bold text-info">+${lineupData.topGD.avgGD} <span class="fs-6 text-muted">GD/game</span></div>
            <div class="small text-muted mt-1">Goal differential per standard match</div>
            <small class="text-muted d-block mt-2" style="font-size:0.7rem">Separate plus/minus metric (${lineupData.topGD.games} games)</small>
        </div>
    </div>` : `<div class="col-12 col-md-4 mb-3"><div class="stat-card-custom"><div class="small text-muted">Needs at least 5 standard matches</div></div></div>`;

    // F. Most Improved of the Month
    const mostImprovedHtml = improvedData.candidates.length > 0 ? `
    <div class="col-12 col-md-6 mb-3">
        <div class="stat-card-custom">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-muted small fw-bold" style="letter-spacing:0.5px">MOST IMPROVED (${esc(improvedData.monthLabel.toUpperCase())})</span>
                <i class="fas fa-chart-line text-success"></i>
            </div>
            ${improvedData.candidates.slice(0, 3).map((c, i) => `
                <div class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary border-opacity-50">
                    <div>
                        <span class="fw-bold text-white small me-2">${i + 1}. ${esc(c.name)}</span>
                        <small class="text-muted font-monospace">(${c.monthGames} games in month)</small>
                    </div>
                    <div class="text-end">
                        <span class="fw-bold text-success fs-6">+${c.delta} PPG</span>
                        <small class="text-muted d-block" style="font-size:0.65rem">${c.monthPpg} vs ${c.allTimePpg} career</small>
                    </div>
                </div>
            `).join('')}
        </div>
    </div>` : `
    <div class="col-12 col-md-6 mb-3">
        <div class="stat-card-custom">
            <span class="text-muted small fw-bold d-block mb-2">MOST IMPROVED (${esc(improvedData.monthLabel.toUpperCase())})</span>
            <div class="small text-muted">No players with ${MIN_GAMES_IMPROVED}+ matches in ${esc(improvedData.monthLabel)} yet.</div>
        </div>
    </div>`;

    // G. Attendance & Milestones Cards
    const milestonePills = attendData.milestoneAchievers.map(m => `
        <span class="badge-milestone me-2 mb-2" onclick="openPlayerStats('${m.id}')" style="cursor:pointer">
            <i class="fas fa-medal text-dark"></i> ${esc(m.name)}: ${m.badges[m.badges.length - 1]}
        </span>
    `).join('') || '<div class="small text-muted">No milestone badges unlocked yet.</div>';

    const ironMenRows = attendData.ironMen.map((m, idx) => `
        <div class="d-flex justify-content-between py-1 border-bottom border-secondary border-opacity-50 small">
            <span class="text-white">${idx + 1}. ${esc(m.name)}</span>
            <span class="text-info fw-bold">${m.maxConsecutive} consecutive games</span>
        </div>
    `).join('');

    const attendanceLeadersRows = Object.values(attendData.attendanceStats)
        .filter(m => m.possibleSinceDebut >= 5)
        .sort((a, b) => b.attendanceRate - a.attendanceRate || b.played - a.played)
        .slice(0, 5)
        .map((m, idx) => `
        <div class="d-flex justify-content-between py-1 border-bottom border-secondary border-opacity-50 small">
            <span class="text-white">${idx + 1}. ${esc(m.name)}</span>
            <span class="text-white font-monospace">${m.attendanceRate}% <span class="text-muted">(${m.attendanceText})</span></span>
        </div>
    `).join('');

    // H. Venue Cards
    let venueCards = Object.entries(venueGoals).map(([v, d]) => {
        const avg = (d.goals / d.games).toFixed(1);
        // Venue names are longer than a half-width mobile card, so text-truncate
        // ate three of the five. Wrap instead — there is vertical room, and h-100
        // keeps the cards in a row level with each other.
        return `<div class="col-6 col-md-3 mb-2"><div class="bg-dark border border-secondary rounded p-2 text-center h-100"><div class="text-white small fw-bold" style="line-height:1.25">${esc(v)}</div><div class="fs-5 fw-bold text-info my-1">${avg}</div><small class="text-muted" style="font-size:0.65rem">${d.goals} Goals / ${d.games} Games</small></div></div>`;
    }).join('');

    // --- FINAL DASHBOARD ASSEMBLY ---
    insightsContainer.innerHTML = `
        <!-- OPTIMAL LINEUP HERO -->
        <div class="row">
            ${optimalLineupHtml}
        </div>

        <!-- POWER RANKINGS (ELO) LEADERBOARD -->
        <div class="row mb-4">
            <div class="col-12">
                <div class="stat-card-custom">
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <div>
                            <h6 class="fw-bold text-white mb-0"><i class="fas fa-bolt text-warning me-2"></i>ALL-TIME POWER RANKINGS (ELO ENGINE)</h6>
                            <small class="text-muted">Chronological rating (Starting 1200, K=32/48, Tournaments=16/24). All-time rating.</small>
                        </div>
                        <span class="badge bg-secondary">Top 10</span>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-dark table-hover mb-0 table-dark-custom text-center">
                            <thead>
                                <tr>
                                    <th class="ps-3 text-start">#</th>
                                    <th class="text-start">Player</th>
                                    <th>Elo Rating</th>
                                    <th class="pe-3">Matches</th>
                                </tr>
                            </thead>
                            <tbody>${powerRankingsRows}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- CURSE & SCORING IMPACT (STANDARD MATCHES ONLY) -->
        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-magic text-danger me-2"></i>SCORING IMPACT & GOAL STATS (STANDARD MATCHES ONLY)</h6>
        <div class="row mb-4">
            ${curseCardHtml}
            ${blessedCardHtml}
            ${diffCardHtml}
        </div>

        <!-- DUO & CHEMISTRY LEADERBOARDS -->
        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-user-friends text-primary me-2"></i>CHEMISTRY & DUO LEADERBOARDS (MIN ${MIN_GAMES_PAIR} GAMES TOGETHER)</h6>
        <div class="row mb-4">
            <div class="col-12 col-md-4 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-3"><i class="fas fa-skull-crossbones text-success me-2"></i>DEADLIEST DUOS</span>
                    ${renderDuoList(chemData.bestDuos)}
                </div>
            </div>
            <div class="col-12 col-md-4 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-3"><i class="fas fa-heart-broken text-danger me-2"></i>WORST DUOS</span>
                    ${renderDuoList(chemData.worstDuos)}
                </div>
            </div>
            <div class="col-12 col-md-4 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-3"><i class="fas fa-link text-info me-2"></i>MOST FREQUENT DUOS</span>
                    ${renderDuoList(chemData.mostPlayedDuos)}
                </div>
            </div>
        </div>

        <!-- REGULARS HEATMAP -->
        <div class="row">
            ${heatmapRows}
        </div>

        <!-- STREAKS & MOST IMPROVED -->
        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-fire text-warning me-2"></i>FORM & ATTENDANCE INSIGHTS</h6>
        <div class="row mb-4">
            ${mostImprovedHtml}
            <div class="col-12 col-md-6 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-2"><i class="fas fa-award text-warning me-2"></i>CAREER MILESTONE BADGES</span>
                    <div class="d-flex flex-wrap pt-2">${milestonePills}</div>
                </div>
            </div>
        </div>

        <!-- ATTENDANCE & CONSECUTIVE RUNS -->
        <div class="row mb-4">
            <div class="col-12 col-md-6 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-2"><i class="fas fa-calendar-check text-info me-2"></i>HIGHEST ATTENDANCE RATE SINCE DEBUT</span>
                    <small class="text-muted d-block mb-2">Denominator = group matches played since player's debut date</small>
                    ${attendanceLeadersRows}
                </div>
            </div>
            <div class="col-12 col-md-6 mb-3">
                <div class="stat-card-custom">
                    <span class="text-muted small fw-bold d-block mb-2"><i class="fas fa-dumbbell text-success me-2"></i>IRON MEN (LONGEST ATTENDANCE STREAKS)</span>
                    <small class="text-muted d-block mb-2">Most consecutive matches attended without missing</small>
                    ${ironMenRows}
                </div>
            </div>
        </div>

        <!-- VENUE GOAL AVERAGES -->
        <h6 class="small fw-bold text-muted mb-3"><i class="fas fa-map-marker-alt text-danger me-2"></i>VENUE GOAL AVERAGES (STANDARD MATCHES ONLY)</h6>
        <div class="row mb-4">${venueCards || '<div class="small text-muted">No venue goal stats.</div>'}</div>
    `;

    // Fill the chemistry mount now that it exists in the DOM.
    renderChemistryMatrix();
}

window.openPlayerStats = (targetIdOrName) => {
    const resolvedTargetId = resolvePlayerIdentifier(targetIdOrName) || targetIdOrName;
    window.activeModalPlayerId = resolvedTargetId;

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
    let monthly = {};
    let colorStats = { 'yellow': {p:0, w:0}, 'blue': {p:0, w:0}, 'red': {p:0, w:0} };
    let venueStats = {};

    pMatches.forEach(m => {
        played++;
        const dObj = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : new Date();
        const monthIdx = dObj.getMonth();
        if(!monthly[monthIdx]) monthly[monthIdx] = {p:0, w:0, pts:0};
        
        let matchPts=0, result='L', matchGF=0, matchGA=0, myColor='';

        if(m.type==='Standard') {
            standardPlayed++;
            const tA=m.teams[0]; const inA=(tA.players||[]).some(matchesPlayer);
            const myS=inA?tA.score:m.teams[1].score;
            const opS=inA?m.teams[1].score:tA.score;
            matchGF = myS; matchGA = opS;
            myColor = inA ? (m.colors?.[0]||'blue') : (m.colors?.[1]||'red');
            
            if(myS>opS) {w++; matchPts=3; result='W';} else if(myS==opS) {matchPts=1; result='D';}
        } else {
            const myTeam = m.teams.find(t=>(t.players||[]).some(matchesPlayer));
            matchPts = myTeam.points !== undefined ? myTeam.points : (myTeam.rank===1 ? 3 : (myTeam.rank===2 ? 1 : 0));
            
            let ogKey = myTeam.originalKey || ''; 
            if(ogKey) myColor = ogKey === 'A' ? 'yellow' : (ogKey === 'B' ? 'blue' : 'red');
            else myColor = (myTeam.teamName||'').toLowerCase().includes('y') ? 'yellow' : ((myTeam.teamName||'').toLowerCase().includes('b') ? 'blue' : 'red');

            if(matchPts >= 3) {w++; result='W';} else if(matchPts === 1) {result='D';} else {result='L';}
        }

        if(colorStats[myColor]) {
            colorStats[myColor].p++;
            if(result === 'W') colorStats[myColor].w++;
        }

        if(!venueStats[m.location]) venueStats[m.location] = {p:0, w:0};
        venueStats[m.location].p++;
        if(result === 'W') venueStats[m.location].w++;

        pts += matchPts; totalGF += matchGF; totalGA += matchGA;
        monthly[monthIdx].p++; monthly[monthIdx].pts += matchPts; if(result==='W') monthly[monthIdx].w++;
    });

    const winRate = Math.round((w/played)*100);
    const goalsPerGame = standardPlayed > 0 ? (totalGF / standardPlayed).toFixed(2) : '0.00';
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

    // Stage D Computations for this player
    const targetPlayerId = playersRegistry.has(targetIdOrName) ? playersRegistry.get(targetIdOrName).id : targetIdOrName;
    const streaksData = computePlayerStreaksAndForm(allMatches, targetPlayerId);
    const rivalryData = computeNemesisAndRivalry(allMatches, targetPlayerId);
    const attendanceAll = computeAttendanceAndMilestones(allMatches);
    const playerAttend = attendanceAll.attendanceStats[targetPlayerId] || { attendanceText: `${played} of ${allMatches.length}`, debutDate: 'Unknown', badges: [] };

    // Elo Rating & Provisional status
    const eloInfo = latestEloMap.get(targetPlayerId) || { rating: STARTING_ELO, matches: played, isProvisional: played < MIN_GAMES_RANKED_ELO };
    const eloBadge = eloInfo.isProvisional ? `<span class="badge-provisional ms-2" title="Provisional — ${eloInfo.matches} of ${MIN_GAMES_RANKED_ELO} games">? Provisional (${eloInfo.matches}/${MIN_GAMES_RANKED_ELO})</span>` : '';

    // Form Badges: W W D W L (most recent last)
    const formDisplay = streaksData.form5.length > 0 ? streaksData.form5.map(r => `
        <span class="badge-form badge-form-${r.toLowerCase()}">${r}</span>
    `).join('') : '<span class="text-muted small">No matches yet</span>';

    // Rolling PPG SVG Chart
    const ppgChartSvg = renderRollingPpgSvg(streaksData.rollingPpgHistory);

    // Nemesis Display
    let nemesisHtml = '';
    if (rivalryData.nemesis && rivalryData.nemesis.lost > 0) {
        nemesisHtml = `
        <div class="p-3 bg-dark border border-danger border-opacity-50 rounded mb-3">
            <div class="d-flex justify-content-between align-items-center mb-1">
                <span class="text-danger small fw-bold"><i class="fas fa-skull me-1"></i> NEMESIS</span>
                <span class="badge bg-danger bg-opacity-25 text-danger font-monospace">${rivalryData.nemesis.lost} Losses</span>
            </div>
            <div class="text-white fw-bold fs-6 mb-1">${esc(rivalryData.nemesis.name)}</div>
            <div class="small text-muted">Lost ${rivalryData.nemesis.lost} of ${rivalryData.nemesis.played} meetings <span class="text-light font-monospace">(${rivalryData.nemesis.won}W-${rivalryData.nemesis.drawn}D-${rivalryData.nemesis.lost}L)</span></div>
        </div>`;
    } else {
        nemesisHtml = `
        <div class="p-2 bg-dark border border-secondary rounded mb-3 text-center small text-muted">
            <i class="fas fa-shield-alt me-1 opacity-50"></i> No nemesis yet — needs at least ${MIN_GAMES_PAIR} meetings
        </div>`;
    }

    // Duo Split Display (Record Together vs Record Opposed)
    const duoSplitRows = rivalryData.duoSplits.slice(0, 3).map(d => {
        const togText = d.together ? `<span class="text-success">${d.together.wr}% W <small class="text-muted">(${d.together.won}W/${d.together.played}P)</small></span>` : '<span class="text-muted">&lt;3P</span>';
        const oppText = d.opposed ? `<span class="text-danger">${d.opposed.wr}% W <small class="text-muted">(${d.opposed.won}W/${d.opposed.played}P)</small></span>` : '<span class="text-muted">&lt;3P</span>';
        return `
        <div class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary border-opacity-50 small">
            <span class="text-white fw-bold"><i class="fas fa-user me-2 text-muted opacity-50"></i>${esc(d.name)}</span>
            <div class="text-end">
                <div><small class="text-muted me-1">Together:</small> ${togText}</div>
                <div><small class="text-muted me-1">Opposed:</small> ${oppText}</div>
            </div>
        </div>`;
    }).join('');

    // Milestone Badges in Modal Header
    const milestoneBadgesHtml = (playerAttend.badges || []).map(b => `
        <span class="badge-milestone me-1"><i class="fas fa-medal text-dark"></i> ${b}</span>
    `).join('');

    let monthRows = "";
    Object.keys(monthly).sort((a,b)=>a-b).forEach(mIdx => {
        const d = monthly[mIdx];
        monthRows += `<div class="d-flex justify-content-between py-2 border-bottom border-secondary small"><div style="width:40px" class="text-muted">${months[mIdx]}</div><div style="width:30px" class="text-center">${d.p}</div><div style="width:30px" class="text-center">${d.w}</div><div style="width:30px" class="text-center fw-bold text-white">${d.pts}</div></div>`;
    });

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
        <!-- ELO & MILESTONES HEADER -->
        <div class="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom border-secondary">
            <div>
                <span class="fs-5 fw-bold text-warning">${eloInfo.rating}</span> <small class="text-muted fw-bold">ELO</small>
                ${eloBadge}
            </div>
            <div>${milestoneBadgesHtml}</div>
        </div>

        <!-- 4-BOX STAT SUMMARY -->
        <div class="row text-center mb-3 g-0 border border-secondary rounded overflow-hidden shadow-sm">
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${played}</div><small class="text-muted" style="font-size:0.6rem">PLAYED</small></div>
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${w}</div><small class="text-muted" style="font-size:0.6rem">WON</small></div>
            <div class="col-3 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${winRate}%</div><small class="text-muted" style="font-size:0.6rem">RATE</small></div>
            <div class="col-3 bg-dark p-2"><div class="fw-bold text-info">${goalsPerGame}</div><small class="text-muted" style="font-size:0.6rem">G/G (STD)</small></div>
        </div>

        <!-- GOALS (STANDARD ONLY) & ATTENDANCE SINCE DEBUT -->
        <div class="mb-3 p-2 rounded bg-body border border-secondary small text-muted">
            <div class="d-flex justify-content-between"><span>Goals (Standard Matches Only):</span><span class="text-white fw-bold">${totalGF} GF / ${totalGA} GA (GD: ${totalGF - totalGA})</span></div>
            <div class="d-flex justify-content-between mt-1"><span>Attendance Rate:</span><span class="text-white fw-bold">${playerAttend.attendanceText}</span></div>
            <div class="d-flex justify-content-between mt-1"><span>Debut Date:</span><span class="text-white">${playerAttend.debutDate}</span></div>
        </div>

        <!-- FORM GUIDE & STREAKS -->
        <div class="bg-dark p-3 rounded border border-secondary mb-3">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <small class="text-muted fw-bold" style="letter-spacing:0.5px;">ROLLING 5-MATCH FORM</small>
                <div>${formDisplay}</div>
            </div>
            <div class="d-flex justify-content-between pt-2 border-top border-secondary border-opacity-50 small">
                <div><small class="text-muted d-block">Current Win Run</small><span class="fw-bold text-success">${streaksData.curW}</span></div>
                <div><small class="text-muted d-block">Max Win Run</small><span class="fw-bold text-success">${streaksData.maxW}</span></div>
                <div><small class="text-muted d-block">Max Loss Run</small><span class="fw-bold text-danger">${streaksData.maxL}</span></div>
                <div><small class="text-muted d-block">Max Unbeaten</small><span class="fw-bold text-info">${streaksData.maxU}</span></div>
            </div>
        </div>

        <!-- ROLLING 5-GAME PPG CHART -->
        ${ppgChartSvg}

        <!-- NEMESIS & HEAD-TO-HEAD -->
        <h6 class="small fw-bold text-muted mb-2">NEMESIS & HEAD-TO-HEAD</h6>
        ${nemesisHtml}

        <!-- DUO SPLITS (TOGETHER VS OPPOSED) -->
        <h6 class="small fw-bold text-muted mb-2">KEY RIVALRIES (TOGETHER VS OPPOSED)</h6>
        <div class="bg-dark p-2 rounded border border-secondary mb-3">
            ${duoSplitRows || '<div class="small text-muted p-2 text-center">Needs at least 3 meetings with a teammate/opponent</div>'}
        </div>

        <!-- COLOR & VENUE STATS -->
        <h6 class="small fw-bold text-muted mb-2">WIN RATE BY COLOR</h6>
        <div class="row g-1 mb-3">${colorsHtml}</div>

        <h6 class="small fw-bold text-muted mb-2">WIN RATE BY VENUE</h6>
        <div class="bg-dark p-2 rounded border border-secondary mb-3">${venuesHtml}</div>

        <!-- MONTHLY BREAKDOWN -->
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
    if(!isOrganizer(currentUser)) return alert("Organizer access required.");

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

        // Item 42: Link to scheduled fixture if active or matching
        try {
            let fixtureToResolve = window.activeLinkedFixtureId;
            if (!fixtureToResolve && allFixtures && allFixtures.length > 0) {
                const scheduledF = allFixtures.find(f => f.status === 'scheduled');
                if (scheduledF && scheduledF.squads && scheduledF.squads.length >= 2 && matchData.teams) {
                    const sCount = Math.min(scheduledF.squads.length, matchData.teams.length);
                    let allMatched = sCount >= 2;
                    for (let sIdx = 0; sIdx < sCount; sIdx++) {
                        const fP = scheduledF.squads[sIdx].players || [];
                        const mP = (matchData.teams[sIdx] || {}).players || [];
                        const overlap = fP.filter(p => mP.includes(p)).length;
                        if (overlap < 2 && fP.length > 0) {
                            allMatched = false;
                            break;
                        }
                    }
                    if (allMatched) {
                        fixtureToResolve = scheduledF.id;
                    }
                }
            }

            if (fixtureToResolve) {
                const resolveFn = functions.httpsCallable('resolveFixtureToMatch');
                await resolveFn({ fixtureId: fixtureToResolve, matchId: docRef.id });
                window.activeLinkedFixtureId = null;
            }
        } catch (resErr) {
            console.warn("Could not resolve fixture to match:", resErr.message);
        }

        // Stage D+ Item 33: Trigger AI match recap in background (fire-and-forget, never blocks save)
        try {
            const genRecapFn = functions.httpsCallable('generateMatchRecap');
            genRecapFn({ matchId: docRef.id }).catch(recapErr => {
                console.warn("Background recap generation skipped/failed:", recapErr.message);
            });
        } catch (e) {
            console.warn("Could not invoke generateMatchRecap:", e);
        }

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
            if (id === 'javi_bernardo') {
                ['javi garcia', 'javi garcia bernardo', 'garcia bernardo'].forEach(a => {
                    if (!aliases.includes(a)) aliases.push(a);
                });
            }
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

/* ==========================================================================
   STAGE D+: AI EXTENSIONS CLIENT HANDLERS
   ========================================================================== */

/** Item 33: Manual Recap Regeneration */
window.regenerateRecap = async (matchId, event) => {
    if (event) event.stopPropagation();
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");

    const btn = event ? event.currentTarget : null;
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span>`;
    }

    try {
        const genRecapFn = functions.httpsCallable('generateMatchRecap');
        const res = await genRecapFn({ matchId });
        if (res.data && res.data.ok) {
            const m = allMatches.find(x => x.id === matchId);
            if (m) {
                m.recap = res.data.recap || null;
                m.recapAngle = res.data.angle || null;
                m.recapScore = res.data.score || 0;
                m.recapModel = res.data.modelUsed || null;
            }
            renderData();
            if (res.data.recap) {
                showToast(`Recap generated (${res.data.angle}, score ${res.data.score})`);
            } else {
                showToast(`No recap generated (highest angle score ${res.data.score} below threshold)`);
            }
        }
    } catch (err) {
        alert(`Failed to regenerate recap: ${err.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
};

/** Item 34: AI Stats Assistant Query */
window.autoResizeTextarea = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    const newHeight = Math.min(el.scrollHeight, 160);
    el.style.height = `${newHeight}px`;
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
};

window.handleStatsQueryKeydown = (e, el) => {
    if (e.key === 'Enter') {
        if (e.shiftKey) {
            // Shift + Enter: Allow new line and auto-expand downward
            setTimeout(() => {
                window.autoResizeTextarea(el);
            }, 0);
        } else {
            // Enter alone: Submit query
            e.preventDefault();
            window.executeStatsQuery();
        }
    }
};

window.setQueryPrompt = (text) => {
    const input = document.getElementById('statsQueryInput');
    if (input) {
        input.value = text;
        window.autoResizeTextarea(input);
        window.executeStatsQuery();
    }
};

window.executeStatsQuery = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");

    const input = document.getElementById('statsQueryInput');
    const qText = input ? input.value.trim() : '';
    if (!qText) return alert("Please enter a question.");

    const spinner = document.getElementById('statsQuerySpinner');
    const btn = document.getElementById('statsQueryBtn');
    const resBox = document.getElementById('statsQueryResponse');

    if (spinner) spinner.classList.remove('d-none');
    if (btn) btn.disabled = true;

    try {
        const queryFn = functions.httpsCallable('queryStats');
        const res = await queryFn({ question: qText });
        const data = res.data;

        if (data && data.ok) {
            let cleanAnswer = data.answer || '';
            try {
                if (typeof cleanAnswer === 'string' && cleanAnswer.trim().startsWith('{') && cleanAnswer.trim().endsWith('}')) {
                    const parsed = JSON.parse(cleanAnswer.trim());
                    cleanAnswer = parsed.answer || parsed.response || parsed.text || cleanAnswer;
                }
            } catch (e) {}

            if (resBox) {
                resBox.classList.remove('d-none');
                resBox.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center mb-2 pb-1 border-bottom border-secondary border-opacity-50">
                        <span class="text-info fw-bold"><i class="fas fa-robot me-1"></i>AI Assistant</span>
                        <span class="badge bg-secondary font-monospace" style="font-size:0.7rem">${esc(data.modelUsed)}</span>
                    </div>
                    <div class="text-white" style="line-height:1.6; font-size:0.9rem;">${esc(cleanAnswer)}</div>
                `;
                setTimeout(() => {
                    resBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 50);
            }
        }
    } catch (err) {
        if (resBox) {
            resBox.classList.remove('d-none');
            resBox.innerHTML = `<span class="text-danger"><i class="fas fa-exclamation-circle me-1"></i>${esc(err.message)}</span>`;
            setTimeout(() => {
                resBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }
    } finally {
        if (spinner) spinner.classList.add('d-none');
        if (btn) btn.disabled = false;
    }
};

/** Item 36: Alias Suggestion on Player Creation */
window.suggestPlayerAliases = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");

    const nameInput = document.getElementById('newPlayerDisplayName');
    const displayName = nameInput ? nameInput.value.trim() : '';
    if (!displayName) return alert("Please enter a player Display Name first.");

    const spinner = document.getElementById('suggestAliasSpinner');
    const box = document.getElementById('suggestedAliasesBox');
    const list = document.getElementById('suggestedAliasesList');

    if (spinner) spinner.classList.remove('d-none');

    try {
        const suggestFn = functions.httpsCallable('suggestAliases');
        const res = await suggestFn({ displayName });
        const data = res.data;

        if (data && data.ok && data.suggestions && data.suggestions.length > 0) {
            if (list) {
                list.innerHTML = data.suggestions.map(alias => `
                    <button type="button" class="btn btn-sm btn-outline-info py-0 px-2" style="font-size:0.75rem;" onclick="appendSuggestedAlias('${esc(alias)}', this)">
                        + ${esc(alias)}
                    </button>
                `).join('');
            }
            if (box) box.classList.remove('d-none');
        } else {
            alert("No new alias suggestions found.");
        }
    } catch (err) {
        alert(`Error suggesting aliases: ${err.message}`);
    } finally {
        if (spinner) spinner.classList.add('d-none');
    }
};

window.appendSuggestedAlias = (alias, btn) => {
    const input = document.getElementById('newPlayerAliases');
    if (!input) return;
    const current = input.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!current.includes(alias.toLowerCase())) {
        current.push(alias.toLowerCase());
        input.value = current.join(', ');
    }
    if (btn) {
        btn.classList.remove('btn-outline-info');
        btn.classList.add('btn-success');
        btn.disabled = true;
    }
};

/** Item 37: Data Health Audit */
window.openDataHealthAudit = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");

    const modalEl = document.getElementById('dataHealthModal');
    if (!modalEl) return;
    const modal = new bootstrap.Modal(modalEl);
    modal.show();

    const spinner = document.getElementById('dataHealthSpinner');
    const content = document.getElementById('dataHealthContent');

    if (spinner) spinner.classList.remove('d-none');
    if (content) content.innerHTML = '';

    try {
        const auditFn = functions.httpsCallable('auditDataHealth');
        const res = await auditFn();
        const data = res.data;

        if (data && data.ok) {
            if (content) {
                content.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom border-secondary">
                        <span class="text-success fw-bold"><i class="fas fa-check-circle me-1"></i>Audit Completed</span>
                        <span class="badge bg-secondary font-monospace" style="font-size:0.75rem">Model: ${esc(data.modelUsed)}</span>
                    </div>
                    <div class="bg-body p-3 rounded border border-secondary" style="font-family: monospace; font-size: 0.85rem; white-space: pre-wrap;">${esc(data.report)}</div>
                `;
            }
        }
    } catch (err) {
        if (content) {
            content.innerHTML = `<div class="alert alert-danger py-2 px-3 small"><i class="fas fa-exclamation-triangle me-1"></i>Audit failed: ${esc(err.message)}</div>`;
        }
    } finally {
        if (spinner) spinner.classList.add('d-none');
    }
};

/* ======================================================================
   STAGE E: COMMUNITY LAYER & PWA (ITEMS 25, 28, 29, 32, 38, 39)
   ====================================================================== */

/** Item 32: Toast Notification Helper */
window.showToast = (msg) => {
    const toastEl = document.getElementById('liveToast');
    const toastMsg = document.getElementById('toastMessage');
    if (!toastEl || !toastMsg) return;
    toastMsg.textContent = msg;
    if (typeof bootstrap !== 'undefined' && bootstrap.Toast) {
        const toast = bootstrap.Toast.getOrCreateInstance(toastEl);
        toast.show();
    }
};

/** Item 32: Deep Link Generator & Native Share */
window.copyShareLink = async (type, id, title = 'Elderly Support League', event = null) => {
    if (event) event.stopPropagation();
    const url = `${window.location.origin}${window.location.pathname}?${type}=${encodeURIComponent(id)}`;
    
    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
        try {
            await navigator.share({ title, url });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
            showToast('Link copied to clipboard!');
        } else {
            prompt('Copy share link:', url);
        }
    } catch (e) {
        prompt('Copy share link:', url);
    }
};

window.shareCurrentPlayer = () => {
    if (window.activeModalPlayerId) {
        const name = getPlayerDisplayName(window.activeModalPlayerId);
        copyShareLink('player', window.activeModalPlayerId, `${name}'s Stats — Elderly Support`);
    }
};

/** Item 32: Deep Link Identifier Resolver */
function resolvePlayerIdentifier(targetIdOrName, registry = playersRegistry) {
    if (!targetIdOrName) return null;
    const clean = String(targetIdOrName).trim().toLowerCase();
    if (registry.has(targetIdOrName)) return targetIdOrName;

    for (const [pId, p] of registry.entries()) {
        if (pId.toLowerCase() === clean) return pId;
        if ((p.displayName || '').toLowerCase() === clean) return pId;
        if ((p.aliases || []).some(a => String(a).toLowerCase() === clean)) return pId;
    }
    return null;
}

let deepLinkHandled = false;
function handleDeepLinks() {
    if (deepLinkHandled) return;
    const params = new URLSearchParams(window.location.search);

    const playerParam = params.get('player');
    const matchParam = params.get('match');
    const roastParam = params.get('roast');
    const fixtureParam = params.get('fixture');
    const tabParam = params.get('tab');

    if (playerParam) {
        deepLinkHandled = true;
        const resolvedId = resolvePlayerIdentifier(playerParam);
        if (resolvedId) {
            setTimeout(() => openPlayerStats(resolvedId), 250);
        } else {
            showToast(`Player "${playerParam}" not found.`);
        }
    } else if (matchParam) {
        deepLinkHandled = true;
        const triggerTab = document.querySelector('[data-bs-target="#matches"]');
        if (triggerTab && typeof bootstrap !== 'undefined') {
            bootstrap.Tab.getOrCreateInstance(triggerTab).show();
        }
        setTimeout(() => {
            const card = document.getElementById(`match-${matchParam}`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('border-warning');
                setTimeout(() => card.classList.remove('border-warning'), 3000);
            } else {
                showToast('Match record not found.');
            }
        }, 300);
    } else if (roastParam) {
        // copyShareLink('roast', ...) has always produced these URLs; nothing
        // used to read them, so a shared roast link just landed on the homepage.
        deepLinkHandled = true;
        openSharedRoast(roastParam);
    } else if (fixtureParam) {
        deepLinkHandled = true;
        openSharedFixture(fixtureParam);
    } else if (tabParam) {
        deepLinkHandled = true;
        const triggerTab = document.querySelector(`[data-bs-target="#${tabParam}"]`);
        if (triggerTab && typeof bootstrap !== 'undefined') {
            bootstrap.Tab.getOrCreateInstance(triggerTab).show();
        }
    }
}

/** Resolve once `cond()` is truthy, or give up after `timeoutMs`. */
function waitFor(cond, timeoutMs = 2500) {
    if (cond()) return Promise.resolve(true);
    return new Promise(resolve => {
        const started = Date.now();
        const tick = () => {
            if (cond()) return resolve(true);
            if (Date.now() - started > timeoutMs) return resolve(false);
            setTimeout(tick, 100);
        };
        tick();
    });
}

function showCommunityTab() {
    const triggerTab = document.querySelector('[data-bs-target="#community"]');
    if (triggerTab && typeof bootstrap !== 'undefined') {
        bootstrap.Tab.getOrCreateInstance(triggerTab).show();
    }
}

async function openSharedFixture(fixtureId) {
    showCommunityTab();
    await waitFor(() => allFixtures.length > 0);
    await waitFor(() => !!document.getElementById('nextGameScheduledCard'), 1200);
    const featured = selectFeaturedFixture(allFixtures);
    const card = document.getElementById('nextGameScheduledCard');
    if (card && featured && featured.fixture.id === fixtureId) return highlightCard(card);
    showToast('That fixture is no longer the next game.');
}

function highlightCard(card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('border-warning');
    setTimeout(() => card.classList.remove('border-warning'), 3000);
}

/**
 * A shared roast link must work for any published roast, not only the one
 * currently featured — the featured one rotates and eventually goes stale.
 * Reads the document directly; rules allow a public get on a published roast.
 */
async function openSharedRoast(roastId) {
    showCommunityTab();

    // Deep links fire on DOMContentLoaded, before the roasts snapshot has
    // arrived. Without this wait, a link to the *featured* roast would decide
    // "not featured" against an empty list and open the modal over the very
    // card it should have highlighted.
    // The snapshot has to land AND the tab has to render before the card exists.
    await waitFor(() => allRoasts.length > 0);
    await waitFor(() => !!document.getElementById('roastOfTheWeekCard'), 1200);

    let roast = allRoasts.find(r => r.id === roastId);
    if (!roast) {
        try {
            const doc = await db.collection('roasts').doc(roastId).get();
            if (doc.exists) roast = { id: doc.id, ...doc.data() };
        } catch (e) {
            console.warn('Shared roast fetch failed:', e.message);
        }
    }

    if (!roast || roast.status !== 'published') {
        return showToast('That roast is no longer available.');
    }

    const featured = selectFeaturedRoast(allRoasts);
    const card = document.getElementById('roastOfTheWeekCard');
    if (card && featured && featured.roast.id === roastId) {
        return highlightCard(card);
    }

    const titleEl = document.getElementById('pairDetailTitle');
    const bodyEl = document.getElementById('pairDetailBody');
    const modalEl = document.getElementById('pairDetailModal');
    if (!titleEl || !bodyEl || !modalEl) return;

    const when = roastMillis(roast);
    titleEl.textContent = `Roast: ${getPlayerDisplayName(roast.targetPlayerId) || roast.targetPlayerName || ''}`;
    bodyEl.innerHTML = `
        <div class="text-light fst-italic mb-3" style="font-size:1rem; line-height:1.55;">"${esc(roast.roastText || '')}"</div>
        <div class="small text-muted border-top border-secondary border-opacity-25 pt-2 d-flex flex-wrap justify-content-between gap-2">
            <span><i class="fas fa-check-circle text-info me-1"></i>Facts: ${esc(roast.facts || '—')}</span>
            <span>${when ? esc(formatDate(new Date(when))) : ''}</span>
        </div>`;
    if (typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/** Item 25: Weekly Power Rankings Computation */
function computeWeeklyPowerRankings(matches, customCutoffDate = null, customLatestDate = null) {
    if (!matches || matches.length === 0) {
        return { dateRangeText: '', hasMatchesInWindow: false, rankings: [] };
    }

    const sorted = [...matches].filter(m => m.date && m.teams && m.teams.length >= 2).sort((a, b) => {
        const tA = a.date ? (a.date.toDate ? a.date.toDate().getTime() : new Date(a.date).getTime()) : 0;
        const tB = b.date ? (b.date.toDate ? b.date.toDate().getTime() : new Date(b.date).getTime()) : 0;
        if (tA !== tB) return tA - tB;
        return (a.id || '').localeCompare(b.id || '');
    });

    if (sorted.length === 0) {
        return { dateRangeText: '', hasMatchesInWindow: false, rankings: [] };
    }

    const latestDate = customLatestDate || (sorted[sorted.length - 1].date.toDate ? sorted[sorted.length - 1].date.toDate() : new Date(sorted[sorted.length - 1].date));
    const cutoffDate = customCutoffDate || new Date(latestDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const matchesInWindow = sorted.filter(m => {
        const d = m.date.toDate ? m.date.toDate() : new Date(m.date);
        return d > cutoffDate && d <= latestDate;
    });

    // 1. Compute Elo as of latestDate
    const currentEloData = computeEloRatings(sorted.filter(m => {
        const d = m.date.toDate ? m.date.toDate() : new Date(m.date);
        return d <= latestDate;
    }));

    // 2. Compute Elo as of cutoffDate
    const prevMatches = sorted.filter(m => {
        const d = m.date.toDate ? m.date.toDate() : new Date(m.date);
        return d <= cutoffDate;
    });
    const prevEloData = computeEloRatings(prevMatches);

    // Map previous ranks among players who had >= MIN_GAMES_RANKED_ELO (5) at cutoff
    const prevRanked = [...(prevEloData.sortedList || [])]
        .filter(p => !p.isProvisional)
        .sort((a, b) => b.rawRating - a.rawRating || a.name.localeCompare(b.name));

    const prevRankMap = new Map();
    prevRanked.forEach((p, idx) => {
        prevRankMap.set(p.id, idx + 1);
    });

    // Current non-provisional vs provisional
    const currNonProvisional = [...(currentEloData.sortedList || [])]
        .filter(p => !p.isProvisional)
        .sort((a, b) => b.rawRating - a.rawRating || a.name.localeCompare(b.name));

    const currProvisional = [...(currentEloData.sortedList || [])]
        .filter(p => p.isProvisional)
        .sort((a, b) => b.rawRating - a.rawRating || a.name.localeCompare(b.name));

    const rankings = [];

    currNonProvisional.forEach((p, idx) => {
        const currRank = idx + 1;
        const hadPrevRank = prevRankMap.has(p.id);
        let delta = null;
        let isNew = false;

        if (hadPrevRank) {
            delta = prevRankMap.get(p.id) - currRank;
        } else {
            isNew = true;
        }

        rankings.push({
            rank: currRank,
            id: p.id,
            name: p.name,
            elo: p.rating,
            rawRating: p.rawRating,
            matches: p.matches,
            wins: p.wins,
            isProvisional: false,
            delta,
            isNew
        });
    });

    currProvisional.forEach(p => {
        rankings.push({
            rank: '-',
            id: p.id,
            name: p.name,
            elo: p.rating,
            rawRating: p.rawRating,
            matches: p.matches,
            wins: p.wins,
            isProvisional: true,
            delta: null,
            isNew: false
        });
    });

    return {
        dateRangeText: `${formatDate(cutoffDate)} – ${formatDate(latestDate)}`,
        hasMatchesInWindow: matchesInWindow.length > 0,
        matchesInWindowCount: matchesInWindow.length,
        rankings
    };
}

/** Item 28: Milestone Watch Computation */
function computeMilestoneWatch(matches, interval = MILESTONE_INTERVAL) {
    if (!matches) return [];

    const capsMap = {};
    matches.forEach(m => {
        if (!m.teams) return;
        m.teams.forEach(t => {
            (t.players || []).forEach(p => {
                capsMap[p] = (capsMap[p] || 0) + 1;
            });
        });
    });

    const watchlist = [];
    Object.entries(capsMap).forEach(([pId, caps]) => {
        if (caps <= 0) return;
        let nextM = Math.ceil((caps + 0.1) / interval) * interval;
        if (caps % interval === 0) nextM = caps + interval;
        const away = nextM - caps;

        if (away === 1 || away === 2) {
            const name = getPlayerDisplayName(pId);
            watchlist.push({
                playerId: pId,
                name,
                caps,
                nextMilestone: nextM,
                away,
                copy: `${name} — ${caps} caps (${away} away from ${nextM})`
            });
        }
    });

    return watchlist.sort((a, b) => a.away - b.away || b.caps - a.caps);
}

/** Item 29: Monthly Awards Computation */
function computeMonthlyAwards(matches, year, month, careerMatches = null) {
    const allM = careerMatches || matches;
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    // If month === 'all' or undefined, find the latest active month in matches
    let targetMonth = month;
    if (targetMonth === 'all' || targetMonth === undefined || targetMonth === null) {
        const activeMonths = [];
        matches.forEach(m => {
            const d = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : null;
            if (!d || isNaN(d.getTime())) return;
            const y = d.getFullYear();
            if (year === 'all' || y === parseInt(year)) {
                const mo = d.getMonth();
                if (!activeMonths.includes(mo)) activeMonths.push(mo);
            }
        });
        activeMonths.sort((a, b) => b - a);
        targetMonth = activeMonths.length > 0 ? String(activeMonths[0]) : String(new Date().getMonth());
    }

    const monthNum = parseInt(targetMonth);
    const monthName = (!isNaN(monthNum) && monthNames[monthNum]) ? monthNames[monthNum] : monthNames[new Date().getMonth()];
    const monthMatches = matches.filter(m => matchesFilter(m, year, targetMonth));

    if (monthMatches.length === 0) {
        return {
            hasMatches: false,
            month: targetMonth,
            monthName,
            year,
            totalMonthMatches: 0,
            maxPlayedInMonth: 0,
            potm: null,
            mostImproved: null,
            ironMen: [],
            worstDuo: null,
            ghost: null
        };
    }

    const monthPlayerStats = {};
    const monthDuos = {};

    monthMatches.forEach(m => {
        if (!m.teams || m.teams.length < 2) return;
        if (m.type === 'Standard') {
            const tA = m.teams[0], tB = m.teams[1];
            const sA = tA.score || 0, sB = tB.score || 0;
            const ptsA = sA > sB ? 3 : (sA === sB ? 1 : 0);
            const ptsB = sB > sA ? 3 : (sB === sA ? 1 : 0);

            [ { t: tA, pts: ptsA }, { t: tB, pts: ptsB } ].forEach(({ t, pts }) => {
                const pList = t.players || [];
                pList.forEach(p => {
                    if (!monthPlayerStats[p]) monthPlayerStats[p] = { id: p, name: getPlayerDisplayName(p), played: 0, won: 0, drawn: 0, lost: 0, pts: 0 };
                    monthPlayerStats[p].played++;
                    monthPlayerStats[p].pts += pts;
                    if (pts === 3) monthPlayerStats[p].won++;
                    else if (pts === 1) monthPlayerStats[p].drawn++;
                    else monthPlayerStats[p].lost++;
                });

                const sortedP = [...pList].sort();
                for (let i = 0; i < sortedP.length; i++) {
                    for (let j = i + 1; j < sortedP.length; j++) {
                        const key = `${sortedP[i]}__${sortedP[j]}`;
                        if (!monthDuos[key]) monthDuos[key] = { p1: sortedP[i], p2: sortedP[j], played: 0, won: 0 };
                        monthDuos[key].played++;
                        if (pts === 3) monthDuos[key].won++;
                    }
                }
            });
        } else {
            m.teams.forEach(t => {
                const pts = t.points !== undefined ? t.points : (t.rank === 1 ? 3 : (t.rank === 2 ? 1 : 0));
                (t.players || []).forEach(p => {
                    if (!monthPlayerStats[p]) monthPlayerStats[p] = { id: p, name: getPlayerDisplayName(p), played: 0, won: 0, drawn: 0, lost: 0, pts: 0 };
                    monthPlayerStats[p].played++;
                    monthPlayerStats[p].pts += pts;
                    if (pts >= 3) monthPlayerStats[p].won++;
                    else if (pts === 1) monthPlayerStats[p].drawn++;
                    else monthPlayerStats[p].lost++;
                });
            });
        }
    });

    // Career player stats for baseline
    const careerStats = {};
    allM.forEach(m => {
        if (!m.teams) return;
        m.teams.forEach(t => {
            const pts = m.type === 'Standard' ? (t.score > (m.teams[0] === t ? m.teams[1].score : m.teams[0].score) ? 3 : (t.score === (m.teams[0] === t ? m.teams[1].score : m.teams[0].score) ? 1 : 0)) : (t.points !== undefined ? t.points : (t.rank === 1 ? 3 : 0));
            (t.players || []).forEach(p => {
                if (!careerStats[p]) careerStats[p] = { played: 0, pts: 0 };
                careerStats[p].played++;
                careerStats[p].pts += pts;
            });
        });
    });

    /* Item 9: tiered qualification.
       Every award records WHICH threshold produced it, so a thin month can be
       labelled honestly instead of rendering an empty card. The tiers run
       strictest first and the first non-empty one wins:
         'qualified' — met the intended threshold, no caveat
         'relaxed'   — threshold lowered to fit a short month
         'best'      — no threshold left; showing the best available
       If a month contains any match at all, every award that can have a winner
       gets one. */
    const pickTier = (tiers) => {
        for (const t of tiers) {
            const list = t.list();
            if (list.length > 0) {
                return { ...list[0], tier: t.tier, note: t.note(list[0], list.length), poolSize: list.length };
            }
        }
        return null;
    };

    const monthPlayers = Object.values(monthPlayerStats);
    const adaptiveMin = Math.max(1, Math.min(MIN_GAMES_IMPROVED, Math.ceil(monthMatches.length * 0.35)));

    // 1. Player of the Month
    const mapPOTM = (arr) => arr
        .map(p => ({ ...p, ppg: (p.pts / p.played).toFixed(2), rawPPG: p.pts / p.played }))
        .sort((a, b) => b.rawPPG - a.rawPPG || b.won - a.won || b.played - a.played || b.pts - a.pts);

    const potm = pickTier([
        {
            tier: 'qualified',
            note: () => '',
            list: () => mapPOTM(monthPlayers.filter(p => p.played >= MIN_GAMES_IMPROVED))
        },
        {
            tier: 'relaxed',
            note: (w) => `Nobody reached ${MIN_GAMES_IMPROVED} appearances in ${monthName} — qualifier lowered to ${adaptiveMin}.`,
            list: () => mapPOTM(monthPlayers.filter(p => p.played >= adaptiveMin))
        },
        {
            tier: 'best',
            note: (w) => `Thin month: best record available, from ${w.played} appearance${w.played === 1 ? '' : 's'}.`,
            list: () => mapPOTM(monthPlayers)
        }
    ]);

    // 2. Most Improved (vs. career baseline)
    const mapImproved = (arr) => arr
        .map(p => {
            const mPPG = p.pts / p.played;
            const c = careerStats[p.id];
            const cPPG = c && c.played ? (c.pts / c.played) : mPPG;
            const delta = mPPG - cPPG;
            return {
                ...p,
                monthPPG: mPPG.toFixed(2),
                careerPPG: cPPG.toFixed(2),
                delta: delta >= 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2),
                rawDelta: delta
            };
        })
        .sort((a, b) => b.rawDelta - a.rawDelta || b.pts - a.pts);

    const careerCaps = (p) => (careerStats[p.id] ? careerStats[p.id].played : 0);

    const mostImproved = pickTier([
        {
            tier: 'qualified',
            note: () => '',
            list: () => mapImproved(monthPlayers.filter(p => p.played >= MIN_GAMES_IMPROVED && careerCaps(p) >= 5)).filter(p => p.rawDelta > 0)
        },
        {
            tier: 'relaxed',
            note: () => `Qualifier lowered to ${adaptiveMin} appearance${adaptiveMin === 1 ? '' : 's'} and 3 career caps for ${monthName}.`,
            list: () => mapImproved(monthPlayers.filter(p => p.played >= adaptiveMin && careerCaps(p) >= 3)).filter(p => p.rawDelta > 0)
        },
        {
            tier: 'best',
            // No positive delta anywhere: say so rather than dressing a decline up
            // as improvement.
            note: (w) => w.rawDelta > 0
                ? `Small sample: based on ${w.played} appearance${w.played === 1 ? '' : 's'}.`
                : `Nobody bettered their career rate in ${monthName} — this is the closest.`,
            list: () => mapImproved(monthPlayers)
        }
    ]);

    // 3. Iron Men (top attendance — always has a winner when anyone played)
    const maxPlayed = Math.max(...monthPlayers.map(p => p.played), 0);
    const ironMen = maxPlayed > 0 ? monthPlayers.filter(p => p.played === maxPlayed) : [];

    // 4. Cold Duo of the Month
    const minDuoGames = Math.max(2, Math.min(MIN_GAMES_PAIR, Math.ceil(monthMatches.length * 0.35)));
    const mapDuos = (arr) => arr
        .map(d => ({
            p1: getPlayerDisplayName(d.p1),
            p2: getPlayerDisplayName(d.p2),
            played: d.played,
            won: d.won,
            winRate: Math.round((d.won / d.played) * 100)
        }))
        .sort((a, b) => a.winRate - b.winRate || b.played - a.played);

    const allDuos = Object.values(monthDuos);
    const worstDuo = pickTier([
        {
            tier: 'qualified',
            note: () => '',
            list: () => mapDuos(allDuos.filter(d => d.played >= MIN_GAMES_PAIR))
        },
        {
            tier: 'relaxed',
            note: () => `No pair reached ${MIN_GAMES_PAIR} games together in ${monthName} — threshold lowered to ${minDuoGames}.`,
            list: () => mapDuos(allDuos.filter(d => d.played >= minDuoGames))
        },
        {
            tier: 'best',
            note: () => `No pair played together more than once in ${monthName} — one game only.`,
            list: () => mapDuos(allDuos)
        }
    ]);

    // 5. Ghost of the Month (regular who missed the most)
    const mapGhosts = (minCaps) => Object.entries(careerStats)
        .filter(([, c]) => c.played >= minCaps)
        .map(([pId, c]) => {
            const mPlayed = monthPlayerStats[pId] ? monthPlayerStats[pId].played : 0;
            return {
                id: pId,
                name: getPlayerDisplayName(pId),
                monthPlayed: mPlayed,
                careerPlayed: c.played,
                attendanceRate: Math.round((mPlayed / monthMatches.length) * 100)
            };
        })
        .filter(p => p.monthPlayed < monthMatches.length)
        .sort((a, b) => a.monthPlayed - b.monthPlayed || b.careerPlayed - a.careerPlayed);

    const ghost = pickTier([
        { tier: 'qualified', note: () => '', list: () => mapGhosts(5) },
        {
            tier: 'relaxed',
            note: () => `No 5-cap regular missed a game in ${monthName} — widened to 3 career caps.`,
            list: () => mapGhosts(3)
        },
        {
            tier: 'best',
            note: (w) => `Widened to every player on record (${w.careerPlayed} career cap${w.careerPlayed === 1 ? '' : 's'}).`,
            list: () => mapGhosts(1)
        }
    ]);

    // Month-level caveat: a handful of matches cannot support a confident award,
    // whatever the per-award tier says.
    const thinMonth = monthMatches.length < 4;
    const sampleNote = thinMonth
        ? `Only ${monthMatches.length} match${monthMatches.length === 1 ? '' : 'es'} recorded in ${monthName} ${year} — treat these as indicative.`
        : '';

    return {
        hasMatches: true,
        month: targetMonth,
        monthName,
        year,
        totalMonthMatches: monthMatches.length,
        maxPlayedInMonth: maxPlayed,
        thinMonth,
        sampleNote,
        potm,
        mostImproved,
        ironMen,
        worstDuo,
        ghost
    };
}


/* ======================================================================
   ITEMS 10-12: CHEMISTRY MATRIX — FILTERING, SORTING, FOCUS, DETAIL
   ----------------------------------------------------------------------
   A 26x26 grid is 676 cells. On a 360px phone about four columns are
   legible at once, so sorting and filtering alone cannot make the grid
   usable there — the grid is simply the wrong shape for the screen.
   Below 576px the section therefore opens in focus mode (pick a player,
   read their partners as a ranked list) with the full grid one tap away.
   Desktop keeps the grid as the default. Everything derives from
   chemData.allDuos, which renderStatsInsights has already computed.
   ====================================================================== */

let chemContext = null; // { chemData, regularIds, eloOrder } — set by renderStatsInsights
const CHEM_METRICS = {
    wr:    { label: 'Win %',    short: 'WIN %' },
    ppg:   { label: 'PPG',      short: 'PPG' },
    games: { label: 'Together', short: 'GAMES' }
};
const CHEM_MIN_OPTIONS = [1, 3, 5, 10];

let chemState = {
    minGames: MIN_GAMES_PAIR,
    metric: 'wr',
    sort: 'elo',
    focusPlayer: null,
    forceGrid: false   // set when a phone user explicitly asks for the grid
};

function chemIsNarrow() {
    return window.innerWidth < 576;
}

function chemPairKey(a, b) {
    return chemContext.chemData.allDuos[`${a}__${b}`] || chemContext.chemData.allDuos[`${b}__${a}`] || null;
}

// The value a cell shows for a pair, plus how it should be coloured.
function chemCellValue(duo, maxGames) {
    if (!duo) return null;
    if (chemState.metric === 'wr') {
        const wr = Math.round((duo.won / duo.played) * 100);
        return { text: `${wr}%`, klass: wr >= 65 ? 'good' : (wr <= 35 ? 'bad' : 'avg'), raw: wr };
    }
    if (chemState.metric === 'ppg') {
        const ppg = duo.pts / duo.played;
        return { text: ppg.toFixed(2), klass: ppg >= 2 ? 'good' : (ppg <= 1 ? 'bad' : 'avg'), raw: ppg };
    }
    // 'games' has no natural good/bad, so shade by volume relative to the busiest pair.
    const share = maxGames > 0 ? duo.played / maxGames : 0;
    return { text: String(duo.played), klass: share >= 0.66 ? 'good' : (share <= 0.33 ? 'bad' : 'avg'), raw: duo.played };
}

// Per-player summary across partners that clear the current threshold.
function chemPlayerSummary(playerId) {
    const { regularIds } = chemContext;
    let games = 0, won = 0, pts = 0, partners = 0;
    regularIds.forEach(other => {
        if (other === playerId) return;
        const d = chemPairKey(playerId, other);
        if (!d || d.played < chemState.minGames) return;
        partners++;
        games += d.played;
        won += d.won;
        pts += d.pts;
    });
    return {
        partners,
        games,
        avgWr: games > 0 ? Math.round((won / games) * 100) : null,
        avgPpg: games > 0 ? pts / games : null
    };
}

function chemSortedIds() {
    const { regularIds, eloOrder } = chemContext;
    const ids = [...regularIds];
    if (chemState.sort === 'name') {
        return ids.sort((a, b) => getPlayerDisplayName(a).localeCompare(getPlayerDisplayName(b)));
    }
    if (chemState.sort === 'chem') {
        return ids.sort((a, b) => {
            const sa = chemPlayerSummary(a), sb = chemPlayerSummary(b);
            return (sb.avgWr === null ? -1 : sb.avgWr) - (sa.avgWr === null ? -1 : sa.avgWr);
        });
    }
    if (chemState.sort === 'games') {
        return ids.sort((a, b) => chemPlayerSummary(b).games - chemPlayerSummary(a).games);
    }
    // 'elo' — the Elo ordering the matrix has always used
    return ids.sort((a, b) => eloOrder.indexOf(a) - eloOrder.indexOf(b));
}

function chemControlsHtml() {
    const minBtns = CHEM_MIN_OPTIONS.map(n => `
        <button type="button" class="chem-chip${chemState.minGames === n ? ' active' : ''}" data-chem-min="${n}">${n}+</button>
    `).join('');
    const metricBtns = Object.keys(CHEM_METRICS).map(k => `
        <button type="button" class="chem-chip${chemState.metric === k ? ' active' : ''}" data-chem-metric="${k}">${CHEM_METRICS[k].label}</button>
    `).join('');
    const sortOpts = [['elo', 'Elo rank'], ['name', 'Name'], ['chem', 'Best chemistry'], ['games', 'Most games']]
        .map(([v, l]) => `<option value="${v}"${chemState.sort === v ? ' selected' : ''}>${l}</option>`).join('');

    return `
    <div class="chem-controls">
        <div class="chem-control-group">
            <span class="chem-control-label">Min games together</span>
            <div class="chem-chip-row">${minBtns}</div>
        </div>
        <div class="chem-control-group">
            <span class="chem-control-label">Metric</span>
            <div class="chem-chip-row">${metricBtns}</div>
        </div>
        <div class="chem-control-group">
            <span class="chem-control-label">Sort players by</span>
            <select class="form-select form-select-sm bg-dark text-white border-secondary" id="chemSortSelect" style="font-size:0.8rem">${sortOpts}</select>
        </div>
    </div>`;
}

function chemFocusHtml() {
    const focusId = chemState.focusPlayer;
    const name = getPlayerDisplayName(focusId);
    const summary = chemPlayerSummary(focusId);

    const rows = chemContext.regularIds
        .filter(id => id !== focusId)
        .map(id => ({ id, duo: chemPairKey(focusId, id) }))
        .filter(r => r.duo && r.duo.played >= chemState.minGames)
        .map(r => {
            const maxG = Math.max(...chemContext.regularIds.map(o => {
                const d = chemPairKey(focusId, o);
                return d ? d.played : 0;
            }), 0);
            return { ...r, cell: chemCellValue(r.duo, maxG) };
        })
        .sort((a, b) => b.cell.raw - a.cell.raw);

    const list = rows.length === 0
        ? `<div class="text-muted small py-4 text-center">
               ${esc(name)} has no partner with ${chemState.minGames}+ games together. Lower the threshold to see more.
           </div>`
        : rows.map((r, i) => `
            <button type="button" class="chem-focus-row" data-chem-pair="${esc(focusId)}|${esc(r.id)}">
                <span class="chem-focus-rank">${i + 1}</span>
                <span class="chem-focus-name">${esc(getPlayerDisplayName(r.id))}</span>
                <span class="chem-focus-sub">${r.duo.won}W ${r.duo.drawn}D ${r.duo.lost}L · ${r.duo.played} together</span>
                <span class="chem-val chem-${r.cell.klass}">${r.cell.text}</span>
            </button>
        `).join('');

    const summaryLine = summary.games > 0
        ? `${summary.partners} partner${summary.partners === 1 ? '' : 's'} · ${summary.avgWr}% average win rate together`
        : 'No qualifying partnerships at this threshold';

    return `
        <div class="chem-focus-head">
            <div style="min-width:0">
                <div class="fw-bold text-white">${esc(name)}</div>
                <small class="text-muted">${esc(summaryLine)}</small>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-chem-action="exit-focus">
                <i class="fas fa-arrow-left me-1"></i>All players
            </button>
        </div>
        <div class="chem-focus-list">${list}</div>
        <small class="text-muted d-block mt-2" style="font-size:0.7rem">Ranked by ${esc(CHEM_METRICS[chemState.metric].label)}. Tap a partner for the shared matches.</small>
    `;
}

function chemPlayerListHtml() {
    const ids = chemSortedIds();
    const rows = ids.map(id => {
        const s = chemPlayerSummary(id);
        const val = s.avgWr === null ? '—' : `${s.avgWr}%`;
        const klass = s.avgWr === null ? 'avg' : (s.avgWr >= 65 ? 'good' : (s.avgWr <= 35 ? 'bad' : 'avg'));
        return `
        <button type="button" class="chem-focus-row" data-chem-focus="${esc(id)}">
            <span class="chem-focus-name">${esc(getPlayerDisplayName(id))}</span>
            <span class="chem-focus-sub">${s.partners} partner${s.partners === 1 ? '' : 's'} · ${s.games} games</span>
            <span class="chem-val chem-${klass}">${val}</span>
        </button>`;
    }).join('');

    return `
        <div class="chem-focus-list">${rows}</div>
        <button type="button" class="btn btn-sm btn-outline-info w-100 mt-2" data-chem-action="show-grid">
            <i class="fas fa-table-cells me-1"></i>Show full grid
        </button>
        <small class="text-muted d-block mt-2" style="font-size:0.7rem">Average win rate with partners above the threshold. Tap a player for their partners.</small>
    `;
}

function chemGridHtml() {
    const ids = chemSortedIds();
    const maxGames = Math.max(...Object.values(chemContext.chemData.allDuos).map(d => d.played), 0);

    const head = ids.map(id => `<th title="${esc(getPlayerDisplayName(id))}">${esc(getPlayerDisplayName(id))}</th>`).join('');
    const body = ids.map(p1 => {
        const cells = ids.map(p2 => {
            if (p1 === p2) return `<td class="heatmap-cell-empty bg-secondary bg-opacity-10">-</td>`;
            const d = chemPairKey(p1, p2);
            if (!d || d.played < chemState.minGames) {
                return `<td class="heatmap-cell-empty" title="Fewer than ${chemState.minGames} games together">-</td>`;
            }
            const cell = chemCellValue(d, maxGames);
            const tip = `${getPlayerDisplayName(p1)} & ${getPlayerDisplayName(p2)}: ${cell.text} (${d.won}W/${d.played}P)`;
            return `<td class="heatmap-cell-${cell.klass} chem-cell" data-chem-pair="${esc(p1)}|${esc(p2)}" title="${esc(tip)}">${cell.text}</td>`;
        }).join('');
        return `<tr><td class="text-start ps-2 fw-bold text-white bg-dark chem-row-head" data-chem-focus="${esc(p1)}">${esc(getPlayerDisplayName(p1))}</td>${cells}</tr>`;
    }).join('');

    const backToList = chemIsNarrow()
        ? `<button type="button" class="btn btn-sm btn-outline-secondary w-100 mt-2" data-chem-action="show-list"><i class="fas fa-list me-1"></i>Back to player list</button>`
        : '';

    return `
        <div class="heatmap-container">
            <table class="heatmap-table">
                <thead><tr><th class="text-start ps-2">Player</th>${head}</tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>
        ${backToList}
        <small class="text-muted d-block mt-2" style="font-size:0.7rem">Tap a cell for the pair's shared matches, or a name on the left for that player's partners.</small>
    `;
}

function renderChemistryMatrix() {
    const mount = document.getElementById('chemistryMatrixMount');
    if (!mount || !chemContext) return;

    // A filter change can drop the focused player out of the regulars list.
    if (chemState.focusPlayer && !chemContext.regularIds.includes(chemState.focusPlayer)) {
        chemState.focusPlayer = null;
    }

    let bodyHtml;
    if (chemState.focusPlayer) {
        bodyHtml = chemFocusHtml();
    } else if (chemIsNarrow() && !chemState.forceGrid) {
        bodyHtml = chemPlayerListHtml();
    } else {
        bodyHtml = chemGridHtml();
    }

    const metricLabel = CHEM_METRICS[chemState.metric].label;
    mount.innerHTML = `
        <h6 class="small fw-bold text-muted mb-2"><i class="fas fa-th text-info me-2"></i>REGULARS CHEMISTRY MATRIX (MIN 10 APPEARANCES)</h6>
        <small class="text-muted d-block mb-3">${esc(metricLabel)} when playing on the same team, for pairs with ${chemState.minGames}+ games together.</small>
        ${chemControlsHtml()}
        ${bodyHtml}
    `;
}

// One delegated listener for the whole section — chemistry controls and cells
// carry player ids, and an inline onclick would break on any id with a quote.
// Share buttons carry ids and player names, so they use data- attributes and a
// delegated listener rather than inline handlers that a quote would break.
function setupCommunityHandlers() {
    const container = document.getElementById('communityContainer');
    if (!container) return;
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.js-share');
        if (!btn) return;
        copyShareLink(btn.dataset.shareType, btn.dataset.shareId, btn.dataset.shareTitle || 'Elderly Support League', e);
    });
}

function setupChemistryHandlers() {
    const container = document.getElementById('insightsContainer');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const minBtn = e.target.closest('[data-chem-min]');
        if (minBtn) { chemState.minGames = parseInt(minBtn.dataset.chemMin, 10); return renderChemistryMatrix(); }

        const metricBtn = e.target.closest('[data-chem-metric]');
        if (metricBtn) { chemState.metric = metricBtn.dataset.chemMetric; return renderChemistryMatrix(); }

        const focusBtn = e.target.closest('[data-chem-focus]');
        if (focusBtn) { chemState.focusPlayer = focusBtn.dataset.chemFocus; return renderChemistryMatrix(); }

        const pairBtn = e.target.closest('[data-chem-pair]');
        if (pairBtn) {
            const [a, b] = pairBtn.dataset.chemPair.split('|');
            return openPairDetail(a, b);
        }

        const action = e.target.closest('[data-chem-action]');
        if (!action) return;
        const what = action.dataset.chemAction;
        if (what === 'exit-focus') { chemState.focusPlayer = null; }
        else if (what === 'show-grid') { chemState.forceGrid = true; }
        else if (what === 'show-list') { chemState.forceGrid = false; }
        renderChemistryMatrix();
    });

    container.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'chemSortSelect') {
            chemState.sort = e.target.value;
            renderChemistryMatrix();
        }
    });

    // Rotating a phone can cross the 576px boundary, which changes the default
    // view. Only re-render when the answer actually changed.
    let wasNarrow = chemIsNarrow();
    window.addEventListener('resize', () => {
        const nowNarrow = chemIsNarrow();
        if (nowNarrow !== wasNarrow) {
            wasNarrow = nowNarrow;
            renderChemistryMatrix();
        }
    });
}

/** Item 12: the pair's record and every match they shared. */
window.openPairDetail = (idA, idB) => {
    if (!chemContext) return;
    const duo = chemPairKey(idA, idB);
    const nameA = getPlayerDisplayName(idA);
    const nameB = getPlayerDisplayName(idB);

    const titleEl = document.getElementById('pairDetailTitle');
    const bodyEl = document.getElementById('pairDetailBody');
    if (!titleEl || !bodyEl) return;

    titleEl.textContent = `${nameA} & ${nameB}`;

    if (!duo) {
        bodyEl.innerHTML = `<div class="text-muted small py-3 text-center">${esc(nameA)} and ${esc(nameB)} have never played on the same team.</div>`;
    } else {
        const wr = Math.round((duo.won / duo.played) * 100);
        const ppg = (duo.pts / duo.played).toFixed(2);
        const refs = [...duo.refs].sort((a, b) => b.ms - a.ms);
        const rows = refs.map(r => {
            const cls = r.res === 'W' ? 'badge-form-w' : (r.res === 'D' ? 'badge-form-d' : 'badge-form-l');
            return `
            <div class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary border-opacity-25">
                <div style="min-width:0">
                    <div class="text-white small fw-bold">${r.ms ? esc(formatDate(new Date(r.ms))) : 'Unknown date'}</div>
                    <small class="text-muted">${esc(r.teamName || 'Team')}${r.location ? ' · ' + esc(r.location) : ''}</small>
                </div>
                <span class="badge ${cls}">${r.res}</span>
            </div>`;
        }).join('');

        bodyEl.innerHTML = `
            <div class="row text-center g-2 mb-3">
                <div class="col-4"><div class="p-2 rounded bg-dark border border-secondary">
                    <div class="fs-5 fw-bold text-info">${wr}%</div><small class="text-muted" style="font-size:0.65rem">WIN RATE</small></div></div>
                <div class="col-4"><div class="p-2 rounded bg-dark border border-secondary">
                    <div class="fs-5 fw-bold text-warning">${ppg}</div><small class="text-muted" style="font-size:0.65rem">PPG</small></div></div>
                <div class="col-4"><div class="p-2 rounded bg-dark border border-secondary">
                    <div class="fs-5 fw-bold text-white">${duo.played}</div><small class="text-muted" style="font-size:0.65rem">TOGETHER</small></div></div>
            </div>
            <div class="text-center small text-muted mb-3">${duo.won}W · ${duo.drawn}D · ${duo.lost}L as teammates</div>
            <h6 class="small fw-bold text-muted mb-1">SHARED MATCHES</h6>
            <div class="chem-pair-matches">${rows}</div>
        `;
    }

    const modalEl = document.getElementById('pairDetailModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
};

/* ======================================================================
   ITEM 42: FIXTURES, ROAST STUDIO & PREDICTION LIFECYCLE
   ====================================================================== */

const ROAST_THRESHOLD = 0.60;

function computeRoastAngles(allMatches, playersList, optOutIds = []) {
  const sorted = [...allMatches].sort((a, b) => {
    const tA = a.date ? (a.date.toDate ? a.date.toDate().getTime() : new Date(a.date).getTime()) : 0;
    const tB = b.date ? (b.date.toDate ? b.date.toDate().getTime() : new Date(b.date).getTime()) : 0;
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  });

  const nameMap = new Map();
  playersList.forEach(p => {
    nameMap.set(p.id, p.displayName || p.id);
  });
  const getName = (id) => nameMap.get(id) || getPlayerDisplayName(id) || id;

  const caps = {};
  const currentStreaks = {};
  const lastPlayedDate = {};
  const h2h = {};
  const duoRecords = {};

  const latestTime = sorted.length > 0 ? (sorted[sorted.length - 1].date ? (sorted[sorted.length - 1].date.toDate ? sorted[sorted.length - 1].date.toDate().getTime() : new Date(sorted[sorted.length - 1].date).getTime()) : Date.now()) : Date.now();

  for (const m of sorted) {
    const mDate = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : new Date();
    if (!m.teams || m.teams.length < 2) continue;

    if (m.type === 'Standard') {
      const tA = m.teams[0], tB = m.teams[1];
      const pA = tA.players || [], pB = tB.players || [];
      const sA = tA.score || 0, sB = tB.score || 0;
      const resA = sA > sB ? 'W' : (sA === sB ? 'D' : 'L');
      const resB = sB > sA ? 'W' : (sB === sA ? 'D' : 'L');

      [...pA, ...pB].forEach(p => {
        caps[p] = (caps[p] || 0) + 1;
        lastPlayedDate[p] = mDate;
      });

      // Streaks
      pA.forEach(p => {
        if (!currentStreaks[p]) currentStreaks[p] = { w: 0, l: 0, u: 0, winless: 0 };
        if (resA === 'W') { currentStreaks[p].w++; currentStreaks[p].u++; currentStreaks[p].l = 0; currentStreaks[p].winless = 0; }
        else if (resA === 'D') { currentStreaks[p].w = 0; currentStreaks[p].u++; currentStreaks[p].l = 0; currentStreaks[p].winless++; }
        else { currentStreaks[p].w = 0; currentStreaks[p].u = 0; currentStreaks[p].l++; currentStreaks[p].winless++; }
      });
      pB.forEach(p => {
        if (!currentStreaks[p]) currentStreaks[p] = { w: 0, l: 0, u: 0, winless: 0 };
        if (resB === 'W') { currentStreaks[p].w++; currentStreaks[p].u++; currentStreaks[p].l = 0; currentStreaks[p].winless = 0; }
        else if (resB === 'D') { currentStreaks[p].w = 0; currentStreaks[p].u++; currentStreaks[p].l = 0; currentStreaks[p].winless++; }
        else { currentStreaks[p].w = 0; currentStreaks[p].u = 0; currentStreaks[p].l++; currentStreaks[p].winless++; }
      });

      // Duos
      [ { team: pA, res: resA }, { team: pB, res: resB } ].forEach(({ team, res }) => {
        const sP = [...team].sort();
        for (let i = 0; i < sP.length; i++) {
          for (let j = i + 1; j < sP.length; j++) {
            const key = `${sP[i]}__${sP[j]}`;
            if (!duoRecords[key]) duoRecords[key] = { p1: sP[i], p2: sP[j], played: 0, won: 0 };
            duoRecords[key].played++;
            if (res === 'W') duoRecords[key].won++;
          }
        }
      });

      // H2H
      pA.forEach(p1 => {
        pB.forEach(p2 => {
          const k1 = `${p1}__${p2}`;
          const k2 = `${p2}__${p1}`;
          if (!h2h[k1]) h2h[k1] = [];
          if (!h2h[k2]) h2h[k2] = [];
          h2h[k1].push(resA);
          h2h[k2].push(resB);
        });
      });
    } else {
      m.teams.forEach(t => {
        const isWin = (t.rank === 1);
        (t.players || []).forEach(p => {
          caps[p] = (caps[p] || 0) + 1;
          lastPlayedDate[p] = mDate;
          if (!currentStreaks[p]) currentStreaks[p] = { w: 0, l: 0, u: 0, winless: 0 };
          if (isWin) { currentStreaks[p].w++; currentStreaks[p].u++; currentStreaks[p].l = 0; currentStreaks[p].winless = 0; }
          else { currentStreaks[p].w = 0; currentStreaks[p].u = 0; currentStreaks[p].l++; currentStreaks[p].winless++; }
        });
      });
    }
  }

  // 30-day Elo delta
  const thirtyDaysAgoMs = latestTime - (30 * 24 * 60 * 60 * 1000);
  const priorMatches = sorted.filter(m => {
    const t = m.date ? (m.date.toDate ? m.date.toDate().getTime() : new Date(m.date).getTime()) : 0;
    return t < thirtyDaysAgoMs;
  });
  const eloPrior = computeEloRatings(priorMatches).ratings || {};
  const eloCurrent = computeEloRatings(sorted).ratings || {};

  const candidates = [];

  // Losing Streak
  Object.entries(currentStreaks).forEach(([pId, s]) => {
    if (optOutIds.includes(pId)) return;
    if (s.l >= 3) {
      const score = Math.min(0.95, Number((0.45 + s.l * 0.12).toFixed(2)));
      candidates.push({
        angleType: 'losing_streak',
        targetPlayerId: pId,
        targetPlayerName: getName(pId),
        score,
        facts: `${getName(pId)} has lost ${s.l} consecutive matches in a row`,
        rawMetric: `${s.l} straight losses`
      });
    }
  });

  // Ghost
  Object.entries(caps).forEach(([pId, count]) => {
    if (optOutIds.includes(pId)) return;
    if (count >= 8 && lastPlayedDate[pId]) {
      const diffMs = latestTime - lastPlayedDate[pId].getTime();
      const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (days >= 35) {
        const score = Math.min(0.92, Number((0.48 + days * 0.005).toFixed(2)));
        candidates.push({
          angleType: 'ghost',
          targetPlayerId: pId,
          targetPlayerName: getName(pId),
          score,
          facts: `${getName(pId)} (${count} career caps) has not appeared for ${days} days (last seen ${lastPlayedDate[pId].toLocaleDateString()})`,
          rawMetric: `${days} days absent`
        });
      }
    }
  });

  // Worst Duo
  Object.values(duoRecords).forEach(d => {
    if (optOutIds.includes(d.p1) || optOutIds.includes(d.p2)) return;
    if (d.played >= 4) {
      const wr = Math.round((d.won / d.played) * 100);
      if (wr <= 30) {
        const score = Math.min(0.90, Number((0.50 + (30 - wr) * 0.012 + d.played * 0.02).toFixed(2)));
        candidates.push({
          angleType: 'worst_duo',
          targetPlayerId: `${d.p1}__${d.p2}`,
          targetPlayerName: `${getName(d.p1)} & ${getName(d.p2)}`,
          score,
          facts: `${getName(d.p1)} and ${getName(d.p2)} have won only ${d.won} of their ${d.played} matches together (${wr}% win rate)`,
          rawMetric: `${d.won}W-${d.played - d.won}L (${wr}%)`
        });
      }
    }
  });

  // Elo Slide
  Object.keys(eloCurrent).forEach(pId => {
    if (optOutIds.includes(pId)) return;
    const cur = Math.round(eloCurrent[pId] || STARTING_ELO);
    const prev = Math.round(eloPrior[pId] || STARTING_ELO);
    const delta = cur - prev;
    if (delta <= -35 && (caps[pId] || 0) >= 5) {
      const drop = Math.abs(delta);
      const score = Math.min(0.90, Number((0.45 + drop * 0.006).toFixed(2)));
      candidates.push({
        angleType: 'elo_slide',
        targetPlayerId: pId,
        targetPlayerName: getName(pId),
        score,
        facts: `${getName(pId)}'s Elo rating dropped by ${drop} points over the last 30 days (from ${prev} to ${cur})`,
        rawMetric: `${delta} Elo in 30 days`
      });
    }
  });

  // Severe Nemesis
  Object.entries(h2h).forEach(([key, history]) => {
    const [p1, p2] = key.split('__');
    if (optOutIds.includes(p1) || optOutIds.includes(p2)) return;
    let trailingLosses = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === 'L') trailingLosses++;
      else break;
    }
    if (trailingLosses >= 3) {
      const score = Math.min(0.95, Number((0.50 + trailingLosses * 0.11).toFixed(2)));
      candidates.push({
        angleType: 'nemesis',
        targetPlayerId: p1,
        targetPlayerName: getName(p1),
        score,
        facts: `${getName(p1)} has suffered ${trailingLosses} straight defeats against ${getName(p2)}`,
        rawMetric: `${trailingLosses} straight losses vs ${getName(p2)}`
      });
    }
  });

  // Winless Drought
  Object.entries(currentStreaks).forEach(([pId, s]) => {
    if (optOutIds.includes(pId)) return;
    if (s.winless >= 4 && s.l < s.winless) {
      const score = Math.min(0.88, Number((0.45 + s.winless * 0.08).toFixed(2)));
      candidates.push({
        angleType: 'cold_streak',
        targetPlayerId: pId,
        targetPlayerName: getName(pId),
        score,
        facts: `${getName(pId)} has gone ${s.winless} consecutive matches without a single win`,
        rawMetric: `${s.winless} games winless`
      });
    }
  });

  // Angle 7: Wildcard / Rookie Debutant (0 or 1 caps)
  playersList.forEach(p => {
    if (optOutIds.includes(p.id)) return;
    const count = caps[p.id] || 0;
    if (count <= 1) {
      const score = count === 0 ? 0.78 : 0.72;
      candidates.push({
        angleType: 'wildcard_rookie',
        targetPlayerId: p.id,
        targetPlayerName: p.displayName || p.id,
        score,
        facts: `${p.displayName || p.id} is an unproven wildcard newcomer with ${count} career appearances. Stepping into the Elderly Support league with zero verified track record.`,
        rawMetric: count === 0 ? 'Unproven Debutant (0 caps)' : 'Rookie (1 cap)'
      });
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map(c => ({
    ...c,
    belowThreshold: c.score < ROAST_THRESHOLD
  }));
}

/*
 * Firestore security rules are NOT filters. `fixtures` and `roasts` are gated per
 * document (status == 'scheduled' / status == 'published'), so an UNCONSTRAINED
 * collection listen cannot be proven safe and is rejected outright for every
 * non-admin visitor — which silently hid the Next Game and Roast cards from the
 * whole group. Public listeners must therefore carry a query constraint that
 * mirrors the rule exactly. The admin needs drafts and played fixtures for the
 * studio, so the admin listener stays unconstrained and is opened only once auth
 * has actually resolved.
 */
function isSuperAdmin(user) {
    return !!(user && user.email && user.email.toLowerCase() === SUPER_ADMIN.toLowerCase());
}

function isOrganizer(user) {
    if (!user || !user.email) return false;
    const email = user.email.toLowerCase();
    return ORGANIZERS.some(e => e.toLowerCase() === email);
}

function noteCommunityFeedError(feed, err) {
    const denied = err && (err.code === 'permission-denied' || err.code === 'missing-or-insufficient-permissions');
    communityFeedErrors[feed] = denied
        ? `${feed === 'roasts' ? 'Roasts' : 'Fixtures'} could not be loaded — the reader is not permitted to see this collection. Check firestore.rules.`
        : `${feed === 'roasts' ? 'Roasts' : 'Fixtures'} could not be loaded: ${err && err.message ? err.message : 'unknown error'}`;
    console.warn(`${feed} snapshot error:`, err && err.message);
    renderCommunityTab(allMatches);
}

function subscribeCommunityCollections() {
    const mode = isSuperAdmin(currentUser) ? 'admin' : 'public';
    if (communityListenersMode === mode) return;
    communityListenersMode = mode;

    if (unsubFixtures) { try { unsubFixtures(); } catch (e) {} unsubFixtures = null; }
    if (unsubRoasts) { try { unsubRoasts(); } catch (e) {} unsubRoasts = null; }

    fetchFixtures(mode);
    fetchRoasts(mode);
}

function fetchFixtures(mode = 'public') {
    try {
        const query = mode === 'admin'
            ? db.collection('fixtures')
            : db.collection('fixtures').where('status', '==', 'scheduled');

        unsubFixtures = query.onSnapshot(snap => {
            communityFeedErrors.fixtures = null;
            allFixtures = [];
            snap.forEach(doc => {
                allFixtures.push({ id: doc.id, ...doc.data() });
            });
            updateCommissionerStatsUI();
            renderExistingFixturesList();
            renderCommunityTab(allMatches);
        }, err => noteCommunityFeedError('fixtures', err));
    } catch (e) {
        noteCommunityFeedError('fixtures', e);
    }
}

function fetchRoasts(mode = 'public') {
    try {
        const query = mode === 'admin'
            ? db.collection('roasts')
            : db.collection('roasts').where('status', '==', 'published');

        unsubRoasts = query.onSnapshot(snap => {
            communityFeedErrors.roasts = null;
            allRoasts = [];
            snap.forEach(doc => {
                allRoasts.push({ id: doc.id, ...doc.data() });
            });
            renderPublishedRoastsList();
            renderCommunityTab(allMatches);
        }, err => noteCommunityFeedError('roasts', err));
    } catch (e) {
        noteCommunityFeedError('roasts', e);
    }
}

window.openRoastStudio = async () => {
    if (!isOrganizer(currentUser)) return alert("Organizer access required.");
    updateCommissionerStatsUI();
    loadRoastCandidates();
    populateFixtureVenueSelect();
    renderExistingFixturesList();
    renderPublishedRoastsList();
    loadRoastSettingsUI();
};

function updateCommissionerStatsUI() {
    const resolvedFixtures = allFixtures.filter(f => f.status === 'played' && f.predictionResult);
    const correctCount = resolvedFixtures.filter(f => f.predictionResult === 'correct').length;
    const wrongCount = resolvedFixtures.filter(f => f.predictionResult === 'wrong').length;
    const total = correctCount + wrongCount;
    const rate = total > 0 ? Math.round((correctCount / total) * 100) : 0;

    safeText('commissionerHeaderBadge', `Commissioner: ${correctCount}-${wrongCount}`);
    safeText('commissionerStatsText', `${correctCount} Correct – ${wrongCount} Wrong`);
    safeText('commissionerRateText', `${rate}% Accuracy across ${total} completed fixtures`);
}

window.loadRoastCandidates = async () => {
    const container = document.getElementById('roastCandidatesContainer');
    if (container) {
        container.innerHTML = '<div class="text-center py-3 text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>Loading candidate angles...</div>';
    }

    let candidates = [];
    try {
        const getFn = functions.httpsCallable('getRoastAngleCandidates');
        const res = await getFn();
        if (res.data && res.data.ok) {
            candidates = res.data.candidates || [];
            if (res.data.settings) roastSettingsState = res.data.settings;
        }
    } catch (err) {
        const playersList = Array.from(playersRegistry.values());
        candidates = computeRoastAngles(allMatches, playersList, roastSettingsState.optedOutPlayerIds || []);
    }

    activeRoastCandidates = candidates;
    renderRoastCandidatesUI();
};

function renderRoastCandidatesUI() {
    const container = document.getElementById('roastCandidatesContainer');
    if (!container) return;

    if (!activeRoastCandidates || activeRoastCandidates.length === 0) {
        container.innerHTML = '<div class="text-center py-3 text-muted small">No roast candidates found in current league history.</div>';
        return;
    }

    container.innerHTML = activeRoastCandidates.map((c, idx) => {
        const isBelow = c.belowThreshold || c.score < ROAST_THRESHOLD;
        const opacityClass = isBelow ? 'opacity-50' : '';
        const badgeColor = isBelow ? 'bg-secondary' : 'bg-danger';

        return `
        <div class="p-2 mb-1 rounded border border-secondary d-flex justify-content-between align-items-center ${opacityClass}" style="cursor:pointer; background: #161b22;" onclick="selectRoastAngle(${idx})">
            <div>
                <span class="badge ${badgeColor} me-1 font-monospace" style="font-size:0.7rem;">${esc(c.angleType)}</span>
                <span class="text-white fw-bold small">${esc(c.targetPlayerName)}</span>
                <small class="text-muted d-block" style="font-size:0.75rem;">${esc(c.rawMetric || c.facts)}</small>
            </div>
            <div class="text-end">
                <span class="badge bg-dark border border-secondary font-monospace">${c.score.toFixed(2)}</span>
                ${isBelow ? '<small class="text-muted d-block" style="font-size:0.65rem;">Below threshold</small>' : ''}
            </div>
        </div>
        `;
    }).join('');
}

window.selectRoastAngle = (idx) => {
    const c = activeRoastCandidates[idx];
    if (!c) return;
    activeSelectedRoastAngle = c;

    const box = document.getElementById('selectedAngleBox');
    if (box) box.classList.remove('d-none');

    safeText('selAngleTypeBadge', c.angleType.toUpperCase());
    safeText('selAnglePlayer', c.targetPlayerName);
    safeText('selAngleScoreBadge', `Score: ${c.score.toFixed(2)}`);
    safeText('selAngleFacts', c.facts);

    const variantsOutput = document.getElementById('roastVariantsOutput');
    if (variantsOutput) variantsOutput.classList.add('d-none');
};

window.executeGenerateRoastVariants = async () => {
    if (!activeSelectedRoastAngle) return alert("Please select an angle first.");

    const spinner = document.getElementById('genRoastSpinner');
    const btn = document.getElementById('btnGenerateRoast');
    const output = document.getElementById('roastVariantsOutput');
    const list = document.getElementById('roastVariantsList');

    if (spinner) spinner.classList.remove('d-none');
    if (btn) btn.disabled = true;

    try {
        const genFn = functions.httpsCallable('generateRoastVariants');
        const res = await genFn({
            angleType: activeSelectedRoastAngle.angleType,
            targetPlayerName: activeSelectedRoastAngle.targetPlayerName,
            facts: activeSelectedRoastAngle.facts,
            intensity: roastSettingsState.intensity || 3,
            allowProfanity: Boolean(roastSettingsState.allowProfanity)
        });

        const data = res.data;
        if (data && data.ok && data.variants) {
            if (list) {
                list.innerHTML = data.variants.map(v => `
                    <div class="p-3 rounded bg-dark border border-secondary js-roast-variant">
                        <div class="text-light fst-italic mb-2" style="font-size:0.95rem; line-height:1.5;">"${esc(v.text)}"</div>
                        <div class="d-flex justify-content-between align-items-center pt-2 border-top border-secondary border-opacity-50">
                            <small class="text-muted"><i class="fas fa-check-circle text-info me-1"></i>Facts checkable: ${esc(activeSelectedRoastAngle.facts)}</small>
                            <div class="d-flex gap-2">
                                <button class="btn btn-sm btn-success fw-bold px-3 js-publish-roast" data-roast-text="${esc(v.text)}"><i class="fas fa-paper-plane me-1"></i>Publish</button>
                                <button class="btn btn-sm btn-outline-secondary js-discard-roast">Discard</button>
                            </div>
                        </div>
                    </div>
                `).join('');
            }
            if (output) output.classList.remove('d-none');
        }
    } catch (err) {
        alert("Failed to generate roast variants: " + err.message);
    } finally {
        if (spinner) spinner.classList.add('d-none');
        if (btn) btn.disabled = false;
    }
};

// Delegated so a roast containing an apostrophe cannot break the handler — an
// inline onclick="publish('${esc(text)}')" is unparseable the moment the text
// contains a quote, and esc() escapes HTML, not JS string delimiters.
function setupRoastVariantHandlers() {
    const list = document.getElementById('roastVariantsList');
    if (!list) return;
    list.addEventListener('click', (e) => {
        const publishBtn = e.target.closest('.js-publish-roast');
        if (publishBtn) {
            publishRoastVariant(publishBtn.dataset.roastText || '', publishBtn);
            return;
        }
        const discardBtn = e.target.closest('.js-discard-roast');
        if (discardBtn) discardRoastVariant(discardBtn);
    });
}

window.publishRoastVariant = async (roastText, btnEl) => {
    if (!activeSelectedRoastAngle) return;
    if (btnEl) btnEl.disabled = true;

    try {
        const pubFn = functions.httpsCallable('publishRoast');
        await pubFn({
            roastText,
            targetPlayerId: activeSelectedRoastAngle.targetPlayerId,
            targetPlayerName: activeSelectedRoastAngle.targetPlayerName,
            angleType: activeSelectedRoastAngle.angleType,
            facts: activeSelectedRoastAngle.facts,
            intensity: roastSettingsState.intensity || 3
        });

        showToast('Roast of the Week published to Community tab!');
        const modalEl = document.getElementById('roastStudioModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    } catch (err) {
        alert("Failed to publish roast: " + err.message);
        if (btnEl) btnEl.disabled = false;
    }
};

window.discardRoastVariant = (btnEl) => {
    const card = btnEl ? btnEl.closest('.js-roast-variant') : null;
    if (card) card.remove();
};

function populateFixtureVenueSelect() {
    const select = document.getElementById('fixtureVenueSelect');
    if (!select) return;
    const sorted = Array.from(locationsRegistry).sort((a, b) => a.localeCompare(b));
    select.innerHTML = sorted.map(loc => `<option value="${esc(loc)}" ${loc==='Sportgebouw Bibian Mentel'?'selected':''}>${esc(loc)}</option>`).join('');
}

let fixturePasteTimer = null;
window.onFixturePasteInput = (val) => {
    clearTimeout(fixturePasteTimer);
    const previewBox = document.getElementById('fixtureSquadsPreview');
    const h2hStrip = document.getElementById('fixtureH2HStrip');
    const btnGen = document.getElementById('btnGenFixturePreview');

    if (!val || !val.trim()) {
        if (previewBox) previewBox.innerHTML = '<span class="text-muted">Paste squads above to resolve players through Stage B resolver.</span>';
        if (h2hStrip) h2hStrip.classList.add('d-none');
        if (btnGen) btnGen.disabled = true;
        currentParsedFixtureSquads = null;
        return;
    }

    if (previewBox) {
        previewBox.innerHTML = '<div class="text-muted small py-2"><i class="fas fa-spinner fa-spin me-2"></i>Parsing lineup with AI...</div>';
    }
    if (btnGen) btnGen.disabled = true;

    fixturePasteTimer = setTimeout(async () => {
        await processFixturePaste(val);
    }, 350);
};

async function processFixturePaste(text) {
    const previewBox = document.getElementById('fixtureSquadsPreview');
    const h2hStrip = document.getElementById('fixtureH2HStrip');
    const btnGen = document.getElementById('btnGenFixturePreview');

    if (!text || !text.trim()) return;

    let parsed = null;
    try {
        const parseFn = functions.httpsCallable('parseLineup');
        const res = await parseFn({ rawText: text });
        parsed = res.data;
    } catch (aiErr) {
        console.warn("parseLineup unavailable/failed for fixture, using local fallback:", aiErr.message);
        parsed = fallbackLocalParser(text);
    }

    if (!parsed || !parsed.teams || parsed.teams.length < 2) {
        if (previewBox) {
            previewBox.innerHTML = '<div class="alert alert-danger py-1 px-2 mb-0 small"><i class="fas fa-exclamation-triangle me-1"></i>Could not identify at least 2 squads from the pasted text.</div>';
        }
        if (h2hStrip) h2hStrip.classList.add('d-none');
        if (btnGen) btnGen.disabled = true;
        currentParsedFixtureSquads = null;
        return;
    }

    // If venue was extracted, update venue select
    if (parsed.venue) {
        locationsRegistry.add(parsed.venue.trim());
        populateFixtureVenueSelect();
        const vSelect = document.getElementById('fixtureVenueSelect');
        if (vSelect) vSelect.value = parsed.venue.trim();
    }
    if (parsed.date) {
        const dInput = document.getElementById('fixtureDateTime');
        if (dInput && !dInput.value) dInput.value = parsed.date;
    }

    const teamKeys = ['A', 'B', 'C', 'D'];
    currentParsedFixtureSquads = parsed.teams.map((t, sIdx) => {
        const tKey = teamKeys[sIdx] || `T${sIdx+1}`;
        const rawPlayers = t.players || [];

        const playerItems = rawPlayers.map(p => {
            const rawToken = (p.rawName || p.playerId || '').trim();
            if (p.playerId && p.confidence >= 0.9 && playersRegistry.has(p.playerId)) {
                return {
                    status: 'resolved',
                    id: p.playerId,
                    displayName: playersRegistry.get(p.playerId).displayName,
                    rawInput: rawToken || playersRegistry.get(p.playerId).displayName
                };
            }
            const res = resolvePlayerInput(rawToken, tKey);
            if (res && res.status === 'resolved') {
                return {
                    status: 'resolved',
                    id: res.id,
                    displayName: res.displayName,
                    rawInput: rawToken
                };
            } else if (res && res.status === 'amber') {
                return {
                    status: 'amber',
                    rawInput: rawToken,
                    candidate: res.candidate,
                    candidates: res.candidates || (res.candidate ? [res.candidate] : []),
                    top3: res.top3 || []
                };
            } else if (res && res.status === 'red') {
                return {
                    status: 'red',
                    rawInput: rawToken,
                    candidates: res.candidates || res.top3 || [],
                    top3: res.top3 || []
                };
            } else {
                return {
                    status: 'new',
                    rawInput: rawToken,
                    top3: res?.top3 || []
                };
            }
        });

        const defaultName = sIdx === 0 ? 'Squad A' : (sIdx === 1 ? 'Squad B' : (sIdx === 2 ? 'Squad C' : `Squad ${sIdx+1}`));
        return {
            name: t.name || defaultName,
            color: t.color || null,
            playerItems,
            players: [],
            unparsed: parsed.unparsed || []
        };
    });

    renderParsedFixtureSquads();
}

function renderParsedFixtureSquads() {
    if (!currentParsedFixtureSquads) return;
    const previewBox = document.getElementById('fixtureSquadsPreview');
    const h2hStrip = document.getElementById('fixtureH2HStrip');
    const btnGen = document.getElementById('btnGenFixturePreview');
    if (!previewBox) return;

    let unresolvedCount = 0;
    const is3Squads = currentParsedFixtureSquads.length >= 3;
    const colClass = is3Squads ? 'col-12 col-md-4' : 'col-6';

    const squadsHtml = currentParsedFixtureSquads.map((sq, sIdx) => {
        const resolvedCount = sq.playerItems.filter(p => p.status === 'resolved').length;
        const chipsHtml = sq.playerItems.map((p, pIdx) => {
            if (p.status === 'resolved') {
                const isNewBadge = p.isNew ? '<span class="badge bg-info text-dark ms-1" style="font-size:0.6rem">NEW</span>' : '';
                return `<span class="badge bg-success bg-opacity-25 text-success me-1 mb-1 border border-success border-opacity-25" style="font-size:0.75rem">✓ ${esc(p.displayName)}${isNewBadge}</span>`;
            }
            unresolvedCount++;

            if (p.status === 'amber' && p.candidate) {
                return `
                <div class="btn-group btn-group-sm me-1 mb-1">
                    <button type="button" class="btn btn-sm btn-warning py-0 px-2 fw-bold" style="font-size:0.75rem" onclick="resolveFixtureCandidate(${sIdx}, ${pIdx}, '${p.candidate.id}')" title="Tap to accept candidate ${esc(p.candidate.displayName)}">
                        ? ${esc(p.rawInput)} → <b>${esc(p.candidate.displayName)}</b> <i class="fas fa-check ms-1"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-warning dropdown-toggle dropdown-toggle-split py-0 px-1" data-bs-toggle="dropdown"></button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow" style="z-index: 1060;">
                        <li><h6 class="dropdown-header">Match Candidates</h6></li>
                        <li><button type="button" class="dropdown-item small" onclick="resolveFixtureCandidate(${sIdx}, ${pIdx}, '${p.candidate.id}')"><i class="fas fa-user-check me-2 text-warning"></i>${esc(p.candidate.displayName)}</button></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><button type="button" class="dropdown-item small text-info" onclick="openFixtureManualSearch(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-search me-2"></i>🔍 Search Roster...</button></li>
                        <li><button type="button" class="dropdown-item small text-success" onclick="acceptFixtureNewPlayer(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-user-plus me-2"></i>+ Add "${esc(p.rawInput)}" as New Player</button></li>
                    </ul>
                </div>`;
            }

            if (p.candidates && p.candidates.length > 1) {
                // Ambiguous e.g. "Which Javi?"
                return `
                <div class="btn-group btn-group-sm me-1 mb-1">
                    <button type="button" class="btn btn-sm btn-warning dropdown-toggle py-0 px-2 fw-bold" data-bs-toggle="dropdown" style="font-size:0.75rem">
                        <i class="fas fa-question-circle me-1"></i>Which ${esc(p.rawInput)}?
                    </button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow" style="z-index: 1060;">
                        <li><h6 class="dropdown-header">Select Which Player</h6></li>
                        ${p.candidates.map(c => `
                            <li><button type="button" class="dropdown-item small" onclick="resolveFixtureCandidate(${sIdx}, ${pIdx}, '${c.id}')"><i class="fas fa-user me-2 text-warning"></i>${esc(c.displayName)} <small class="text-muted">(${esc(c.id)})</small></button></li>
                        `).join('')}
                        <li><hr class="dropdown-divider"></li>
                        <li><button type="button" class="dropdown-item small text-info" onclick="openFixtureManualSearch(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-search me-2"></i>🔍 Search Roster...</button></li>
                        <li><button type="button" class="dropdown-item small text-success" onclick="acceptFixtureNewPlayer(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-user-plus me-2"></i>+ Add "${esc(p.rawInput)}" as New Player</button></li>
                    </ul>
                </div>`;
            }

            // New / Unmatched (e.g. Tjeerd, Jory, Mark Jr)
            return `
            <div class="btn-group btn-group-sm me-1 mb-1">
                <button type="button" class="btn btn-sm btn-outline-info dropdown-toggle py-0 px-2 fw-bold" data-bs-toggle="dropdown" style="font-size:0.75rem">
                    <i class="fas fa-user-plus me-1"></i>New? "${esc(p.rawInput)}"
                </button>
                <ul class="dropdown-menu dropdown-menu-dark shadow" style="z-index: 1060;">
                    <li><h6 class="dropdown-header">Unmatched Player</h6></li>
                    <li><button type="button" class="dropdown-item small text-success fw-bold" onclick="acceptFixtureNewPlayer(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-check me-2"></i>+ Add "${esc(p.rawInput)}" as New Player</button></li>
                    <li><button type="button" class="dropdown-item small text-info" onclick="openFixtureManualSearch(${sIdx}, ${pIdx}, '${esc(p.rawInput)}')"><i class="fas fa-search me-2"></i>🔍 Manually Match from Roster</button></li>
                </ul>
            </div>`;
        }).join('');

        return `
        <div class="${colClass}">
            <div class="fw-bold text-white small mb-1">${esc(sq.name)} (${resolvedCount}/${sq.playerItems.length} resolved):</div>
            <div class="d-flex flex-wrap">${chipsHtml || '<span class="text-muted">Empty</span>'}</div>
        </div>`;
    }).join('');

    previewBox.innerHTML = `
        <div class="row g-2">
            ${squadsHtml}
        </div>
        ${unresolvedCount > 0 ? `
            <div class="alert alert-warning py-2 px-3 mt-3 mb-0 small d-flex flex-wrap justify-content-between align-items-center gap-2">
                <div><i class="fas fa-exclamation-circle me-1"></i><b>${unresolvedCount} player(s)</b> need resolution (debutants / ambiguous names).</div>
                <button type="button" class="btn btn-sm btn-success fw-bold py-1 px-2" onclick="acceptAllUnresolvedFixturePlayers()">
                    <i class="fas fa-user-plus me-1"></i>+ Accept All as New Players
                </button>
            </div>
        ` : ''}
    `;

    const allSquadsHavePlayers = currentParsedFixtureSquads.every(sq => sq.playerItems.length > 0);
    const isValid = unresolvedCount === 0 && allSquadsHavePlayers && currentParsedFixtureSquads.length >= 2;
    if (btnGen) btnGen.disabled = !isValid;

    if (isValid) {
        // Sync players array with IDs for preview generation
        currentParsedFixtureSquads.forEach(sq => {
            sq.players = sq.playerItems.map(p => p.id);
        });

        const eloData = computeEloRatings(allMatches).ratings || {};
        const avgElos = currentParsedFixtureSquads.map(sq => {
            return sq.players.length > 0
                ? Math.round(sq.players.reduce((sum, p) => sum + (eloData[p] || STARTING_ELO), 0) / sq.players.length)
                : STARTING_ELO;
        });

        if (h2hStrip) {
            h2hStrip.classList.remove('d-none');
            if (currentParsedFixtureSquads.length >= 3) {
                h2hStrip.innerHTML = `
                    <div class="d-flex flex-wrap justify-content-around align-items-center gap-2">
                        ${currentParsedFixtureSquads.map((sq, idx) => `
                            <div><b>${esc(sq.name)}:</b> Avg Elo <span class="text-info fw-bold">${avgElos[idx]}</span></div>
                        `).join('<span class="text-muted">vs</span>')}
                    </div>
                `;
            } else {
                h2hStrip.innerHTML = `
                    <div class="d-flex justify-content-between align-items-center">
                        <div><b>${esc(currentParsedFixtureSquads[0].name)}:</b> Avg Elo <span class="text-info fw-bold">${avgElos[0]}</span></div>
                        <span class="badge bg-secondary">H2H PREVIEW</span>
                        <div><b>${esc(currentParsedFixtureSquads[1].name)}:</b> Avg Elo <span class="text-info fw-bold">${avgElos[1]}</span></div>
                    </div>
                `;
            }
        }
    } else {
        if (h2hStrip) h2hStrip.classList.add('d-none');
    }
}

window.resolveFixtureCandidate = (sIdx, pIdx, playerId) => {
    if (!currentParsedFixtureSquads || !currentParsedFixtureSquads[sIdx]) return;
    const item = currentParsedFixtureSquads[sIdx].playerItems[pIdx];
    if (!item) return;
    const player = playersRegistry.get(playerId);
    if (!player) return;

    item.status = 'resolved';
    item.id = player.id;
    item.displayName = player.displayName;
    renderParsedFixtureSquads();
};

window.acceptFixtureNewPlayer = (sIdx, pIdx, rawName) => {
    if (!currentParsedFixtureSquads || !currentParsedFixtureSquads[sIdx]) return;
    const item = currentParsedFixtureSquads[sIdx].playerItems[pIdx];
    if (!item) return;

    const cleanName = (rawName || item.rawInput || '').trim();
    if (!cleanName) return;

    const slug = cleanName.toLowerCase()
        .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const newPlayerId = slug || `player_${Date.now()}_${Math.floor(Math.random()*1000)}`;

    const newPlayer = {
        id: newPlayerId,
        displayName: cleanName,
        aliases: [cleanName.toLowerCase()],
        active: true,
        isNew: true
    };
    playersRegistry.set(newPlayerId, newPlayer);

    item.status = 'resolved';
    item.id = newPlayerId;
    item.displayName = cleanName;
    item.isNew = true;

    renderParsedFixtureSquads();
};

window.acceptAllUnresolvedFixturePlayers = () => {
    if (!currentParsedFixtureSquads) return;
    currentParsedFixtureSquads.forEach((sq, sIdx) => {
        sq.playerItems.forEach((p, pIdx) => {
            if (p.status !== 'resolved') {
                if (p.status === 'amber' && p.candidate) {
                    p.status = 'resolved';
                    p.id = p.candidate.id;
                    p.displayName = p.candidate.displayName;
                } else {
                    const targetName = (p.candidates && p.candidates[0]) ? p.candidates[0].displayName : (p.rawInput || 'New Player');
                    acceptFixtureNewPlayer(sIdx, pIdx, targetName);
                }
            }
        });
    });
    renderParsedFixtureSquads();
};

let fixtureSearchContext = null; // { sIdx, pIdx, rawName }

window.openFixtureManualSearch = (sIdx, pIdx, rawName) => {
    fixtureSearchContext = { sIdx, pIdx, rawName };
    safeText('disambiguatePrompt', `Match "${rawName}" to an existing roster player:`);

    const container = document.getElementById('disambiguateCandidates');
    if (container) {
        const allPlayers = Array.from(playersRegistry.values()).filter(p => p.active !== false);
        allPlayers.sort((a, b) => a.displayName.localeCompare(b.displayName));

        container.innerHTML = `
            <input type="text" class="form-control form-control-sm mb-2" id="fixtureSearchRosterFilter" placeholder="Type player name..." style="font-size:16px;" oninput="filterFixtureRosterSearch(this.value)">
            <div id="fixtureRosterSearchResults" class="d-grid gap-1" style="max-height: 240px; overflow-y: auto;">
                ${allPlayers.map(p => `
                    <button type="button" class="btn btn-outline-light text-start py-1 px-2 small fw-bold" onclick="selectFixtureManualMatch('${p.id}')">
                        <i class="fas fa-user me-2 text-info"></i>${esc(p.displayName)} <small class="text-muted">(${esc(p.id)})</small>
                    </button>
                `).join('')}
            </div>
        `;
        setTimeout(() => document.getElementById('fixtureSearchRosterFilter')?.focus(), 300);
    }

    const createNewBtn = document.getElementById('disambiguateCreateNewBtn');
    if (createNewBtn) {
        createNewBtn.onclick = () => {
            const modalEl = document.getElementById('disambiguateModal');
            if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();
            acceptFixtureNewPlayer(sIdx, pIdx, rawName);
        };
    }

    const modalEl = document.getElementById('disambiguateModal');
    if (modalEl) new bootstrap.Modal(modalEl).show();
};

window.filterFixtureRosterSearch = (query) => {
    const list = document.getElementById('fixtureRosterSearchResults');
    if (!list) return;
    const q = (query || '').toLowerCase().trim();
    const allPlayers = Array.from(playersRegistry.values()).filter(p => p.active !== false);
    const filtered = allPlayers.filter(p => {
        const aliases = (p.aliases || []).join(' ').toLowerCase();
        return p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || aliases.includes(q);
    });
    list.innerHTML = filtered.map(p => `
        <button type="button" class="btn btn-outline-light text-start py-1 px-2 small fw-bold" onclick="selectFixtureManualMatch('${p.id}')">
            <i class="fas fa-user me-2 text-info"></i>${esc(p.displayName)} <small class="text-muted">(${esc(p.id)})</small>
        </button>
    `).join('');
};

window.selectFixtureManualMatch = (playerId) => {
    if (!fixtureSearchContext) return;
    const { sIdx, pIdx } = fixtureSearchContext;
    resolveFixtureCandidate(sIdx, pIdx, playerId);
    fixtureSearchContext = null;
    const modalEl = document.getElementById('disambiguateModal');
    if (modalEl) bootstrap.Modal.getInstance(modalEl)?.hide();
};

let currentDraftPreviewData = null;
window.executeGenerateFixturePreview = async () => {
    if (!currentParsedFixtureSquads) return alert("Please paste and resolve squads first.");

    const dateVal = document.getElementById('fixtureDateTime')?.value;
    const venueVal = document.getElementById('fixtureVenueSelect')?.value || 'Sportgebouw Bibian Mentel';
    const intensity = document.getElementById('fixturePreviewIntensity')?.value || 3;

    const spinner = document.getElementById('genFixtureSpinner');
    const btn = document.getElementById('btnGenFixturePreview');
    const draftCard = document.getElementById('fixtureDraftReviewCard');

    if (spinner) spinner.classList.remove('d-none');
    if (btn) btn.disabled = true;

    try {
        const previewFn = functions.httpsCallable('generateFixturePreview');
        const res = await previewFn({
            squads: currentParsedFixtureSquads,
            venue: venueVal,
            date: dateVal,
            intensity: Number(intensity)
        });

        const data = res.data;
        if (data && data.ok) {
            currentDraftPreviewData = {
                ...data,
                date: dateVal,
                venue: venueVal,
                squads: currentParsedFixtureSquads
            };

            safeText('draftPredictedWinnerBadge', `Prediction: ${data.predictedWinner} (${data.predictedWinnerOdds}% odds)`);
            safeText('draftPreviewText', `"${data.preview}"`);
            if (draftCard) draftCard.classList.remove('d-none');
        }
    } catch (err) {
        alert("Failed to generate draft preview: " + err.message);
    } finally {
        if (spinner) spinner.classList.add('d-none');
        if (btn) btn.disabled = false;
    }
};

window.publishCurrentFixture = async () => {
    if (!currentDraftPreviewData) return;

    try {
        // Permanently register any newly added debutant players to Firestore players_v2
        if (currentDraftPreviewData.squads) {
            const batch = db.batch();
            let newPlayerCount = 0;
            currentDraftPreviewData.squads.forEach(sq => {
                (sq.players || []).forEach(pId => {
                    const pDoc = playersRegistry.get(pId);
                    if (pDoc && pDoc.isNew) {
                        newPlayerCount++;
                        batch.set(db.collection(DB_CONFIG.collections.players).doc(pId), {
                            displayName: pDoc.displayName,
                            aliases: pDoc.aliases || [pDoc.displayName.toLowerCase()],
                            active: true,
                            createdAt: firebase.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                        delete pDoc.isNew;
                    }
                });
            });
            if (newPlayerCount > 0) {
                await batch.commit();
                fetchPlayerNames();
            }
        }

        const saveFn = functions.httpsCallable('saveFixture');
        await saveFn({
            status: 'scheduled',
            venue: currentDraftPreviewData.venue,
            date: currentDraftPreviewData.date,
            squads: currentDraftPreviewData.squads,
            preview: currentDraftPreviewData.preview,
            previewAngle: currentDraftPreviewData.previewAngle,
            predictedWinner: currentDraftPreviewData.predictedWinner,
            predictedWinnerOdds: currentDraftPreviewData.predictedWinnerOdds,
            predictionModel: currentDraftPreviewData.modelUsed
        });

        showToast('Fixture published! Predicted winner permanently frozen.');
        const draftCard = document.getElementById('fixtureDraftReviewCard');
        if (draftCard) draftCard.classList.add('d-none');
        const pasteInput = document.getElementById('fixtureSquadsPaste');
        if (pasteInput) pasteInput.value = '';
        onFixturePasteInput('');
    } catch (err) {
        alert("Failed to publish fixture: " + err.message);
    }
};

function renderExistingFixturesList() {
    const list = document.getElementById('existingFixturesList');
    if (!list) return;

    if (!allFixtures || allFixtures.length === 0) {
        list.innerHTML = '<div class="text-muted small">No scheduled or past fixtures found.</div>';
        return;
    }

    const sorted = [...allFixtures].sort((a, b) => {
        const tA = a.date ? (a.date.toDate ? a.date.toDate().getTime() : new Date(a.date).getTime()) : 0;
        const tB = b.date ? (b.date.toDate ? b.date.toDate().getTime() : new Date(b.date).getTime()) : 0;
        return tB - tA;
    });

    list.innerHTML = sorted.map(f => {
        const isScheduled = f.status === 'scheduled';
        const isPlayed = f.status === 'played';
        const dateStr = f.date ? formatDate(f.date.toDate ? f.date.toDate() : new Date(f.date)) : 'Upcoming';
        const sq1Names = (f.squads?.[0]?.players || []).map(getPlayerDisplayName).join(', ');
        const sq2Names = (f.squads?.[1]?.players || []).map(getPlayerDisplayName).join(', ');

        let statusBadge = `<span class="badge bg-secondary font-monospace">${f.status}</span>`;
        if (isScheduled) statusBadge = `<span class="badge bg-info text-dark font-monospace fw-bold">SCHEDULED</span>`;
        if (isPlayed) {
            statusBadge = f.predictionResult === 'correct'
                ? `<span class="badge bg-success bg-opacity-25 text-success font-monospace fw-bold">✓ Pick Correct</span>`
                : `<span class="badge bg-danger bg-opacity-25 text-danger font-monospace fw-bold">✗ Pick Wrong</span>`;
        }

        return `
        <div class="p-2 rounded bg-dark border border-secondary d-flex justify-content-between align-items-center">
            <div>
                <div class="d-flex align-items-center gap-2 mb-1">
                    <b class="text-white small">${dateStr}</b>
                    <small class="text-muted">${esc(f.venue || '')}</small>
                    ${statusBadge}
                </div>
                <small class="text-muted d-block" style="font-size:0.75rem;">${esc(sq1Names)} vs ${esc(sq2Names)}</small>
                ${f.predictedWinner ? `<small class="text-warning font-monospace" style="font-size:0.7rem;">🎯 Pick: ${esc(f.predictedWinner)}</small>` : ''}
            </div>
            <div class="d-flex gap-2">
                ${isScheduled ? `<button class="btn btn-sm btn-primary fw-bold py-1 px-2" onclick="recordResultShortcut('${f.id}')" style="font-size:0.75rem;"><i class="fas fa-clipboard-check me-1"></i>Record Result</button>` : ''}
                ${f.status !== 'archived' ? `<button class="btn btn-sm btn-outline-secondary py-1 px-2" onclick="archiveFixtureHandler('${f.id}')" style="font-size:0.75rem;">Archive</button>` : ''}
            </div>
        </div>
        `;
    }).join('');
}

/* ----------------------------------------------------------------------
   Roast management: list every roast and delete any of them.
   Deletion is a direct Firestore write — firestore.rules already restricts
   `roasts` writes to the admin, so no Cloud Function is needed. The admin
   listener is unconstrained, so this list sees drafts too.
   ---------------------------------------------------------------------- */
function renderPublishedRoastsList() {
    const list = document.getElementById('publishedRoastsList');
    const badge = document.getElementById('roastCountBadge');
    if (!list) return;

    const sorted = [...(allRoasts || [])].sort((a, b) => roastMillis(b) - roastMillis(a));
    if (badge) badge.textContent = String(sorted.length);

    if (sorted.length === 0) {
        list.innerHTML = '<div class="text-muted small">No roasts published yet.</div>';
        return;
    }

    const featured = selectFeaturedRoast(allRoasts);
    const featuredId = featured ? featured.roast.id : null;

    list.innerHTML = sorted.map(r => {
        const when = roastMillis(r);
        const isLive = r.id === featuredId;
        const statusBadge = isLive
            ? `<span class="badge bg-danger bg-opacity-25 text-danger font-monospace fw-bold" style="font-size:0.65rem">ON COMMUNITY TAB</span>`
            : `<span class="badge bg-secondary font-monospace" style="font-size:0.65rem">${esc(String(r.status || 'unknown').toUpperCase())}</span>`;
        return `
        <div class="p-2 rounded bg-dark border border-secondary">
            <div class="d-flex justify-content-between align-items-start gap-2">
                <div style="min-width:0">
                    <div class="d-flex align-items-center flex-wrap gap-2 mb-1">
                        <b class="text-white small">${esc(r.targetPlayerName || 'Unknown')}</b>
                        <small class="text-muted">${when ? esc(formatDate(new Date(when))) : 'No date'}</small>
                        ${statusBadge}
                    </div>
                    <small class="text-muted d-block fst-italic" style="font-size:0.75rem; overflow-wrap:anywhere">"${esc(r.roastText || '')}"</small>
                </div>
                <button class="btn btn-sm btn-outline-danger py-1 px-2 js-delete-roast" data-roast-id="${esc(r.id)}" style="font-size:0.75rem" title="Delete roast">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

window.confirmDeleteRoast = (roastId) => {
    if (!isSuperAdmin(currentUser)) return alert('Admin login required.');
    const r = (allRoasts || []).find(x => x.id === roastId);
    if (!r) return;

    const summary = document.getElementById('deleteRoastSummary');
    const target = document.getElementById('deleteRoastTargetId');
    if (target) target.value = roastId;
    if (summary) {
        const when = roastMillis(r);
        summary.innerHTML = `
            <div class="mb-2"><b>Target:</b> ${esc(r.targetPlayerName || 'Unknown')}</div>
            <div class="mb-2"><b>Published:</b> ${when ? esc(formatDate(new Date(when))) : 'Unknown'}</div>
            <div class="mb-2"><b>Intensity:</b> ${esc(String(r.intensity || 3))}/5</div>
            <div class="border-top border-secondary pt-2 mt-2 fst-italic text-muted" style="overflow-wrap:anywhere">"${esc(r.roastText || '')}"</div>`;
    }

    const modalEl = document.getElementById('deleteRoastModal');
    if (modalEl && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).show();
};

window.executeDeleteRoast = async () => {
    const target = document.getElementById('deleteRoastTargetId');
    const id = target ? target.value : '';
    if (!id) return;

    const modalEl = document.getElementById('deleteRoastModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
    }

    const load = document.getElementById('loadingOverlay');
    if (load) load.classList.remove('d-none');
    try {
        await db.collection('roasts').doc(id).delete();
        showToast('Roast deleted.');
        // The admin snapshot listener refreshes allRoasts and the Community tab;
        // this list lives in a modal the listener does not know about.
        renderPublishedRoastsList();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    } finally {
        if (load) load.classList.add('d-none');
    }
};

function setupRoastAdminHandlers() {
    const list = document.getElementById('publishedRoastsList');
    if (!list) return;
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('.js-delete-roast');
        if (btn) confirmDeleteRoast(btn.dataset.roastId);
    });
}

window.recordResultShortcut = (fixtureId) => {
    const f = allFixtures.find(x => x.id === fixtureId);
    if (!f || !f.squads || f.squads.length < 2) return;

    window.activeLinkedFixtureId = fixtureId;

    // Switch to match entry tab
    const adminTab = document.querySelector('button[data-bs-target="#admin"]');
    if (adminTab) new bootstrap.Tab(adminTab).show();

    // Close modal
    const modalEl = document.getElementById('roastStudioModal');
    if (modalEl) {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
    }

    // Set Date & Location
    if (f.date) {
        const d = f.date.toDate ? f.date.toDate() : new Date(f.date);
        const dInput = document.getElementById('matchDate');
        if (dInput) dInput.value = d.toISOString().split('T')[0];
    }
    if (f.venue) {
        locationsRegistry.add(f.venue);
        renderLocationsSelect(f.venue);
    }

    // Populate resolved chips
    const toChip = (pId) => ({
        status: 'resolved',
        id: pId,
        displayName: getPlayerDisplayName(pId),
        rawInput: getPlayerDisplayName(pId)
    });

    const isTourn = f.squads && f.squads.length >= 3;
    if (isTourn) {
        const rbTourn = document.getElementById('typeTournament');
        if (rbTourn) rbTourn.click();

        const colorSlotMap = { yellow: 'TournA', blue: 'TournB', red: 'TournC' };
        const defaultSlotNames = { TournA: 'Yellow', TournB: 'Blue', TournC: 'Red' };
        const allKeys = ['TournA', 'TournB', 'TournC'];
        const availableKeys = ['TournA', 'TournB', 'TournC'];
        const squadSlotAssignments = new Array(Math.min(3, f.squads.length));

        // Pass 1: match explicit color
        f.squads.slice(0, 3).forEach((sq, i) => {
            const c = (sq.color || '').toLowerCase().trim();
            const targetKey = colorSlotMap[c];
            if (targetKey && availableKeys.includes(targetKey)) {
                squadSlotAssignments[i] = targetKey;
                availableKeys.splice(availableKeys.indexOf(targetKey), 1);
            }
        });

        // Pass 2: remaining squads to available slots
        f.squads.slice(0, 3).forEach((sq, i) => {
            if (!squadSlotAssignments[i]) {
                squadSlotAssignments[i] = availableKeys.shift() || allKeys[i];
            }
        });

        f.squads.slice(0, 3).forEach((sq, i) => {
            const k = squadSlotAssignments[i];
            selectedPlayers[k] = (sq.players || []).map(toChip);
            const nameEl = document.getElementById(`name${k}`);
            if (nameEl) nameEl.value = sq.name || defaultSlotNames[k];
            renderList(k);
        });
    } else {
        const rbStd = document.getElementById('typeStandard');
        if (rbStd) rbStd.click();

        selectedPlayers.A = ((f.squads[0] && f.squads[0].players) || []).map(toChip);
        selectedPlayers.B = ((f.squads[1] && f.squads[1].players) || []).map(toChip);

        const nameA = document.getElementById('nameTeamA');
        if (nameA) nameA.value = (f.squads[0] && f.squads[0].name) || 'Squad A';
        const nameB = document.getElementById('nameTeamB');
        if (nameB) nameB.value = (f.squads[1] && f.squads[1].name) || 'Squad B';

        renderList('A');
        renderList('B');
    }

    renderRosterGrid();
    updateSaveButtonState();
    showToast('Match entry pre-populated! Enter score and save.');
};

window.archiveFixtureHandler = async (fixtureId) => {
    try {
        const arcFn = functions.httpsCallable('archiveFixture');
        await arcFn({ fixtureId });
        showToast('Fixture archived.');
    } catch (err) {
        alert("Failed to archive fixture: " + err.message);
    }
};

function loadRoastSettingsUI() {
    const range = document.getElementById('roastIntensityRange');
    const profCheck = document.getElementById('roastProfanityCheck');
    const optContainer = document.getElementById('roastOptOutContainer');

    if (range) range.value = roastSettingsState.intensity || 3;
    updateIntensityLabel(roastSettingsState.intensity || 3);
    if (profCheck) profCheck.checked = Boolean(roastSettingsState.allowProfanity);

    if (optContainer) {
        const players = Array.from(playersRegistry.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        optContainer.innerHTML = players.map(p => {
            const isOptedOut = (roastSettingsState.optedOutPlayerIds || []).includes(p.id);
            return `
            <div class="form-check form-check-inline me-2 mb-1">
                <input class="form-check-input" type="checkbox" id="opt_${p.id}" value="${p.id}" ${isOptedOut ? 'checked' : ''}>
                <label class="form-check-label small text-white" for="opt_${p.id}">${esc(p.displayName)}</label>
            </div>
            `;
        }).join('');
    }
}

window.updateIntensityLabel = (val) => {
    const lbl = document.getElementById('intensityValLabel');
    const textMap = {
        1: '1 (Gentle Ribbing)',
        2: '2 (Light Banter)',
        3: '3 (Playful Bite)',
        4: '4 (Savage Humor)',
        5: '5 (Scorched Earth)'
    };
    if (lbl) lbl.innerText = textMap[val] || `${val}`;
};

window.saveRoastSettingsHandler = async () => {
    // The opt-out list is a promise to a person; only the owner may change it.
    if (!isSuperAdmin(currentUser)) return alert("Roast safety settings are owner-only.");
    const intensity = document.getElementById('roastIntensityRange')?.value || 3;
    const allowProfanity = document.getElementById('roastProfanityCheck')?.checked || false;
    const optContainer = document.getElementById('roastOptOutContainer');
    const checked = optContainer ? Array.from(optContainer.querySelectorAll('input:checked')).map(i => i.value) : [];

    const spinner = document.getElementById('saveSettingsSpinner');
    if (spinner) spinner.classList.remove('d-none');

    try {
        const saveFn = functions.httpsCallable('saveRoastSettings');
        await saveFn({
            intensity: Number(intensity),
            allowProfanity,
            optedOutPlayerIds: checked
        });

        roastSettingsState = { intensity: Number(intensity), allowProfanity, optedOutPlayerIds: checked };
        showToast('Roast settings saved successfully.');
    } catch (err) {
        alert("Failed to save settings: " + err.message);
    } finally {
        if (spinner) spinner.classList.add('d-none');
    }
};

/* ======================================================================
   ITEM 13: FIXTURE & ROAST LIFECYCLE
   ----------------------------------------------------------------------
   Neither card used to expire. A fixture stayed pinned as "NEXT GAME" with
   a "Kickoff imminent" countdown long after it was played, and the first
   scheduled document won regardless of date, so several scheduled fixtures
   meant an arbitrary one was featured. A roast sat as "OF THE WEEK"
   indefinitely.
   ====================================================================== */
const FIXTURE_GRACE_MS  = 3 * 60 * 60 * 1000;       // still "next" while being played
const FIXTURE_AWAIT_MS  = 7 * 24 * 60 * 60 * 1000;  // then "awaiting result" for a week
const ROAST_FRESH_MS    = 7 * 24 * 60 * 60 * 1000;  // "of the week" only while true
const ROAST_STALE_MS    = 30 * 24 * 60 * 60 * 1000; // retired from the tab after this

function fixtureMillis(f) {
    if (!f || !f.date) return 0;
    const d = f.date.toDate ? f.date.toDate() : new Date(f.date);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * The fixture the Community tab should feature, if any.
 * Returns { fixture, state } where state is 'upcoming' or 'awaiting'.
 */
function selectFeaturedFixture(fixtures, now = Date.now()) {
    const scheduled = (fixtures || []).filter(f =>
        f.status === 'scheduled' && f.squads && f.squads.length >= 2 && fixtureMillis(f) > 0);
    if (scheduled.length === 0) return null;

    // Soonest still-upcoming fixture wins — not simply the first one found.
    const upcoming = scheduled
        .filter(f => fixtureMillis(f) >= now - FIXTURE_GRACE_MS)
        .sort((a, b) => fixtureMillis(a) - fixtureMillis(b));
    if (upcoming.length > 0) return { fixture: upcoming[0], state: 'upcoming' };

    // Recently played but never recorded: prompt instead of pretending it's next.
    const overdue = scheduled
        .filter(f => now - fixtureMillis(f) <= FIXTURE_AWAIT_MS)
        .sort((a, b) => fixtureMillis(b) - fixtureMillis(a));
    if (overdue.length > 0) return { fixture: overdue[0], state: 'awaiting' };

    return null;
}

function roastMillis(r) {
    if (!r) return 0;
    const t = r.publishedAt || r.createdAt;
    if (!t) return 0;
    if (t.toMillis) return t.toMillis();
    const d = t.toDate ? t.toDate() : new Date(t);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * The roast to feature. Returns { roast, fresh } — `fresh` false means it is
 * shown, but no longer billed as this week's.
 */
function selectFeaturedRoast(roasts, now = Date.now()) {
    const published = (roasts || [])
        .filter(r => r.status === 'published')
        .sort((a, b) => roastMillis(b) - roastMillis(a));
    if (published.length === 0) return null;

    const latest = published[0];
    const age = now - roastMillis(latest);
    if (roastMillis(latest) > 0 && age > ROAST_STALE_MS) return null;
    return { roast: latest, fresh: roastMillis(latest) === 0 || age <= ROAST_FRESH_MS };
}

function formatCountdown(targetDate) {
    if (!targetDate || isNaN(targetDate.getTime())) return '';
    const now = new Date();
    const diffMs = targetDate.getTime() - now.getTime();
    if (diffMs <= 0) return 'Kickoff imminent / Today';
    const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0) return `In ${days}d ${hours}h`;
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `In ${hours}h ${mins}m`;
}

/** Item 29 & Item 42: Community Tab Rendering with Strict Hierarchy */
window.selectedCommunityAwardsMonth = null;
window.renderCommunityTabWithMonth = (monthVal) => {
    window.selectedCommunityAwardsMonth = monthVal;
    renderCommunityTab(allMatches, monthVal);
};

async function renderCommunityTab(matches, forcedMonth = null) {
    const container = document.getElementById('communityContainer');
    if (!container) return;

    // Helper: render player pills with profile navigation
    const renderPlayerPills = (playerIds) => {
        if (!playerIds || playerIds.length === 0) return '';
        return playerIds.map(pId => {
            const name = getPlayerDisplayName(pId);
            return `<span class="player-pill" data-player-id="${esc(pId)}">${esc(name)}</span>`;
        }).join(', ');
    };

    // 1. CARD 1: NEXT GAME SCHEDULED (Item 42)
    let nextGameHtml = '';
    const featuredFixture = selectFeaturedFixture(allFixtures);
    const scheduledFixture = featuredFixture ? featuredFixture.fixture : null;
    if (scheduledFixture) {
        const awaitingResult = featuredFixture.state === 'awaiting';
        const fDate = scheduledFixture.date ? (scheduledFixture.date.toDate ? scheduledFixture.date.toDate() : new Date(scheduledFixture.date)) : null;
        // A fixture whose date has passed is awaiting a result, not imminent.
        const countdownStr = awaitingResult
            ? `Played ${fDate ? formatDate(fDate) : ''} — result not recorded`
            : (fDate ? formatCountdown(fDate) : 'Upcoming');
        const dateDisplay = fDate ? formatDate(fDate) : 'Upcoming';

        const eloData = computeEloRatings(matches).ratings || {};
        let squadsLayoutHtml = '';
        if (scheduledFixture.squads && scheduledFixture.squads.length >= 3) {
            squadsLayoutHtml = `
            <div class="row g-2 mb-3 text-center align-items-stretch justify-content-center">
                ${scheduledFixture.squads.map((sq, sIdx) => {
                    const avgElo = sq.players?.length ? Math.round(sq.players.reduce((sum, p) => sum + (eloData[p] || STARTING_ELO), 0) / sq.players.length) : STARTING_ELO;
                    return `
                    <div class="col-12 col-md-4">
                        <div class="p-2 rounded bg-black bg-opacity-25 h-100 border border-secondary border-opacity-25 d-flex flex-column justify-content-between">
                            <div>
                                <h6 class="fw-bold text-white mb-1">${esc(sq.name || `Squad ${String.fromCharCode(65 + sIdx)}`)}</h6>
                                <div class="text-info small fw-bold mb-1">Avg Elo: ${avgElo}</div>
                            </div>
                            <div class="small text-muted mt-1">${renderPlayerPills(sq.players)}</div>
                        </div>
                    </div>
                    `;
                }).join('')}
            </div>
            `;
        } else {
            const sq1 = scheduledFixture.squads[0] || { name: 'Squad A', players: [] };
            const sq2 = scheduledFixture.squads[1] || { name: 'Squad B', players: [] };
            const avgElo1 = sq1.players?.length ? Math.round(sq1.players.reduce((sum, p) => sum + (eloData[p] || STARTING_ELO), 0) / sq1.players.length) : STARTING_ELO;
            const avgElo2 = sq2.players?.length ? Math.round(sq2.players.reduce((sum, p) => sum + (eloData[p] || STARTING_ELO), 0) / sq2.players.length) : STARTING_ELO;

            squadsLayoutHtml = `
            <div class="row g-2 mb-3 align-items-center text-center">
                <div class="col-5">
                    <h6 class="fw-bold text-white mb-1">${esc(sq1.name || 'Squad A')}</h6>
                    <div class="text-info small fw-bold mb-1">Avg Elo: ${avgElo1}</div>
                    <div class="small text-muted">${renderPlayerPills(sq1.players)}</div>
                </div>
                <div class="col-2">
                    <span class="badge bg-secondary font-monospace px-2 py-1" style="font-size:0.8rem">VS</span>
                </div>
                <div class="col-5">
                    <h6 class="fw-bold text-white mb-1">${esc(sq2.name || 'Squad B')}</h6>
                    <div class="text-info small fw-bold mb-1">Avg Elo: ${avgElo2}</div>
                    <div class="small text-muted">${renderPlayerPills(sq2.players)}</div>
                </div>
            </div>
            `;
        }

        nextGameHtml = `
        <div class="card bg-dark ${awaitingResult ? 'border-warning' : 'border-info'} border-opacity-75 p-3 mb-4 shadow-sm" id="nextGameScheduledCard">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2 pb-1 border-bottom border-secondary border-opacity-50">
                <div class="d-flex align-items-center flex-wrap gap-2">
                    <span class="badge ${awaitingResult ? 'bg-warning' : 'bg-info'} text-dark fw-bold"><i class="far fa-calendar-alt me-1"></i>${awaitingResult ? 'AWAITING RESULT' : 'NEXT GAME'}</span>
                    <span class="text-white small fw-bold"><i class="far fa-clock me-1 ${awaitingResult ? 'text-warning' : 'text-info'}"></i>${esc(countdownStr)}</span>
                </div>
                <div class="d-flex align-items-center gap-2">
                    <span class="text-muted small"><i class="fas fa-map-marker-alt text-primary me-1"></i>${esc(scheduledFixture.venue || 'Sportgebouw Bibian Mentel')}</span>
                    <button class="btn btn-sm btn-link text-muted p-0 text-decoration-none js-share" data-share-type="fixture" data-share-id="${esc(scheduledFixture.id)}" data-share-title="Next Fixture — Elderly Support" title="Share Fixture"><i class="fas fa-share-alt"></i></button>
                </div>
            </div>
            
            ${squadsLayoutHtml}

            ${scheduledFixture.preview ? `
            <div class="p-3 rounded bg-black bg-opacity-40 border border-warning border-opacity-50 mt-2">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="text-warning fw-bold small"><i class="fas fa-feather-alt me-1"></i>The Commissioner's Preview:</span>
                    ${scheduledFixture.predictedWinner ? `<span class="badge bg-warning text-dark font-monospace fw-bold" style="font-size:0.75rem">🎯 Pick: ${esc(scheduledFixture.predictedWinner)} (${scheduledFixture.predictedWinnerOdds || 55}% odds)</span>` : ''}
                </div>
                <div class="text-light fst-italic" style="font-size:0.9rem; line-height:1.5;">"${esc(scheduledFixture.preview)}"</div>
            </div>
            ` : ''}
        </div>
        `;
    }

    // 2. CARD 2: ROAST OF THE WEEK (Item 42)
    let roastHtml = '';
    // Newest published roast, retired from the tab once it goes stale (item 13).
    const featuredRoast = selectFeaturedRoast(allRoasts);
    if (featuredRoast) {
        const latestRoast = featuredRoast.roast;
        const roastIsFresh = featuredRoast.fresh;
        roastHtml = `
        <div class="card bg-dark ${roastIsFresh ? 'border-danger' : 'border-secondary'} p-3 mb-4 shadow-sm" id="roastOfTheWeekCard">
            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2 pb-1 border-bottom border-secondary border-opacity-50">
                <div class="d-flex align-items-center flex-wrap gap-2">
                    <span class="badge ${roastIsFresh ? 'bg-danger' : 'bg-secondary'} text-white fw-bold"><i class="fas fa-fire me-1"></i>${roastIsFresh ? 'ROAST OF THE WEEK' : 'LATEST ROAST'}</span>
                    <span class="text-muted small">Target: <b class="text-white">${esc(latestRoast.targetPlayerName)}</b></span>
                </div>
                <div class="d-flex align-items-center gap-2">
                    <span class="badge bg-secondary font-monospace" style="font-size:0.7rem">Intensity ${latestRoast.intensity || 3}/5</span>
                    <button class="btn btn-sm btn-link text-muted p-0 text-decoration-none js-share" data-share-type="roast" data-share-id="${esc(latestRoast.id)}" data-share-title="Roast: ${esc(latestRoast.targetPlayerName)}" title="Share Roast"><i class="fas fa-share-alt"></i></button>
                </div>
            </div>
            <div class="text-light fst-italic my-2" style="font-size:0.95rem; line-height:1.5;">"${esc(latestRoast.roastText)}"</div>
            <div class="small text-muted pt-1 border-top border-secondary border-opacity-25 d-flex justify-content-between">
                <span><i class="fas fa-check-circle text-info me-1"></i>Facts: ${esc(latestRoast.facts || '')}</span>
                <span>${latestRoast.publishedAt ? formatDate(latestRoast.publishedAt.toDate ? latestRoast.publishedAt.toDate() : new Date(latestRoast.publishedAt)) : ''}</span>
            </div>
        </div>
        `;
    }

    // 3. CARD 3: WEEKLY POWER RANKINGS (Item 25)
    const powerData = computeWeeklyPowerRankings(matches);
    let powerRankingsRows = '';

    if (!powerData.rankings || powerData.rankings.length === 0) {
        powerRankingsRows = '<tr><td colspan="5" class="text-center py-4 text-muted small">No ranking data available.</td></tr>';
    } else {
        powerData.rankings.forEach(p => {
            let movementBadge = '';
            if (p.isProvisional) {
                movementBadge = `<span class="badge-provisional" title="Provisional (${p.matches}/${MIN_GAMES_RANKED_ELO})">?</span>`;
            } else if (p.isNew) {
                movementBadge = `<span class="badge bg-info bg-opacity-25 text-info" style="font-size:0.75rem">★ NEW</span>`;
            } else if (p.delta > 0) {
                movementBadge = `<span class="badge bg-success bg-opacity-25 text-success fw-bold" style="font-size:0.75rem">▲ +${p.delta}</span>`;
            } else if (p.delta < 0) {
                movementBadge = `<span class="badge bg-danger bg-opacity-25 text-danger fw-bold" style="font-size:0.75rem">▼ ${p.delta}</span>`;
            } else {
                movementBadge = `<span class="badge bg-secondary bg-opacity-25 text-muted" style="font-size:0.75rem">― 0</span>`;
            }

            const rowClass = p.isProvisional ? 'text-muted opacity-75' : '';

            powerRankingsRows += `
            <tr style="cursor:pointer;" onclick="openPlayerStats('${p.id}')" class="${rowClass}">
                <td class="ps-3 fw-bold">${p.rank}</td>
                <td>${movementBadge}</td>
                <td class="fw-bold text-start ${p.isProvisional ? '' : 'text-light'}">${esc(p.name)}</td>
                <td class="fw-bold text-warning">${p.elo}</td>
                <td class="pe-3 text-muted">${p.matches}</td>
            </tr>`;
        });
    }

    const windowNotice = powerData.hasMatchesInWindow
        ? `<span class="text-success small"><i class="fas fa-check-circle me-1"></i>${powerData.matchesInWindowCount} matches in 7-day window (${powerData.dateRangeText})</span>`
        : `<span class="text-muted small"><i class="fas fa-info-circle me-1"></i>No matches in the past 7 days (${powerData.dateRangeText}). Movement unchanged.</span>`;

    // 4. CARD 4: MILESTONE WATCH (Item 28) - Collapsed by default
    const watchlist = computeMilestoneWatch(matches);
    let milestoneWatchHtml = '';
    if (watchlist.length === 0) {
        milestoneWatchHtml = `<div class="p-3 rounded bg-dark border border-secondary text-muted small text-center"><i class="fas fa-flag-checkered text-secondary me-2"></i>No players currently within 1–2 games of a 25-cap milestone.</div>`;
    } else {
        milestoneWatchHtml = `<div class="row g-2">` + watchlist.map(w => `
            <div class="col-12 col-md-6">
                <div class="p-2 px-3 rounded bg-dark border border-warning border-opacity-50 d-flex justify-content-between align-items-center" style="cursor:pointer;" onclick="openPlayerStats('${w.playerId}')">
                    <div>
                        <span class="fw-bold text-white">${esc(w.name)}</span>
                        <small class="text-muted d-block">${w.caps} Caps</small>
                    </div>
                    <span class="badge bg-warning text-dark fw-bold">${w.away} away from ${w.nextMilestone} 🎯</span>
                </div>
            </div>
        `).join('') + `</div>`;
    }

    // 5. CARD 5: MONTHLY AWARDS (Item 29) - Collapsed by default
    // Under "All Time" the awards still need one concrete season: use the most
    // recent year present in the data, never a hardcoded year.
    const fYear = document.getElementById('filterYear');
    const latestYear = latestYearInMatches(matches);
    const curYear = (fYear && fYear.value !== 'all') ? fYear.value : latestYear;

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthsWithMatches = [];
    matches.forEach(m => {
        const d = m.date ? (m.date.toDate ? m.date.toDate() : new Date(m.date)) : null;
        if (!d || isNaN(d.getTime())) return;
        const y = d.getFullYear();
        if (curYear === 'all' || y === parseInt(curYear)) {
            const mo = d.getMonth();
            if (!monthsWithMatches.includes(mo)) monthsWithMatches.push(mo);
        }
    });
    monthsWithMatches.sort((a, b) => b - a);

    const defaultMonth = monthsWithMatches.length > 0 ? String(monthsWithMatches[0]) : String(new Date().getMonth());
    let activeMonth = forcedMonth !== null ? String(forcedMonth) : (window.selectedCommunityAwardsMonth !== null ? String(window.selectedCommunityAwardsMonth) : defaultMonth);
    // A month remembered from a previous year filter may not exist in this one.
    if (monthsWithMatches.length > 0 && !monthsWithMatches.includes(parseInt(activeMonth, 10))) {
        activeMonth = defaultMonth;
    }

    const awardsData = computeMonthlyAwards(matches, curYear, activeMonth);

    const monthOptionsHtml = monthsWithMatches.map(mo => {
        const isSel = String(mo) === String(activeMonth) ? 'selected' : '';
        return `<option value="${mo}" ${isSel}>${monthNames[mo]} ${curYear}</option>`;
    }).join('');

    /* Item 9: a card whose winner came from a lowered threshold says so, rather
       than presenting a thin-month result with the same confidence as a full one. */
    const tierBadge = (award) => (award && award.tier && award.tier !== 'qualified')
        ? `<span class="badge bg-secondary bg-opacity-50 text-warning fw-bold ms-2" style="font-size:0.6rem; letter-spacing:0.5px" title="Qualification threshold was lowered for this month">PROVISIONAL</span>`
        : '';
    const tierNote = (award) => (award && award.note)
        ? `<div class="text-warning opacity-75 mt-2" style="font-size:0.7rem; line-height:1.3"><i class="fas fa-circle-info me-1"></i>${esc(award.note)}</div>`
        : '';
    const emptyAward = (reason) => `<div class="text-muted small py-3">${esc(reason)}</div>`;
    const noMatchesMsg = `No matches recorded in ${awardsData.monthName} ${curYear}.`;

    let potmCard = `<div class="col-12 col-md-6 col-lg-4 mb-3">
        <div class="p-3 rounded bg-dark border border-secondary h-100">
            <span class="text-warning small fw-bold d-block mb-1"><i class="fas fa-crown me-2"></i>PLAYER OF THE MONTH${tierBadge(awardsData.potm)}</span>
            ${awardsData.potm ? `
                <h5 class="fw-bold text-white mb-1" style="cursor:pointer;" onclick="openPlayerStats('${esc(awardsData.potm.id)}')">${esc(awardsData.potm.name)}</h5>
                <div class="text-info fw-bold mb-1">${awardsData.potm.ppg} PPG <span class="text-muted small fw-normal">(${awardsData.potm.played} matches, ${awardsData.potm.won}W)</span></div>
                <small class="text-muted">Highest points-per-game in ${awardsData.monthName} (${awardsData.potm.played} of ${awardsData.totalMonthMatches} games)</small>
                ${tierNote(awardsData.potm)}
            ` : emptyAward(noMatchesMsg)}
        </div>
    </div>`;

    let improvedCard = `<div class="col-12 col-md-6 col-lg-4 mb-3">
        <div class="p-3 rounded bg-dark border border-secondary h-100">
            <span class="text-success small fw-bold d-block mb-1"><i class="fas fa-chart-line me-2"></i>MOST IMPROVED${tierBadge(awardsData.mostImproved)}</span>
            ${awardsData.mostImproved ? `
                <h5 class="fw-bold text-white mb-1" style="cursor:pointer;" onclick="openPlayerStats('${esc(awardsData.mostImproved.id)}')">${esc(awardsData.mostImproved.name)}</h5>
                <div class="${awardsData.mostImproved.rawDelta > 0 ? 'text-success' : 'text-warning'} fw-bold mb-1">${awardsData.mostImproved.delta} PPG <span class="text-muted small fw-normal">(${awardsData.mostImproved.monthPPG} vs ${awardsData.mostImproved.careerPPG} career)</span></div>
                <small class="text-muted">${awardsData.mostImproved.rawDelta > 0 ? 'Strongest positive form differential relative to baseline' : 'Closest to their career baseline this month'}</small>
                ${tierNote(awardsData.mostImproved)}
            ` : emptyAward(noMatchesMsg)}
        </div>
    </div>`;

    let ironMenList = awardsData.ironMen.length > 0 
        ? awardsData.ironMen.map(p => `<span class="badge bg-secondary me-1 mb-1 p-2" style="cursor:pointer" onclick="openPlayerStats('${p.id}')">${esc(p.name)}</span>`).join('')
        : emptyAward(noMatchesMsg);

    const isFullAttendance = awardsData.maxPlayedInMonth === awardsData.totalMonthMatches;
    let ironManCard = `<div class="col-12 col-md-6 col-lg-4 mb-3">
        <div class="p-3 rounded bg-dark border border-secondary h-100">
            <span class="text-info small fw-bold d-block mb-1"><i class="fas fa-shield-alt me-2"></i>IRON MEN (${isFullAttendance ? '100% ATTENDANCE' : 'TOP ATTENDANCE'})</span>
            <div class="d-flex flex-wrap pt-1">${ironMenList}</div>
            <small class="text-muted d-block mt-2">${isFullAttendance ? `Attended ${awardsData.totalMonthMatches === 1 ? 'the one match' : `all ${awardsData.totalMonthMatches} matches`}` : `Attended ${awardsData.maxPlayedInMonth} of ${awardsData.totalMonthMatches} matches`} in ${awardsData.monthName}</small>
        </div>
    </div>`;

    let worstDuoCard = `<div class="col-12 col-md-6 col-lg-6 mb-3">
        <div class="p-3 rounded bg-dark border border-secondary h-100">
            <span class="text-danger small fw-bold d-block mb-1"><i class="fas fa-heart-broken me-2"></i>COLD DUO OF THE MONTH${tierBadge(awardsData.worstDuo)}</span>
            ${awardsData.worstDuo ? `
                <h6 class="fw-bold text-white mb-1">${esc(awardsData.worstDuo.p1)} & ${esc(awardsData.worstDuo.p2)}</h6>
                <div class="text-danger fw-bold mb-1">${awardsData.worstDuo.winRate}% Win Rate <span class="text-muted small fw-normal">(${awardsData.worstDuo.won} ${awardsData.worstDuo.won === 1 ? 'win' : 'wins'} in ${awardsData.worstDuo.played} ${awardsData.worstDuo.played === 1 ? 'game' : 'games'})</span></div>
                <small class="text-muted">Lowest win percentage as teammates in ${awardsData.monthName}</small>
                ${tierNote(awardsData.worstDuo)}
            ` : emptyAward(noMatchesMsg)}
        </div>
    </div>`;

    let ghostCard = `<div class="col-12 col-md-6 col-lg-6 mb-3">
        <div class="p-3 rounded bg-dark border border-secondary h-100">
            <span class="text-muted small fw-bold d-block mb-1"><i class="fas fa-ghost me-2"></i>GHOST OF THE MONTH${tierBadge(awardsData.ghost)}</span>
            ${awardsData.ghost ? `
                <h6 class="fw-bold text-white mb-1" style="cursor:pointer;" onclick="openPlayerStats('${esc(awardsData.ghost.id)}')">${esc(awardsData.ghost.name)}</h6>
                <div class="text-warning fw-bold mb-1">${awardsData.ghost.monthPlayed} of ${awardsData.totalMonthMatches} attended <span class="text-muted small fw-normal">(${awardsData.ghost.attendanceRate}%)</span></div>
                <small class="text-muted">Regular player (${awardsData.ghost.careerPlayed} career caps) most missed in ${awardsData.monthName}</small>
                ${tierNote(awardsData.ghost)}
            ` : emptyAward(`Every player on record turned out for ${awardsData.totalMonthMatches === 1 ? 'the one match' : `all ${awardsData.totalMonthMatches} matches`} in ${awardsData.monthName}.`)}
        </div>
    </div>`;

    // A handful of matches cannot support a confident award whatever the
    // per-card tier says, so state the sample size once at the top.
    const sampleBanner = awardsData.sampleNote
        ? `<div class="p-2 px-3 mb-3 rounded bg-black bg-opacity-25 border border-warning border-opacity-25 text-warning small">
               <i class="fas fa-circle-info me-2"></i>${esc(awardsData.sampleNote)}
           </div>`
        : '';

    // Bootstrap collapse state lives in the DOM, so it is lost when this container
    // is rebuilt. Capture it first — otherwise picking an awards month re-renders
    // the panel closed and reads as "nothing happened". Changing the month always
    // reopens the awards panel, since that is what the maintainer just asked to see.
    const wasOpen = (id) => {
        const el = document.getElementById(id);
        return !!(el && el.classList.contains('show'));
    };
    const awardsOpen = forcedMonth !== null || wasOpen('awardsCollapse');
    const milestoneOpen = wasOpen('milestoneWatchCollapse');

    // A denied or failed feed used to vanish into console.warn, leaving the cards
    // silently absent. Say so on the page instead.
    const feedErrorHtml = Object.values(communityFeedErrors).filter(Boolean).map(msg => `
        <div class="alert alert-warning bg-dark border-warning text-warning py-2 px-3 mb-3 small" role="alert">
            <i class="fas fa-triangle-exclamation me-2"></i>${esc(msg)}
        </div>
    `).join('');

    container.innerHTML = `
        ${feedErrorHtml}

        <!-- 1. NEXT GAME SCHEDULED (ITEM 42) -->
        ${nextGameHtml}

        <!-- 2. ROAST OF THE WEEK (ITEM 42) -->
        ${roastHtml}

        <!-- 3. WEEKLY POWER RANKINGS (ITEM 25) -->
        <div class="card bg-dark border-secondary p-3 mb-4">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-2">
                <h6 class="fw-bold text-white small m-0"><i class="fas fa-bolt text-warning me-2"></i>WEEKLY POWER RANKINGS (7-DAY MOVEMENT)</h6>
                <div class="mt-1 mt-sm-0">${windowNotice}</div>
            </div>
            <small class="text-muted d-block mb-3">Rank delta compares current Elo ranking against Elo ranking 7 days prior. Provisional players (? badge) excluded from movement.</small>
            <div class="table-responsive">
                <table class="table table-dark table-hover mb-0 text-center" style="white-space: nowrap;">
                    <thead>
                        <tr class="text-muted small border-secondary">
                            <th class="ps-3 text-start">#</th>
                            <th>MOVE</th>
                            <th class="text-start">PLAYER</th>
                            <th>ELO</th>
                            <th class="pe-3">CAPS</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${powerRankingsRows}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- 4. MILESTONE WATCH (ITEM 28) - Collapsed by default -->
        <div class="card bg-dark border-secondary p-3 mb-4">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <h6 class="fw-bold text-white small m-0"><i class="fas fa-flag-checkered text-warning me-2"></i>MILESTONE WATCH (25-CAP INTERVALS)</h6>
                <button class="btn btn-sm btn-outline-secondary py-0" type="button" data-bs-toggle="collapse" data-bs-target="#milestoneWatchCollapse" aria-expanded="${milestoneOpen}">
                    Toggle View
                </button>
            </div>
            <div class="collapse${milestoneOpen ? ' show' : ''}" id="milestoneWatchCollapse">
                ${milestoneWatchHtml}
            </div>
        </div>

        <!-- 5. MONTHLY AWARDS (ITEM 29) - Collapsed by default -->
        <div class="card bg-dark border-secondary p-3 mb-4">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
                <div>
                    <h6 class="fw-bold text-white small m-0"><i class="fas fa-trophy text-info me-2"></i>MONTHLY AWARDS (${awardsData.monthName} ${curYear})</h6>
                    <small class="text-muted">Honoring standout performances and league stories</small>
                </div>
                <div class="d-flex align-items-center gap-2">
                    <select id="communityAwardsMonth" class="form-select form-select-sm bg-dark text-white border-secondary" style="width: auto; font-size: 0.8rem;" onchange="renderCommunityTabWithMonth(this.value)">
                        ${monthOptionsHtml}
                    </select>
                    <button class="btn btn-sm btn-outline-secondary py-0" type="button" data-bs-toggle="collapse" data-bs-target="#awardsCollapse" aria-expanded="${awardsOpen}">
                        Toggle View
                    </button>
                </div>
            </div>
            <div class="collapse${awardsOpen ? ' show' : ''}" id="awardsCollapse">
                ${sampleBanner}
                <div class="row">
                    ${potmCard}
                    ${improvedCard}
                    ${ironManCard}
                </div>
                <div class="row">
                    ${worstDuoCard}
                    ${ghostCard}
                </div>
            </div>
        </div>
    `;

    // The select was destroyed with the old markup; hand focus back so the next
    // month is one tap away.
    if (forcedMonth !== null) {
        const monthSelect = document.getElementById('communityAwardsMonth');
        if (monthSelect) monthSelect.focus({ preventScroll: true });
    }
}

// Listen for deep links & tab visibility
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        handleDeepLinks();
        updateFilterVisibility();
        document.querySelectorAll('#myTab button[data-bs-toggle="tab"]').forEach(tabBtn => {
            tabBtn.addEventListener('shown.bs.tab', () => {
                updateFilterVisibility();
            });
        });
    });
}
if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
        handleDeepLinks();
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        STARTING_ELO,
        K_STANDARD_REG,
        K_STANDARD_NEW,
        K_TOURN_REG,
        K_TOURN_NEW,
        MIN_GAMES_RANKED_ELO,
        MIN_APPEARANCES_PPG,
        MIN_GAMES_PAIR,
        MIN_GAMES_IMPROVED,
        MILESTONE_INTERVAL,
        ROAST_THRESHOLD,
        minAppearancesForPeriod,
        computeWeeklyPowerRankings,
        computeMilestoneWatch,
        computeMonthlyAwards,
        resolvePlayerIdentifier,
        computeEloRatings,
        computeRoastAngles,
        computeExpectedScore
    };
}

