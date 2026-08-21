# Implementation Plan

Status key: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**This plan supersedes the original 26-item / five-stage plan (Stages A–E).** That
plan is complete and its history is in git. Everything below is the current agreed
scope, agreed 2026-08-21 after a review of the Community tab, the chemistry matrix,
the optimal-lineup layout and the Roast Studio.

### Note on the old "out of scope" list

The previous plan listed "AI roast / hype generator" as considered and declined.
A full Roast Studio and fixture/prediction lifecycle shipped anyway in commit
`eebfc29` (Item 42). The declined-list entry is therefore withdrawn — the roast
feature is in the product and is maintained like any other. The remaining declined
items still stand: canvas recap cards, prediction league, YouTube auto-embed,
fantasy draft, Team Name Hall of Fame, second Firestore database, soft delete,
per-tournament goal capture.

---

## Phase 1 — Blockers  ✅ complete

All six are bugs, not features. Items 1 and 2 together are the entire cause of
"Community month selector never populates names".

- [x] **1. `matchesFilter` year type coercion**
  - `matchesFilter()` compares `d.getFullYear() === year` strictly. `renderData()`
    passes a number; `renderCommunityTab()` passes a string (`fYear.value`), so
    `2026 === '2026'` is false and **every** month of awards computes over zero
    matches and renders "No fixtures played in this month."
  - Coerce inside `matchesFilter` so both call styles work. Audit all three call
    sites. Guard against a missing/malformed `m.date` while there — the function
    calls `.toDate()` unguarded.

- [x] **2. Preserve awards collapse state across re-render**
  - The month `<select>`'s `onchange` re-renders the whole community container,
    re-emitting the awards body as `class="collapse"` (closed). Selecting a month
    therefore snaps the panel shut even once item 1 is fixed.
  - Keep the panel open across re-render and return focus to the select.

- [x] **3. Derive `curYear` from data**
  - `renderCommunityTab()` hardcodes `'2026'` when the year filter is "All Time".
    Take the latest year present in the match data instead, so this keeps working
    as seasons accumulate.

- [x] **4. Roast / fixture listeners are denied for the public**
  - `firestore.rules` gates `roasts` and `fixtures` per document
    (`resource.data.status == 'published'` / `!= 'draft'`). Firestore rules are not
    filters: an **unconstrained** collection listen cannot be proven safe and is
    rejected outright for every non-admin visitor. `fetchRoasts()` and
    `fetchFixtures()` both listen unconstrained, and swallow the resulting
    `permission-denied` into `console.warn` — so the Roast and Next Game cards are
    silently invisible to everyone except the admin.
  - Public listener: constrained query. Admin listener: unconstrained, opened only
    after auth resolves (both are currently started at `DOMContentLoaded`, before
    `onAuthStateChanged` fires).
  - Surface a real error state instead of only warning to the console.
  - **May require a `firestore.rules` change. Edit only — the maintainer deploys.**

- [x] **5. Roast publish button breaks on apostrophes**
  - `publishRoastVariant('${esc(v.text)}', this)` — `esc()` escapes HTML, not JS
    string delimiters. Any roast containing `'` (i.e. most of them) produces a
    broken `onclick` and the Publish button silently does nothing.
  - Same fix as Stage A item 3: `data-` attributes plus a delegated listener.

- [x] **6. Latest roast by `publishedAt`**
  - "Roast of the Week" picks `publishedRoasts[length - 1]`, which is the last
    document in **ID order**, not the newest. Sort by `publishedAt` descending.

---

## Phase 2 — Mobile layout  ✅ complete

- [x] **7. Optimal 5-player lineup grid**
  - Five tiles render as `<div class="col">` in a `.row`. Bootstrap's `.col` is
    `flex: 1 0 0%` with auto min-width, so tile content (rank badge, 4-digit Elo,
    caps line) sets a ~70px floor. On a 360px Android viewport the line overflows,
    the row wraps, and the 5th tile lands alone stretched edge-to-edge.
  - Replace with a CSS grid: phones get #1 as a full-width hero and #2–#5 as 2×2;
    ≥576px returns to five equal columns. Add `min-width: 0` so `text-truncate`
    actually engages.
  - Note: `index.html` currently contains **no `@media` queries at all**.

