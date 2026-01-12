// FIREBASE CONFIG
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
let selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
// Cache matches data locally to open modals easily
let cachedMatches = {}; 

document.addEventListener('DOMContentLoaded', () => {
    loadLeaderboard();
    loadMatchHistory();
    fetchPlayerNamesForAutocomplete();
    
    document.getElementById('matchDate').valueAsDate = new Date();

    // Bind Enter Keys
    ['inputPlayerA', 'inputPlayerB', 'inputPlayerTournA', 'inputPlayerTournB', 'inputPlayerTournC'].forEach(id => {
        const teamKey = id.replace('inputPlayer', ''); // e.g. TournA
        document.getElementById(id)?.addEventListener("keypress", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addPlayerToTeam(teamKey); }
        });
    });
});

// --- LOAD DATA ---

function loadLeaderboard() {
    db.collection("players").onSnapshot((snapshot) => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        
        if(snapshot.empty) {
            tbody.innerHTML = "<tr><td colspan='6' class='text-center py-4'>No data yet.</td></tr>";
            return;
        }

        let players = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            const s = d.stats || { played:0, won:0, drawn:0, lost:0, gf:0, ga:0, points:0 };
            players.push({ name: d.name, ...s });
        });

        // SORT: Points -> GD -> Won
        players.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            const gdA = a.gf - a.ga;
            const gdB = b.gf - b.ga;
            if (gdB !== gdA) return gdB - gdA;
            return b.won - a.won;
        });

        players.forEach((p, index) => {
            let rank = index + 1;
            let rankClass = "rank-circle";
            if(rank===1) rankClass += " rank-1";
            else if(rank===2) rankClass += " rank-2";
            else if(rank===3) rankClass += " rank-3";

            tbody.innerHTML += `
                <tr>
                    <td class="ps-3"><div class="${rankClass}">${rank}</div></td>
                    <td class="fw-bold text-dark">${p.name}</td>
                    <td class="text-center">${p.played}</td>
                    <td class="text-center text-muted">${p.won}</td>
                    <td class="text-center text-muted small">${p.gf - p.ga}</td>
                    <td class="text-center fw-bold text-primary pe-3">${p.points}</td>
                </tr>`;
        });
    });
}

function loadMatchHistory() {
    db.collection("matches").orderBy("date", "desc").limit(15)
    .onSnapshot((snapshot) => {
        const list = document.getElementById('match-history-list');
        list.innerHTML = "";
        cachedMatches = {};

        if(snapshot.empty) {
            list.innerHTML = "<div class='text-center py-5 text-muted'>No matches recorded.</div>";
            return;
        }

        snapshot.forEach((doc) => {
            const m = doc.data();
            cachedMatches[doc.id] = m; // Save for modal
            
            const dateStr = m.date.toDate().toLocaleDateString('en-NL', { day: 'numeric', month: 'short' });
            
            let cardContent = "";
            let typeBadge = "";

            if (m.type === 'Standard') {
                const teamA = m.teams[0];
                const teamB = m.teams[1];
                cardContent = `
                    <div class="d-flex justify-content-between align-items-center mt-2">
                        <div class="text-center w-25">
                            <span class="badge bg-primary text-wrap mb-1">${teamA.teamName || 'Blue'}</span>
                        </div>
                        <div class="score-display">${teamA.score} - ${teamB.score}</div>
                        <div class="text-center w-25">
                            <span class="badge bg-danger text-wrap mb-1">${teamB.teamName || 'Red'}</span>
                        </div>
                    </div>
                `;
            } else {
                // Tournament Summary
                const winner = m.winnerName || "Unknown";
                cardContent = `
                    <div class="mt-2 text-center">
                        <div class="text-uppercase small text-muted mb-1">Tournament Winner</div>
                        <span class="badge bg-warning text-dark fs-6 shadow-sm"><i class="fas fa-trophy"></i> ${winner}</span>
                        <div class="mt-2 small text-primary"><i class="fas fa-eye"></i> Click for details</div>
                    </div>
                `;
            }

            list.innerHTML += `
                <div class="custom-card match-card type-${m.type} p-3" onclick="openMatchDetail('${doc.id}')">
                    <div class="d-flex justify-content-between small text-muted">
                        <span><i class="far fa-calendar"></i> ${dateStr}</span>
                        <span>${m.location}</span>
                    </div>
                    ${cardContent}
                </div>`;
        });
    });
}

