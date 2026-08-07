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

if (location.hostname === 'localhost') {
    db.useEmulator('localhost', 8080);
    auth.useEmulator('http://localhost:9099');
}

let currentUser = null;
let selectedPlayers = { A: [], B: [], TournA: [], TournB: [], TournC: [] };
let allMatches = []; 
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

// SORTING STATE
let currentSortCol = 'points';
let isSortDesc = true;

function safeText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }
function esc(value) { return (value ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeUrl(url) { return /^https?:\/\//i.test(url || '') ? url : ''; }

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

    document.addEventListener('click', (e) => {
        const icon = e.target.closest('.player-tag i.fa-times');
        if(!icon) return;
        const tag = icon.closest('.player-tag');
        removePlayer(tag.dataset.team, tag.dataset.player);
    });

    const lb = document.getElementById('leaderboard-body');
    if(lb) lb.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-player]');
        if(row) window.openPlayerStats(row.dataset.player);
    });
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
            const currentSelected = parseInt(yearSelect.value);
            yearSelect.innerHTML = ''; 
            const sortedYears = Array.from(uniqueYears).sort((a, b) => b - a);
            sortedYears.forEach(year => {
                const isSelected = year === currentSelected ? 'selected' : '';
                yearSelect.innerHTML += `<option value="${year}" ${isSelected}>${year}</option>`;
            });
            if (!sortedYears.includes(currentSelected)) {
                yearSelect.value = sortedYears[0];
            }
        }
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

// SORTING LOGIC
window.sortTable = (col) => {
    if (currentSortCol === col) {
        isSortDesc = !isSortDesc; // Geriye dönük sırala
    } else {
        currentSortCol = col;
        isSortDesc = true; // Yeni sütunsa büyükten küçüğe başla (İsim hariç)
        if(col === 'name') isSortDesc = false; // İsimse A-Z başla
    }
    renderData();
};

