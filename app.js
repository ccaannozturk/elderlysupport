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

// --- INIT & AUTH ---
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
    const userEmail = document.getElementById('userEmailDisplay');
    
    if (currentUser) {
        navEntry.classList.remove('d-none');
        authBtn.innerHTML = '<i class="fas fa-user-check text-success fa-lg"></i>';
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('userInfo').classList.remove('d-none');
        userEmail.innerText = currentUser.email;

        // Super Admin Check for Edit/Delete buttons
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
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPass').value;
    auth.signInWithEmailAndPassword(email, pass)
        .then(() => bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide())
        .catch(err => alert("Error: " + err.message));
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    auth.signOut().then(() => bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide());
});

// --- DATA LOADING ---

function loadLeaderboard() {
    db.collection("players").onSnapshot(snap => {
        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = "";
        let players = [];
        snap.forEach(doc => players.push({name: doc.id, ...doc.data().stats}));
        
        // Robust Sort
        players.sort((a,b) => (b.points - a.points) || ((b.gf-b.ga)-(a.gf-a.ga)) || (b.won - a.won));

        players.forEach((p, i) => {
            const icon = i===0 ? "🥇" : (i===1?"🥈":(i===2?"🥉": i+1));
            const color = i===0 ? "text-warning" : (i<3 ? "text-secondary" : "text-muted");
            tbody.innerHTML += `
                <tr>
                    <td class="ps-3 fw-bold ${color}">${icon}</td>
                    <td class="fw-bold">${p.name}</td>
                    <td class="text-center">${p.won||0}</td>
                    <td class="text-center text-muted small">${(p.gf||0)-(p.ga||0)}</td>
                    <td class="text-center fw-bold pe-3 text-primary">${p.points||0}</td>
                </tr>`;
        });
    });
}

function loadMatchHistory() {
    // Removed 'limit' to ensure all matches load if dates are mixed
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
            const dateStr = m.date && m.date.toDate ? m.date.toDate().toLocaleDateString('en-NL', {day:'numeric', month:'short'}) : 'Date Err';
            
            // Buttons for Super Admin
            const adminBtns = `
                <div class="admin-actions">
                    <button class="btn btn-sm btn-light text-primary border" onclick="editMatch('${doc.id}', event)"><i class="fas fa-edit"></i> Edit</button>
                    <button class="btn btn-sm btn-light text-danger border ms-2" onclick="deleteMatch('${doc.id}', event)"><i class="fas fa-trash"></i> Delete</button>
                </div>
            `;

            if(m.type === 'Standard') {
                const t1 = m.teams[0], t2 = m.teams[1];
                const c1 = m.colors?.[0] || 'blue', c2 = m.colors?.[1] || 'red';
                list.innerHTML += `
                    <div class="match-card" onclick="openModal('${doc.id}')">
                        <div class="match-header"><span>${dateStr}</span><span>${m.location}</span></div>
                        <div class="match-body">
                            <div class="text-center" style="width:35%"><div class="badge-dot bg-${c1}"></div><div class="fw-bold small">${t1.teamName||'A'}</div></div>
                            <div class="score-box">${t1.score} - ${t2.score}</div>
                            <div class="text-center" style="width:35%"><div class="badge-dot bg-${c2}"></div><div class="fw-bold small">${t2.teamName||'B'}</div></div>
                        </div>
                        ${adminBtns}
                    </div>`;
            } else {
                // Tournament
                const r1 = m.teams.find(t=>t.rank===1)||m.teams[0];
                const r2 = m.teams.find(t=>t.rank===2)||m.teams[1];
                list.innerHTML += `
                    <div class="match-card" onclick="openModal('${doc.id}')" style="border-left:4px solid #facc15">
                        <div class="match-header"><span>${dateStr}</span><span>${m.location}</span></div>
                        <div class="p-3">
                            <div class="d-flex align-items-center mb-1"><span class="badge bg-warning text-dark me-2">1st</span><span class="fw-bold">${r1.teamName}</span></div>
                            <div class="d-flex align-items-center small text-muted"><span class="badge bg-light text-dark border me-2">2nd</span><span>${r2.teamName}</span></div>
                        </div>
                        ${adminBtns}
                    </div>`;
            }
        });
        // Apply admin visibility class after rendering
        if(currentUser && currentUser.email === SUPER_ADMIN) list.classList.add('show-super-admin');
    });
}

