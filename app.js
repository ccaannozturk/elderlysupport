/* =========================================================
   ELDERLY LEAGUE – APP.JS (CLEAN VERSION)
   ========================================================= */

/* =====================
   CONFIG
===================== */

// 🔹 Firebase Config (KENDİ BİLGİLERİNLE DEĞİŞTİR)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "XXXX",
  appId: "XXXX"
};

// 🔹 Admin Email
const ADMIN_EMAIL = "can.ozturk1907@gmail.com";

// 🔹 Fixed Logo Path
const LOGO_URL =
  "https://firebasestorage.googleapis.com/v0/b/YOUR_PROJECT.appspot.com/o/public%2Flogo.png?alt=media";

/* =====================
   INIT FIREBASE
===================== */

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

/* =====================
   STATE
===================== */

const state = {
  user: null,
  matches: [],
};

/* =====================
   DOM HELPERS
===================== */

const $ = (id) => document.getElementById(id);

/* =====================
   INIT
===================== */

document.addEventListener("DOMContentLoaded", () => {
  initLogo();
  initAuth();
  fetchMatches();
});

/* =====================
   LOGO
===================== */

function initLogo() {
  const logo = $("app-logo");
  if (logo) logo.src = LOGO_URL;
}

/* =====================
   AUTH
===================== */

function initAuth() {
  auth.onAuthStateChanged((user) => {
    state.user = user || null;
    toggleAdminUI();
  });
}

function isAdmin() {
  return state.user && state.user.email === ADMIN_EMAIL;
}

/* =====================
   UI VISIBILITY
===================== */

function toggleAdminUI() {
  const adminSection = $("admin-section");
  if (!adminSection) return;

  adminSection.style.display = isAdmin() ? "block" : "none";

  if (isAdmin()) renderAdminPanel();
}

/* =====================
   FIRESTORE – MATCHES
===================== */

function fetchMatches() {
  db.collection("matches")
    .orderBy("date", "desc")
    .onSnapshot((snapshot) => {
      state.matches = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      renderMatches();
      renderLeaderboard();
    });
}

/* =====================
   RENDER – MATCHES
===================== */

function renderMatches() {
  const container = $("matches");
  if (!container) return;

  if (state.matches.length === 0) {
    container.innerHTML = "<div class='muted'>No matches yet.</div>";
    return;
  }

  container.innerHTML = state.matches
    .map(
      (m) => `
      <div class="match-card" style="margin-bottom:12px;">
        <strong>${m.teamA} ${m.scoreA} - ${m.scoreB} ${m.teamB}</strong><br/>
        <span class="muted">${formatDate(m.date)}</span>
      </div>
    `
    )
    .join("");
}

/* =====================
   LEADERBOARD LOGIC
===================== */

function renderLeaderboard() {
  const container = $("leaderboard");
  if (!container) return;

  if (state.matches.length === 0) {
    container.innerHTML = "<div class='muted'>No data.</div>";
    return;
  }

  const stats = {};

  state.matches.forEach((m) => {
    if (!stats[m.teamA]) stats[m.teamA] = { win: 0, loss: 0 };
    if (!stats[m.teamB]) stats[m.teamB] = { win: 0, loss: 0 };

    if (m.scoreA > m.scoreB) {
      stats[m.teamA].win++;
      stats[m.teamB].loss++;
    } else {
      stats[m.teamB].win++;
      stats[m.teamA].loss++;
    }
  });

  const rows = Object.entries(stats)
    .sort((a, b) => b[1].win - a[1].win)
    .map(
      ([team, s]) => `
      <tr>
        <td>${team}</td>
        <td>${s.win}</td>
        <td>${s.loss}</td>
      </tr>
    `
    )
    .join("");

  container.innerHTML = `
    <table style="width:100%; font-size:14px;">
      <thead>
        <tr>
          <th align="left">Team</th>
          <th>W</th>
          <th>L</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* =====================
   ADMIN PANEL
===================== */

function renderAdminPanel() {
  const panel = $("admin-panel");
  if (!panel) return;

  panel.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:8px;">
      <input id="teamA" placeholder="Team A" />
      <input id="scoreA" type="number" placeholder="Score A" />
      <input id="teamB" placeholder="Team B" />
      <input id="scoreB" type="number" placeholder="Score B" />
      <button id="saveMatch">Save Match</button>
    </div>
  `;

  $("saveMatch").onclick = saveMatch;
}

/* =====================
   SAVE MATCH (ADMIN)
===================== */

function saveMatch() {
  const teamA = $("teamA").value.trim();
  const teamB = $("teamB").value.trim();
  const scoreA = Number($("scoreA").value);
  const scoreB = Number($("scoreB").value);

  if (!teamA || !teamB) {
    alert("Teams required");
    return;
  }

  db.collection("matches").add({
    teamA,
    teamB,
    scoreA,
    scoreB,
    date: new Date().toISOString(),
  });
}

/* =====================
   UTIL
===================== */

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return "-";
  }
}