window.parseMagicPaste = () => {
    const text = document.getElementById('magicPaste').value.trim();
    if (!text) return alert("Empty!");
    
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    if(lines.length < 4) return alert("Format error. Need at least 4 lines.");

    const headerRegex = /^(?:(\d+)[\s:-]+)?(.*?)(?:[\s:-]+(yellow|blue|red))?$/i;
    window.cancelEditMode(); 

    if (lines.length >= 6) {
        document.getElementById('typeTournament').click();
        let teamsArr = [];
        for(let i=0; i<6; i+=2) teamsArr.push({ header: lines[i], players: lines[i+1] });
        
        let assigned = { 'yellow': null, 'blue': null, 'red': null };
        let unassigned = [];
        
        teamsArr.forEach(t => {
            const match = t.header.match(headerRegex);
            let color = match && match[3] ? match[3].toLowerCase() : null;
            if(color && !assigned[color]) assigned[color] = { ...t, match };
            else unassigned.push({ ...t, match });
        });
        
        ['yellow', 'blue', 'red'].forEach(c => {
            if(!assigned[c] && unassigned.length > 0) assigned[c] = unassigned.shift();
        });
        
        const mapToForm = (tObj, suffix) => {
            if(tObj) {
                const m = tObj.match || tObj.header.match(headerRegex);
                if(m && m[1]) document.getElementById(`ptsTourn${suffix}`).value = m[1];
                document.getElementById(`nameTourn${suffix}`).value = m ? m[2].trim() : tObj.header;
                selectedPlayers[`Tourn${suffix}`] = tObj.players.split(',').map(p=> {
                    let clean = p.trim(); return clean.charAt(0).toUpperCase() + clean.slice(1);
                }).filter(p=>p);
            }
            renderList(`Tourn${suffix}`);
        };
        
        mapToForm(assigned['yellow'], 'A'); 
        mapToForm(assigned['blue'], 'B');   
        mapToForm(assigned['red'], 'C');    
        
        alert("Parsed Tournament!");
    } else {
        document.getElementById('typeStandard').click();
        const matchA = lines[0].match(headerRegex);
        if(matchA) {
            if(matchA[1]) document.getElementById('scoreA').value = matchA[1];
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
            if(matchB[1]) document.getElementById('scoreB').value = matchB[1];
            document.getElementById('nameTeamB').value = matchB[2].trim();
            const col = matchB[3] ? matchB[3].toLowerCase() : 'red';
            const rb = document.querySelector(`input[name="colorB"][value="${col}"]`);
            if(rb) rb.checked = true;
        }
        const pListB = lines[3].split(',').map(p => p.trim()).filter(p=>p);
        selectedPlayers.B = [];
        pListB.forEach(p => { selectedPlayers.B.push(p.charAt(0).toUpperCase() + p.slice(1)); });
        renderList('B');
        alert("Parsed Standard Match!");
    }
};

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
                    const pA = esc((tA.players||[]).join(', ')); const pB = esc((tB.players||[]).join(', '));

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
                
                // FIX: Sıralamaya göre değil, formdaki asıl rengine (originalKey) göre renk ver
                const getCol = (t) => { 
                    if (t.originalKey === 'A') return 'y';
                    if (t.originalKey === 'B') return 'b';
                    if (t.originalKey === 'C') return 'r';
                    // Eski veriler için yedek kurgu
                    const idx = m.teams.indexOf(t); return idx === 0 ? 'y' : (idx === 1 ? 'b' : 'r'); 
                };
                    
                    const pts1 = r1.points !== undefined ? `${r1.points} pts` : '';
                    const pts2 = r2.points !== undefined ? `${r2.points} pts` : '';
                    const pts3 = r3.points !== undefined ? `${r3.points} pts` : '';

                    html = `
                    <div class="match-card" onclick="openMatchModal('${m.id}')" style="border-left: 3px solid #ffea00;">
                        <div class="card-top"><span><i class="fas fa-trophy text-warning me-1"></i> ${dateStr} <span class="mx-2 opacity-25">|</span> ${esc(m.location)}</span> ${ytLink}</div>
                        <div class="p-3 bg-card">
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-white fw-bold"><span class="rank-badge rank-1">1</span> <span class="dot bg-${getCol(r1)}"></span> ${esc(r1.teamName)} <span class="text-warning ms-1" style="font-size:0.75rem">${pts1}</span></span></div><div style="font-size:0.75rem; color:#8b949e; margin-left:32px">${esc((r1.players||[]).join(', '))}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted"><span class="rank-badge bg-secondary">2</span> <span class="dot bg-${getCol(r2)}"></span> ${esc(r2.teamName)} <span class="text-muted ms-1" style="font-size:0.75rem">${pts2}</span></span></div><div style="font-size:0.75rem; color:#666; margin-left:32px">${esc((r2.players||[]).join(', '))}</div></div>
                            <div class="tourn-row"><div class="d-flex justify-content-between"><span class="text-muted opacity-50"><span class="rank-badge bg-secondary">3</span> <span class="dot bg-${getCol(r3)}"></span> ${esc(r3.teamName)} <span class="text-muted opacity-50 ms-1" style="font-size:0.75rem">${pts3}</span></span></div><div style="font-size:0.75rem; color:#555; margin-left:32px">${esc((r3.players||[]).join(', '))}</div></div>
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
            processTeamStats(stats, tA.players||[], tA.score, tB.score, ptsA);
            processTeamStats(stats, tB.players||[], tB.score, tA.score, ptsB);
        } else {
            m.teams.forEach(t => {
                const pts = t.points !== undefined ? t.points : (t.rank===1 ? 3 : (t.rank===2 ? 1 : 0));
                processTeamStats(stats, t.players||[], 0, 0, pts);
            });
        }
    });

    const tbody = document.getElementById('leaderboard-body');
    if(tbody) {
        tbody.innerHTML = "";
        
        // SORTING ENGINE (DİNAMİK)
        const players = Object.values(stats).sort((a,b) => {
            let valA = a[currentSortCol];
            let valB = b[currentSortCol];
            
            // Eğer sütun PPG ise hesapla
            if(currentSortCol === 'ppg') { valA = a.points/a.played; valB = b.points/b.played; }
            if(currentSortCol === 'name') {
                return isSortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
            }
            
            if (valA === valB) return b.won - a.won; // Beraberlik bozucu
            return isSortDesc ? valB - valA : valA - valB;
        });

        if(players.length === 0) tbody.innerHTML = "<tr><td colspan='8' class='text-center py-4 text-muted small'>No stats available.</td></tr>";
        
        players.forEach((p, i) => {
            const rowClass = i%2===0 ? "" : "bg-white bg-opacity-5"; 
            const ppg = (p.points / p.played).toFixed(2);
            tbody.innerHTML += `<tr data-player="${esc(p.name)}" style="cursor:pointer" class="${rowClass}">
                <td class="ps-3 fw-bold text-start"><span class="rank-circle ${i===0&&currentSortCol==='points'&&isSortDesc?'r-1':''}">${i+1}</span></td>
                <td class="fw-bold text-light text-start">${esc(p.name)}</td>
                <td class="text-muted">${p.played}</td>
                <td class="text-muted">${p.won}</td>
                <td class="text-muted">${p.drawn}</td>
                <td class="text-muted">${p.lost}</td>
                <td class="fw-bold text-white">${p.points}</td>
                <td class="pe-3 fw-bold text-info">${ppg}</td>
            </tr>`;
        });
    }

    // --- YENİ STATS (INSIGHTS) EKRANINI OLUŞTUR ---
    generateInsights(filtered);
}

function processTeamStats(stats, playerArr, gf, ga, pts) {
    if(!playerArr) return; 
    playerArr.forEach(name => {
        if(!stats[name]) stats[name] = { name:name, played:0, won:0, drawn:0, lost:0, gf:0, ga:0, gd:0, points:0, form:[] };
        stats[name].played++; 
        stats[name].points += pts;
        stats[name].gf += gf;
        stats[name].ga += ga;
        stats[name].gd = stats[name].gf - stats[name].ga;
        
        if(pts >= 3) stats[name].won++; 
        else if(pts === 1) stats[name].drawn++; 
        else if(pts === 0) stats[name].lost++;
    });
}

// KOMBİNASYON YARDIMCISI (İkili/Üçlü Bulmak İçin)
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

// --- V12.4+: INSIGHTS ENGINE (FUN FACTS + COLOR WIN RATES) ---
function generateInsights(matches) {
    let duos = {}, trios = {}, fullTeams = {};
    let colorStats = { 'yellow': {p:0, w:0}, 'blue': {p:0, w:0}, 'red': {p:0, w:0} };
    
    matches.forEach(m => {
        if (!m.teams || m.teams.length < 2) return;
        
        m.teams.forEach(t => {
            let isWin = false;
            let pts = 0;
            let color = '';
            
            if(m.type === 'Standard') {
                const isA = t === m.teams[0];
                const myS = isA ? m.teams[0].score : m.teams[1].score;
                const opS = isA ? m.teams[1].score : m.teams[0].score;
                if(myS > opS) { isWin = true; pts = 3; }
                else if (myS == opS) pts = 1;
                
                color = isA ? (m.colors?.[0]||'blue') : (m.colors?.[1]||'red');
            } else {
                pts = t.points !== undefined ? t.points : (t.rank===1 ? 3 : (t.rank===2 ? 1 : 0));
                if(pts >= 3) isWin = true;
                
                if(t.originalKey) color = t.originalKey === 'A' ? 'yellow' : (t.originalKey === 'B' ? 'blue' : 'red');
                else color = (t.teamName||'').toLowerCase().includes('y') ? 'yellow' : ((t.teamName||'').toLowerCase().includes('b') ? 'blue' : 'red');
            }
            
            // Renk İstatistiğini Kaydet
            if(colorStats[color]) {
                colorStats[color].p++;
                if(isWin) colorStats[color].w++;
            }
            
            const players = (t.players || []).sort();
            if(players.length === 0) return;
            
            const teamKey = players.join(', ');
            if(!fullTeams[teamKey]) fullTeams[teamKey] = {p:0, w:0, pts:0};
            fullTeams[teamKey].p++; fullTeams[teamKey].pts+=pts; if(isWin) fullTeams[teamKey].w++;
            
            if(players.length >= 2) {
                getCombinations(players, 2).forEach(c => {
                    const key = c.join(' & ');
                    if(!duos[key]) duos[key] = {p:0, w:0, pts:0};
                    duos[key].p++; duos[key].pts+=pts; if(isWin) duos[key].w++;
                });
            }
            if(players.length >= 3) {
                getCombinations(players, 3).forEach(c => {
                    const key = c.join(', ');
                    if(!trios[key]) trios[key] = {p:0, w:0, pts:0};
                    trios[key].p++; trios[key].pts+=pts; if(isWin) trios[key].w++;
                });
            }
        });
    });

    const minMatches = 3; 
    const validDuos = Object.entries(duos).filter(e => e[1].p >= minMatches).map(e => ({name:e[0], ...e[1], wr: e[1].w/e[1].p}));
    const validTrios = Object.entries(trios).filter(e => e[1].p >= minMatches).map(e => ({name:e[0], ...e[1], wr: e[1].w/e[1].p}));
    const validTeams = Object.entries(fullTeams).filter(e => e[1].p >= 2).map(e => ({name:e[0], ...e[1], wr: e[1].w/e[1].p}));
    
    validDuos.sort((a,b) => b.wr - a.wr || b.p - a.p);
    validTrios.sort((a,b) => b.wr - a.wr || b.p - a.p);
    validTeams.sort((a,b) => b.wr - a.wr || b.p - a.p);

    const container = document.getElementById('insightsContainer');
    if(!container) return;

    if(validDuos.length === 0 && colorStats['blue'].p === 0) {
        container.innerHTML = `<div class="text-center py-5 text-muted small"><i class="fas fa-ghost fs-1 mb-3 d-block opacity-25"></i>Not enough data for insights yet.<br>Play a few more matches!</div>`;
        return;
    }

    // Renkleri UI'a Dönüştür
    const colMap = { 'yellow': 'text-warning', 'blue': 'text-primary', 'red': 'text-danger' };
    let colorsHtml = Object.entries(colorStats).filter(c => c[1].p > 0).sort((a,b) => (b[1].w/b[1].p) - (a[1].w/a[1].p)).map(c => {
        const wr = Math.round(c[1].w/c[1].p * 100);
        return `<div class="col p-1"><div class="border border-secondary rounded p-2 text-center bg-dark"><div class="fw-bold ${colMap[c[0]]} small">${c[0].toUpperCase()}</div><div class="fw-bold text-white fs-6">${wr}%</div><div style="font-size:0.6rem" class="text-muted mt-1">${c[1].w}W - ${c[1].p}P</div></div></div>`;
    }).join('');

    const bestDuo = validDuos.length > 0 ? validDuos[0] : null;
    const worstDuo = validDuos.length > 0 ? validDuos[validDuos.length-1] : null;
    const bestTrio = validTrios.length > 0 ? validTrios[0] : null;
    const worstTrio = validTrios.length > 0 ? validTrios[validTrios.length-1] : null;
    const bestTeam = validTeams.length > 0 ? validTeams[0] : null;

    const renderCard = (title, icon, color, data, desc) => {
        if(!data) return '';
        return `
        <div class="col-12 col-md-6 mb-2">
            <div class="p-3 border border-secondary rounded bg-dark h-100 position-relative overflow-hidden">
                <i class="fas ${icon} position-absolute opacity-10" style="font-size: 5rem; right: -10px; bottom: -10px;"></i>
                <div class="text-${color} fw-bold mb-2"><i class="fas ${icon} me-2"></i>${title}</div>
                <div class="text-white fw-bold fs-6 mb-1">${esc(data.name)}</div>
                <div class="text-muted small">${Math.round(data.wr*100)}% Win Rate (${data.w}W - ${data.p}P)</div>
                <div class="text-muted small mt-2 border-top border-secondary pt-2" style="font-size:0.7rem"><i>${desc}</i></div>
            </div>
        </div>`;
    };

    let html = `<h6 class="small fw-bold text-muted mb-2 px-1">WIN RATE BY COLOR</h6>`;
    html += `<div class="row g-1 mb-4 px-1">${colorsHtml}</div>`;
    html += `<h6 class="small fw-bold text-muted mb-2 px-1">TOP TEAM COMBINATIONS</h6>`;
    html += `<div class="row g-2 px-1">`;
    html += renderCard('UNSTOPPABLE DUO', 'fa-fire', 'warning', bestDuo, 'They carry the team.');
    html += renderCard('TERRIBLE DUO', 'fa-skull-crossbones', 'danger', worstDuo, 'Maybe play on different teams next time.');
    html += renderCard('DREAM TRIO', 'fa-star', 'info', bestTrio, 'The holy trinity.');
    html += renderCard('TRAGIC TRIO', 'fa-dumpster-fire', 'danger', worstTrio, 'A complete disaster together.');
    html += renderCard('BEST EXACT ROSTER', 'fa-trophy', 'success', bestTeam, 'The most dominant complete lineup.');
    html += `</div>`;
    
    container.innerHTML = html;
}

window.openPlayerStats = (name) => {
    const year = parseInt(document.getElementById('filterYear').value);
    const pMatches = allMatches.filter(m => {
        if(!m.teams) return false;
        const t = m.teams.find(t => (t.players||[]).includes(name));
        return t && m.date.toDate().getFullYear() === year;
    }).sort((a,b) => b.date.toMillis() - a.date.toMillis());

    if(pMatches.length === 0) return;

    let w=0, played=0, pts=0, totalGF=0, totalGA=0;
    let monthly = {}, recentForm = [];
    let teammates = {}; 
    let colorStats = { 'yellow': {p:0, w:0}, 'blue': {p:0, w:0}, 'red': {p:0, w:0} };

    pMatches.forEach(m => {
        played++;
        const monthIdx = m.date.toDate().getMonth();
        if(!monthly[monthIdx]) monthly[monthIdx] = {p:0, w:0, pts:0};
        
        let matchPts=0, result='L', matchGF=0, matchGA=0, myColor='';
        let myTeamMates = [];

        if(m.type==='Standard') {
            const tA=m.teams[0]; const inA=(tA.players||[]).includes(name);
            const myS=inA?tA.score:m.teams[1].score;
            const opS=inA?m.teams[1].score:tA.score;
            matchGF = myS; matchGA = opS;
            myColor = inA ? (m.colors?.[0]||'blue') : (m.colors?.[1]||'red');
            myTeamMates = inA ? tA.players : m.teams[1].players;
            
            if(myS>opS) {w++; matchPts=3; result='W';} else if(myS==opS) {matchPts=1; result='D';}
        } else {
            const myTeam = m.teams.find(t=>(t.players||[]).includes(name));
            myTeamMates = myTeam.players || [];
            matchPts = myTeam.points !== undefined ? myTeam.points : (myTeam.rank===1 ? 3 : (myTeam.rank===2 ? 1 : 0));
            
            let ogKey = myTeam.originalKey || ''; 
            if(ogKey) myColor = ogKey === 'A' ? 'yellow' : (ogKey === 'B' ? 'blue' : 'red');
            else myColor = (myTeam.teamName||'').toLowerCase().includes('y') ? 'yellow' : ((myTeam.teamName||'').toLowerCase().includes('b') ? 'blue' : 'red');

            if(matchPts >= 3) {w++; result='W';} else if(matchPts === 1) {result='D';} else {result='L';}
        }

        myTeamMates.forEach(mate => {
            if(mate !== name) {
                if(!teammates[mate]) teammates[mate] = {p:0, w:0};
                teammates[mate].p++;
                if(result === 'W') teammates[mate].w++;
            }
        });

        if(colorStats[myColor]) {
            colorStats[myColor].p++;
            if(result === 'W') colorStats[myColor].w++;
        }

        pts += matchPts; totalGF += matchGF; totalGA += matchGA;
        monthly[monthIdx].p++; monthly[monthIdx].pts += matchPts; if(result==='W') monthly[monthIdx].w++;
        if(recentForm.length < 5) recentForm.push(result);
    });

    const winRate = Math.round((w/played)*100);
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
        <h6 class="small fw-bold text-muted mb-2">WIN RATE BY COLOR</h6>
        <div class="row g-1 mb-4">${colorsHtml}</div>
        <h6 class="small fw-bold text-muted mb-2">MOST PLAYED WITH</h6>
        <div class="bg-dark p-2 rounded border border-secondary mb-4">${matesHtml}</div>
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
            
            const ptsA = parseInt(document.getElementById('ptsTournA').value) || 0;
            const ptsB = parseInt(document.getElementById('ptsTournB').value) || 0;
            const ptsC = parseInt(document.getElementById('ptsTournC').value) || 0;
            
            let tArr = [
                {teamName: document.getElementById('nameTournA').value || 'Yellow', players: pA, points: ptsA, originalKey: 'A'},
                {teamName: document.getElementById('nameTournB').value || 'Blue', players: pB, points: ptsB, originalKey: 'B'},
                {teamName: document.getElementById('nameTournC').value || 'Red', players: pC, points: ptsC, originalKey: 'C'}
            ];
            
            tArr.sort((a,b) => b.points - a.points);
            tArr.forEach((t, i) => t.rank = i + 1);
            matchData.teams = tArr;
        }
        
        const docRef = isEdit ? db.collection("matches").doc(editingId) : db.collection("matches").doc();
        await docRef.set(matchData);
        const allNames = matchData.teams.flatMap(t => t.players || []);
        const rosterBatch = db.batch();
        allNames.forEach(n => rosterBatch.set(db.collection("players").doc(n), {}, {merge: true}));
        if(allNames.length) await rosterBatch.commit();
        fetchPlayerNames();
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
        if(m.teams && m.teams.length >= 3) {
            const tY = m.teams.find(t=>t.originalKey==='A') || m.teams[0];
            const tB = m.teams.find(t=>t.originalKey==='B') || m.teams[1];
            const tR = m.teams.find(t=>t.originalKey==='C') || m.teams[2];
            
            document.getElementById('nameTournA').value=tY.teamName; 
            document.getElementById('ptsTournA').value=tY.points || 0;
            (tY.players||[]).forEach(p=>selectedPlayers.TournA.push(p));
            
            document.getElementById('nameTournB').value=tB.teamName; 
            document.getElementById('ptsTournB').value=tB.points || 0;
            (tB.players||[]).forEach(p=>selectedPlayers.TournB.push(p));
            
            document.getElementById('nameTournC').value=tR.teamName; 
            document.getElementById('ptsTournC').value=tR.points || 0;
            (tR.players||[]).forEach(p=>selectedPlayers.TournC.push(p));
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
        body.innerHTML=`<div class="text-center mb-3 text-muted small letter-spacing-1">${date}</div><div class="d-flex justify-content-center align-items-center mb-4"><div class="text-center w-50"><span class="badge bg-${m.colors?.[0]||'blue'} mb-1">${esc(tA.teamName||'A')}</span><div class="display-4 fw-bold text-white">${tA.score}</div></div><div class="text-muted">-</div><div class="text-center w-50"><span class="badge bg-${m.colors?.[1]||'red'} mb-1">${esc(tB.teamName||'B')}</span><div class="display-4 fw-bold text-white">${tB.score}</div></div></div><div class="row text-center small text-light"><div class="col-6">${esc((tA.players||[]).join(', '))}</div><div class="col-6">${esc((tB.players||[]).join(', '))}</div></div>`;
    } else {
        const r1=m.teams.find(t=>t.rank===1),r2=m.teams.find(t=>t.rank===2),r3=m.teams.find(t=>t.rank===3);
        const pts1 = r1.points !== undefined ? `(${r1.points} pts)` : '';
        const pts2 = r2.points !== undefined ? `(${r2.points} pts)` : '';
        const pts3 = r3.points !== undefined ? `(${r3.points} pts)` : '';
        
        body.innerHTML=`<div class="text-center mb-3 text-muted small">${date} (Tourn)</div><div class="text-center mb-3"><span class="badge bg-warning text-dark mb-2">WINNER</span><h3 class="fw-bold text-white">${esc(r1.teamName)} <span class="text-warning fs-6">${pts1}</span></h3><small class="text-light">${esc((r1.players||[]).join(', '))}</small></div><ul class="list-group list-group-flush bg-dark small"><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>2. ${esc(r2.teamName)} <span class="text-muted">${pts2}</span></span><span>${esc((r2.players||[]).join(', '))}</span></li><li class="list-group-item bg-dark text-white d-flex justify-content-between"><span>3. ${esc(r3.teamName)} <span class="text-muted">${pts3}</span></span><span>${esc((r3.players||[]).join(', '))}</span></li></ul>`;
    }
    const mEl = document.getElementById('matchDetailModal'); if(mEl) new bootstrap.Modal(mEl).show(); 
}

function fetchPlayerNames() { db.collection("players").get().then(s=>{ const l=document.getElementById('playerList'); if(!l)return; l.innerHTML=""; s.forEach(d=>l.appendChild(new Option(d.id))); }); }
function setupEnterKeys() { ['inputPlayerA','inputPlayerB','inputPlayerTournA','inputPlayerTournB','inputPlayerTournC'].forEach(id=>{ const el=document.getElementById(id); if(el) { el.addEventListener('keypress',e=>{if(e.key==='Enter'){e.preventDefault();addPlayer(id.replace('inputPlayer',''))}}); el.addEventListener('input', e => { const listId = el.getAttribute('list'); const listEl = document.getElementById(listId); if (listEl) { const options = Array.from(listEl.options).map(opt => opt.value); if (options.includes(el.value.trim())) { addPlayer(id.replace('inputPlayer','')); } } }); } }); }
function addPlayer(k) { const i=document.getElementById(`inputPlayer${k}`); let v=i.value.trim(); if(!v)return; v=v.charAt(0).toUpperCase()+v.slice(1); if(selectedPlayers[k].includes(v))return alert("Added"); selectedPlayers[k].push(v); renderList(k); i.value=""; i.focus(); }
function removePlayer(k,n) { selectedPlayers[k]=selectedPlayers[k].filter(x=>x!==n); renderList(k); }
function renderList(k) { const el=document.getElementById(`listTeam${k}`); if(el) el.innerHTML=selectedPlayers[k].map(p=>`<span class="player-tag" data-team="${k}" data-player="${esc(p)}">${esc(p)}<i class="fas fa-times"></i></span>`).join(''); }

window.exportToCSV = () => {
    let csvContent = "\uFEFF";
    csvContent += "Date,Type,Location,Score,Team A,Players A,Team B,Players B,Team C,Players C\n";
    allMatches.forEach(m => {
        const date = formatDate(m.date.toDate());
        const type = m.type;
        const esc = (text) => `"${(text || "").toString().replace(/"/g, '""')}"`;
        const loc = esc(m.location);
        let score = "", tA = "", pA = "", tB = "", pB = "", tC = "", pC = "";

        if (type === 'Standard') {
            const teamA = m.teams[0]; const teamB = m.teams[1];
            score = esc(`${teamA.score}-${teamB.score}`);
            tA = esc(teamA.teamName); pA = esc((teamA.players || []).join(", "));
            tB = esc(teamB.teamName); pB = esc((teamB.players || []).join(", "));
        } else {
            const sorted = [...m.teams].sort((a,b) => a.rank - b.rank);
            score = esc("Tournament"); 
            if(sorted[0]) { tA = esc(`1. ${sorted[0].teamName} (${sorted[0].points}pts)`); pA = esc((sorted[0].players || []).join(", ")); }
            if(sorted[1]) { tB = esc(`2. ${sorted[1].teamName} (${sorted[1].points}pts)`); pB = esc((sorted[1].players || []).join(", ")); }
            if(sorted[2]) { tC = esc(`3. ${sorted[2].teamName} (${sorted[2].points}pts)`); pC = esc((sorted[2].players || []).join(", ")); }
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
window.toggleMatchType = () => { const isTourn = document.getElementById('typeTournament').checked; document.getElementById('standardSection').classList.toggle('d-none', isTourn); document.getElementById('tournamentSection').classList.toggle('d-none', !isTourn); };
