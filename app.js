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

let currentUser = null;
let selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
let cachedMatches = {};
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

// --- INIT ---
document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateUI();
    });
    
    loadLeaderboard();
    loadMatchHistory();
    fetchPlayerNames();
    document.getElementById('matchDate').valueAsDate = new Date();
    setupEnterKeys();
});

function updateUI() {
    const navEntry = document.getElementById('navNewEntry');
    const authBtn = document.getElementById('authBtn');
    const list = document.getElementById('match-history-list');
    
    if (currentUser) {
        navEntry.classList.remove('d-none');
        authBtn.innerHTML = '<i class="fas fa-user-check text-success fa-lg"></i>';
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('userInfo').classList.remove('d-none');
        document.getElementById('userEmailDisplay').innerText = currentUser.email;

        if(currentUser.email === SUPER_ADMIN) {
            list.classList.add('show-super-admin');
        } else {
            list.classList.remove('show-super-admin');
        }
    } else {
        navEntry.classList.add('d-none');
        authBtn.innerHTML = '<i class="fas fa-lock fa-lg"></i>';
        document.getElementById('loginForm').classList.remove('d-none');
        document.getElementById('userInfo').classList.add('d-none');
        list.classList.remove('show-super-admin');
    }
}

// LOGIN / LOGOUT
document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    auth.signInWithEmailAndPassword(document.getElementById('loginEmail').value, document.getElementById('loginPass').value)
        .then(() => bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide())
        .catch(err => alert(err.message));
});
document.getElementById('logoutBtn').addEventListener('click', () => {
    auth.signOut().then(() => bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide());
});

// --- DATA ---

function loadLeaderboard() {
    db.collection("players").onSnapshot(snap => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        let players = [];
        snap.forEach(doc => players.push({name: doc.id, ...doc.data().stats}));
        
        players.sort((a,b) => (b.points - a.points) || ((b.gf-b.ga)-(a.gf-a.ga)) || (b.won - a.won));

        players.forEach((p, i) => {
            const icon = i===0 ? "🥇" : (i===1?"🥈":(i===2?"🥉": i+1));
            const color = i===0 ? "text-warning" : (i<3 ? "text-secondary" : "text-muted");
            tbody.innerHTML += `
                <tr>
                    <td class="ps-3 fw-bold ${color}">${icon}</td>
                    <td class="fw-bold">${p.name}</td>
                    <td class="text-center">${p.played||0}</td>
                    <td class="text-center">${p.won||0}</td>
                    <td class="text-center small">${(p.gf||0)-(p.ga||0)}</td>
                    <td class="text-center fw-bold pe-3 text-primary">${p.points||0}</td>
                </tr>`;
        });
    });
}

function loadMatchHistory() {
    db.collection("matches").orderBy("date", "desc").onSnapshot(snap => {
        const list = document.getElementById('match-history-list');
        list.innerHTML = "";
        cachedMatches = {};

        if(snap.empty) {
            list.innerHTML = "<div class='text-center py-5 text-muted'>No matches found.</div>";
            return;
        }

        snap.forEach(doc => {
            const m = doc.data();
            cachedMatches[doc.id] = m;
            const dateStr = m.date.toDate().toLocaleDateString('en-NL', {day:'numeric', month:'short'});
            const yt = m.youtubeLink ? `<a href="${m.youtubeLink}" target="_blank" class="youtube-link"><i class="fab fa-youtube me-1"></i>Watch</a>` : '';

            // Admin buttons
            const admin = `
                <div class="admin-actions">
                    <button class="btn btn-sm btn-light text-primary border" onclick="editMatch('${doc.id}')"><i class="fas fa-edit"></i> Edit</button>
                    <button class="btn btn-sm btn-light text-danger border ms-2" onclick="deleteMatch('${doc.id}')"><i class="fas fa-trash"></i></button>
                </div>`;

            if(m.type === 'Standard') {
                const t1=m.teams[0], t2=m.teams[1];
                const c1=m.colors?.[0]||'blue', c2=m.colors?.[1]||'red';
                list.innerHTML += `
                    <div class="match-card">
                        <div class="match-header"><span>${dateStr} @ ${m.location}</span> ${yt}</div>
                        <div class="match-body">
                            <div class="team-block">
                                <span class="team-name"><span class="badge-dot bg-${c1}"></span>${t1.teamName||'Team A'}</span>
                                <div class="team-roster">${t1.players.join(', ')}</div>
                            </div>
                            <div class="score-block">${t1.score}-${t2.score}</div>
                            <div class="team-block">
                                <span class="team-name"><span class="badge-dot bg-${c2}"></span>${t2.teamName||'Team B'}</span>
                                <div class="team-roster">${t2.players.join(', ')}</div>
                            </div>
                        </div>
                        ${admin}
                    </div>`;
            } else {
                // Tournament
                const r1 = m.teams.find(t=>t.rank===1)||m.teams[0];
                const r2 = m.teams.find(t=>t.rank===2)||m.teams[1];
                const r3 = m.teams.find(t=>t.rank===3)||m.teams[2];
                list.innerHTML += `
                    <div class="match-card" style="border-left:4px solid #facc15">
                        <div class="match-header"><span>${dateStr} @ ${m.location} (Tournament)</span> ${yt}</div>
                        <div class="p-3">
                            <table class="tourn-table">
                                <tr><td><span class="badge bg-warning text-dark me-2">1st</span><b>${r1.teamName}</b></td><td class="text-end text-muted small">${r1.players.join(', ')}</td></tr>
                                <tr><td><span class="badge bg-secondary me-2" style="opacity:0.6">2nd</span>${r2.teamName}</td><td class="text-end text-muted small">${r2.players.join(', ')}</td></tr>
                                <tr><td><span class="badge bg-secondary me-2" style="opacity:0.3">3rd</span>${r3.teamName}</td><td class="text-end text-muted small">${r3.players.join(', ')}</td></tr>
                            </table>
                        </div>
                        ${admin}
                    </div>`;
            }
        });
        if(currentUser && currentUser.email === SUPER_ADMIN) list.classList.add('show-super-admin');
    });
}

