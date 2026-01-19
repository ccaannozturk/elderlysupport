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
let allMatches = []; 
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

// --- HELPER: CRASH PREVENTER ---
function safeText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }

document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateAuthUI();
    });

    if(document.getElementById('filterYear')) document.getElementById('filterYear').addEventListener('change', renderData);
    if(document.getElementById('filterMonth')) document.getElementById('filterMonth').addEventListener('change', renderData);
    
    fetchMatches();
    fetchPlayerNames();
    
    const dDate = document.getElementById('matchDate');
    if(dDate) dDate.valueAsDate = new Date();
    
    setupEnterKeys();
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
    db.collection("matches").orderBy("date", "desc").onSnapshot(snap => {
        allMatches = [];
        snap.forEach(doc => allMatches.push({ id: doc.id, ...doc.data() }));
        renderData();
    });
}

function formatDate(dateObj) {
    if (!dateObj) return "";
    const d = new Date(dateObj);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

// --- V12.0: MAGIC PASTE ---
window.parseMagicPaste = () => {
    const text = document.getElementById('magicPaste').value.trim();
    if (!text) return alert("Empty!");
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    if(lines.length < 4) return alert("Format error.");
    const headerRegex = /^(\d+)[\s:-]+(.*?)(?:[\s:-]+(yellow|blue|red))?$/i;
    window.cancelEditMode(); 
    document.getElementById('typeStandard').click();
    
    const matchA = lines[0].match(headerRegex);
    if(matchA) {
        document.getElementById('scoreA').value = matchA[1];
        document.getElementById('nameTeamA').value = matchA[2].trim();
        const col = matchA[3] ? matchA[3].toLowerCase() : 'blue';
        const rb = document.querySelector(`input[name="colorA"][value="${col}"]`);
        if(rb) rb.checked = true;
    }
    const pListA = lines[1].split(',').map(p => p.trim()).filter(p=>p);
    selectedPlayers.A = [];
    pListA.forEach(p => { selectedPlayers.A.push(p.charAt(0).toUpperCase() + p.slice(1)); });
    renderList('A');

    const matchB = lines[2].match(headerRegex);
    if(matchB) {
        document.getElementById('scoreB').value = matchB[1];
        document.getElementById('nameTeamB').value = matchB[2].trim();
        const col = matchB[3] ? matchB[3].toLowerCase() : 'red';
        const rb = document.querySelector(`input[name="colorB"][value="${col}"]`);
        if(rb) rb.checked = true;
    }
    const pListB = lines[3].split(',').map(p => p.trim()).filter(p=>p);
    selectedPlayers.B = [];
    pListB.forEach(p => { selectedPlayers.B.push(p.charAt(0).toUpperCase() + p.slice(1)); });
    renderList('B');
    alert("Parsed!");
};

// RENDER (V12.1 - Safety Update)
function renderData() {
    const fYear = document.getElementById('filterYear');
    const fMonth = document.getElementById('filterMonth');
    const year = fYear ? parseInt(fYear.value) : 2026;
    const month = fMonth ? fMonth.value : 'all';
    
    const filtered = allMatches.filter(m => {
        const d = m.date.toDate();
        const yMatch = d.getFullYear() === year;
        const mMatch = month === 'all' || d.getMonth() === parseInt(month);
        return yMatch && mMatch;
    });

    const list = document.getElementById('match-history-list');
    if(!list) return;
    
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
            const ytLink = m.youtubeLink ? `<a href="${m.youtubeLink}" target="_blank" onclick="event.stopPropagation()" style="color:#fa7970; text-decoration:none; font-size:0.75rem; font-weight:600;"><i class="fab fa-youtube"></i> Watch</a>` : '';

            let html = "";
            if(m.type === 'Standard') {
                const tA=m.teams[0], tB=m.teams[1];
                const cA=m.colors?.[0]||'blue', cB=m.colors?.[1]||'red';
                const winA = tA.score > tB.score ? 'text-white' : 't-loser';
                const winB = tB.score > tA.score ? 'text-white' : 't-loser';
                const pA = (tA.players||[]).join(', '); const pB = (tB.players||[]).join(', ');

                html = `
                <div class="match-card" onclick="openMatchModal('${m.id}')">
                    <div class="card-top"><span><i class="far fa-calendar me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${m.location}</span> ${ytLink}</div>
                    <div class="card-body-strip">
                        <div class="team-block">
                            <div class="team-row mb-2"><div class="t-name ${winA}"><span class="dot bg-${cA.charAt(0)}"></span>${tA.teamName||'A'}</div><div class="t-score ${winA}">${tA.score}</div></div>
                            <div class="team-players text-muted small" style="font-size:0.75rem">${pA}</div>
                        </div>
                        <div class="match-meta"><span class="ft-badge">FT</span></div>
                        <div class="team-block text-end">
                            <div class="team-row mb-2 justify-content-end"><div class="t-score ${winB} me-2">${tB.score}</div><div class="t-name justify-content-end ${winB}">${tB.teamName||'B'}<span class="dot bg-${cB.charAt(0)} ms-2"></span></div></div>
                            <div class="team-players text-end text-muted small" style="font-size:0.75rem">${pB}</div>
                        </div>
                    </div>
                    ${adminBtns}
                </div>`;
            } else {
                const r1 = m.teams.find(t=>t.rank===1)||m.teams[0];
                const r2 = m.teams.find(t=>t.rank===2)||m.teams[1];
                const r3 = m.teams.find(t=>t.rank===3)||m.teams[2];
                const getCol = (t) => { const idx = m.teams.indexOf(t); return idx === 0 ? 'y' : (idx === 1 ? 'b' : 'r'); };
                let scoreHtml = "";
                if(m.fixture) {
                    const f = m.fixture;
                    scoreHtml = `
                    <div class="tourn-scores">
                        <span class="score-pill"><span class="dot bg-y" style="margin-right:2px; width:6px; height:6px;"></span>${f.m1.a}-${f.m1.b}<span class="dot bg-b" style="margin-left:2px; width:6px; height:6px;"></span></span>
                        <span class="score-pill"><span class="dot bg-y" style="margin-right:2px; width:6px; height:6px;"></span>${f.m2.a}-${f.m2.c}<span class="dot bg-r" style="margin-left:2px; width:6px; height:6px;"></span></span>
                        <span class="score-pill"><span class="dot bg-b" style="margin-right:2px; width:6px; height:6px;"></span>${f.m3.b}-${f.m3.c}<span class="dot bg-r" style="margin-left:2px; width:6px; height:6px;"></span></span>
                        <span class="score-pill"><span class="dot bg-y" style="margin-right:2px; width:6px; height:6px;"></span>${f.m4.a}-${f.m4.b}<span class="dot bg-b" style="margin-left:2px; width:6px; height:6px;"></span></span>
                        <span class="score-pill"><span class="dot bg-y" style="margin-right:2px; width:6px; height:6px;"></span>${f.m5.a}-${f.m5.c}<span class="dot bg-r" style="margin-left:2px; width:6px; height:6px;"></span></span>
                        <span class="score-pill"><span class="dot bg-b" style="margin-right:2px; width:6px; height:6px;"></span>${f.m6.b}-${f.m6.c}<span class="dot bg-r" style="margin-left:2px; width:6px; height:6px;"></span></span>
                    </div>`;
                }

                html = `
                <div class="match-card" onclick="openMatchModal('${m.id}')" style="border-left: 3px solid #facc15;">
                    <div class="card-top"><span><i class="fas fa-trophy text-warning me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${m.location}</span> ${ytLink}</div>
                    <div class="p-3 bg-card">
                        <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-white fw-bold"><span class="rank-badge rank-1">1</span> <span class="dot bg-${getCol(r1)}"></span> ${r1.teamName}</span></div><div style="font-size:0.75rem; color:#8b949e; margin-left:32px">${(r1.players||[]).join(', ')}</div></div>
                        <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted"><span class="rank-badge bg-secondary">2</span> <span class="dot bg-${getCol(r2)}"></span> ${r2.teamName}</span></div><div style="font-size:0.75rem; color:#666; margin-left:32px">${(r2.players||[]).join(', ')}</div></div>
                        <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted opacity-50"><span class="rank-badge bg-secondary">3</span> <span class="dot bg-${getCol(r3)}"></span> ${r3.teamName}</span></div><div style="font-size:0.75rem; color:#555; margin-left:32px">${(r3.players||[]).join(', ')}</div></div>
                        ${scoreHtml}
                    </div>
                    ${adminBtns}
                </div>`;
            }
            list.innerHTML += html;
        });
    }

    // LEADERBOARD CALC - CRASH GUARD
    let stats = {};
    filtered.forEach(m => {
        // FIX 2: Deep safety check for malformed matches
        if (!m.teams || m.teams.length < 2) return; 

        if(m.type === 'Standard') {
            const tA=m.teams[0], tB=m.teams[1];
            processTeamStats(stats, tA.players||[], tA.score, tB.score, (tA.score>tB.score?3:(tA.score==tB.score?1:0)));
            processTeamStats(stats, tB.players||[], tB.score, tA.score, (tB.score>tA.score?3:(tB.score==tA.score?1:0)));
        } else {
            m.teams.forEach(t => {
                const pts = t.rank===1 ? 3 : (t.rank===2 ? 1 : 0);
                processTeamStats(stats, t.players||[], 0, 0, pts);
            });
        }
    });

    const tbody = document.getElementById('leaderboard-body');
    if(!tbody) return;
    tbody.innerHTML = "";
    const players = Object.values(stats).sort((a,b) => (b.points-a.points) || (b.won-a.won));
    if(players.length === 0) tbody.innerHTML = "<tr><td colspan='5' class='text-center py-4 text-muted small'>No stats available.</td></tr>";
    players.forEach((p, i) => {
        const rowClass = i%2===0 ? "" : "bg-white bg-opacity-5"; 
        tbody.innerHTML += `<tr onclick="window.openPlayerStats('${p.name}')" style="cursor:pointer" class="${rowClass}"><td class="ps-3 fw-bold"><span class="rank-circle ${i===0?'r-1':''}">${i+1}</span></td><td class="fw-bold text-light">${p.name}</td><td class="text-center text-muted">${p.played}</td><td class="text-center text-muted">${p.won}</td><td class="text-center pe-3 fw-bold text-white">${p.points}</td></tr>`;
    });
}

