# Elderly Support League 🏆

A comprehensive, real-time match tracking and leaderboard management system designed for the "Elderly Support League" (Est. 2020, Amsterdam). This single-page application (SPA) allows players to track their match history, view detailed individual statistics, and monitor the global leaderboard, while providing a secure admin dashboard for seamless data entry.

## ✨ Key Features

* **📊 Dynamic Leaderboard:** Automatically calculates player rankings, points (3 for a win/1st place, 1 for a draw/2nd place), win rates, and goals based on match history.
* **🗓️ Match History & Filters:** View past matches with support for both **Standard (1v1 / Team vs Team)** and **Tournament (3-way)** formats. Filter results by Year and Month.
* **📈 Advanced Player Stats:** Interactive modals displaying individual player forms (last 5 matches), total goals scored/conceded, win percentages, and monthly breakdowns.
* **🔒 Secure Admin Panel:** Firebase Authentication integration. Authorized admins can:
    * Add, edit, or delete matches.
    * Use the **"Magic Paste"** feature to auto-fill match data from raw text formats.
    * Manage team colors and rosters easily with a dynamic datalist.
* **📥 Export to CSV:** One-click export of all match data to an Excel-compatible CSV file (with UTF-8 BOM support).
* **📱 Fully Responsive:** Built with Bootstrap 5, ensuring a seamless experience on both desktop and mobile devices.

## 🛠️ Tech Stack

* **Frontend:** HTML5, CSS3, Vanilla JavaScript (ES6+)
* **UI Framework:** Bootstrap 5 (Custom Dark Theme)
* **Icons & Fonts:** FontAwesome 6, Google Fonts (Inter)
* **Backend & Database:** Firebase (Firestore & Firebase Auth)

## 🚀 How to Run Locally

1.  Clone this repository to your local machine:
    ```bash
    git clone [https://github.com/ccaannozturk/elderly-support-league.git](https://github.com/ccaannozturk/elderly-support-league.git)
    ```
2.  Open the project folder.
3.  Since the project uses Firebase via CDN and standard web technologies, no Node.js or build tools are required. Simply open `index.html` in any modern web browser.

## 🔐 Admin Access

Admin features are hidden by default. To access the dashboard:
1. Click the "Lock" icon in the top right corner.
2. Log in with authorized super admin credentials.
3. The "Admin" tab will appear in the main navigation.

---
*Designed and developed by [Can Öztürk](https://github.com/ccaannozturk).*