// --- SAVE / EDIT ---

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!currentUser) return alert("Login required.");
    
    document.getElementById('loadingOverlay').classList.remove('d-none');
    const isEdit = document.getElementById('editMatchId').value !== "";
    const editingId = document.getElementById('editMatchId').value;
    const batch = db.batch();

    try {
        // 1. If Edit, Reverse Old Stats
        if(isEdit) {
            const oldM = cachedMatches[editingId];
            if(oldM) await reverseStats(batch, oldM);
        }

        // 2. Prepare Data
        const type = document.querySelector('input[name="matchType"]:checked').value;
        const common = {
            date: new Date(document.getElementById('matchDate').value),
            location: document.getElementById('matchLocation').value,
            youtubeLink: document.getElementById('matchYoutube').value || null,
            type: type,
            updatedBy: currentUser.email,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };

        if(type === 'Standard') {
            const sA=parseInt(document.getElementById('scoreA').value)||0;
            const sB=parseInt(document.getElementById('scoreB').value)||0;
            const pA=selectedPlayers.A, pB=selectedPlayers.B;
            const cA=document.querySelector('input[name="colorA"]:checked').value;
            const cB=document.querySelector('input[name="colorB"]:checked').value;

            if(!pA.length || !pB.length) throw new Error("Add players!");

            const matchData = {
                ...common, colors: [cA, cB],
                teams: [
                    { teamName: document.getElementById('nameTeamA').value, score: sA, players: pA },
                    { teamName: document.getElementById('nameTeamB').value, score: sB, players: pB }
                ]
            };
            const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
            batch.set(docRef, matchData);

            updateStats(batch, pA, sA, sB, 1);
            updateStats(batch, pB, sB, sA, 1);

        } else {
            // Tournament
            const pA=selectedPlayers.TournA, pB=selectedPlayers.TournB, pC=selectedPlayers.TournC;
            if(!pA.length||!pB.length||!pC.length) throw new Error("Add players!");
            
            const v = (id) => parseInt(document.getElementById(id).value)||0;
            const f = {
                m1:{a:v('t_m1_a'),b:v('t_m1_b')}, m2:{a:v('t_m2_a'),c:v('t_m2_c')},
                m3:{b:v('t_m3_b'),c:v('t_m3_c')}, m4:{a:v('t_m4_a'),b:v('t_m4_b')},
                m5:{a:v('t_m5_a'),c:v('t_m5_c')}, m6:{b:v('t_m6_b'),c:v('t_m6_c')}
            };

            let t = {A:{gf:0,ga:0,pts:0}, B:{gf:0,ga:0,pts:0}, C:{gf:0,ga:0,pts:0}};
            const proc = (k1,s1,k2,s2) => {
                t[k1].gf+=s1; t[k1].ga+=s2; t[k2].gf+=s2; t[k2].ga+=s1;
                if(s1>s2)t[k1].pts+=3; else if(s2>s1)t[k2].pts+=3; else {t[k1].pts++; t[k2].pts++;}
            };
            proc('A',f.m1.a,'B',f.m1.b); proc('A',f.m2.a,'C',f.m2.c); proc('B',f.m3.b,'C',f.m3.c);
            proc('A',f.m4.a,'B',f.m4.b); proc('A',f.m5.a,'C',f.m5.c); proc('B',f.m6.b,'C',f.m6.c);

            const ranks = ['A','B','C'].sort((x,y) => (t[y].pts-t[x].pts)||(t[y].gf-t[y].ga)-(t[x].gf-t[x].ga));
            
            const matchData = {
                ...common, fixture: f,
                teams: [
                    { teamName: document.getElementById('nameTournA').value||'Yellow', players: pA, rank: ranks.indexOf('A')+1 },
                    { teamName: document.getElementById('nameTournB').value||'Blue', players: pB, rank: ranks.indexOf('B')+1 },
                    { teamName: document.getElementById('nameTournC').value||'Red', players: pC, rank: ranks.indexOf('C')+1 }
                ]
            };
            const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
            batch.set(docRef, matchData);

            // Stats Update
            [pA, pB, pC].forEach((pArr, i) => {
                const key = ['A','B','C'][i];
                const stats = t[key];
                const r = ranks.indexOf(key)+1;
                const pts = r===1?3 : (r===2?1:0);
                // Important: Stats update takes player ARRAY
                updateStats(batch, pArr, stats.gf, stats.ga, 1, pts);
            });
        }

        await batch.commit();
        cancelEditMode();
        document.getElementById('addMatchForm').reset();
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert("Success!");
        bootstrap.Tab.getInstance(document.querySelector('button[data-bs-target="#matches"]')).show();

    } catch (err) {
        console.error(err);
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert("Error: " + err.message);
    }
});