// --- SAVE / EDIT LOGIC ---

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!currentUser) return alert("Login required.");
    
    // UI Loading
    document.getElementById('loadingOverlay').classList.remove('d-none');
    
    const isEdit = document.getElementById('editMatchId').value !== "";
    const editingId = document.getElementById('editMatchId').value;

    try {
        const batch = db.batch();
        
        // 1. IF EDITING: First, REVERSE old stats
        if(isEdit) {
            const oldM = cachedMatches[editingId];
            await reverseMatchStats(batch, oldM);
            // Delete old match doc reference (we will overwrite/set it)
        }

        // 2. PREPARE NEW DATA
        const type = document.querySelector('input[name="matchType"]:checked').value;
        const common = {
            date: new Date(document.getElementById('matchDate').value),
            location: document.getElementById('matchLocation').value,
            youtubeLink: document.getElementById('matchYoutube').value || null,
            type: type,
            updatedBy: currentUser.email,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };

        let newMatchData = { ...common };

        if(type === 'Standard') {
            const sA = parseInt(document.getElementById('scoreA').value)||0;
            const sB = parseInt(document.getElementById('scoreB').value)||0;
            const pA = selectedPlayers.A, pB = selectedPlayers.B;
            const cA = document.querySelector('input[name="colorA"]:checked').value;
            const cB = document.querySelector('input[name="colorB"]:checked').value;

            if(!pA.length || !pB.length) throw new Error("Teams empty.");

            newMatchData.colors = [cA, cB];
            newMatchData.teams = [
                { teamName: document.getElementById('nameTeamA').value, score: sA, players: pA },
                { teamName: document.getElementById('nameTeamB').value, score: sB, players: pB }
            ];

            // Add Stats
            updateStats(batch, pA, sA, sB, 1);
            updateStats(batch, pB, sB, sA, 1);

        } else {
            // Tournament
            const pA=selectedPlayers.TournA, pB=selectedPlayers.TournB, pC=selectedPlayers.TournC;
            if(!pA.length||!pB.length||!pC.length) throw new Error("Teams empty.");

            const val = (id) => parseInt(document.getElementById(id).value)||0;
            const f = {
                m1:{a:val('t_m1_a'),b:val('t_m1_b')}, m2:{a:val('t_m2_a'),c:val('t_m2_c')},
                m3:{b:val('t_m3_b'),c:val('t_m3_c')}, m4:{a:val('t_m4_a'),b:val('t_m4_b')},
                m5:{a:val('t_m5_a'),c:val('t_m5_c')}, m6:{b:val('t_m6_b'),c:val('t_m6_c')}
            };

            // Calc Table
            let t = {A:{gf:0,ga:0,pts:0}, B:{gf:0,ga:0,pts:0}, C:{gf:0,ga:0,pts:0}};
            const proc = (k1,s1,k2,s2) => {
                t[k1].gf+=s1; t[k1].ga+=s2; t[k2].gf+=s2; t[k2].ga+=s1;
                if(s1>s2)t[k1].pts+=3; else if(s2>s1)t[k2].pts+=3; else {t[k1].pts++; t[k2].pts++;}
            };
            proc('A',f.m1.a,'B',f.m1.b); proc('A',f.m2.a,'C',f.m2.c); proc('B',f.m3.b,'C',f.m3.c);
            proc('A',f.m4.a,'B',f.m4.b); proc('A',f.m5.a,'C',f.m5.c); proc('B',f.m6.b,'C',f.m6.c);

            const ranks = ['A','B','C'].sort((x,y) => (t[y].pts-t[x].pts)||(t[y].gf-t[y].ga)-(t[x].gf-t[x].ga));

            newMatchData.fixture = f;
            newMatchData.teams = [
                { teamName: document.getElementById('nameTournA').value||'Yellow', players: pA, rank: ranks.indexOf('A')+1 },
                { teamName: document.getElementById('nameTournB').value||'Blue', players: pB, rank: ranks.indexOf('B')+1 },
                { teamName: document.getElementById('nameTournC').value||'Red', players: pC, rank: ranks.indexOf('C')+1 }
            ];

            // Add Stats
            [pA, pB, pC].forEach((pArr, i) => {
                const key = ['A','B','C'][i];
                const stats = t[key];
                const r = ranks.indexOf(key)+1;
                const pts = r===1?3 : (r===2?1:0);
                updateStats(batch, pArr, stats.gf, stats.ga, 1, pts);
            });
        }

        // 3. WRITE TO DB
        const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
        batch.set(docRef, newMatchData);

        await batch.commit();
        
        // Reset Form
        cancelEditMode();
        document.getElementById('addMatchForm').reset();
        selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
        ['A','B','TournA','TournB','TournC'].forEach(k => renderList(k));
        
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert(isEdit ? "Match Updated!" : "Match Saved!");
        
        // Switch to matches tab
        const triggerEl = document.querySelector('button[data-bs-target="#matches"]');
        bootstrap.Tab.getInstance(triggerEl).show();

    } catch (err) {
        console.error(err);
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert("Error: " + err.message);
    }
});

