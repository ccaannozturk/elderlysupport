// 1. FIREBASE CONFIG
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

// Global State
let selectedPlayers = { 
    A: [], B: [], // Standard
    TournA: [], TournB: [], TournC: [] // Tournament
};

document.addEventListener('DOMContentLoaded', () => {
    loadLeaderboard(); // Client-side sorting logic
    loadMatchHistory();
    fetchPlayerNamesForAutocomplete();
    
    document.getElementById('matchDate').valueAsDate = new Date();

    // Bind Enter Keys for Standard
    bindEnterKey('inputPlayerA', 'A');
    bindEnterKey('inputPlayerB', 'B');
    // Bind Enter Keys for Tournament
    bindEnterKey('inputPlayerTournA', 'TournA');
    bindEnterKey('inputPlayerTournB', 'TournB');
    bindEnterKey('inputPlayerTournC', 'TournC');
});

function bindEnterKey(elemId, teamKey) {
    const el = document.getElementById(elemId);
    if(el) {
        el.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                addPlayerToTeam(teamKey);
            }
        });
    }
}

// --- DATA LOGIC ---

function loadLeaderboard() {
    // FIX: We remove orderBy from Firestore query to avoid Index errors
    // We sort in Javascript instead.
    db.collection("players").onSnapshot((snapshot) => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        
        if(snapshot.empty) {
            tbody.innerHTML = "<tr><td colspan='8' class='text-center py-4 text-muted'>No data found.</td></tr>";
            return;
        }

        let players = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Safety check for missing stats
            const stats = data.stats || { played:0, won:0, drawn:0, lost:0, gf:0, ga:0, points:0 };
            players.push({ name: data.name, ...stats });
        });

        // CLIENT-SIDE SORTING (Points -> Goal Diff -> Won)
        players.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points; // 1. Points
            const gdA = a.gf - a.ga;
            const gdB = b.gf - b.ga;
            if (gdB !== gdA) return gdB - gdA; // 2. GD
            return b.won - a.won; // 3. Wins
        });

        let rank = 1;
        players.forEach(p => {
            let rankClass = "rank-circle";
            if(rank===1) rankClass += " rank-1";
            else if(rank===2) rankClass += " rank-2";
            else if(rank===3) rankClass += " rank-3";

            const row = `
                <tr>
                    <td><div class="${rankClass}">${rank}</div></td>
                    <td class="fw-bold">${p.name}</td>
                    <td class="text-center">${p.played}</td>
                    <td class="text-center text-success">${p.won}</td>
                    <td class="text-center text-muted">${p.drawn}</td>
                    <td class="text-center text-danger">${p.lost}</td>
                    <td class="text-center fw-bold">${p.gf - p.ga}</td>
                    <td class="text-center fw-bold fs-6 text-primary">${p.points}</td>
                </tr>`;
            tbody.innerHTML += row;
            rank++;
        });
    });
}

function loadMatchHistory() {
    db.collection("matches").orderBy("date", "desc").limit(15)
    .onSnapshot((snapshot) => {
        const list = document.getElementById('match-history-list');
        list.innerHTML = "";

        if(snapshot.empty) {
            list.innerHTML = "<div class='text-center py-5 text-muted'>No matches recorded.</div>";
            return;
        }

        snapshot.forEach((doc) => {
            const m = doc.data();
            const dateStr = m.date.toDate().toLocaleDateString('en-NL', { day: 'numeric', month: 'short' });
            
            const ytClass = m.youtubeLink ? "has-video border-danger" : "";
            const ytBadge = m.youtubeLink ? `<i class="fab fa-youtube text-danger ms-2"></i>` : "";
            const onclick = m.youtubeLink ? `onclick="window.open('${m.youtubeLink}')"` : "";

            let content = "";
            if (m.type === 'Standard') {
                content = `
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="w-50">
                            <div class="fw-bold small text-primary">${m.teams[0].teamName || 'TEAM A'}</div>
                            <div class="text-muted small text-truncate">${m.teams[0].players.join(', ')}</div>
                        </div>
                        <div class="fs-4 fw-bold mx-2">${m.teams[0].score} - ${m.teams[1].score}</div>
                        <div class="w-50 text-end">
                            <div class="fw-bold small text-danger">${m.teams[1].teamName || 'TEAM B'}</div>
                            <div class="text-muted small text-truncate">${m.teams[1].players.join(', ')}</div>
                        </div>
                    </div>`;
            } else {
                // Tournament Display
                content = `
                    <div class="text-center mb-2"><span class="badge bg-warning text-dark">Tournament Winner: ${m.winnerName || 'Unknown'}</span></div>
                    <div class="d-flex justify-content-between text-muted small">
                        <span>${m.teams[0].players.length} players per team</span>
                        <span>Ranking: 1st(+3), 2nd(+1), 3rd(0)</span>
                    </div>
                `;
            }

            const html = `
                <div class="col-md-6">
                    <div class="custom-card match-card p-3 mb-3 ${ytClass}" ${onclick}>
                        <div class="d-flex justify-content-between small text-muted mb-2">
                            <span>${dateStr} @ ${m.location}</span>
                            <span>${ytBadge}</span>
                        </div>
                        ${content}
                    </div>
                </div>`;
            list.innerHTML += html;
        });
    });
}

