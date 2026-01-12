// --- 1. CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc",
    authDomain: "elderly-support-league.firebaseapp.com",
    projectId: "elderly-support-league",
    storageBucket: "elderly-support-league.firebasestorage.app",
    messagingSenderId: "973119844128",
    appId: "1:973119844128:web:0205ac9cdf912fa31ef145",
    measurementId: "G-101F2P233G"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Global State for Form
let selectedPlayers = { A: [], B: [], C: [] };
let allPlayerNames = []; // For autocomplete

// --- 2. INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    loadLeaderboard();
    loadMatchHistory();
    fetchPlayerNamesForAutocomplete();
    
    // Set default date to today
    document.getElementById('matchDate').valueAsDate = new Date();
});

// --- 3. CORE FUNCTIONS ---

// A. Fetch Leaderboard & Update UI
function loadLeaderboard() {
    db.collection("players").orderBy("stats.points", "desc").orderBy("stats.gd", "desc")
    .onSnapshot((snapshot) => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        
        if(snapshot.empty) {
            tbody.innerHTML = "<tr><td colspan='8' class='text-center'>No stats yet. Start by adding a match!</td></tr>";
            return;
        }

        let rank = 1;
        snapshot.forEach((doc) => {
            const p = doc.data();
            const s = p.stats;
            const row = `
                <tr>
                    <td>${rank++}</td>
                    <td class="fw-bold">${p.name}</td>
                    <td>${s.played}</td>
                    <td>${s.won}</td>
                    <td>${s.drawn}</td>
                    <td>${s.lost}</td>
                    <td>${s.gf - s.ga}</td>
                    <td class="fw-bold text-primary">${s.points}</td>
                </tr>`;
            tbody.innerHTML += row;
        });
    });
}

// B. Fetch Match History
function loadMatchHistory() {
    db.collection("matches").orderBy("date", "desc").limit(10)
    .onSnapshot((snapshot) => {
        const list = document.getElementById('match-history-list');
        list.innerHTML = "";

        if(snapshot.empty) {
            list.innerHTML = "<div class='text-center p-3'>No matches found.</div>";
            return;
        }

        snapshot.forEach((doc) => {
            const m = doc.data();
            const dateStr = m.date.toDate().toLocaleDateString();
            
            // Format match display based on type
            let html = `<div class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    <small class="text-muted">${dateStr} @ ${m.location}</small>
                    <span class="badge bg-secondary">${m.type}</span>
                </div>
                <div class="mt-2">`;
            
            m.teams.forEach(t => {
                html += `<div class="d-flex justify-content-between">
                            <span>${t.players.join(", ")}</span>
                            <span class="fw-bold">${t.score}</span>
                         </div>`;
            });
            
            html += `</div></div>`;
            list.innerHTML += html;
        });
    });
}

// C. Autocomplete Helper
function fetchPlayerNamesForAutocomplete() {
    db.collection("players").get().then(snap => {
        allPlayerNames = [];
        const datalist = document.getElementById('playerList');
        datalist.innerHTML = "";
        
        snap.forEach(doc => {
            const name = doc.data().name;
            allPlayerNames.push(name);
            const option = document.createElement('option');
            option.value = name;
            datalist.appendChild(option);
        });
    });
}

// --- 4. FORM HANDLING (ADD MATCH) ---

// Toggle between Standard (2 Teams) and Tournament (3 Teams)
function toggleMatchType() {
    const type = document.querySelector('input[name="matchType"]:checked').value;
    const teamC = document.getElementById('teamCContainer');
    
    if (type === 'Tournament') {
        teamC.classList.remove('d-none');
    } else {
        teamC.classList.add('d-none');
        selectedPlayers.C = []; // Clear Team C
        renderTeamList('C');
    }
}

// Add Player to Team List
function addPlayerToTeam(team) {
    const input = document.getElementById(`inputPlayer${team}`);
    const name = input.value.trim();
    
    if (!name) return;
    
    // Prevent duplicates in the same team
    if (selectedPlayers[team].includes(name)) {
        alert("Player already in this team!");
        return;
    }

    selectedPlayers[team].push(name);
    renderTeamList(team);
    input.value = ""; // Clear input
    input.focus();
}

function removePlayerFromTeam(team, name) {
    selectedPlayers[team] = selectedPlayers[team].filter(p => p !== name);
    renderTeamList(team);
}

function renderTeamList(team) {
    const container = document.getElementById(`listTeam${team}`);
    container.innerHTML = "";
    selectedPlayers[team].forEach(player => {
        const badge = document.createElement('span');
        badge.className = "badge bg-primary player-badge";
        badge.innerHTML = `${player} &times;`;
        badge.onclick = () => removePlayerFromTeam(team, player);
        container.appendChild(badge);
    });
}

