# Elderly Support League — System Status & Capabilities Report

**Current State:** Stages A, B, and C Complete · Live in Production  
**Active Branch:** `main` (Latest commit synced with GitHub Pages)  
**Database:** Cloud Firestore (`matches_v2`, `players_v2`, `locations`, `config/gemini_meta`)  
**Backend:** Firebase Cloud Functions (Node.js 22, `us-central1`)  

---

## 1. System Overview & Architecture

```mermaid
graph TD
    Client["Mobile & Web Client (GitHub Pages)"]
    Auth["Firebase Auth (Admin: can.ozturk1907@gmail.com)"]
    CF["Cloud Functions (us-central1)"]
    Gemini["Google AI Studio (Gemini 1.5 Flash)"]
    FS[("Cloud Firestore")]

    Client -->|Public Reads / Live UI| FS
    Client -->|Admin Login| Auth
    Client -->|Callable Functions| CF
    CF -->|Verify Token & Email| Auth
    CF -->|Fetch Key & Registry| FS
    CF -->|Prompt + Strict Schema| Gemini
    CF -->|Server Validation| FS
```

### Security & Access Control
- **Zero Client Key Exposure:** The Google AI Studio Gemini API key is stored securely in Firestore `config/gemini` with `allow read, write: if false;`. It is never transmitted to or readable by any web client.
- **Admin Authentication:** All administrative actions (saving matches, editing, deleting, updating AI settings, creating players/locations) are enforced by `firestore.rules` and Cloud Functions via Firebase Auth email verification (`can.ozturk1907@gmail.com`).
- **Data Integrity:** Production data runs exclusively on canonical collections `players_v2` (68 unique identities) and `matches_v2` (65 verified matches).

---

## 2. Completed Features & Functionality

### 🟢 Stage A — Core Engine & Quality Fixes
- **Full HTML Escaping & Injection Defense:** All user and player inputs are escaped via `esc()` and URL schemes are validated via `safeUrl()`.
- **Apostrophe & Special Character Handling:** Player management uses delegated DOM listeners and `data-` attributes, fully supporting names with apostrophes (e.g. `O'Brien`, `D'Angelo`) and accents.
- **Timestamp & Date Robustness:** Fixed `NaN` sorting bugs by using Firestore `Timestamp.toMillis()`. Defensive date parsing guards against corrupted documents.
- **Unified Filtering ("All Time" / Year / Month):** Leaderboard, stats summary, and individual player modals respect active filters synchronously.
- **PPG Minimum-Appearance Qualifier:** Leaderboard enforces a **10-appearance qualifier** to rank on Points-Per-Game. Unqualified players are displayed below a clean separator.
- **Venue & Match Statistics:** High-scoring games, biggest blowouts, most frequent draws, and per-venue goal/win averages (indoor vs. outdoor).

---

### 🟢 Stage B — Canonical Identity Layer & Resolver
- **Authoritative Player Registry (`players_v2`):**
  - Stable player IDs (e.g., `daniel_gomez`, `daniel_muller`, `anderson_brazil`, `javi_farres`, `javi_bernardo`).
  - Case-insensitive alias matching array (`aliases: ["dani g", "dani gomez", "daniel g"]`).
  - Matches store immutable player IDs instead of raw strings; display name updates propagate across all historical stats instantly.
- **Zero-Typo Resolver with Hard Gate:**
  - **Green Chip (Resolved):** Exact alias or high-confidence match.
  - **Amber Chip (Ambiguous):** Single high-confidence fuzzy candidate requiring 1-tap confirmation.
  - **Red Chip (Conflict / Multiple Candidates):** Forces explicit maintainer selection.
  - **New Player Dialog:** Prompts before creating a new canonical player, displaying the 3 closest existing names first to eliminate typos.
  - **Hard Gate:** The **SAVE** button is strictly disabled whenever any chip is Amber or Red.
- **Context Constraints:** Automatically prevents the same player from appearing on multiple teams in the same match.

---

### 🟢 Stage C — Mobile-First Entry & AI Magic Paste
- **AI Magic Paste (Lineup Extraction):**
  - Paste unmodified WhatsApp lineup messages directly.
  - Cloud Function `parseLineup` injects the active roster registry into Gemini, extracting match type, date, venue, team names, jersey colors, scores, and player IDs.
  - **Resilient Parsing:** Strips role markers (e.g. `Patrick (Ref)`), parses nickname initials (`Dani G` → `Daniel Gomez`, `Dani M` → `Daniel Müller`), resolves prefixes (`Antra` → `Antraniek`, `Gus` → `Gustavo`), handles standalone `Vs` delimiters, and extracts natural-language outcome sentences (`"red team won 3-2"`).
  - Unparsed lines are surfaced in a prominent warning box.
- **Roster Quick-Pick Grid:**
  - Fast tap-to-add / tap-to-remove chips for the ~26 regular players.
  - Target selector (`[+ Team A]`, `[+ Team B]` or `[+ Yellow]`, `[+ Blue]`, `[+ Red]`) enables rapid single-handed lineup assembly.
  - Live search input instantly filters occasional players.