// --- MODAL LOGIC (THE NEW PART) ---

function openMatchDetail(matchId) {
    const m = cachedMatches[matchId];
    if(!m) return;

    const modalDate = document.getElementById('modalDateLoc');
    const modalBody = document.getElementById('modalBody');
    const modalYt = document.getElementById('modalYoutube');
    
    // Set Header
    const dateStr = m.date.toDate().toLocaleDateString('en-NL', { weekday:'short', day: 'numeric', month: 'long', year:'numeric' });
    modalDate.innerHTML = `<small class="d-block fw-normal text-muted">${dateStr}</small>${m.location}`;

    // Set YouTube
    if(m.youtubeLink) {
        modalYt.classList.remove('d-none');
        modalYt.href = m.youtubeLink;
    } else {
        modalYt.classList.add('d-none');
    }

    // Build Content based on Type
    if(m.type === 'Standard') {
        const t1 = m.teams[0];
        const t2 = m.teams[1];
        
        modalBody.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-4">
                <div class="text-center">
                    <span class="badge bg-primary fs-6 mb-2">${t1.teamName || 'Blue'}</span>
                    <div class="display-4 fw-bold">${t1.score}</div>
                </div>
                <div class="text-muted">VS</div>
                <div class="text-center">
                    <span class="badge bg-danger fs-6 mb-2">${t2.teamName || 'Red'}</span>
                    <div class="display-4 fw-bold">${t2.score}</div>
                </div>
            </div>
            <hr>
            <div class="row">
                <div class="col-6 border-end">
                    <small class="text-muted d-block mb-1">Blue Players</small>
                    ${t1.players.map(p => `<div class="fw-bold">${p}</div>`).join('')}
                </div>
                <div class="col-6 ps-3">
                    <small class="text-muted d-block mb-1">Red Players</small>
                    ${t2.players.map(p => `<div class="fw-bold">${p}</div>`).join('')}
                </div>
            </div>
        `;
    } else {
        // TOURNAMENT DETAILS (Reconstruct Matrix)
        const f = m.fixture || {}; // Saved scores: m1_a, m1_b etc.
        const tA = m.teams[0]; // Yellow (Usually stored as index 0)
        const tB = m.teams[1]; // Blue
        const tC = m.teams[2]; // Red
        
        // Helper to render row
        const row = (lbl1, s1, s2, lbl2, cls1, cls2) => `
            <div class="d-flex justify-content-between align-items-center mb-2 p-2 bg-light rounded">
                <span class="badge bg-${cls1} text-dark" style="width:70px">${lbl1}</span>
                <span class="fw-bold fs-5">${s1} - ${s2}</span>
                <span class="badge bg-${cls2} text-dark" style="width:70px">${lbl2}</span>
            </div>`;

        modalBody.innerHTML = `
            <h6 class="text-center text-muted mb-3">Match Results</h6>
            ${row('Yellow', f.m1?.a||0, f.m1?.b||0, 'Blue', 'warning', 'primary')}
            ${row('Yellow', f.m2?.a||0, f.m2?.c||0, 'Red', 'warning', 'danger')}
            ${row('Blue',   f.m3?.b||0, f.m3?.c||0, 'Red', 'primary', 'danger')}
            <div class="text-center small text-muted my-2">- Round 2 -</div>
            ${row('Yellow', f.m4?.a||0, f.m4?.b||0, 'Blue', 'warning', 'primary')}
            ${row('Yellow', f.m5?.a||0, f.m5?.c||0, 'Red', 'warning', 'danger')}
            ${row('Blue',   f.m6?.b||0, f.m6?.c||0, 'Red', 'primary', 'danger')}
            
            <hr>
            <div class="row g-2">
                <div class="col-4"><div class="p-2 border rounded bg-warning bg-opacity-10"><small>Yellow Team</small><br>${tA.players.join('<br>')}</div></div>
                <div class="col-4"><div class="p-2 border rounded bg-primary bg-opacity-10"><small>Blue Team</small><br>${tB.players.join('<br>')}</div></div>
                <div class="col-4"><div class="p-2 border rounded bg-danger bg-opacity-10"><small>Red Team</small><br>${tC.players.join('<br>')}</div></div>
            </div>
        `;
    }

    // Open Bootstrap Modal
    const myModal = new bootstrap.Modal(document.getElementById('matchDetailModal'));
    myModal.show();
}

// --- SAVE LOGIC ---

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.innerText = "Saving...";

    const type = document.querySelector('input[name="matchType"]:checked').value;
    const commonData = {
        date: new Date(document.getElementById('matchDate').value),
        location: document.getElementById('matchLocation').value,
        youtubeLink: document.getElementById('matchYoutube').value || null,
        type: type
    };
    
    const batch = db.batch();

    try {
        if (type === 'Standard') {
            const pA = selectedPlayers['A'];
            const pB = selectedPlayers['B'];
            const sA = parseInt(document.getElementById('scoreA').value)||0;
            const sB = parseInt(document.getElementById('scoreB').value)||0;
            const nA = document.getElementById('nameTeamA').value;
            const nB = document.getElementById('nameTeamB').value;

            if(pA.length===0 || pB.length===0) throw new Error("Teams need players!");

            // Save Match
            const ref = db.collection("matches").doc();
            batch.set(ref, {
                ...commonData,
                teams: [
                    { teamName: nA, score: sA, players: pA },
                    { teamName: nB, score: sB, players: pB }
                ]
            });

            // Update Stats
            pA.forEach(p => updatePlayerStats(batch, p, sA, sB, (sA>sB?3:(sA===sB?1:0)), (sA>sB?1:0), (sA===sB?1:0), (sA<sB?1:0)));
            pB.forEach(p => updatePlayerStats(batch, p, sB, sA, (sB>sA?3:(sB===sA?1:0)), (sB>sA?1:0), (sB===sA?1:0), (sB<sA?1:0)));

        } else {
            // TOURNAMENT
            const pA = selectedPlayers['TournA']; // Yellow
            const pB = selectedPlayers['TournB']; // Blue
            const pC = selectedPlayers['TournC']; // Red
            const nA = document.getElementById('nameTournA').value || 'Yellow';
            const nB = document.getElementById('nameTournB').value || 'Blue';
            const nC = document.getElementById('nameTournC').value || 'Red';

            if(pA.length===0 || pB.length===0 || pC.length===0) throw new Error("All teams need players!");

            // Grab Raw Scores for DB & Calculation
            const f = {
                m1: { a: parseInt(document.getElementById('t_m1_a').value)||0, b: parseInt(document.getElementById('t_m1_b').value)||0 },
                m2: { a: parseInt(document.getElementById('t_m2_a').value)||0, c: parseInt(document.getElementById('t_m2_c').value)||0 },
                m3: { b: parseInt(document.getElementById('t_m3_b').value)||0, c: parseInt(document.getElementById('t_m3_c').value)||0 },
                m4: { a: parseInt(document.getElementById('t_m4_a').value)||0, b: parseInt(document.getElementById('t_m4_b').value)||0 },
                m5: { a: parseInt(document.getElementById('t_m5_a').value)||0, c: parseInt(document.getElementById('t_m5_c').value)||0 },
                m6: { b: parseInt(document.getElementById('t_m6_b').value)||0, c: parseInt(document.getElementById('t_m6_c').value)||0 }
            };

            // Calculate Mini League
            let stats = {
                A: { name: nA, players: pA, pts:0, gf:0, ga:0 },
                B: { name: nB, players: pB, pts:0, gf:0, ga:0 },
                C: { name: nC, players: pC, pts:0, gf:0, ga:0 }
            };

            const process = (k1, s1, k2, s2) => {
                stats[k1].gf+=s1; stats[k1].ga+=s2;
                stats[k2].gf+=s2; stats[k2].ga+=s1;
                if(s1>s2) stats[k1].pts+=3;
                else if(s2>s1) stats[k2].pts+=3;
                else { stats[k1].pts+=1; stats[k2].pts+=1; }
            };

            process('A', f.m1.a, 'B', f.m1.b);
            process('A', f.m2.a, 'C', f.m2.c);
            process('B', f.m3.b, 'C', f.m3.c);
            process('A', f.m4.a, 'B', f.m4.b);
            process('A', f.m5.a, 'C', f.m5.c);
            process('B', f.m6.b, 'C', f.m6.c);

            // Determine Ranks
            const sortedKeys = ['A','B','C'].sort((k1, k2) => {
                if(stats[k2].pts !== stats[k1].pts) return stats[k2].pts - stats[k1].pts;
                const gd1 = stats[k1].gf - stats[k1].ga;
                const gd2 = stats[k2].gf - stats[k2].ga;
                if(gd2 !== gd1) return gd2 - gd1;
                return stats[k2].gf - stats[k1].gf;
            });

            // Save Match with FIXTURE details
            const ref = db.collection("matches").doc();
            batch.set(ref, {
                ...commonData,
                fixture: f, // SAVING THE SCORES HERE
                winnerName: stats[sortedKeys[0]].name,
                teams: [
                    { teamName: nA, players: pA, rank: sortedKeys.indexOf('A')+1 },
                    { teamName: nB, players: pB, rank: sortedKeys.indexOf('B')+1 },
                    { teamName: nC, players: pC, rank: sortedKeys.indexOf('C')+1 }
                ]
            });

            // Update Global Stats (Rank 1=+3pts, Rank 2=+1pt)
            // 1st
            const t1 = stats[sortedKeys[0]];
            t1.players.forEach(p => updatePlayerStats(batch, p, t1.gf, t1.ga, 3, 1, 0, 0));
            // 2nd
            const t2 = stats[sortedKeys[1]];
            t2.players.forEach(p => updatePlayerStats(batch, p, t2.gf, t2.ga, 1, 0, 1, 0));
            // 3rd
            const t3 = stats[sortedKeys[2]];
            t3.players.forEach(p => updatePlayerStats(batch, p, t3.gf, t3.ga, 0, 0, 0, 1));
        }

        await batch.commit();
        alert("Saved!");
        window.location.reload();

    } catch (err) {
        console.error(err);
        alert("Error: " + err.message);
        btn.disabled = false; btn.innerText = "SAVE MATCH RESULT";
    }
});

function updatePlayerStats(batch, name, gf, ga, pts, w, d, l) {
    const ref = db.collection("players").doc(name);
    const inc = firebase.firestore.FieldValue.increment;
    batch.set(ref, {
        name: name,
        stats: {
            played: inc(1), won:inc(w), drawn:inc(d), lost:inc(l),
            gf:inc(gf), ga:inc(ga), points:inc(pts)
        }
    }, { merge: true });
}

// UI Helpers
function toggleMatchType() {
    const isTourn = document.getElementById('typeTournament').checked;
    document.getElementById('standardSection').classList.toggle('d-none', isTourn);
    document.getElementById('tournamentSection').classList.toggle('d-none', !isTourn);
}

function addPlayerToTeam(key) {
    const input = document.getElementById(`inputPlayer${key}`);
    let val = input.value.trim();
    if(!val) return;
    val = val.charAt(0).toUpperCase() + val.slice(1);
    
    if(selectedPlayers[key].includes(val)) { alert("Already in team!"); return; }
    
    selectedPlayers[key].push(val);
    renderList(key);
    input.value = ""; input.focus();
}

function removePlayer(key, name) {
    selectedPlayers[key] = selectedPlayers[key].filter(x => x!==name);
    renderList(key);
}

function renderList(key) {
    const div = document.getElementById(key.startsWith('Tourn') ? `listTeam${key}` : `listTeam${key}`);
    div.innerHTML = selectedPlayers[key].map(p => 
        `<span class="player-tag">${p} <i class="fas fa-times-circle ms-1 text-danger" onclick="removePlayer('${key}','${p}')"></i></span>`
    ).join('');
}

function fetchPlayerNamesForAutocomplete() {
    db.collection("players").get().then(snap => {
        const dl = document.getElementById('playerList');
        dl.innerHTML = "";
        snap.forEach(d => {
            let opt = document.createElement('option');
            opt.value = d.data().name;
            dl.appendChild(opt);
        });
    });
}