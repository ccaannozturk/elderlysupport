// 1. FIREBASE CONFIGURATION
const firebaseConfig = {
    apiKey: "AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc",
    authDomain: "elderly-support-league.firebaseapp.com",
    projectId: "elderly-support-league",
    storageBucket: "elderly-support-league.firebasestorage.app",
    messagingSenderId: "973119844128",
    appId: "1:973119844128:web:0205ac9cdf912fa31ef145",
    measurementId: "G-101F2P233G"
};

// Initialize
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Global State
let selectedPlayers = { A: [], B: [], C: [] };

// 2. INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    loadLeaderboard();
    loadMatchHistory();
    fetchPlayerNamesForAutocomplete();
    
    // Default Date: Today
    document.getElementById('matchDate').valueAsDate = new Date();

    // Bind Enter Keys
    setupEnterKey('inputPlayerA', 'A');
    setupEnterKey('inputPlayerB', 'B');
    setupEnterKey('inputPlayerC', 'C');
});

function setupEnterKey(inputId, team) {
    document.getElementById(inputId).addEventListener("keypress", function(event) {
        if (event.key === "Enter") {
            event.preventDefault(); // Prevent form submit
            addPlayerToTeam(team);
        }
    });
}

// 3. READ DATA (Leaderboard & History)

function loadLeaderboard() {
    // Sort: Points (Desc) -> Goal Diff (Desc) -> Won (Desc)
    db.collection("players")
      .orderBy("stats.points", "desc")
      .orderBy("stats.gd", "desc")
      .orderBy("stats.won", "desc")
    .onSnapshot((snapshot) => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        
        if(snapshot.empty) {
            tbody.innerHTML = "<tr><td colspan='8' class='text-center py-5 text-muted'>No data yet. Start the season!</td></tr>";
            return;
        }

        let rank = 1;
        snapshot.forEach((doc) => {
            const p = doc.data();
            const s = p.stats;
            
            // Rank Styling
            let rankClass = "rank-circle";
            if(rank === 1) rankClass += " rank-1";
            if(rank === 2) rankClass += " rank-2";
            if(rank === 3) rankClass += " rank-3";

            const row = `
                <tr>
                    <td><div class="${rankClass}">${rank}</div></td>
                    <td class="fw-bold text-dark">${p.name}</td>
                    <td class="text-center">${s.played}</td>
                    <td class="text-center text-success">${s.won}</td>
                    <td class="text-center text-muted">${s.drawn}</td>
                    <td class="text-center text-danger">${s.lost}</td>
                    <td class="text-center fw-bold">${s.gf - s.ga}</td>
                    <td class="text-center fw-bold fs-6 text-primary">${s.points}</td>
                </tr>`;
            tbody.innerHTML += row;
            rank++;
        });
    });
}

function loadMatchHistory() {
    db.collection("matches").orderBy("date", "desc").limit(20)
    .onSnapshot((snapshot) => {
        const container = document.getElementById('match-history-list');
        container.innerHTML = "";

        if(snapshot.empty) {
            container.innerHTML = "<div class='text-center py-5 text-muted'>No matches found.</div>";
            return;
        }

        snapshot.forEach((doc) => {
            const m = doc.data();
            const dateStr = m.date.toDate().toLocaleDateString('en-NL', { day: 'numeric', month: 'short', year: 'numeric' });
            
            // YouTube Handling
            const hasVideo = m.youtubeLink ? 'has-video' : '';
            const clickAttr = m.youtubeLink ? `onclick="window.open('${m.youtubeLink}', '_blank')"` : '';
            const ytBadge = m.youtubeLink ? '<i class="fab fa-youtube text-danger ms-2" title="Watch Video"></i>' : '';

            let html = `
            <div class="col-md-6 col-lg-4">
                <div class="custom-card match-item ${hasVideo} p-3 mb-3" ${clickAttr}>
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <span class="match-date">${dateStr}</span>
                        <small class="text-muted">${m.location} ${ytBadge}</small>
                    </div>
                    
                    <div class="match-content">`;
            
            // Teams Display
            m.teams.forEach(t => {
                const tName = t.teamName ? `<span class="fw-bold text-uppercase small" style="letter-spacing:0.5px">${t.teamName}</span>` : `<span class="text-muted small">Team</span>`;
                html += `
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <div class="d-flex flex-column" style="width:75%">
                            ${tName}
                            <div class="text-muted small text-truncate">${t.players.join(", ")}</div>
                        </div>
                        <div class="score-box">${t.score}</div>
                    </div>
                `;
            });
            
            html += `</div></div></div>`;
            container.innerHTML += html;
        });
    });
}

