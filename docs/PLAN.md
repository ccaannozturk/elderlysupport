# Implementation Plan

Status key: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

26 agreed items across five stages. Stages are ordered by dependency. Within a
stage, items can be done in any order unless noted.

---

## Stage A — Independent fixes (no dependencies, start here)

Branch: `stage-a-fixes`

- [x] **3. Escaping + roster writes**
  - Add `esc()` (HTML-escape) and `safeUrl()` (scheme allowlist: http/https only)
    helpers. Apply to every interpolated value in every `innerHTML` template.
  - `renderList()` currently emits `onclick="removePlayer('${k}','${p}')"`. A name
    containing an apostrophe (`O'Brien`, `D'Angelo`) breaks the handler today. Move
    to `data-` attributes plus one delegated listener on the container.
  - Same treatment for `openPlayerStats('${p.name}')` in the leaderboard rows.
  - Make match save write any new player names to the `players` collection. Nothing
    currently does, which is why autocomplete goes stale.

- [ ] **8. Timestamp sort bug**
  - `openPlayerStats()` sorts with `b.date - a.date` on Firestore `Timestamp`
    objects, which produces `NaN`. It only appears to work because `allMatches`
    arrives pre-sorted from the query. Use `.toMillis()`.
  - Audit for the same pattern elsewhere.

- [ ] **11. Filter consistency**
  - Leaderboard and Stats respect year + month. `openPlayerStats()` respects year
    only, so a player modal opened under a month filter shows numbers that don't
    reconcile with the table. Make it respect both.

- [ ] **12. Defensive render**
  - `renderData()` calls `m.date.toDate()` unguarded — a single document with a
    missing or malformed date takes down the entire page. Filter invalid documents
    out early and log a warning.

- [ ] **13. PPG minimum-appearance qualifier**
  - Minimum **10 appearances** to rank. Unqualified players render greyed out below
    a separator line, still visible, not sorted into the main ranking.

- [ ] **15. "All Time" filter option**
  - Add to the year dropdown. Must work indefinitely as seasons accumulate — derive
    from the data, don't hardcode years. Currently career totals are unviewable.

- [ ] **21. Venue and match-level stats**
  - Goals per game by venue (indoor Sporthallen Zuid vs. outdoor Zeeburgereiland
    are expected to differ materially).
  - Biggest blowout, highest-scoring match, most draws.
  - Per-player win rate by venue.
  - Standard matches only for anything goal-based.

---

## Stage B — Identity layer (the core)

Branch: `stage-b-identity`
**Blocked until the maintainer supplies the reviewed roster mapping at
`data/roster-mapping.csv`.**

Context: player names are currently free-text strings used directly as statistic
keys, so one keystroke creates a permanent phantom player. The 2026 dataset needed
both **merges** (`Anderson Müller` → `Anderson`, `Guillermo` → `Guille`) and a
**split** (`Javi` was two different people, now `Javi Farres` and `Javi Bernardo`).
Fuzzy matching alone cannot handle this — the registry must be authoritative.

- [ ] **1. Canonical player registry**
  - `players_v2/{playerId}` where `playerId` is a stable slug:
    ```
    { displayName: "Anderson Brazil",
      aliases: ["anderson brazil", "anderson b", "andersonbr"],
      active: true,
      createdAt: Timestamp }
    ```
  - `matches_v2` stores player **IDs**, not display names.
  - Renaming a player then updates all history instantly.
  - **All alias matching is case-insensitive.** `Jp`, `JP`, and `jp` must resolve
    to the same player regardless of how it's typed. Store aliases lowercased and
    lowercase the input before comparing — don't rely on the maintainer typing
    consistently, that's the exact failure mode this registry exists to remove.
  - Note the trap: `Anderson`, `Anderson Brazil` and `Anderson Müller` coexisted.
    "Anderson" is both a standalone identity and a prefix of others. Never
    auto-snap a longer name to a shorter one.

- [ ] **2. Migration script** (`scripts/migrate.js`)
  - Reads `data/roster-mapping.csv` (maintainer-approved), rewrites all matches
    into `matches_v2` with resolved IDs, builds `players_v2`.
  - **Defaults to `--dry-run`.** Prints a full diff and a reconciliation report
    (per-player appearance counts before vs. after) and writes nothing without an
    explicit `--commit` flag.
  - Original `matches` and `players` collections are never modified.
  - Fails loudly on any name not present in the mapping file.
  - Look up `raw_name` case-insensitively against `data/roster-mapping.csv` — same
    reasoning as above, don't require exact-case matches against the mapping file.
  - Known special cases already resolved in the current mapping file, worth
    understanding before touching it again:
    - `Anderson Müller` and `Guillermo` are merges (same person as `Anderson` and
      `Guille` respectively). The `Guillermo` merge restores him to the
      16/05/2026 match, where the manual data review had accidentally dropped him
      instead of renaming him.
    - `Javi` is a **split** — two different people were both recorded as "Javi".
      Resolved by match date, not by name: 01/08/2026 → Javi Farres,
      11/07/2026 → Javi Bernardo. Name-only lookup cannot disambiguate this; the
      script needs a per-match override for this one raw name.

- [ ] **4. Resolver with hard gate**
  - Every entered name resolves against the registry before save is possible:
    - exact alias hit → green chip, auto-accepted
    - single fuzzy candidate above threshold → amber chip, one tap to confirm
    - multiple candidates → red chip, forced selection, **no default**
    - no hit → "create new player?" dialog showing the three closest existing
      names first
  - "Exact alias hit" means case-insensitive exact match. `jp`, `Jp`, `JP` are all
    the same alias — don't send `JP` down the fuzzy-match path just because the
    casing differs from what's stored.
  - **SAVE button disabled while any chip is amber or red.** This single constraint
    is what eliminates the error class — a mistake becomes unsaveable.
  - UI must be chips and bottom sheets, not desktop dropdowns. See item 7.