- [x] **8. Sweep for the same overflow pattern**
  - Audited every tab at 360px for orphan-wrapped rows, elements painted outside
    the viewport, and clipped truncated text. The lineup was the only orphan-row
    instance; page-level horizontal overflow was already zero everywhere.
  - Found and fixed two real defects:
    - **Match cards could hide a whole team.** `.card-body-strip` is a flex row
      and `.team-block` had the default `min-width: auto`, so a team name with no
      spaces ("MalazIsShitAtFreeKicksButIPickedHimAnyway") refused to shrink,
      pushed the strip 197px past the card, and `.match-card { overflow: hidden }`
      clipped that team's name and all seven players into unreachable space. One
      of 65 cards was affected today, and any future long name would do the same
      silently. Fixed with `min-width: 0` plus `overflow-wrap: anywhere`.
    - **Venue cards truncated three of five names** ("Sporthal ROC Europaboul…").
      They now wrap, with `h-100` keeping a row level.
  - Known false positive to ignore on re-runs: the leaderboard table reports ~313
    elements past the viewport. It sits in `.card.overflow-auto` and scrolls
    horizontally by design; verified by walking its ancestor chain.
  - Cost of the match-card fix, measured: 9 team names that previously fit on one
    line now take two (109 of 114 wrap, versus 100 before). Worst case is
    unchanged at 4 lines, and nothing is hidden any more. See item 14.

---

## Phase 3 — Awards honesty  ✅ complete

