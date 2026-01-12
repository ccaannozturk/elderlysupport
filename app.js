// 1. Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyA7_V8m4sKxU-gGffeV3Uoa-deDieeu9rc",
    authDomain: "elderly-support-league.firebaseapp.com",
    projectId: "elderly-support-league",
    storageBucket: "elderly-support-league.firebasestorage.app",
    messagingSenderId: "973119844128",
    appId: "1:973119844128:web:0205ac9cdf912fa31ef145",
    measurementId: "G-101F2P233G"
};

// 2. Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

console.log("Firebase connected! Ready to rock, Captain.");

// 3. Global Variables & Helpers
const leaderboardBody = document.getElementById('leaderboard-body');
const matchHistoryList = document.getElementById('match-history-list');

// 4. Load Leaderboard (Real-time listener)
function loadLeaderboard() {
    // Veritabanında 'players' koleksiyonunu dinle
    // Puanı yüksekten düşüğe sırala
    db.collection("players").orderBy("stats.points", "desc").onSnapshot((snapshot) => {
        leaderboardBody.innerHTML = ""; // Tabloyu temizle
        let rank = 1;

        if(snapshot.empty) {
            leaderboardBody.innerHTML = "<tr><td colspan='8' class='text-center'>No players found yet. Add a match!</td></tr>";
            return;
        }

        snapshot.forEach((doc) => {
            const player = doc.data();
            const s = player.stats;
            
            // Satır oluştur
            const row = `
                <tr>
                    <td>${rank++}</td>
                    <td class="fw-bold">${player.name}</td>
                    <td>${s.played}</td>
                    <td>${s.won}</td>
                    <td>${s.drawn}</td>
                    <td>${s.lost}</td>
                    <td>${s.gf - s.ga}</td>
                    <td class="fw-bold text-primary">${s.points}</td>
                </tr>
            `;
            leaderboardBody.innerHTML += row;
        });
    });
}

// UI Helpers
function toggleMatchType() {
    // Turnuva veya Standart maç seçimine göre arayüz değişecek (Sonra kodlayacağız)
    console.log("Toggle match type clicked");
}

// Sayfa Yüklendiğinde
document.addEventListener('DOMContentLoaded', () => {
    loadLeaderboard(); // Liderlik tablosunu getirmeyi dene
    
    // Form submit olayını şimdilik sadece konsola basalım
    document.getElementById('addMatchForm').addEventListener('submit', (e) => {
        e.preventDefault();
        alert("Bağlantı başarılı ustam! Sonraki adımda kayıt fonksiyonunu yazacağız.");
    });
});