// --- 5. SAVE MATCH LOGIC (THE BRAIN) ---
document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerText = "Processing...";

    const matchType = document.querySelector('input[name="matchType"]:checked').value;
    const dateVal = document.getElementById('matchDate').value;
    const location = document.getElementById('matchLocation').value;

    try {
        // 1. Prepare Data
        let teamsData = [];
        
        // Team A & B
        teamsData.push(createTeamData('A'));
        teamsData.push(createTeamData('B'));
        
        // Team C (only if Tournament)
        if (matchType === 'Tournament') {
            teamsData.push(createTeamData('C'));
        }

        // Validate: Ensure players are added
        if (teamsData.some(t => t.players.length === 0)) {
            throw new Error("Please add players to all teams.");
        }

        // 2. Calculate Results (Who won?)
        // Sort teams by score descending (Highest score first)
        const sortedTeams = [...teamsData].sort((a, b) => b.score - a.score);
        
        // Assign Points Logic
        const updates = {}; // Map of playerName -> { pointsToAdd, w/d/l, gf, ga }

        if (matchType === 'Standard') {
            // Standard: Win(3), Draw(1), Loss(0)
            const scoreA = teamsData[0].score;
            const scoreB = teamsData[1].score;
            
            teamsData[0].players.forEach(p => calculateStandardStats(p, scoreA, scoreB, updates));
            teamsData[1].players.forEach(p => calculateStandardStats(p, scoreB, scoreA, updates));
        
        } else {
            // Tournament: 1st(3), 2nd(1), 3rd(0)
            // Note: Does not currently handle draws perfectly in tournament (e.g. shared 1st place), 
            // but assumes strict ranking for now or standard logic.
            // Simplified Rule: Rank 1 gets 3pts, Rank 2 gets 1pt.
            
            sortedTeams.forEach((team, index) => {
                let pts = 0;
                let isWin = false, isDraw = false, isLoss = false;

                if (index === 0) { pts = 3; isWin = true; }      // 1st Place
                else if (index === 1) { pts = 1; isDraw = true; } // 2nd Place (treated as 'Draw' for stats?) Or just 2nd place.
                else { pts = 0; isLoss = true; }                 // 3rd Place

                team.players.forEach(p => {
                    if(!updates[p]) updates[p] = { pts: 0, w:0, d:0, l:0, gf:0, ga:0 };
                    updates[p].pts = pts;
                    updates[p].w = isWin ? 1 : 0;
                    // Let's treat 2nd place as neither W nor L, maybe distinct? 
                    // User said: 2nd place gets 1 point. Let's count it as a Draw for stats consistency or just Points.
                    // For now mapping: 1st=Win, 2nd=Draw, 3rd=Loss
                    updates[p].d = isDraw ? 1 : 0;
                    updates[p].l = isLoss ? 1 : 0;
                    updates[p].gf = team.score; 
                    // GA is average of others? Or sum? Simplified: GA = 0 in tournament or irrelevant?
                    // Let's keep GA simple: Sum of other teams' scores
                    const otherScores = teamsData.filter(t => t !== team).reduce((acc, t) => acc + t.score, 0);
                    updates[p].ga = otherScores;
                });
            });
        }

        // 3. Database Updates (Batch)
        const batch = db.batch();

        // Save Match Record
        const matchRef = db.collection("matches").doc();
        batch.set(matchRef, {
            date: new Date(dateVal),
            location: location,
            type: matchType,
            teams: teamsData
        });

        // Update Each Player
        for (const [name, stats] of Object.entries(updates)) {
            const playerRef = db.collection("players").doc(name);
            // We use a Helper to atomic update or set if new
            // Since we can't read-modify-write easily in a simple batch without reads,
            // we will use Transaction in real app, but here we can rely on increment
            // However, creating new docs with increment requires 'set' with merge.
            
            batch.set(playerRef, {
                name: name,
                stats: {
                    played: firebase.firestore.FieldValue.increment(1),
                    won: firebase.firestore.FieldValue.increment(stats.w),
                    drawn: firebase.firestore.FieldValue.increment(stats.d),
                    lost: firebase.firestore.FieldValue.increment(stats.l),
                    gf: firebase.firestore.FieldValue.increment(stats.gf),
                    ga: firebase.firestore.FieldValue.increment(stats.ga),
                    points: firebase.firestore.FieldValue.increment(stats.pts)
                }
            }, { merge: true });
        }

        await batch.commit();

        // 4. Cleanup
        alert("Match saved successfully!");
        location.reload(); // Refresh to clear form and update lists

    } catch (err) {
        console.error(err);
        alert("Error saving match: " + err.message);
        btn.disabled = false;
        btn.innerText = "Save Match Record";
    }
});

// Helper: Extract Data from DOM
function createTeamData(teamKey) {
    const score = parseInt(document.getElementById(`score${teamKey}`).value) || 0;
    const players = selectedPlayers[teamKey];
    return { score, players };
}

// Helper: Standard Match Stats Logic
function calculateStandardStats(playerName, myScore, oppScore, updates) {
    if(!updates[playerName]) updates[playerName] = { pts: 0, w:0, d:0, l:0, gf:0, ga:0 };
    
    updates[playerName].gf = myScore;
    updates[playerName].ga = oppScore;

    if (myScore > oppScore) {
        updates[playerName].pts = 3;
        updates[playerName].w = 1;
    } else if (myScore === oppScore) {
        updates[playerName].pts = 1;
        updates[playerName].d = 1;
    } else {
        updates[playerName].pts = 0;
        updates[playerName].l = 1;
    }
}