- [x] **9. Provisional / low-sample tier**
  - `computeMonthlyAwards()` already has resilient fallback tiers (relaxed
    qualifier, then best-available-unqualified). They were simply never reached
    because of Phase 1 item 1.
  - Replaced the ad-hoc two-step fallbacks with an explicit tiered selector.
    Each award now reports which threshold produced it:
    `qualified` (intended threshold met, no caveat) · `relaxed` (threshold
    lowered to fit a short month) · `best` (no threshold left, showing the best
    available). The first non-empty tier wins.
  - A card from a lowered tier carries a `PROVISIONAL` badge and a one-line
    caveat naming the threshold that moved ("Nobody reached 3 appearances in
    August — qualifier lowered to 1"). A month under 4 matches also gets one
    banner stating the sample size.
  - Most Improved no longer dresses a decline up as improvement: when nobody beat
    their career rate it says so and relabels the card "Closest to their career
    baseline this month".
  - The genuinely empty cases now explain themselves instead of going blank
    ("Every player on record turned out for the one match in August").
  - Verified: all 8 months of 2026 select at `qualified` with **zero** badges or
    notes, so healthy months gain no noise; forced 1-, 2- and 3-match months
    degrade through the tiers with correct caveats and never render an empty
    POTM or Iron Men card.
  - Also fixed "Attended all 1 matches" / "0 wins in 1 games" pluralisation.

---

## Phase 4 — Chemistry matrix interactivity  ✅ complete

Today: a static 26×26 all-time table, fixed min-3-games threshold, `title=`
tooltips that do not exist on touch. Everything below derives from
`chemData.allDuos`, which is already computed — no new data entry, no new reads.

- [x] **10. Min-games slider and metric toggle**
  - Threshold 1 / 3 / 5 / 10 to trade noise against coverage.
  - Metric toggle: Win % · PPG · games together.

- [x] **11. Row sort and focus-on-player mode**
  - Sort rows by name / Elo / average chemistry / most games.
  - Tap a player name to collapse the matrix to that player's row as a sorted
    list — the only form a 360px screen can really display.

- [x] **12. Tap-a-cell detail sheet**
  - Modal with the pair's win rate, PPG, W/D/L record and every match they shared
    (date, team name, venue, result), newest first.
  - `computeChemistryMatrix()` now records a reference per pair appearance; the
    aggregates alone could not produce the list.

### How the section is built

The matrix renders into its own mount (`#chemistryMatrixMount`) from
`chemContext`, so a control change re-renders only that card instead of
rebuilding — and re-scrolling — the whole Stats tab. One delegated listener on
`#insightsContainer` handles every control, cell and row, since player ids ride
in `data-` attributes.

**Below 576px the section opens in focus mode**, agreed 2026-08-21: a ranked
player list, tap a name for that player's partners, with "Show full grid" one tap
away. A 26x26 grid is 676 cells and only about four columns are legible at 360px,
so filtering and sorting alone could not make the grid usable there. Desktop keeps
the grid as its default. Crossing the breakpoint on rotate re-renders.

Verified: mobile list (26 rows) → focus (20 partners, correctly ranked) → pair
modal (75%, 2.38 PPG, 8 together, 8 matches listed); metric toggle re-sorts;
thresholds filter 1+ → 546 cells, 3+ → 336, 10+ → 18; sorts reorder as expected;
desktop grid 26x27 intact; no page overflow; no console errors.

---

## Phase 2b — Declined

- **14. Stack the match card vertically on phones — DECLINED 2026-08-21.**
  At 360px, 109 of 114 team names wrap onto two or more lines and long ones reach
  four, because a two-column card leaves each team about 120px and this group's
  team names are long and emoji-heavy by habit. Stacking the card below ~430px
  would fix it, but the maintainer's call is that exceptional team names can live
  as they are — it does not matter much. Do not re-propose; nothing is hidden
  (see item 8), it is only tall.

---

## Phase 5 — Fixture and roast lifecycle  ✅ complete

- [x] **13. Expiry and selection**
  - `selectFeaturedFixture()` picks the **soonest upcoming** scheduled fixture
    rather than the first document found. A 3-hour grace keeps a match in progress
    billed as NEXT GAME; after that it becomes an amber **AWAITING RESULT** card
    reading "Played 20/08/2026 — result not recorded" for a week, then drops off.
    Previously `formatCountdown()` reported "Kickoff imminent / Today" for any past
    date, so a played fixture stayed pinned indefinitely.
  - `selectFeaturedRoast()` keeps the newest published roast, demotes it from
    "ROAST OF THE WEEK" to "LATEST ROAST" after 7 days, and retires it after 30.
  - 17 unit tests cover the selection rules (grace window, overdue ordering,
    missing dates, drafts, staleness boundaries).

- [x] **15. Fixture and roast deep links**
  - `copyShareLink('roast'|'fixture', …)` has always produced `?roast=` and
    `?fixture=` URLs, but `handleDeepLinks()` only understood `player`, `match`
    and `tab` — so every shared roast or fixture link landed on the homepage.
  - `?roast=<id>` highlights the card when that roast is the featured one, and
    otherwise opens it in a modal, reading the document directly so a link to an
    older roast still works. `?fixture=<id>` highlights the featured fixture or
    explains that it is no longer next.
  - Both wait for the snapshot **and** the render before deciding; without that
    the check ran against an empty list and a link to the featured roast opened a
    modal on top of the card it should have highlighted.

- [x] **16. Admin: delete any roast**
  - Roast Studio → Tab A now lists every roast (newest first) with its target,
    date, status, and a badge marking the one currently on the Community tab.
  - Delete goes through a confirmation modal showing the full roast text, matching
    the match-delete pattern from Stage A item 14 — deletion happens on a phone
    and mis-taps are the real risk.
  - Deletion is a direct Firestore write. `firestore.rules` already limits
    `roasts` writes to the admin, so **no Cloud Function or rules deploy is
    needed** for this.

---

## Phase 6 — Second organizer, shared source of truth  ✅ complete

Not originally scoped; the maintainer asked for a second organizer account and,
separately, to open the data to a third-party WhatsApp chatbot. Both raised the
same underlying question — what is the single source of truth — so they're
grouped here.

- [x] **17. Two-tier access model**
  - `elderly.group.futsal@gmail.com` added as an **organizer**: full day-to-day
    access (matches, players, venues, fixtures, roasts, every AI tool).
  - The **owner** (Can) keeps what has real blast radius: the Gemini key/model
    (his billing), roast opt-out settings (a promise to a person, not reversible
    by whoever's signed in), and every irreversible delete (match, roast,
    fixture, player rename/delete).
  - Enforced independently in `firestore.rules`, `functions/index.js`
    (`assertAdmin` vs `assertOrganizer`), and `app.js` UI gating. Fixed a bug
    the change surfaced: the UI previously gated admin controls on "is anyone
    signed in" rather than identity, so any signed-in stranger saw controls
    that then failed server-side.
  - `tests/firestore-rules.test.js` grew to 65 assertions covering both tiers.

- [x] **18. `stats-core.js` — one statistics engine**
  - The project had drifted into **two** Elo implementations — one in `app.js`
    for the site, a second in `functions/index.js` for the AI's answers.
    They agreed on every player when checked, but nothing enforced it.
  - Extracted seven engines (Elo, streaks/form, nemesis/rivalry, attendance,
    optimal lineup, chemistry, plus the Elo helper) into `stats-core.js`,
    loaded by `index.html` and `require()`-able from Node. Verified
    byte-identical output before/after across all players and pairs.
  - `functions/index.js` keeps its own Elo copy (Cloud Functions can't
    `require()` outside `functions/`), now pinned by
    `tests/elo-parity.test.js`, which fails if the two ever diverge.

- [x] **19. Public read-only data export**
  - A friend wanted to build a WhatsApp chatbot over the league's stats. The
    options were Firestore access (shares the read quota, couples an outside
    consumer to the internal schema, invites a request for a service-account
    key) or a static file. Chose the static file.
  - `scripts/export-public.js` builds `public-data/league.json` from the
    public REST API — no credentials — requiring `stats-core.js` so the
    export can never disagree with the site. Schema v2 carries counting
    stats, Elo, chemistry pairs, streaks, nemesis, attendance.
  - Deliberately excludes roasts (the opt-out promise doesn't travel to a
    third party) and never reimplements a model — `docs/PUBLIC-DATA.md` says
    so explicitly to whoever builds against it.
  - `.github/workflows/refresh-public-data.yml` regenerates it every 6h and
    on demand, no secrets required, and skips the commit when nothing but the
    timestamp changed.

---

## Out of scope — do not propose

Considered and explicitly declined:

- Canvas-rendered shareable recap cards
- Prediction league
- YouTube auto-embed and highlight prompts
- Fantasy draft
- Team Name Hall of Fame (may return later as a separate design discussion)
- Second Firestore database (parallel `_v2` collections used instead)
- Soft delete / archive collection
- Per-tournament goal capture