// --- UI HELPERS ---

function toggleMatchType() {
    const isTourn = document.getElementById('typeTournament').checked;
    const stdSec = document.getElementById('standardSection');
    const tournSec = document.getElementById('tournamentSection');
    
    if(isTourn) {
        stdSec.classList.add('d-none');
        tournSec.classList.remove('d-none');
    } else {
        stdSec.classList.remove('d-none');
        tournSec.classList.add('d-none');
    }
}

function addPlayerToTeam(teamKey) {
    const inputId = teamKey.startsWith('Tourn') ? `inputPlayer${teamKey}` : `inputPlayer${teamKey}`;
    const input = document.getElementById(inputId);
    let name = input.value.trim();
    
    if(!name) return;
    name = name.charAt(0).toUpperCase() + name.slice(1);

    if(selectedPlayers[teamKey].includes(name)) {
        alert("Player already added!");
        return;
    }
    
    selectedPlayers[teamKey].push(name);
    renderList(teamKey);
    input.value = "";
    input.focus();
}

function removePlayer(teamKey, name) {
    selectedPlayers[teamKey] = selectedPlayers[teamKey].filter(n => n !== name);
    renderList(teamKey);
}

function renderList(teamKey) {
    const divId = teamKey.startsWith('Tourn') ? `listTeam${teamKey}` : `listTeam${teamKey}`;
    const div = document.getElementById(divId);
    div.innerHTML = "";
    selectedPlayers[teamKey].forEach(p => {
        div.innerHTML += `<span class="player-tag">${p} <i class="fas fa-times-circle" onclick="removePlayer('${teamKey}','${p}')"></i></span>`;
    });
}

function fetchPlayerNamesForAutocomplete() {
    db.collection("players").get().then(snap => {
        const dl = document.getElementById('playerList');
        dl.innerHTML = "";
        snap.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.data().name;
            dl.appendChild(opt);
        });
    });
}

