# Handover — Phase 7: Elo/tournament consolidation, citation removal, export freshness

**Status: proposed, not started.** Written for a fresh agent with no memory of
the session that diagnosed it — read this whole file before touching code.
Nothing here has shipped. `docs/PLAN.md` has a one-line pointer to this file;
once the work below is done, fold a summary back into `docs/PLAN.md` as
Phase 7 and delete this file, matching how every other phase is recorded.

Three unrelated asks from the maintainer, bundled because two of them touch
the same root cause:

1. Tournaments are inconsistently counted in AI stats answers (they ARE
   counted almost everywhere else — see the diagnosis below, don't assume
   the bug is bigger than it is).
2. Remove the "award citation" feature from the Community tab entirely.
3. `public-data/league.json` should reflect the most recent match "all the
   time," not on a 6-hourly cron.

---

## 1. Tournament handling — diagnosis (confirmed, not guessed)

### The claim vs. reality

The maintainer's instinct was "tournaments aren't counted." **That's not
quite true.** Investigated with real data before writing this:

- `stats-core.js` (the website's engines — Elo, streaks, nemesis, chemistry,
  attendance) handles both `Standard` and `Tournament` match types
  correctly. Confirmed for **attendance** specifically: player `Jp` has 2
  Standard + 3 Tournament appearances in the backup, and
  `computeAttendanceAndMilestones()` reports `played: 5` — tournaments are
  counted there.
- `functions/index.js`'s own `computeEloRatings()` (used by
  `generateMatchRecap`) also handles tournaments correctly, and is pinned to
  `stats-core.js` by `tests/elo-parity.test.js` (currently passing).

**The actual bug is narrower and worse: a third, separate Elo/streak
implementation, inline inside `exports.queryStats` in `functions/index.js`
(the natural-language AI stats Q&A), that only processes `m.type ===
'Standard'` matches.** This is the function that answered the maintainer's
question about player JP and gave a wrong picture.

Quantified against the full dataset (65-67 matches, reshaped to `matches_v2`
form):

- **64 of 68 players** have a different Elo rating between the site
  (`stats-core.js`) and what `queryStats`'s inline calculation would produce.
- Player `Jp` specifically: site says `1229` Elo across `5` games,
  non-provisional. The `queryStats` inline calc says `1204` Elo across only
  `2` games, marked **provisional** — a materially different answer to "how
  good is JP" from the same underlying data, purely because tournaments were
  dropped.