// --- EDIT MODE POPULATE ---
window.editMatch = (id) => {
    const m = cachedMatches[id];
    if(!m) return;
    
    // Switch Tab
    new bootstrap.Tab(document.querySelector('button[data-bs-target="#admin"]')).show();
    
    // UI Setup
    document.getElementById('formTitle').innerText = "Editing Match...";
    document.getElementById('saveBtn').innerText = "UPDATE MATCH";
    document.getElementById('saveBtn').classList.replace('btn-primary', 'btn-warning');
    document.getElementById('cancelEditBtn').classList.remove('d-none');
    document.getElementById('editMatchId').value = id;

    // Common Fields
    document.getElementById('matchDate').value = m.date.toDate().toISOString().split('T')[0];
    document.getElementById('matchLocation').value = m.location;
    document.getElementById('matchYoutube').value = m.youtubeLink || "";

    // Clear lists first!
    selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
    ['A','B','TournA','TournB','TournC'].forEach(k => renderList(k));

    if(m.type === 'Standard') {
        document.getElementById('typeStandard').click();
        
        // Populate inputs
        document.getElementById('nameTeamA').value = m.teams[0].teamName;
        document.getElementById('scoreA').value = m.teams[0].score;
        document.getElementById('nameTeamB').value = m.teams[1].teamName;
        document.getElementById('scoreB').value = m.teams[1].score;
        
        // Colors
        const c1 = m.colors?.[0]||'blue'; const c2 = m.colors?.[1]||'red';
        document.querySelector(`input[name="colorA"][value="${c1}"]`).checked = true;
        document.querySelector(`input[name="colorB"][value="${c2}"]`).checked = true;

        // Players
        m.teams[0].players.forEach(p => selectedPlayers.A.push(p));
        m.teams[1].players.forEach(p => selectedPlayers.B.push(p));
        renderList('A'); renderList('B');

    } else {
        document.getElementById('typeTournament').click();
        const f = m.fixture || {};
        // Fixture Scores
        Object.keys(f).forEach(mKey => {
            Object.keys(f[mKey]).forEach(side => {
                const el = document.getElementById(`t_${mKey}_${side}`);
                if(el) el.value = f[mKey][side];
            });
        });
        
        // Teams (Order in DB: 0=Yellow, 1=Blue, 2=Red logic from save)
        // Wait, saving order was fixed: Yellow(A), Blue(B), Red(C).
        document.getElementById('nameTournA').value = m.teams[0].teamName;
        m.teams[0].players.forEach(p => selectedPlayers.TournA.push(p));
        
        document.getElementById('nameTournB').value = m.teams[1].teamName;
        m.teams[1].players.forEach(p => selectedPlayers.TournB.push(p));
        
        document.getElementById('nameTournC').value = m.teams[2].teamName;
        m.teams[2].players.forEach(p => selectedPlayers.TournC.push(p));
        
        renderList('TournA'); renderList('TournB'); renderList('TournC');
    }
};