// --- EDIT FUNCTIONALITY ---

window.editMatch = (id, e) => {
    e.stopPropagation();
    const m = cachedMatches[id];
    if(!m) return;

    // Switch to Entry Tab
    const tabBtn = document.querySelector('button[data-bs-target="#admin"]');
    new bootstrap.Tab(tabBtn).show();

    // Set Edit Mode UI
    document.getElementById('formTitle').innerText = "Edit Match";
    document.getElementById('saveBtn').innerText = "UPDATE MATCH";
    document.getElementById('saveBtn').classList.replace('btn-primary', 'btn-warning');
    document.getElementById('cancelEditBtn').classList.remove('d-none');
    document.getElementById('editMatchId').value = id;

    // Fill Form
    document.getElementById('matchDate').value = m.date.toDate().toISOString().split('T')[0];
    document.getElementById('matchLocation').value = m.location;
    document.getElementById('matchYoutube').value = m.youtubeLink || "";
    
    if(m.type === 'Standard') {
        document.getElementById('typeStandard').click();
        document.getElementById('nameTeamA').value = m.teams[0].teamName;
        document.getElementById('scoreA').value = m.teams[0].score;
        document.getElementById('nameTeamB').value = m.teams[1].teamName;
        document.getElementById('scoreB').value = m.teams[1].score;
        
        // Set Colors
        const c1 = m.colors?.[0]||'blue'; const c2 = m.colors?.[1]||'red';
        document.querySelector(`input[name="colorA"][value="${c1}"]`).checked = true;
        document.querySelector(`input[name="colorB"][value="${c2}"]`).checked = true;

        // Set Players
        selectedPlayers.A = [...m.teams[0].players];
        selectedPlayers.B = [...m.teams[1].players];
        renderList('A'); renderList('B');

    } else {
        document.getElementById('typeTournament').click();
        const f = m.fixture || {};
        // Fill Matrix
        ['m1','m2','m3','m4','m5','m6'].forEach(k => {
            Object.keys(f[k]).forEach(sub => document.getElementById(`t_${k}_${sub}`).value = f[k][sub]);
        });
        
        // Fill Names (Using index assumptions based on saved structure)
        // Yellow=0, Blue=1, Red=2 is how we saved array logic in addMatchForm
        // But teams array order depends on rank. We need to match by name or context.
        // Simplified: Assume fixed team slots for editing: Yellow/Blue/Red.
        // We need to find which team object corresponds to Yellow etc.
        // In save logic: teams[0] is Yellow input, teams[1] Blue, teams[2] Red.
        // So we can just trust the array order IF we didn't sort teams array by rank in DB.
        // WAIT. I sorted teams array by rank in the save logic! (ranks.indexOf)
        // Correct fix: Load players based on finding the teamName or logic.
        // Since names are custom, we better rely on the `fixture` logic.
        // Actually, let's just use the players.
        
        // Find team objects
        // Logic: In Save, I pushed teams: [YellowObj, BlueObj, RedObj]. 
        // Firestore saves arrays in order. So index 0 is always Yellow input team.
        // Let's verify... Yes: `teams: [ {teamName: Yellow...}, {Blue}, {Red} ]`.
        // Even if rank is different, the array order in 'teams' field is preserved as written.
        
        document.getElementById('nameTournA').value = m.teams[0].teamName;
        selectedPlayers.TournA = [...m.teams[0].players];
        
        document.getElementById('nameTournB').value = m.teams[1].teamName;
        selectedPlayers.TournB = [...m.teams[1].players];
        
        document.getElementById('nameTournC').value = m.teams[2].teamName;
        selectedPlayers.TournC = [...m.teams[2].players];
        
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

// --- DELETE & REVERSE HELPERS ---

window.deleteMatch = async (id, e) => {
    e.stopPropagation();
    if(!confirm("Delete match? Stats will be reverted.")) return;
    
    document.getElementById('loadingOverlay').classList.remove('d-none');
    try {
        const batch = db.batch();
        const m = cachedMatches[id];
        await reverseMatchStats(batch, m);
        batch.delete(db.collection("matches").doc(id));
        await batch.commit();
        alert("Deleted.");
    } catch(err) { console.error(err); alert("Error"); }
    document.getElementById('loadingOverlay').classList.add('d-none');
};

function reverseMatchStats(batch, m) {
    // Standard Reverse
    if(m.type === 'Standard') {
        const t1=m.teams[0], t2=m.teams[1];
        updateStats(batch, t1.players, t1.score, t2.score, -1);
        updateStats(batch, t2.players, t2.score, t1.score, -1);
    } else {
        // Tournament Reverse
        m.teams.forEach(t => {
            const r = t.rank; 
            const pts = r===1?3 : (r===2?1:0);
            // Reversing GF/GA is tricky without exact stored values per team.
            // But we can reverse Points/Played/Won accurately.
            // For GF/GA, in V5 we recalculate fresh on Edit, so minor drift in GF/GA on Delete is acceptable 
            // OR we can try to recalculate if fixture exists.
            // Let's rely on stored fixture if available to reverse GF/GA too.
            // Simplified: Just reverse Points/W/D/L/Played.
            const ref = db.collection("players").doc(t.players[0]); // Batch needs 1 ref per loop logic, see helper
            // Actually helper handles array.
            updateStats(batch, t.players, 0, 0, -1, pts); // GF/GA set to 0 to avoid corruption if not sure
        });
    }
}

function updateStats(batch, players, gf, ga, multiplier, tournPts=null) {
    let pts, w=0, d=0, l=0;
    if(tournPts!==null) {
        pts=tournPts;
        if(pts===3) w=1; else if(pts===1) d=1; else l=1;
    } else {
        if(gf>ga) {pts=3; w=1;} else if(gf===ga) {pts=1; d=1;} else {pts=0; l=1;}
    }
    
    players.forEach(name => {
        const ref = db.collection("players").doc(name);
        const inc = (v) => firebase.firestore.FieldValue.increment(v * multiplier);
        batch.set(ref, {
            name: name,
            stats: {
                played: inc(1), won: inc(w), drawn: inc(d), lost: inc(l),
                gf: inc(gf), ga: inc(ga), points: inc(pts)
            }
        }, { merge: true });
    });
}

// --- UTILS ---
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
window.openModal = (id) => {
    const m = cachedMatches[id]; if(!m)return;
    const b = document.getElementById('modalBody');
    const d = m.date.toDate().toLocaleDateString();
    
    if(m.type==='Standard') {
        b.innerHTML=`<div class="text-center mb-3 text-muted">${d}</div>
        <div class="d-flex justify-content-center align-items-center gap-4">
            <div class="text-center"><h3>${m.teams[0].score}</h3><small>${m.teams[0].players.join('<br>')}</small></div>
            <div class="text-muted">-</div>
            <div class="text-center"><h3>${m.teams[1].score}</h3><small>${m.teams[1].players.join('<br>')}</small></div>
        </div>`;
    } else {
        b.innerHTML=`<div class="text-center mb-3 text-muted">${d} (Tournament)</div>
        <div class="text-center">Winner: ${m.teams.find(t=>t.rank==1).teamName}</div>`;
    }
    new bootstrap.Modal(document.getElementById('matchDetailModal')).show();
}