- Within that same inline block, tournament matches DO count toward W/D/L,
  points, and head-to-head (there's a working `else` branch for that), but do
  **not** update Elo and do **not** update the win/loss streak tracker. So a
  player's `queryStats`-reported win rate can look right while their Elo and
  streak are wrong, in the same answer.

### Where the code is

In `functions/index.js`, inside `exports.queryStats`:

- Around line 1160–1220: a hand-rolled Elo loop that only runs when
  `m.type === 'Standard'` (look for the comment `// Elo update` and the loop
  right after `if (m.type === 'Standard') {`).
- The same `if (m.type === 'Standard')` block also updates the win/loss
  streak tracker (`streaks[p]`) — tournaments never reach that code either.
- Around line 1281–1309: the **separate** tournament branch (comment
  `// Tournament format`) that correctly updates points/W/D/L/H2H but was
  never wired to touch `eloMap` or `streaks`.

Meanwhile `functions/index.js` **already has** a correct, tournament-aware,
tested `computeEloRatings(matchList)` function (defined around line 498,
returns `{ ratings, matchCounts }`) sitting unused by `queryStats` — it's
called by `generateMatchRecap` but not by `queryStats`. This is not a case
of "no correct implementation exists in this file"; `queryStats` just never
called the one that does.

### The fix — do NOT write a fourth implementation

1. **Replace `queryStats`'s inline Elo loop with a call to the existing
   `computeEloRatings(allMatchesList)`** (same function `generateMatchRecap`
   already calls). Delete the inline Elo/K-factor code entirely from
   `queryStats`. Read `eloMap[p].rating` / `matchCounts[p]` from its return
   value instead of the local hand-rolled one.
2. **Streaks and H2H are a separate, smaller duplication.** `stats-core.js`
   has `computePlayerStreaksAndForm()` and `computeNemesisAndRivalry()` that
   are already tournament-correct. `functions/index.js` cannot
   `require('../stats-core.js')` — Cloud Functions only upload the
   `functions/` directory (confirmed: no `predeploy` hook in `firebase.json`
   that would copy shared files in). Two honest options, don't invent a
   third:
   - **(a)** Copy `computePlayerStreaksAndForm` and
     `computeNemesisAndRivalry` into `functions/index.js`, the same pattern
     already used for `computeEloRatings`, and extend
     `tests/elo-parity.test.js` (or add a sibling test) to pin all three
     functions between `stats-core.js` and `functions/index.js`, not just
     Elo. This is the more thorough fix and matches existing precedent.
   - **(b)** Minimal patch: inside `queryStats`'s existing tournament branch,
     also update `streaks[p]` using the same win/draw/loss logic already
     used in the Standard branch (the `res` variable is already computed
     there as `'W'|'D'|'L'` — just call the same streak-update logic for
     both branches instead of only the Standard one). Lower effort, but
     leaves a second, un-pinned partial copy of streak logic in
     `functions/index.js`.
   - Recommend (a) for consistency with how the Elo duplication was already
     handled, but this is a judgment call for whoever picks up the work —
     not dictated here.
3. **Verify, don't assume.** Before calling this done: pick 2–3 players who
   have meaningfully different tournament participation (JP is one; find
   others via `Object.entries(...).filter(...)` over the backup), ask
   `queryStats` a question about them through the actual AI Stats Query UI in
   the Admin tab, and confirm the Elo/streak numbers it cites now match the
   Stats tab. A unit test comparing the two number sets (site vs.
   `queryStats`) the way `tests/elo-parity.test.js` does for the standalone
   `computeEloRatings` functions is the more durable check — extend that
   test file rather than writing a new one from scratch.

### Explicitly NOT in scope for this item

Chemistry, attendance, and the site's own Stats tab are already correct.
Don't touch `stats-core.js` for this — the bug is entirely inside
`functions/index.js`'s `queryStats`.

---

## 2. Remove award citations completely

The maintainer doesn't like this feature and wants it gone, not hidden.
Every touch point, confirmed by grep — there is nothing else to find beyond
this list:

### `app.js`

- Lines ~5385–5390: the `cachedCitation` read
  (`db.collection('awards').doc(awardDocId).get()`) inside the Community tab
  render function. Delete the read and the `cachedCitation` variable.
- Lines ~5466–5481: `citationBanner` and `adminCitationBtn` construction
  (the "↺ Generate Citation" button and the "Official Award Citation" banner
  markup). Delete both, and the `${citationBanner}` interpolation at its
  render call site (~line 5576).
- Lines 5598–5622: the entire `window.generateAwardCitation` function.
  Delete it.

### `functions/index.js`

- Lines 1432–1479: `exports.generateAwardsCopy`. Delete the whole function.
  Confirmed nothing else in the codebase calls it once the `app.js` call
  site above is removed.

### `firestore.rules`

- The `match /awards/{awardId} { ... }` block. Confirmed via grep that the
  `awards` collection is used **only** for citation caching — nothing else
  reads or writes it. Safe to delete the rule entirely (it will then fall
  through to the default-deny at the bottom of the file), or leave the rule
  in place but stop writing to the collection — deleting it is cleaner and
  matches "remove it completely."
- This needs a rules deploy after merging. Follow the existing procedure in
  `docs/SETUP.md` §7.

### Firestore data

- Existing `awards/{YYYY-MM}` documents become orphaned once nothing reads
  them. Leaving them is harmless (nothing points at them once the `app.js`
  read is gone) — deleting them is optional cleanup, not required for the
  feature removal to be complete. If deleting, do it manually via the
  Firebase console; don't write a script for a handful of documents.

### Verification

- `grep -rn "citation\|Citation" app.js functions/index.js firestore.rules`
  should return nothing after the change.
- Load the Community tab (as both signed-out and as an organizer) and
  confirm the Monthly Awards card renders with no citation banner and no
  "Generate Citation" button, for a month that has a Player of the Month.

---

## 3. `public-data/league.json` freshness

### Current state

`.github/workflows/refresh-public-data.yml` runs on a 6-hour cron
(`0 */6 * * *`) plus a manual `workflow_dispatch` button in the Actions tab.
The export script itself (`scripts/export-public.js`) already skips
committing when nothing but `generatedAt` changed, so the cron is cheap —
but a match entered right after a scheduled run is still up to ~6 hours
stale unless someone remembers to click the button.

### Two options — pick one, don't build both

**Option A — event-driven (recommended if the maintainer wants "always
current" to mean minutes, not hours):**

Matches are written directly from the client to `matches_v2` (`create`/
`update` in `firestore.rules`), not through a Cloud Function — so the only
way to react server-side to a save is a genuine Firestore trigger.

1. Add a 1st-gen Firestore trigger in `functions/index.js`:
   `functions.firestore.document('matches_v2/{matchId}').onWrite(...)`
   (matches the 1st-gen style already used for `scheduledBackup`'s
   `pubsub.schedule`; keep the codebase consistent rather than introducing
   2nd-gen `onDocumentWritten` for just this one function).
2. Inside it, call GitHub's
   [`POST /repos/{owner}/{repo}/dispatches`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
   endpoint with a custom `event_type` (e.g. `"match-changed"`), authenticated
   with a **fine-grained personal access token** scoped to only this repo,
   with `Contents: write` permission (that's what the dispatch endpoint
   needs).
3. Store the token as a Firebase Functions secret —
   `firebase functions:secrets:set GITHUB_DISPATCH_TOKEN` — never in
   Firestore, never in client code, never committed. Read it in the function
   via `functions.config()` / the secrets API (check current
   `firebase-functions` version's supported pattern — v5 supports
   `defineSecret`).
4. Add a `repository_dispatch:` trigger (alongside the existing `schedule:`
   and `workflow_dispatch:`) to
   `.github/workflows/refresh-public-data.yml`, matching the `event_type`
   from step 2.
5. Consider debouncing: rapid successive writes to the same match (e.g. a
   fixture resolving into a match, immediately followed by a manual edit)
   could fire two dispatches seconds apart. Not harmful — the export script's
   own no-op detection makes the second run a cheap skip — but worth a code
   comment saying so rather than adding real debounce infrastructure for a
   non-problem.
6. This adds a new secret and a new failure mode (GitHub API errors,
   auth failures) to a function that fires on every match write. Log
   failures; do not let a dispatch failure block or throw inside the
   Firestore write path — this must be fire-and-forget, same posture as
   `generateMatchRecap` already uses for its own Gemini call on match save
   (see the existing comment there: "never blocks save").

**Option B — tighten the cron interval (near-zero effort, not truly
real-time):**

Change `cron: '0 */6 * * *'` to something like `'*/15 * * * *'` (every 15
minutes) or `'*/30 * * * *'`. GitHub's scheduled workflows aren't guaranteed
to the minute under load, and very short intervals (sub-5-minute) are
explicitly discouraged by GitHub's own docs — 15–30 minutes is a reasonable
floor. This does not require a new secret or a new function, and the
existing manual "Run workflow" button already covers the "I want it now"
case the maintainer can already use today (confirm they know about it —
that's arguably the cheapest fix of all: no code change, just make sure the
maintainer knows to click it after a match night, and cite that in the
handover conversation with them before spending an engineering session on
Option A).

**Decide with the maintainer before building**, don't assume. If "all the
time" means "I don't want to think about it and it should just be current
within a couple of minutes of a save," build Option A. If it means "stop
making me remember to click a button most weeks," Option B plus a reminder
that the button exists is proportionate and much less to maintain.

### Verification (either option)

- Add or edit a match, confirm `public-data/league.json`'s `generatedAt` and
  match count update within the target window (minutes for A, the cron
  interval for B).
- Confirm the export script's own no-op detection (already in
  `scripts/export-public.js`) still prevents empty commits — this matters
  more under Option A, where writes could be much more frequent.

---

## Suggested order of work

1. Item 2 (citation removal) first — smallest, fully self-contained, no
   Cloud Functions redeploy risk beyond the one function being deleted, and
   it's a pure subtraction so it can't introduce a new bug in the areas
   Item 1 touches.
2. Item 1 (Elo/tournament consolidation in `queryStats`) — the diagnosis is
   done; verify against real data as described above before considering it
   closed, not just "the code compiles."
3. Item 3 (freshness) last, and only after agreeing the option with the
   maintainer — it's the one item here that adds new infrastructure
   (a secret, a new trigger) rather than fixing or removing existing code.

Each item gets its own commit and, per this repo's existing convention
(`docs/PLAN.md`), its own line-item writeup folded back into `docs/PLAN.md`
under a new `## Phase 7` heading once done — see how Phases 1–6 are recorded
there for the format to match.