- **Tournament Rank Buttons:** Segmented 1st / 2nd / 3rd buttons with auto-assigned 3 / 1 / 0 points and uniqueness validation.
- **Goal Calculation Fix:** Goal statistics (`GF`, `GA`, `GD`, Goals/Game) are computed exclusively on Standard matches, eliminating tournament dilution.
- **Location Management:**
  - Real-time Firestore sync with `locations` collection.
  - `[+]` Add Location button next to the dropdown allows adding new halls on the fly (e.g., `Sporthal De Pijp`).
- **Safety Safeguards:** Duplicate-match guard (date + venue collision check) and detailed Bootstrap delete confirmation modal.
- **Gemini Settings & Free-Tier Fallback Chain (Fixed):**
  - **Fallback Chain:** Single exported constant `MODEL_FALLBACK_CHAIN = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']`.
  - **Error Discrimination:** Walks fallback chain on 404 (model not found), 403 on model, or 400 (deprecated/parameter mismatch). Does NOT walk chain on 429 (rate limit) or invalid API keys.
  - **Paid-Model Guard:** `KNOWN_PAID_MODELS` list protects against Blaze billing by warning in UI on paid model selection. Zero paid models allowed in the fallback chain.
  - **Filtered Models List:** Strictly filters API models to text generation only (`generateContent`), excluding image, music (Lyria), TTS, robotics, and computer use models.
  - **Universal Parameter Compatibility:** Removed `temperature` / `top_p` / `top_k` / `thinking_level` from request generationConfig to prevent HTTP 400 failures on newer Flash models.
  - **UI Persistence & Status:** Preserves selected model across panel re-opens, displays last used model and fallback notices.

### 🟢 Stage D — Statistics & Analytics Engine
- **Elo & Power Ranking Engine (Item 16):** Chronological, deterministic (date + doc ID tiebreak) Elo ratings (Starting 1200, K=32/48, Tournament half-K=16/24). Inline provisional rating badge (`? Provisional (X/5)`) for players with < 5 appearances.
- **Nemesis & Rivalry Engine (Item 17):** Head-to-head tracking against all opponents (including tournament placement comparisons). Displays most-lost-to nemesis (`"Lost 4 of 5 to Hector"`) and duo split metrics (together vs opposed) with $\ge 3$ match threshold.
- **Streaks & Rolling Form (Item 18):** Current and all-time longest Win, Loss, and Unbeaten runs; rolling 5-match form guide badges (`W W D W L`); embedded SVG rolling 5-game PPG career trajectory chart; and Most Improved Player of the Month calculation.
- **Chemistry Matrix & Duo Leaderboards (Item 19):** Deadliest Duos (Top 10), Worst Duos (Top 10), and Most Frequent Duos with sample size visibility on every row (`"5 games together"`) and small-sample badges for 3–4 games; compact Regulars Synergy Heatmap for players with $\ge 10$ caps.
- **Attendance & Indefinite Milestones (Item 20):** Milestone badges dynamically derived for 25, 50, 75, 100, 125... Caps; attendance denominator computed strictly from player's debut date (`"12 of 18 since debut (67%)"`); Iron Men consecutive attendance runs; and One-Cap Wonders list.
- **Optimal Lineup & Curse Stat (Item 22):** Optimal 5-player lineup from eligible Elo ratings ($\ge 5$ games); The Curse Stat (player whose presence most lowers team scored goals relative to league average GF in Standard matches); The Blessed Stat; and Goal Differential (GD/game) as a distinct metric.

---

## 3. Current Data Health & Metrics

| Metric | Count / Value | Status |
| :--- | :--- | :--- |
| **Total Recorded Matches** | 67 matches (134 team records) | ✅ Fully verified in `matches_v2` (59 Standard, 8 Tournament) |
| **Canonical Player Identities** | 68 unique players | ✅ Synced in `players_v2` |
| **Active Regulars** | ~26 players (≥10 appearances) | ✅ Included in Roster Grid & Heatmap |
| **Venues Registered** | 5 active halls / fields + dynamic add | ✅ Synced in `locations` |
| **Security Rules** | Enforced on all collections | ✅ Deployed to Cloud Firestore |
| **Cloud Functions** | 4 callable endpoints (`setGeminiKey`, `testGeminiConnection`, `setGeminiModel`, `parseLineup`) | ✅ Live in `us-central1` |

---

## 4. Feature Matrix by Stage

```
Stage A — Core Fixes           [████████████████████] 100% (7/7 Complete)
Stage B — Identity Layer       [████████████████████] 100% (4/4 Complete)
Stage C — Entry Experience     [████████████████████] 100% (6/6 Complete)
Stage D — Statistics Engine    [████████████████████] 100% (6/6 Complete)
Stage E — Community Layer      [░░░░░░░░░░░░░░░░░░░░]   0% (Next up)
```

---

## 5. Next Planned Milestones (Stage E)

1. **Stage E: Community & Engagement (`stage-e-community`):**
   - **Item 32:** PWA Support (Installable Web App, `manifest.json`, Service Worker & Deep Linking).
   - **Item 25:** Weekly Power Rankings (Monday view with movement arrows vs. last week, feeding off Item 16 Elo).
   - **Item 28:** Milestone Notices ("Sam plays his 40th tonight", feeding off Item 20).
   - **Item 29:** Monthly Awards (Player of the Month, Most Improved, Iron Man, Worst Duo, Ghost of the Month).