// --- SAVE LOGIC ---

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = "Saving...";

    const type = document.querySelector('input[name="matchType"]:checked').value;
    const commonData = {
        date: new Date(document.getElementById('matchDate').value),
        location: document.getElementById('matchLocation').value,
        youtubeLink: document.getElementById('matchYoutube').value || null,
        type: type
    };

    const batch = db.batch();

    try {
        if(type === 'Standard') {
            const sA = parseInt(document.getElementById('scoreA').value) || 0;
            const sB = parseInt(document.getElementById('scoreB').value) || 0;
            const pA = selectedPlayers['A'];
            const pB = selectedPlayers['B'];

            if(pA.length === 0 || pB.length === 0) throw new Error("Add players to both teams");

            // Save Match
            const matchRef = db.collection("matches").doc();
            batch.set(matchRef, {
                ...commonData,
                teams: [
                    { score: sA, players: pA, teamName: document.getElementById('nameTeamA').value },
                    { score: sB, players: pB, teamName: document.getElementById('nameTeamB').value }
                ]
            });

            // Update Stats
            pA.forEach(p => updatePlayerStats(batch, p, sA, sB, (sA>sB?3:(sA===sB?1:0)), (sA>sB?1:0), (sA===sB?1:0), (sA<sB?1:0) ));
            pB.forEach(p => updatePlayerStats(batch, p, sB, sA, (sB>sA?3:(sB===sA?1:0)), (sB>sA?1:0), (sB===sA?1:0), (sB<sA?1:0) ));

        } else {
            // TOURNAMENT LOGIC
            const pA = selectedPlayers['TournA'];
            const pB = selectedPlayers['TournB'];
            const pC = selectedPlayers['TournC'];

            if(pA.length===0 || pB.length===0 || pC.length===0) throw new Error("All 3 teams must have players");

            // Gather Scores
            const scores = {
                m1: { a: parseInt(document.getElementById('t_m1_a').value)||0, b: parseInt(document.getElementById('t_m1_b').value)||0 },
                m2: { a: parseInt(document.getElementById('t_m2_a').value)||0, c: parseInt(document.getElementById('t_m2_c').value)||0 },
                m3: { b: parseInt(document.getElementById('t_m3_b').value)||0, c: parseInt(document.getElementById('t_m3_c').value)||0 },
                m4: { a: parseInt(document.getElementById('t_m4_a').value)||0, b: parseInt(document.getElementById('t_m4_b').value)||0 },
                m5: { a: parseInt(document.getElementById('t_m5_a').value)||0, c: parseInt(document.getElementById('t_m5_c').value)||0 },
                m6: { b: parseInt(document.getElementById('t_m6_b').value)||0, c: parseInt(document.getElementById('t_m6_c').value)||0 },
            };

            // Calculate Mini-League Table
            let teams = {
                A: { name: 'Team A', pts: 0, gf: 0, ga: 0, players: pA },
                B: { name: 'Team B', pts: 0, gf: 0, ga: 0, players: pB },
                C: { name: 'Team C', pts: 0, gf: 0, ga: 0, players: pC }
            };

            // Helper to process a single game result for the internal table
            const processGame = (t1, score1, t2, score2) => {
                teams[t1].gf += score1; teams[t1].ga += score2;
                teams[t2].gf += score2; teams[t2].ga += score1;
                if(score1 > score2) teams[t1].pts += 3;
                else if(score2 > score1) teams[t2].pts += 3;
                else { teams[t1].pts += 1; teams[t2].pts += 1; }
            };

            processGame('A', scores.m1.a, 'B', scores.m1.b);
            processGame('A', scores.m2.a, 'C', scores.m2.c);
            processGame('B', scores.m3.b, 'C', scores.m3.c);
            processGame('A', scores.m4.a, 'B', scores.m4.b);
            processGame('A', scores.m5.a, 'C', scores.m5.c);
            processGame('B', scores.m6.b, 'C', scores.m6.c);

            // Sort: Points -> GD -> GF
            const sortedKeys = Object.keys(teams).sort((k1, k2) => {
                const t1 = teams[k1], t2 = teams[k2];
                if(t2.pts !== t1.pts) return t2.pts - t1.pts;
                const gd1 = t1.gf - t1.ga, gd2 = t2.gf - t2.ga;
                if(gd2 !== gd1) return gd2 - gd1;
                return t2.gf - t1.gf;
            });

            // Assign League Points based on Rank
            // Rank 1: +3 pts, Rank 2: +1 pts, Rank 3: 0 pts
            // Also accumulating Total Goals for career stats
            
            // 1st Place
            const t1 = teams[sortedKeys[0]];
            t1.players.forEach(p => updatePlayerStats(batch, p, t1.gf, t1.ga, 3, 1, 0, 0)); // Treat as 1 Win, 3 Pts

            // 2nd Place
            const t2 = teams[sortedKeys[1]];
            t2.players.forEach(p => updatePlayerStats(batch, p, t2.gf, t2.ga, 1, 0, 1, 0)); // Treat as 1 Draw, 1 Pt

            // 3rd Place
            const t3 = teams[sortedKeys[2]];
            t3.players.forEach(p => updatePlayerStats(batch, p, t3.gf, t3.ga, 0, 0, 0, 1)); // Treat as 1 Loss, 0 Pt

            // Save Tournament Record
            const matchRef = db.collection("matches").doc();
            batch.set(matchRef, {
                ...commonData,
                winnerName: `Team ${sortedKeys[0]}`,
                teams: [
                    { teamName: 'Team A', players: pA, score: teams.A.pts + " pts" },
                    { teamName: 'Team B', players: pB, score: teams.B.pts + " pts" },
                    { teamName: 'Team C', players: pC, score: teams.C.pts + " pts" }
                ]
            });
        }

        await batch.commit();
        alert("Saved successfully!");
        window.location.reload();

    } catch(err) {
        console.error(err);
        alert(err.message);
        btn.disabled = false;
        btn.innerHTML = "SAVE MATCH";
    }
});

function updatePlayerStats(batch, playerName, gf, ga, pts, w, d, l) {
    const ref = db.collection("players").doc(playerName);
    const inc = firebase.firestore.FieldValue.increment;
    
    // We use set with merge, creating the doc if it doesn't exist
    batch.set(ref, {
        name: playerName,
        stats: {
            played: inc(1),
            won: inc(w),
            drawn: inc(d),
            lost: inc(l),
            gf: inc(gf),
            ga: inc(ga),
            points: inc(pts)
        }
    }, { merge: true });
}