function processTeamStats(stats, playerArr, gf, ga, pts) {
    if(!playerArr) return; 
    playerArr.forEach(name => {
        if(!stats[name]) stats[name] = { name:name, played:0, won:0, drawn:0, lost:0, points:0, form:[] };
        stats[name].played++; stats[name].points += pts;
        if(pts===3) stats[name].won++; else if(pts===1) stats[name].drawn++; else stats[name].lost++;
    });
}

// --- PLAYER STATS ---
window.openPlayerStats = (name) => {
    const year = parseInt(document.getElementById('filterYear').value);
    const pMatches = allMatches.filter(m => {
        // FIX: Safety check for m.teams
        if(!m.teams) return false;
        const t = m.teams.find(t => (t.players||[]).includes(name));
        return t && m.date.toDate().getFullYear() === year;
    }).sort((a,b) => b.date - a.date);

    if(pMatches.length === 0) return;

    let w=0, played=0, pts=0;
    let totalGF = 0, totalGA = 0;
    let monthly = {};
    let recentForm = [];

    pMatches.forEach(m => {
        played++;
        const monthIdx = m.date.toDate().getMonth();
        if(!monthly[monthIdx]) monthly[monthIdx] = {p:0, w:0, pts:0};
        
        let matchPts=0, result='L';
        let matchGF=0, matchGA=0;

        if(m.type==='Standard') {
            const tA=m.teams[0]; const inA=(tA.players||[]).includes(name);
            const myS=inA?tA.score:m.teams[1].score;
            const opS=inA?m.teams[1].score:tA.score;
            matchGF = myS; matchGA = opS;
            if(myS>opS) {w++; matchPts=3; result='W';} else if(myS==opS) {matchPts=1; result='D';}
        } else {
            const myTeam = m.teams.find(t=>(t.players||[]).includes(name));
            const teamIdx = m.teams.indexOf(myTeam); 
            const r = myTeam.rank;
            if(r===1) {w++; matchPts=3; result='W';} else if(r===2) {matchPts=1; result='D';}
            if(m.fixture) {
                const f = m.fixture;
                const add = (my, op) => { matchGF+=my; matchGA+=op; };
                if(teamIdx === 0) { add(f.m1.a, f.m1.b); add(f.m2.a, f.m2.c); add(f.m4.a, f.m4.b); add(f.m5.a, f.m5.c); } 
                else if(teamIdx === 1) { add(f.m1.b, f.m1.a); add(f.m3.b, f.m3.c); add(f.m4.b, f.m4.a); add(f.m6.b, f.m6.c); } 
                else { add(f.m2.c, f.m2.a); add(f.m3.c, f.m3.b); add(f.m5.c, f.m5.a); add(f.m6.c, f.m6.b); }
            }
        }
        pts += matchPts; totalGF += matchGF; totalGA += matchGA;
        monthly[monthIdx].p++; monthly[monthIdx].pts += matchPts; if(result==='W') monthly[monthIdx].w++;
        if(recentForm.length < 5) recentForm.push(result);
    });

    const winRate = Math.round((w/played)*100);
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const gd = totalGF - totalGA;
    
    const formDisplay = recentForm.reverse().map(r => {
        if(r==='W') return '<i class="fas fa-check text-success mx-1"></i>';
        if(r==='D') return '<i class="far fa-circle text-warning mx-1"></i>';
        return '<i class="fas fa-times text-danger mx-1"></i>';
    }).join('');

    let monthRows = "";
    Object.keys(monthly).sort((a,b)=>a-b).forEach(mIdx => {
        const d = monthly[mIdx];
        monthRows += `<div class="d-flex justify-content-between py-2 border-bottom border-secondary small"><div style="width:40px" class="text-muted">${months[mIdx]}</div><div style="width:30px" class="text-center">${d.p}</div><div style="width:30px" class="text-center">${d.w}</div><div style="width:30px" class="text-center fw-bold text-white">${d.pts}</div></div>`;
    });

    safeText('psName', name.toUpperCase());
    const psBody = document.getElementById('psBody');
    if(psBody) {
        psBody.innerHTML = `
        <div class="text-center mb-3"><div class="mb-2 text-muted small" style="letter-spacing:1px">CURRENT FORM</div><div class="fs-5">${formDisplay}</div></div>
        <div class="row text-center mb-3 g-0 border border-secondary rounded overflow-hidden shadow-sm">
            <div class="col-4 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${played}</div><small class="text-muted" style="font-size:0.6rem">PLAYED</small></div>
            <div class="col-4 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-white">${w}</div><small class="text-muted" style="font-size:0.6rem">WON</small></div>
            <div class="col-4 bg-dark p-2"><div class="fw-bold text-white">${winRate}%</div><small class="text-muted" style="font-size:0.6rem">RATE</small></div>
        </div>
        <div class="row text-center mb-4 g-0 border border-secondary rounded overflow-hidden shadow-sm">
            <div class="col-4 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-success">${totalGF}</div><small class="text-muted" style="font-size:0.6rem">SCORED</small></div>
            <div class="col-4 bg-dark p-2 border-end border-secondary"><div class="fw-bold text-danger">${totalGA}</div><small class="text-muted" style="font-size:0.6rem">CONCEDED</small></div>
            <div class="col-4 bg-dark p-2"><div class="fw-bold text-white">${gd > 0 ? '+'+gd : gd}</div><small class="text-muted" style="font-size:0.6rem">DIFF</small></div>
        </div>
        <h6 class="small fw-bold text-muted border-bottom border-secondary pb-2 mb-0">MONTHLY BREAKDOWN</h6>
        <div class="d-flex justify-content-between py-1 text-muted small" style="font-size:0.7rem"><div style="width:40px">MO</div><div class="text-center" style="width:30px">P</div><div class="text-center" style="width:30px">W</div><div class="text-center" style="width:30px">PTS</div></div>
        ${monthRows}`;
    }
    const modalEl = document.getElementById('playerStatsModal');
    if(modalEl) new bootstrap.Modal(modalEl).show();
};

