# Elderly Support League — Project Context

## What this is

A single-page match tracker and leaderboard for a recreational football/futsal group
in Amsterdam (est. 2020, ~68 players, ~61 matches recorded in 2026 so far).
Owner and sole maintainer: Can Öztürk.

Live site is served from GitHub Pages off `main`.

## Architecture — READ THIS BEFORE PROPOSING CHANGES

Three static files. No build step. No npm at runtime. No bundler. No framework.

```
index.html      markup + all CSS in a <style> block
app.js          all application logic, plain ES6, no modules
README.md
```

Dependencies are loaded from CDN: Bootstrap 5.3, FontAwesome 6.4,
Firebase JS SDK 9.23 (**compat** build, not modular).

### Hard constraints

These are deliberate decisions, not technical debt. Do not "fix" them.

- **No build tooling.** No Vite, no webpack, no TypeScript, no npm install step for
  the app itself. The maintainer works on this in spare time and must be able to
  edit a file and push. Node is used only for the scripts in `scripts/`.
- **Stay on the Firebase compat SDK.** Migrating to the modular SDK is out of scope.
- **No frontend framework.** Vanilla JS only.
- **Mobile-first, specifically Android Chrome.** Match entry happens on a phone,
  standing at a sports hall. Desktop is the secondary case. Keyboard shortcuts are
  near-useless here; tap targets and thumb reach are what matter.
- **Keep it simple.** If a feature requires the maintainer to reliably do extra data
  entry after every match, it will not get done. Prefer features that work off data
  already captured.

### Known-fragile areas

- `renderData()` and `openPlayerStats()` both re-derive statistics from scratch on
  every render. That's fine at this data volume — don't add caching complexity.
- Firestore `Timestamp` objects are NOT `Date` objects. `a.date - b.date` yields
  `NaN`. Always use `.toMillis()` or `.toDate()`.
- The app has two match types, `Standard` (two teams, goals) and `Tournament`
  (three teams, ranked 1/2/3 with 3/1/0 points, no goals recorded). Almost every
  statistics function needs to handle both. Tournament matches have no goal data —
  never include them in goal-based statistics.
- `originalKey` on tournament teams ('A'/'B'/'C') maps to shirt colour
  (yellow/blue/red) and is independent of finishing rank. Don't conflate them.

## Data model

### Current (pre-migration)

`matches/{autoId}`
```
date         Timestamp
location     string   (one of five fixed venues)
type         'Standard' | 'Tournament'
youtubeLink  string | null
updatedBy    string   (email — client-supplied, do not trust)
timestamp    serverTimestamp
colors       [string, string]        Standard only, e.g. ['blue','red']
teams        [ { teamName, score, players[] } ]              Standard: 2 entries
             [ { teamName, points, rank, originalKey, players[] } ]  Tournament: 3
```

`players/{playerName}` — document ID is the display name, no fields. Used only to
populate an autocomplete datalist. **Nothing in the app currently writes to it**,
which is why it goes stale.

### Target (post-migration, Stage B)

Player identity moves from free-text strings to stable IDs. See `docs/PLAN.md`
items 1 and 2. New collections are written as `matches_v2` / `players_v2` and the
originals are left untouched until the maintainer verifies and flips over.

## Firebase

Project: `elderly-support-league`. Blaze plan. Single default Firestore database.

Auth is email/password, single super-admin. The `firebaseConfig` object in `app.js`
is **public by design** — it is not a secret and does not need rotating. Real
authorization lives in `firestore.rules`.

### Rules of engagement with Firebase

- **Never connect to production Firestore.** Develop against the local emulator.
- **Never run `firebase deploy`** (any target). The maintainer deploys manually
  after reviewing diffs. Note that `firebase login` credentials may already exist
  on this machine — the absence of an auth error does not mean you have permission.
- **Never run migration scripts against production.** `scripts/migrate.js` defaults
  to `--dry-run` and must stay that way.
- You may edit `firestore.rules`. You may not deploy it.
- Never commit a service-account JSON, `.env`, or any credential file.

## Local development

```bash
firebase emulators:start --import=./emulator-data
```

Serves the app at http://localhost:5000 with Firestore at :8080 and Auth at :9099,
seeded from a backup. See `docs/SETUP.md`.

## Working style

- Work in stage branches (`stage-a-fixes`, `stage-b-identity`, ...), not per-item
  branches. See `docs/PLAN.md` for the stage breakdown.
- Consult `docs/PLAN.md` at the start of every session to see what is done and
  what is next. Update the status markers as you complete items.
- The plan is agreed and scoped. If you think an item should change, say so and
  wait — do not unilaterally expand scope.
- Items explicitly rejected: canvas recap cards, prediction league, AI roast
  generator, YouTube auto-embed, fantasy draft, Team Name Hall of Fame. Do not
  re-propose these; they were considered and declined.

## Style

- Match the existing code's conventions. It is terse and uses template literals
  heavily. Don't reformat files you aren't otherwise changing.
- Dark theme, CSS custom properties defined in `:root`. Reuse them; don't hardcode
  hex values.
- Some existing comments are in Turkish. Leave them; write new ones in English.