// Helper: Autocomplete
function fetchPlayerNamesForAutocomplete() {
    db.collection("players").get().then(snap => {
        const datalist = document.getElementById('playerList');
        datalist.innerHTML = "";
        snap.forEach(doc => {
            const option = document.createElement('option');
            option.value = doc.data().name;
            datalist.appendChild(option);
        });
    });
}

// 4. INTERACTION & FORM LOGIC

function toggleMatchType() {
    const type = document.querySelector('input[name="matchType"]:checked').value;
    const teamC = document.getElementById('teamCContainer');
    
    if (type === 'Tournament') {
        teamC.classList.remove('d-none');
    } else {
        teamC.classList.add('d-none');
        selectedPlayers.C = [];
        renderTeamList('C');
    }
}

function addPlayerToTeam(team) {
    const input = document.getElementById(`inputPlayer${team}`);
    let name = input.value.trim();
    
    // Format Name (First letter Upper)
    if(name) {
        name = name.charAt(0).toUpperCase() + name.slice(1);
    } else {
        return;
    }

    // Check Duplicate in Same Team
    if (selectedPlayers[team].includes(name)) {
        alert(`${name} is already in Team ${team}!`);
        input.value = "";
        return;
    }

    selectedPlayers[team].push(name);
    renderTeamList(team);
    input.value = "";
    input.focus(); // Keep focus for fast entry
}

function removePlayerFromTeam(team, name) {
    selectedPlayers[team] = selectedPlayers[team].filter(p => p !== name);
    renderTeamList(team);
}

function renderTeamList(team) {
    const container = document.getElementById(`listTeam${team}`);
    container.innerHTML = "";
    selectedPlayers[team].forEach(player => {
        const tag = document.createElement('span');
        tag.className = "player-tag";
        tag.innerHTML = `${player} <i class="fas fa-times-circle" onclick="removePlayerFromTeam('${team}', '${player}')"></i>`;
        container.appendChild(tag);
    });
}

// 5. SAVE MATCH (WRITE TO DB)
document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

    const matchType = document.querySelector('input[name="matchType"]:checked').value;
    const dateVal = document.getElementById('matchDate').value;
    const location = document.getElementById('matchLocation').value;
    const youtubeLink = document.getElementById('matchYoutube').value;

    try {
        let teamsData = [];
        teamsData.push(createTeamData('A'));
        teamsData.push(createTeamData('B'));
        
        if (matchType === 'Tournament') {
            teamsData.push(createTeamData('C'));
        }

        // Validation
        if (teamsData.some(t => t.players.length === 0)) {
            throw new Error("Each team must have at least one player.");
        }

        // --- CALCULATION LOGIC ---
        const sortedTeams = [...teamsData].sort((a, b) => b.score - a.score);
        const updates = {}; 

        if (matchType === 'Standard') {
            const scoreA = teamsData[0].score;
            const scoreB = teamsData[1].score;
            teamsData[0].players.forEach(p => calcStats(p, scoreA, scoreB, updates));
            teamsData[1].players.forEach(p => calcStats(p, scoreB, scoreA, updates));
        } else {
            // Tournament (1st: 3pts, 2nd: 1pt, 3rd: 0pt)
            sortedTeams.forEach((team, index) => {
                let pts = 0; let w=0, d=0, l=0;
                if (index === 0) { pts = 3; w = 1; }
                else if (index === 1) { pts = 1; d = 1; } // 2nd place treated as Draw stat-wise? Or just points? Let's use points mostly.
                else { pts = 0; l = 1; }

                team.players.forEach(p => {
                    if(!updates[p]) updates[p] = { pts: 0, w:0, d:0, l:0, gf:0, ga:0 };
                    updates[p].pts = pts;
                    updates[p].w = w;
                    updates[p].d = d;
                    updates[p].l = l;
                    updates[p].gf = team.score;
                    updates[p].ga = 0; // Keeping simple for tournament
                });
            });
        }

        // --- BATCH WRITE ---
        const batch = db.batch();
        const matchRef = db.collection("matches").doc();
        
        batch.set(matchRef, {
            date: new Date(dateVal),
            location: location,
            type: matchType,
            youtubeLink: youtubeLink || null,
            teams: teamsData
        });

        for (const [name, stats] of Object.entries(updates)) {
            const playerRef = db.collection("players").doc(name);
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
        
        // Success
        alert("Match saved successfully!");
        window.location.reload(); 

    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
});

// Helpers
function createTeamData(teamKey) {
    const score = parseInt(document.getElementById(`score${teamKey}`).value) || 0;
    const name = document.getElementById(`nameTeam${teamKey}`).value || "";
    const players = selectedPlayers[teamKey];
    return { score, players, teamName: name };
}

function calcStats(playerName, myScore, oppScore, updates) {
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