/*************************************************
 * ELDERLY SUPPORT LEAGUE – V9 FOUNDATION
 * Clean Architecture – GitHub Pages Compatible
 *************************************************/

/* =======================
   1. CONFIG & INIT
======================= */

const firebaseConfig = {
  apiKey: "AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc",
  authDomain: "elderly-support-league.firebaseapp.com",
  projectId: "elderly-support-league",
  storageBucket: "elderly-support-league.firebasestorage.app",
  messagingSenderId: "973119844128",
  appId: "1:973119844128:web:0205ac9cdf912fa31ef145"
};

firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();
const auth = firebase.auth();
const SUPER_ADMIN = "can.ozturk1907@gmail.com";

/* =======================
   2. GLOBAL STATE
======================= */

const STATE = {
  user: null,
  matches: [],
  currentMatch: null,
  selectedPlayers: {
    A: [], B: [],
    TournA: [], TournB: [], TournC: []
  }
};

/* =======================
   3. BOOTSTRAP
======================= */

document.addEventListener("DOMContentLoaded", () => {
  bindAuth();
  bindFilters();
  bindForms();
  loadInitialData();
});

/* =======================
   4. AUTH
======================= */

function bindAuth() {
  auth.onAuthStateChanged(user => {
    STATE.user = user;
    updateAuthUI();
  });

  document.getElementById("loginForm").addEventListener("submit", e => {
    e.preventDefault();
    auth.signInWithEmailAndPassword(
      loginEmail.value,
      loginPass.value
    ).then(() => hideModal("loginModal"))
     .catch(err => showError(err.message));
  });

  logoutBtn.addEventListener("click", () => {
    auth.signOut().then(() => hideModal("loginModal"));
  });
}

function updateAuthUI() {
  const adminTab = document.getElementById("navNewEntry");
  const email = document.getElementById("userEmailDisplay");

  if (STATE.user) {
    adminTab.classList.remove("d-none");
    loginForm.classList.add("d-none");
    userInfo.classList.remove("d-none");
    email.innerText = STATE.user.email;
  } else {
    adminTab.classList.add("d-none");
    loginForm.classList.remove("d-none");
    userInfo.classList.add("d-none");
  }
}

/* =======================
   5. DATA FETCH
======================= */

function loadInitialData() {
  fetchMatches();
  fetchPlayerNames();
  matchDate.valueAsDate = new Date();
}

function fetchMatches() {
  db.collection("matches")
    .orderBy("date", "desc")
    .onSnapshot(snapshot => {
      STATE.matches = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));
      render();
    });
}

function fetchPlayerNames() {
  db.collection("players").get().then(snap => {
    playerList.innerHTML = "";
    snap.forEach(d => playerList.appendChild(new Option(d.id)));
  });
}

/* =======================
   6. FILTERS & RENDER
======================= */

function bindFilters() {
  filterYear.addEventListener("change", render);
  filterMonth.addEventListener("change", render);
}

function render() {
  renderMatches();
  renderLeaderboard();
}

function renderMatches() {
  const year = Number(filterYear.value);
  const month = filterMonth.value;

  const list = document.getElementById("match-history-list");
  list.innerHTML = "";

  const filtered = STATE.matches.filter(m => {
    const d = m.date.toDate();
    return d.getFullYear() === year &&
      (month === "all" || d.getMonth() === Number(month));
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="text-muted text-center py-5 small">No matches found</div>`;
    return;
  }

  filtered.forEach(m => {
    list.insertAdjacentHTML("beforeend", buildMatchCard(m));
  });
}

function buildMatchCard(m) {
  const date = formatDate(m.date.toDate());
  const yt = m.youtubeLink
    ? `<a href="${m.youtubeLink}" target="_blank" onclick="event.stopPropagation()" class="yt-link-small">
         <i class="fab fa-youtube"></i> Watch
       </a>` : "";

  if (m.type === "Standard") {
    const A = m.teams[0], B = m.teams[1];
    return `
    <div class="match-card" onclick="openMatch('${m.id}')">
      <div class="card-header-strip">
        <span>${date} | ${m.location}</span>${yt}
      </div>
      <div class="card-body-strip">
        <div class="team-block">
          <div class="team-row">
            <div class="team-name">${A.teamName}</div>
            <div class="team-score">${A.score}</div>
          </div>
          <div class="team-players">${A.players.join(", ")}</div>
        </div>
        <div class="match-meta-strip"><span class="ft-badge">FT</span></div>
        <div class="team-block text-end">
          <div class="team-row justify-content-end">
            <div class="team-score me-2">${B.score}</div>
            <div class="team-name">${B.teamName}</div>
          </div>
          <div class="team-players">${B.players.join(", ")}</div>
        </div>
      </div>
    </div>`;
  }

  const winner = m.teams.find(t => t.rank === 1);
  return `
  <div class="match-card" onclick="openMatch('${m.id}')">
    <div class="card-header-strip">
      <span class="text-warning">${date} – Tournament</span>${yt}
    </div>
    <div class="p-3">
      <strong>${winner.teamName}</strong><br>
      <small>${winner.players.join(", ")}</small>
    </div>
  </div>`;
}

/* =======================
   7. LEADERBOARD
======================= */

function renderLeaderboard() {
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  const stats = {};

  STATE.matches.forEach(m => {
    if (m.type === "Standard") {
      processStats(stats, m.teams[0], m.teams[1]);
      processStats(stats, m.teams[1], m.teams[0]);
    } else {
      m.teams.forEach(t => {
        const pts = t.rank === 1 ? 3 : t.rank === 2 ? 1 : 0;
        t.players.forEach(p => {
          stats[p] ??= { name: p, played: 0, won: 0, points: 0 };
          stats[p].played++;
          stats[p].points += pts;
          if (pts === 3) stats[p].won++;
        });
      });
    }
  });

  Object.values(stats)
    .sort((a, b) => b.points - a.points)
    .forEach((p, i) => {
      tbody.insertAdjacentHTML("beforeend", `
        <tr>
          <td class="ps-3">${i + 1}</td>
          <td>${p.name}</td>
          <td class="text-center">${p.played}</td>
          <td class="text-center">${p.won}</td>
          <td class="text-center fw-bold">${p.points}</td>
        </tr>
      `);
    });
}

function processStats(stats, team, opponent) {
  const pts =
    team.score > opponent.score ? 3 :
    team.score === opponent.score ? 1 : 0;

  team.players.forEach(p => {
    stats[p] ??= { name: p, played: 0, won: 0, points: 0 };
    stats[p].played++;
    stats[p].points += pts;
    if (pts === 3) stats[p].won++;
  });
}

/* =======================
   8. UTIL
======================= */

function formatDate(d) {
  return d.toLocaleDateString("en-GB");
}

function showError(msg) {
  alert(msg);
}

function hideModal(id) {
  bootstrap.Modal.getInstance(document.getElementById(id))?.hide();
}

window.openMatch = id => {
  STATE.currentMatch = STATE.matches.find(m => m.id === id);
  openMatchModalLogic(id);
};
