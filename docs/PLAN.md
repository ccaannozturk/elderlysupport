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

## Phase 2 — Mobile layout

- [ ] **7. Optimal 5-player lineup grid**
  - Five tiles render as `<div class="col">` in a `.row`. Bootstrap's `.col` is
    `flex: 1 0 0%` with auto min-width, so tile content (rank badge, 4-digit Elo,
    caps line) sets a ~70px floor. On a 360px Android viewport the line overflows,
    the row wraps, and the 5th tile lands alone stretched edge-to-edge.
  - Replace with a CSS grid: phones get #1 as a full-width hero and #2–#5 as 2×2;
    ≥576px returns to five equal columns. Add `min-width: 0` so `text-truncate`
    actually engages.
  - Note: `index.html` currently contains **no `@media` queries at all**.

- [ ] **8. Sweep for the same overflow pattern**
  - Audit the other Community and Stats cards for bare `.col` children that will
    wrap the same way at 360px.

---

## Phase 3 — Awards honesty

- [ ] **9. Provisional / low-sample tier**
  - `computeMonthlyAwards()` already has resilient fallback tiers (relaxed
    qualifier, then best-available-unqualified). They were simply never reached
    because of Phase 1 item 1.
  - Add an explicit tier below them so a thin month shows an approximation with a
    labelled caveat ("3 matches in June — below qualifier, showing best available")
    and a `PROVISIONAL` badge, rather than a blank card. No month should ever
    render empty if any match exists in it.

---

## Phase 4 — Chemistry matrix interactivity

Today: a static 26×26 all-time table, fixed min-3-games threshold, `title=`
tooltips that do not exist on touch. Everything below derives from
`chemData.allDuos`, which is already computed — no new data entry, no new reads.

- [ ] **10. Min-games slider and metric toggle**
  - Threshold 1 / 3 / 5 / 10 to trade noise against coverage.
  - Metric toggle: Win % · PPG · games together.

- [ ] **11. Row sort and focus-on-player mode**
  - Sort rows by name / Elo / average chemistry / most games.
  - Tap a player name to collapse the matrix to that player's row as a sorted
    list — the only form a 360px screen can really display.

- [ ] **12. Tap-a-cell detail sheet**
  - Bottom sheet with the pair's full record and the list of shared matches.

---

## Phase 5 — Fixture and roast lifecycle

- [ ] **13. Expiry and selection**
  - "Roast of the Week" and "NEXT GAME" never expire: a stale roast sits
    indefinitely and a past fixture stays pinned with a negative countdown until
    manually marked played. Add auto-expiry.
  - `allFixtures.find(f => f.status === 'scheduled')` picks an arbitrary match when
    several are scheduled. Pick the soonest.

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