document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!currentUser) return alert("Login needed");
    const load = document.getElementById('loadingOverlay'); if(load) load.classList.remove('d-none');
    const isEdit = document.getElementById('editMatchId').value !== "";
    const editingId = document.getElementById('editMatchId').value;
    try {
        const type = document.querySelector('input[name="matchType"]:checked').value;
        const dVal = document.getElementById('matchDate').value;
        const common = { date: new Date(dVal), location: document.getElementById('matchLocation').value, youtubeLink: document.getElementById('matchYoutube').value || null, type: type, updatedBy: currentUser.email, timestamp: firebase.firestore.FieldValue.serverTimestamp() };
        let matchData = { ...common };
        if(type === 'Standard') {
            const sA=parseInt(document.getElementById('scoreA').value)||0, sB=parseInt(document.getElementById('scoreB').value)||0;
            const pA=selectedPlayers.A, pB=selectedPlayers.B;
            if(!pA.length || !pB.length) throw new Error("Add players!");
            const caEl = document.querySelector('input[name="colorA"]:checked'); const cbEl = document.querySelector('input[name="colorB"]:checked');
            const cA = caEl ? caEl.value : 'blue'; const cB = cbEl ? cbEl.value : 'red';
            matchData.colors = [cA, cB];
            matchData.teams = [{teamName: document.getElementById('nameTeamA').value, score:sA, players:pA}, {teamName: document.getElementById('nameTeamB').value, score:sB, players:pB}];
        } else {
            const pA=selectedPlayers.TournA, pB=selectedPlayers.TournB, pC=selectedPlayers.TournC;
            if(!pA.length||!pB.length||!pC.length) throw new Error("Add players!");
            const v = (id) => { const el=document.getElementById(id); return el?(parseInt(el.value)||0):0; };
            const f = { m1:{a:v('t_m1_a'),b:v('t_m1_b')}, m2:{a:v('t_m2_a'),c:v('t_m2_c')}, m3:{b:v('t_m3_b'),c:v('t_m3_c')}, m4:{a:v('t_m4_a'),b:v('t_m4_b')}, m5:{a:v('t_m5_a'),c:v('t_m5_c')}, m6:{b:v('t_m6_b'),c:v('t_m6_c')} };
            const ranks = ['A','B','C'].sort((x,y) => 0); 
            matchData.fixture = f;
            matchData.teams = [{teamName:document.getElementById('nameTournA').value||'Yellow',players:pA,rank:1},{teamName:document.getElementById('nameTournB').value||'Blue',players:pB,rank:2},{teamName:document.getElementById('nameTournC').value||'Red',players:pC,rank:3}];
        }
        const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
        await docRef.set(matchData);
        cancelEditMode();
        if(load) load.classList.add('d-none');
        const matchesTab = document.querySelector('button[data-bs-target="#matches"]');
        if(matchesTab) bootstrap.Tab.getInstance(matchesTab).show();
    } catch (err) { if(load) load.classList.add('d-none'); alert("Error: " + err.message); }
});

