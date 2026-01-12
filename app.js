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
let currentMatchForImage = null; 
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(user => {
        currentUser = user;
        updateAuthUI();
    });

    document.getElementById('filterYear').addEventListener('change', renderData);
    document.getElementById('filterMonth').addEventListener('change', renderData);
    
    fetchMatches();
    fetchPlayerNames();
    document.getElementById('matchDate').valueAsDate = new Date();
    setupEnterKeys();
});

function updateAuthUI() {
    const navEntry = document.getElementById('navNewEntry');
    const authBtn = document.getElementById('authBtn');
    
    if (currentUser) {
        navEntry.classList.remove('d-none');
        authBtn.innerHTML = '<i class="fas fa-user-check text-success"></i>';
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('userInfo').classList.remove('d-none');
        document.getElementById('userEmailDisplay').innerText = currentUser.email;
    } else {
        navEntry.classList.add('d-none');
        authBtn.innerHTML = '<i class="fas fa-lock text-white"></i>';
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

function renderData() {
    const year = parseInt(document.getElementById('filterYear').value);
    const month = document.getElementById('filterMonth').value;
    
    const filtered = allMatches.filter(m => {
        const d = m.date.toDate();
        const yMatch = d.getFullYear() === year;
        const mMatch = month === 'all' || d.getMonth() === parseInt(month);
        return yMatch && mMatch;
    });

    const list = document.getElementById('match-history-list');
    list.innerHTML = "";
    
    if(filtered.length === 0) {
        list.innerHTML = "<div class='text-center py-5 text-muted'>No matches found.</div>";
    } else {
        filtered.forEach(m => {
            const dateStr = formatDate(m.date.toDate());
            const yt = m.youtubeLink ? `<a href="${m.youtubeLink}" target="_blank" onclick="event.stopPropagation()" class="youtube-link"><i class="fab fa-youtube text-danger me-1"></i>Watch</a>` : '';
            
            let adminBtns = "";
            if (currentUser && currentUser.email === SUPER_ADMIN) {
                adminBtns = `<div class="admin-actions">
                    <button class="btn btn-sm btn-light border text-primary" onclick="editMatch('${m.id}', event)">Edit</button> 
                    <button class="btn btn-sm btn-light border text-danger" onclick="deleteMatch('${m.id}', event)">Delete</button>
                </div>`;
            }

            let html = "";
            if(m.type === 'Standard') {
                const tA=m.teams[0], tB=m.teams[1];
                const cA=m.colors?.[0]||'blue', cB=m.colors?.[1]||'red';
                html = `
                    <div class="custom-card match-card" onclick="openMatchModal('${m.id}')">
                        <div class="match-header"><span>${dateStr} @ ${m.location}</span> ${yt}</div>
                        <div class="d-flex align-items-center justify-content-between p-3">
                            <div class="text-center w-25"><div class="badge-dot bg-${cA}"></div><span class="fw-bold d-block small">${tA.teamName||'A'}</span></div>
                            <div class="fs-2 fw-bold">${tA.score}-${tB.score}</div>
                            <div class="text-center w-25"><div class="badge-dot bg-${cB}"></div><span class="fw-bold d-block small">${tB.teamName||'B'}</span></div>
                        </div>
                        ${adminBtns}
                    </div>`;
            } else {
                const r1 = m.teams.find(t=>t.rank===1)||m.teams[0];
                html = `
                    <div class="custom-card match-card" onclick="openMatchModal('${m.id}')" style="border-left:4px solid #facc15">
                        <div class="match-header"><span>${dateStr} (Tourn)</span> ${yt}</div>
                        <div class="p-3 text-center">
                            <span class="badge bg-warning text-dark mb-1">Winner</span><br>
                            <span class="fw-bold">${r1.teamName}</span>
                        </div>
                        ${adminBtns}
                    </div>`;
            }
            list.innerHTML += html;
        });
    }

    let stats = {};
    filtered.forEach(m => {
        if(m.type === 'Standard') {
            const tA=m.teams[0], tB=m.teams[1];
            processTeamStats(stats, tA.players, tA.score, tB.score, (tA.score>tB.score?3:(tA.score==tB.score?1:0)));
            processTeamStats(stats, tB.players, tB.score, tA.score, (tB.score>tA.score?3:(tB.score==tA.score?1:0)));
        } else {
            m.teams.forEach(t => {
                const pts = t.rank===1 ? 3 : (t.rank===2 ? 1 : 0);
                processTeamStats(stats, t.players, 0, 0, pts);
            });
        }
    });

    const tbody = document.getElementById('leaderboard-body');
    tbody.innerHTML = "";
    const players = Object.values(stats).sort((a,b) => (b.points-a.points) || (b.won-a.won));

    if(players.length === 0) tbody.innerHTML = "<tr><td colspan='5' class='text-center py-3 text-muted'>No stats.</td></tr>";
    players.forEach((p, i) => {
        const icon = i===0?"🥇":(i===1?"🥈":(i===2?"🥉":i+1));
        const color = i===0?"text-warning":(i<3?"text-secondary":"text-muted");
        tbody.innerHTML += `<tr onclick="openPlayerStats('${p.name}')" style="cursor:pointer"><td class="ps-3 fw-bold ${color}">${icon}</td><td class="fw-bold">${p.name}</td><td class="text-center">${p.played}</td><td class="text-center">${p.won}</td><td class="text-center pe-3 fw-bold text-primary">${p.points}</td></tr>`;
    });
}

function processTeamStats(stats, playerArr, gf, ga, pts) {
    playerArr.forEach(name => {
        if(!stats[name]) stats[name] = { name:name, played:0, won:0, drawn:0, lost:0, points:0, form:[] };
        stats[name].played++; stats[name].points += pts;
        if(pts===3) stats[name].won++; else if(pts===1) stats[name].drawn++; else stats[name].lost++;
        stats[name].form.push(pts===3?'W':(pts===1?'D':'L'));
    });
}

// CANVAS GENERATOR (WITH LOGO)
window.downloadMatchImage = () => {
    const m = currentMatchForImage;
    if(!m) return;
    const canvas = document.getElementById('shareCanvas');
    const ctx = canvas.getContext('2d');
    const logoImg = document.getElementById('leagueLogo');
    
    // BG
    ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, 1080, 1920);
    
    // LOGO - Top Center
    if (logoImg && logoImg.complete) {
        const logoWidth = 220;
        const scale = logoWidth / logoImg.naturalWidth;
        const logoHeight = logoImg.naturalHeight * scale;
        ctx.drawImage(logoImg, 430, 80, logoWidth, logoHeight);
    }

    // Header
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 60px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("ELDERLY SUPPORT", 540, 360);
    ctx.font = "40px Inter, sans-serif"; ctx.fillStyle = "#94a3b8";
    ctx.fillText(formatDate(m.date.toDate()), 540, 430);

    // Content
    if(m.type === 'Standard') {
        const tA=m.teams[0], tB=m.teams[1];
        ctx.font = "bold 250px Inter, sans-serif"; ctx.fillStyle = "#ffffff";
        ctx.fillText(`${tA.score} - ${tB.score}`, 540, 700);
        
        ctx.font = "bold 70px Inter, sans-serif"; ctx.fillStyle = "#60a5fa";
        ctx.fillText(tA.teamName || "TEAM A", 540, 900);
        ctx.font = "40px Inter, sans-serif"; ctx.fillStyle = "#cbd5e1";
        wrapText(ctx, tA.players.join(", "), 540, 960, 900, 50);

        ctx.font = "italic 40px Inter, sans-serif"; ctx.fillStyle = "#64748b"; ctx.fillText("VS", 540, 1150);

        ctx.font = "bold 70px Inter, sans-serif"; ctx.fillStyle = "#f87171";
        ctx.fillText(tB.teamName || "TEAM B", 540, 1300);
        ctx.font = "40px Inter, sans-serif"; ctx.fillStyle = "#cbd5e1";
        wrapText(ctx, tB.players.join(", "), 540, 1360, 900, 50);

    } else {
        const r1 = m.teams.find(t=>t.rank===1);
        ctx.font = "bold 120px Inter, sans-serif"; ctx.fillStyle = "#facc15";
        ctx.fillText("WINNER", 540, 700);
        
        ctx.font = "bold 150px Inter, sans-serif"; ctx.fillStyle = "#ffffff";
        ctx.fillText(r1.teamName, 540, 900);
        
        ctx.font = "50px Inter, sans-serif"; ctx.fillStyle = "#cbd5e1";
        wrapText(ctx, r1.players.join(", "), 540, 1000, 900, 60);
    }
    
    // Footer
    ctx.font = "40px Inter, sans-serif"; ctx.fillStyle = "#475569";
    ctx.fillText("Elderly Support League", 540, 1800);

    try {
        const link = document.createElement('a');
        link.download = `Match_${formatDate(m.date.toDate()).replace(/\//g,'-')}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
    } catch(e) { alert("Image Error (CORS)."); }
};

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' '); let line = '';
    for(let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) { ctx.fillText(line, x, y); line = words[n] + ' '; y += lineHeight; }
        else { line = testLine; }
    }
    ctx.fillText(line, x, y);
}

// LOGIC REMAINS SAME
document.getElementById('addMatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!currentUser) return alert("Login needed");
    document.getElementById('loadingOverlay').classList.remove('d-none');
    
    const isEdit = document.getElementById('editMatchId').value !== "";
    const editingId = document.getElementById('editMatchId').value;
    const batch = db.batch(); // Legacy logic keeper

    try {
        // No reverse stats needed as we calc dynamic. Just overwrite doc.
        const type = document.querySelector('input[name="matchType"]:checked').value;
        const common = {
            date: new Date(document.getElementById('matchDate').value),
            location: document.getElementById('matchLocation').value,
            youtubeLink: document.getElementById('matchYoutube').value || null,
            type: type, updatedBy: currentUser.email, timestamp: firebase.firestore.FieldValue.serverTimestamp()
        };

        let matchData = { ...common };

        if(type === 'Standard') {
            const sA=parseInt(document.getElementById('scoreA').value)||0, sB=parseInt(document.getElementById('scoreB').value)||0;
            const pA=selectedPlayers.A, pB=selectedPlayers.B;
            if(!pA.length || !pB.length) throw new Error("Add players!");
            const cA=document.querySelector('input[name="colorA"]:checked').value;
            const cB=document.querySelector('input[name="colorB"]:checked').value;
            matchData.colors = [cA, cB];
            matchData.teams = [{teamName: document.getElementById('nameTeamA').value, score:sA, players:pA}, {teamName: document.getElementById('nameTeamB').value, score:sB, players:pB}];
        } else {
            const pA=selectedPlayers.TournA, pB=selectedPlayers.TournB, pC=selectedPlayers.TournC;
            if(!pA.length||!pB.length||!pC.length) throw new Error("Add players!");
            const v = (id) => parseInt(document.getElementById(id).value)||0;
            const f = {
                m1:{a:v('t_m1_a'),b:v('t_m1_b')}, m2:{a:v('t_m2_a'),c:v('t_m2_c')},
                m3:{b:v('t_m3_b'),c:v('t_m3_c')}, m4:{a:v('t_m4_a'),b:v('t_m4_b')},
                m5:{a:v('t_m5_a'),c:v('t_m5_c')}, m6:{b:v('t_m6_b'),c:v('t_m6_c')}
            };
            let t = {A:{pts:0}, B:{pts:0}, C:{pts:0}};
            // Calc internal simple ranks
            const proc = (k1,s1,k2,s2) => { if(s1>s2)t[k1].pts+=3; else if(s2>s1)t[k2].pts+=3; else {t[k1].pts++; t[k2].pts++;} };
            proc('A',f.m1.a,'B',f.m1.b); proc('A',f.m2.a,'C',f.m2.c); proc('B',f.m3.b,'C',f.m3.c);
            proc('A',f.m4.a,'B',f.m4.b); proc('A',f.m5.a,'C',f.m5.c); proc('B',f.m6.b,'C',f.m6.c);
            const ranks = ['A','B','C'].sort((x,y) => t[y].pts-t[x].pts);

            matchData.fixture = f;
            matchData.teams = [
                { teamName: document.getElementById('nameTournA').value||'Yellow', players: pA, rank: ranks.indexOf('A')+1 },
                { teamName: document.getElementById('nameTournB').value||'Blue', players: pB, rank: ranks.indexOf('B')+1 },
                { teamName: document.getElementById('nameTournC').value||'Red', players: pC, rank: ranks.indexOf('C')+1 }
            ];
        }

        const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
        await docRef.set(matchData);

        cancelEditMode();
        document.getElementById('addMatchForm').reset();
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert("Saved!");
        bootstrap.Tab.getInstance(document.querySelector('button[data-bs-target="#matches"]')).show();

    } catch (err) {
        console.error(err);
        document.getElementById('loadingOverlay').classList.add('d-none');
        alert("Error: " + err.message);
    }
});

// Helpers
document.getElementById('loginForm').addEventListener('submit', (e) => { e.preventDefault(); auth.signInWithEmailAndPassword(document.getElementById('loginEmail').value, document.getElementById('loginPass').value).then(()=>bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide()).catch(e=>alert(e.message)); });
document.getElementById('logoutBtn').addEventListener('click', ()=>auth.signOut().then(()=>bootstrap.Modal.getInstance(document.getElementById('loginModal')).hide()));

window.editMatch = (id, e) => {
    e.stopPropagation();
    const m = allMatches.find(x=>x.id===id); if(!m)return;
    new bootstrap.Tab(document.querySelector('button[data-bs-target="#admin"]')).show();
    document.getElementById('formTitle').innerText = "Edit Match";
    document.getElementById('saveBtn').innerText = "UPDATE";
    document.getElementById('saveBtn').classList.replace('btn-primary', 'btn-warning');
    document.getElementById('cancelEditBtn').classList.remove('d-none');
    document.getElementById('editMatchId').value = id;
    document.getElementById('matchDate').value = m.date.toDate().toISOString().split('T')[0];
    document.getElementById('matchLocation').value = m.location;
    document.getElementById('matchYoutube').value = m.youtubeLink||"";
    
    selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]}; ['A','B','TournA','TournB','TournC'].forEach(k=>renderList(k));

    if(m.type==='Standard') {
        document.getElementById('typeStandard').click();
        document.getElementById('nameTeamA').value=m.teams[0].teamName; document.getElementById('scoreA').value=m.teams[0].score;
        document.getElementById('nameTeamB').value=m.teams[1].teamName; document.getElementById('scoreB').value=m.teams[1].score;
        document.querySelector(`input[name="colorA"][value="${m.colors?.[0]||'blue'}"]`).checked=true;
        document.querySelector(`input[name="colorB"][value="${m.colors?.[1]||'red'}"]`).checked=true;
        m.teams[0].players.forEach(p=>selectedPlayers.A.push(p)); m.teams[1].players.forEach(p=>selectedPlayers.B.push(p));
        renderList('A'); renderList('B');
    } else {
        document.getElementById('typeTournament').click();
        const f=m.fixture||{}; Object.keys(f).forEach(k=>Object.keys(f[k]).forEach(s=>document.getElementById(`t_${k}_${s}`).value=f[k][s]));
        ['nameTournA','nameTournB','nameTournC'].forEach((id,i)=>document.getElementById(id).value=m.teams[i].teamName);
        m.teams[0].players.forEach(p=>selectedPlayers.TournA.push(p)); m.teams[1].players.forEach(p=>selectedPlayers.TournB.push(p)); m.teams[2].players.forEach(p=>selectedPlayers.TournC.push(p));
        renderList('TournA'); renderList('TournB'); renderList('TournC');
    }
};
window.deleteMatch = (id, e) => { e.stopPropagation(); if(confirm("Delete?")) db.collection("matches").doc(id).delete(); };
window.cancelEditMode = () => { document.getElementById('formTitle').innerText="New Entry"; document.getElementById('saveBtn').innerText="SAVE"; document.getElementById('saveBtn').classList.replace('btn-warning','btn-primary'); document.getElementById('cancelEditBtn').classList.add('d-none'); document.getElementById('editMatchId').value=""; document.getElementById('addMatchForm').reset(); selectedPlayers={A:[],B:[],TournA:[],TournB:[],TournC:[]}; ['A','B','TournA','TournB','TournC'].forEach(k=>renderList(k)); };
window.openMatchModal = (id) => { currentMatchForImage=allMatches.find(x=>x.id===id); openMatchModalLogic(id); }; 
function openMatchModalLogic(id) { 
    const m=allMatches.find(x=>x.id===id); 
    const body=document.getElementById('modalBody');
    const date=formatDate(m.date.toDate());
    if(m.type==='Standard') {
        const tA=m.teams[0], tB=m.teams[1];
        body.innerHTML=`<div class="text-center mb-3 text-muted">${date}</div><div class="d-flex justify-content-center align-items-center mb-4"><div class="text-center w-50"><span class="badge bg-${m.colors?.[0]||'blue'} mb-1">${tA.teamName||'A'}</span><div class="display-4 fw-bold">${tA.score}</div></div><div class="text-muted">-</div><div class="text-center w-50"><span class="badge bg-${m.colors?.[1]||'red'} mb-1">${tB.teamName||'B'}</span><div class="display-4 fw-bold">${tB.score}</div></div></div><div class="row text-center small"><div class="col-6 text-muted">${tA.players.join(', ')}</div><div class="col-6 text-muted">${tB.players.join(', ')}</div></div>`;
    } else {
        const r1=m.teams.find(t=>t.rank===1),r2=m.teams.find(t=>t.rank===2),r3=m.teams.find(t=>t.rank===3);
        body.innerHTML=`<div class="text-center mb-3 text-muted">${date} (Tourn)</div><div class="text-center mb-3"><span class="badge bg-warning text-dark mb-2">WINNER</span><h3 class="fw-bold">${r1.teamName}</h3><small class="text-muted">${r1.players.join(', ')}</small></div><ul class="list-group list-group-flush small"><li class="list-group-item d-flex justify-content-between"><span>2. ${r2.teamName}</span><span>${r2.players.join(', ')}</span></li><li class="list-group-item d-flex justify-content-between"><span>3. ${r3.teamName}</span><span>${r3.players.join(', ')}</span></li></ul>`;
    }
    new bootstrap.Modal(document.getElementById('matchDetailModal')).show(); 
}
function fetchPlayerNames() { db.collection("players").get().then(s=>{ const l=document.getElementById('playerList'); l.innerHTML=""; s.forEach(d=>l.appendChild(new Option(d.id))); }); }
function setupEnterKeys() { ['inputPlayerA','inputPlayerB','inputPlayerTournA','inputPlayerTournB','inputPlayerTournC'].forEach(id=>{ document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter'){e.preventDefault();addPlayer(id.replace('inputPlayer',''))}}); }); }
function addPlayer(k) { const i=document.getElementById(`inputPlayer${k}`); let v=i.value.trim(); if(!v)return; v=v.charAt(0).toUpperCase()+v.slice(1); if(selectedPlayers[k].includes(v))return alert("Added"); selectedPlayers[k].push(v); renderList(k); i.value=""; i.focus(); }
function removePlayer(k,n) { selectedPlayers[k]=selectedPlayers[k].filter(x=>x!==n); renderList(k); }
function renderList(k) { document.getElementById(`listTeam${k}`).innerHTML=selectedPlayers[k].map(p=>`<span class="player-tag">${p}<i class="fas fa-times ms-1 text-danger" onclick="removePlayer('${k}','${p}')" style="cursor:pointer"></i></span>`).join(''); }
window.openPlayerStats = openPlayerStats; 
window.exportToCSV = () => { let c="Date,Type,Loc,Score,TeamA,TeamB\n"; allMatches.forEach(m=>{c+=`${formatDate(m.date.toDate())},${m.type},${m.location},${m.type==='Standard'?m.teams[0].score+'-'+m.teams[1].score:'Win: '+m.teams[0].teamName},${m.teams[0].teamName},${m.teams[1].teamName}\n`}); const l=document.createElement("a"); l.href=encodeURI("data:text/csv;charset=utf-8,"+c); l.download="data.csv"; l.click(); };