window.cancelEditMode = () => {
    document.getElementById('formTitle').innerText = "New Match Entry";
    document.getElementById('saveBtn').innerText = "SAVE MATCH";
    document.getElementById('saveBtn').classList.replace('btn-warning', 'btn-primary');
    document.getElementById('cancelEditBtn').classList.add('d-none');
    document.getElementById('editMatchId').value = "";
    document.getElementById('addMatchForm').reset();
    selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
    ['A','B','TournA','TournB','TournC'].forEach(k => renderList(k));
};

// --- STATS LOGIC ---
function updateStats(batch, players, gf, ga, mult, tournPts=null) {
    let pts, w=0, d=0, l=0;
    if(tournPts!==null) {
        pts = tournPts;
        if(pts===3) w=1; else if(pts===1) d=1; else l=1;
    } else {
        if(gf>ga) {pts=3; w=1;} else if(gf===ga) {pts=1; d=1;} else {pts=0; l=1;}
    }
    
    players.forEach(name => {
        const ref = db.collection("players").doc(name);
        const inc = (v) => firebase.firestore.FieldValue.increment(v*mult);
        batch.set(ref, {
            name: name,
            stats: { played:inc(1), won:inc(w), drawn:inc(d), lost:inc(l), gf:inc(gf), ga:inc(ga), points:inc(pts) }
        }, {merge:true});
    });
}

async function reverseStats(batch, m) {
    if(m.type==='Standard') {
        const t1=m.teams[0], t2=m.teams[1];
        updateStats(batch, t1.players, t1.score, t2.score, -1);
        updateStats(batch, t2.players, t2.score, t1.score, -1);
    } else {
        m.teams.forEach(t => {
            const r=t.rank, pts=(r===1?3:(r===2?1:0));
            // Using 0,0 for GF/GA reverse in tournament as simplified logic
            // Since we recalculate exact on save, this avoids negative drift if calc differs
            updateStats(batch, t.players, 0, 0, -1, pts);
        });
    }
}

window.deleteMatch = async(id) => {
    if(!confirm("Delete match? Stats will reverse.")) return;
    document.getElementById('loadingOverlay').classList.remove('d-none');
    try {
        const batch = db.batch();
        await reverseStats(batch, cachedMatches[id]);
        batch.delete(db.collection("matches").doc(id));
        await batch.commit();
        alert("Deleted.");
    } catch(e) { console.error(e); alert("Error"); }
    document.getElementById('loadingOverlay').classList.add('d-none');
};

// --- HELPERS ---
function toggleMatchType() {
    const isTourn = document.getElementById('typeTournament').checked;
    document.getElementById('standardSection').classList.toggle('d-none', isTourn);
    document.getElementById('tournamentSection').classList.toggle('d-none', !isTourn);
}
function setupEnterKeys() {
    ['inputPlayerA','inputPlayerB','inputPlayerTournA','inputPlayerTournB','inputPlayerTournC'].forEach(id=>{
        document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter'){e.preventDefault();addPlayer(id.replace('inputPlayer',''))}});
    });
}
function addPlayer(k) {
    const i=document.getElementById(`inputPlayer${k}`); let v=i.value.trim(); if(!v)return;
    v=v.charAt(0).toUpperCase()+v.slice(1);
    if(selectedPlayers[k].includes(v))return alert("Added already");
    selectedPlayers[k].push(v); renderList(k); i.value=""; i.focus();
}
function removePlayer(k,n) { selectedPlayers[k]=selectedPlayers[k].filter(x=>x!==n); renderList(k); }
function renderList(k) {
    document.getElementById(`listTeam${k}`).innerHTML=selectedPlayers[k].map(p=>`<span class="player-tag">${p}<i class="fas fa-times ms-1 text-danger" onclick="removePlayer('${k}','${p}')" style="cursor:pointer"></i></span>`).join('');
}
function fetchPlayerNames() {
    db.collection("players").get().then(s=>{
        const l=document.getElementById('playerList'); l.innerHTML="";
        s.forEach(d=>l.appendChild(new Option(d.id)));
    });
}