document.getElementById('loginForm').addEventListener('submit', (e) => { e.preventDefault(); auth.signInWithEmailAndPassword(document.getElementById('loginEmail').value, document.getElementById('loginPass').value).then(()=>bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide()).catch(e=>alert(e.message)); });
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
    selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]}; ['A','B','TournA','TournB','TournC'].forEach(k=>renderList(k));
    if(m.type==='Standard') {
        document.getElementById('typeStandard').click();
        document.getElementById('nameTeamA').value=m.teams[0].teamName; document.getElementById('scoreA').value=m.teams[0].score;
        document.getElementById('nameTeamB').value=m.teams[1].teamName; document.getElementById('scoreB').value=m.teams[1].score;
        const r1=document.querySelector(`input[name="colorA"][value="${m.colors?.[0]||'blue'}"]`); if(r1)r1.checked=true;
        const r2=document.querySelector(`input[name="colorB"][value="${m.colors?.[1]||'red'}"]`); if(r2)r2.checked=true;
        (m.teams[0].players||[]).forEach(p=>selectedPlayers.A.push(p)); (m.teams[1].players||[]).forEach(p=>selectedPlayers.B.push(p));
        renderList('A'); renderList('B');
    } else {
        const rb = document.getElementById('typeTournament'); if(rb){rb.checked=true; toggleMatchType();}
        const f=m.fixture||{}; Object.keys(f).forEach(k=>Object.keys(f[k]).forEach(s=>{ const el=document.getElementById(`t_${k}_${s}`); if(el)el.value=f[k][s]; }));
        if(m.teams.length >= 3) {
            document.getElementById('nameTournA').value=m.teams[0].teamName; (m.teams[0].players||[]).forEach(p=>selectedPlayers.TournA.push(p));
            document.getElementById('nameTournB').value=m.teams[1].teamName; (m.teams[1].players||[]).forEach(p=>selectedPlayers.TournB.push(p));
            document.getElementById('nameTournC').value=m.teams[2].teamName; (m.teams[2].players||[]).forEach(p=>selectedPlayers.TournC.push(p));
        }
        renderList('TournA'); renderList('TournB'); renderList('TournC');
    }
};
window.deleteMatch = (id, e) => { e.stopPropagation(); if(confirm("Delete?")) db.collection("matches").doc(id).delete(); };
window.cancelEditMode = () => { 
    safeText('formTitle', "NEW MATCH ENTRY"); safeText('saveBtn', "SAVE RECORD");
    const saveBtn = document.getElementById('saveBtn'); if(saveBtn) saveBtn.classList.replace('btn-warning','btn-light');
    const cancelBtn = document.getElementById('cancelEditBtn'); if(cancelBtn) cancelBtn.classList.add('d-none');
    document.getElementById('editMatchId').value=""; document.getElementById('addMatchForm').reset(); 
    selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]}; ['A','B','TournA','TournB','TournC'].forEach(k=>renderList(k)); 
    document.querySelectorAll('.border input[type="number"]').forEach(i=>i.value="");
};
window.openMatchModal = (id) => { currentMatchForImage=allMatches.find(x=>x.id===id); openMatchModalLogic(id); }; 
function openMatchModalLogic(id) { 
    const m=allMatches.find(x=>x.id===id); 
    const body=document.getElementById('modalBody');
    const date=formatDate(m.date.toDate());
    if(m.type==='Standard') {
        const tA=m.teams[0], tB=m.teams[1];
        body.innerHTML=`<div class="text-center mb-3 text-muted small letter-spacing-1">${date}</div><div class="d-flex justify-content-center align-items-center mb-4"><div class="text-center w-50"><span class="badge bg-${m.colors?.[0]||'blue'} mb-1">${tA.teamName||'A'}</span><div class="display-4 fw-bold text-white">${tA.score}</div></div><div class="text-muted">-</div><div class="text-center w-50"><span class="badge bg-${m.colors?.[1]||'red'} mb-1">${tB.teamName||'B'}</span><div class="display-4 fw-bold text-white">${tB.score}</div></div></div><div class="row text-center small text-light"><div class="col-6">${(tA.players||[]).join(', ')}</div><div class="col-6">${(tB.players||[]).join(', ')}</div></div>`;
    } else {
        const r1=m.teams.find(t=>t.rank===1),r2=m.teams.find(t=>t.rank===2),r3=m.teams.find(t=>t.rank===3);
        body.innerHTML=`<div class="text-center mb-3 text-muted small">${date} (Tourn)</div><div class="text-center mb-3"><span class="badge bg-warning text-dark mb-2">WINNER</span><h3 class="fw-bold text-white">${r1.teamName}</h3><small class="text-light">${(r1.players||[]).join(', ')}</small></div><ul class="list-group list-group-flush bg-dark small"><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>2. ${r2.teamName}</span><span>${(r2.players||[]).join(', ')}</span></li><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>3. ${r3.teamName}</span><span>${(r3.players||[]).join(', ')}</span></li></ul>`;
    }
    const mEl = document.getElementById('matchDetailModal'); if(mEl) new bootstrap.Modal(mEl).show(); 
}
function fetchPlayerNames() { db.collection("players").get().then(s=>{ const l=document.getElementById('playerList'); if(!l)return; l.innerHTML=""; s.forEach(d=>l.appendChild(new Option(d.id))); }); }
function setupEnterKeys() { ['inputPlayerA','inputPlayerB','inputPlayerTournA','inputPlayerTournB','inputPlayerTournC'].forEach(id=>{ const el=document.getElementById(id); if(el) { el.addEventListener('keypress',e=>{if(e.key==='Enter'){e.preventDefault();addPlayer(id.replace('inputPlayer',''))}}); el.addEventListener('input', e => { if(e.inputType === "insertReplacementText" || e.inputType == undefined) { /* Detected dropdown click */ } }); } }); }
function addPlayer(k) { const i=document.getElementById(`inputPlayer${k}`); let v=i.value.trim(); if(!v)return; v=v.charAt(0).toUpperCase()+v.slice(1); if(selectedPlayers[k].includes(v))return alert("Added"); selectedPlayers[k].push(v); renderList(k); i.value=""; i.focus(); }
function removePlayer(k,n) { selectedPlayers[k]=selectedPlayers[k].filter(x=>x!==n); renderList(k); }
function renderList(k) { const el=document.getElementById(`listTeam${k}`); if(el) el.innerHTML=selectedPlayers[k].map(p=>`<span class="player-tag">${p}<i class="fas fa-times" onclick="removePlayer('${k}','${p}')"></i></span>`).join(''); }
window.exportToCSV = () => { let c="Date,Type,Loc,Score,TeamA,TeamB\n"; allMatches.forEach(m=>{c+=`${formatDate(m.date.toDate())},${m.type},${m.location},${m.type==='Standard'?m.teams[0].score+'-'+m.teams[1].score:'Win: '+m.teams[0].teamName},${m.teams[0].teamName},${m.teams[1].teamName}\n`}); const l=document.createElement("a"); l.href=encodeURI("data:text/csv;charset=utf-8,"+c); l.download="data.csv"; l.click(); };
window.toggleMatchType = () => { const isTourn = document.getElementById('typeTournament').checked; document.getElementById('standardSection').classList.toggle('d-none', isTourn); document.getElementById('tournamentSection').classList.toggle('d-none', !isTourn); };