- [ ] **5. Context constraints**
  - A player cannot appear on two teams in the same match. Exclude already-placed
    players from candidate lists — this auto-resolves the Anderson ambiguity most
    of the time.
  - Loud warning on any name appearing for the first time ever (genuinely new
    players are rare; typos are common).
  - Flag team-size imbalance for confirmation (5v7 is legal but worth a prompt).

---

## Stage C — Entry experience

Branch: `stage-c-entry`

- [ ] **7. Mobile-first entry (Android)**
  - **Replace the `<input list="playerList">` datalist.** Android Chrome handles
    datalists poorly — inconsistent dropdown, multiple taps, unreliable filtering.
    This is a likely root cause of the maintainer typing full names by hand and
    therefore of the typos themselves.
  - Roster grid: ~25 regulars as tappable chips, tap to add, tap to remove.
    Typing becomes the exception. Search box above it for the ~40 occasional players.
  - `inputmode="numeric"` on score fields.
  - Minimum 16px font on inputs (prevents Android zoom-on-focus jump).
  - Sticky save button.
  - Duplicate-match guard: warn if a match already exists on that date + venue.

- [ ] **9. Tournament rank buttons**
  - Replace free-number points entry with three buttons: 1st / 2nd / 3rd.
    Points auto-assigned 3/1/0. Less typing than now, and structurally prevents
    invalid values.
  - Background: `processTeamStats()` treats `pts >= 3` as a win and `pts === 1` as
    a draw, so a stray value of `2` currently registers as played but as neither
    W, D, nor L — silently breaking `P = W + D + L`.

- [ ] **10. Goals: exclude tournaments explicitly**
  - Tournament matches record no goals and currently pass `gf: 0, ga: 0` into the
    aggregate, diluting everyone's totals.
  - Exclude them from all goal-based statistics and label the stat
    "Goals (standard matches only)" so the number is honest.

- [ ] **14. Better delete confirmation**
  - Plain hard delete retained (no archive collection, no soft-delete flag — the
    maintainer wants Firestore kept clean).
  - Replace `confirm("Delete?")` with a dialog showing date, both team names, and
    the score. Deletion happens on a phone; mis-taps are the real risk.

- [ ] **6. AI Magic Paste** *(do last in this stage)*
  - Paste the raw WhatsApp lineup message unmodified — no strict format required.
  - Cloud Function proxy → Gemini (Google AI Studio free-tier key). The key lives
    in Firebase Functions config and **must never appear in client JS**.
  - Returns strict JSON: teams, scores/ranks, resolved player IDs, and a
    per-name confidence score.
  - Anything below high confidence drops into the amber/red resolver state from
    item 4 — the model never silently commits a name.
  - Rate-limit / queue calls; free tier limits are per-minute, not per-month.

---

## Stage D — Statistics engine

Branch: `stage-d-stats`

- [ ] **16. Elo / power ranking** *(do first — 22 and 25 depend on it)*
  - Player rating updates from team-average rating vs. opponent-team-average.
    Fairer than PPG when team allocation is uneven.
  - Handle tournaments as a three-way comparison, not two.
  - Expose the rating so it can feed team-balancing later.

- [ ] **17. Nemesis and rivalry**
  - Most-lost-to opponent per player, with record.
  - Duo split analysis: record together vs. record opposed.

- [ ] **18. Streaks and form**
  - Current and all-time longest win / loss / unbeaten runs.
  - Rolling 5-game PPG line chart per player.
  - Most improved: current month vs. season average.

- [ ] **19. Chemistry matrix**
  - Heatmap of every pair's win rate together. Apply a minimum-games threshold or
    it will be noise.

- [ ] **20. Appearances and attendance**
  - Milestone badges (50 / 100 / 200).
  - Attendance rate, longest consecutive-appearance run, debut tracker,
    one-cap-wonders list (14 players had a single appearance in 2026).

- [ ] **22. Optimal lineup and curse stat**
  - Highest-rated lineup buildable from the pool (needs item 16).
  - "Curse": the player whose presence most lowers his team's average score,
    independent of result.

---

## Stage E — Community layer

Branch: `stage-e-community`

- [ ] **32. PWA + deep links** *(do first — 25, 28, 29 all point at these URLs)*
  - `manifest.json` + service worker: add-to-homescreen, fullscreen launch,
    cached reads, offline viewing.
  - Deep links: `?player=Sam` and `?match=<id>` open directly on that view, so a
    link dropped in the group chat lands where intended.

- [ ] **25. Weekly power rankings**
  - Monday view with movement arrows vs. last week. Requires item 16.

- [ ] **28. Milestone notices**
  - "Sam plays his 40th tonight", "Hector needs 2 wins for 50". Requires item 20.

- [ ] **29. Monthly awards**
  - Player of the Month, Most Improved, Iron Man, Worst Duo, Ghost of the Month
    (lowest attendance among active players). Mostly assembly of stats from
    Stage D.

---

## Out of scope — do not propose

Considered and explicitly declined:

- Canvas-rendered shareable recap cards
- Prediction league
- AI roast / hype generator
- YouTube auto-embed and highlight prompts
- Fantasy draft
- Team Name Hall of Fame (may return later as a separate design discussion)
- Second Firestore database (parallel `_v2` collections used instead)
- Soft delete / archive collection
- Per-tournament goal capture
