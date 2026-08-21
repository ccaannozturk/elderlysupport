# Elderly Support League — Project Context

## What this is

A single-page match tracker and leaderboard for a recreational football/futsal group
in Amsterdam (est. 2020). Owner: Can Öztürk. A second organizer account
(`elderly.group.futsal@gmail.com`) runs day-to-day operations alongside him —
see "Access model" below.

Live site is served from GitHub Pages off `main`.

## Architecture — READ THIS BEFORE PROPOSING CHANGES

Static files. No build step. No npm at runtime. No bundler. No framework.

```
index.html      markup + all CSS in a <style> block
stats-core.js   every statistical engine (Elo, chemistry, streaks, ...).
                Loaded by index.html AND require()'d by scripts/export-public.js.
                This is the ONLY implementation — see "Single source of truth" below.
app.js          application logic, plain ES6, no modules
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
- **Never reimplement a statistical engine.** Elo, chemistry, streaks, nemesis,
  attendance, and the optimal lineup live in `stats-core.js` and nowhere else in
  the client. Any code that needs them calls into it. The one deliberate
  exception is `functions/index.js`, which keeps its own copy of Elo because
  Cloud Functions cannot `require()` outside `functions/` — that copy is pinned
  to `stats-core.js` by `tests/elo-parity.test.js`, which must stay green.

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

`matches_v2` and `players_v2` are canonical. The original `matches` /
`players` collections are retired — read-only in `firestore.rules`, kept only
for history. Never write to them.

`matches_v2/{autoId}`
```
date         Timestamp
location     string   (one of five fixed venues, extensible via `locations`)
type         'Standard' | 'Tournament'
youtubeLink  string | null
updatedBy    string   (email — client-supplied, do not trust)
timestamp    serverTimestamp
colors       [string, string]        Standard only, e.g. ['blue','red']
teams        [ { teamName, score, players[] } ]                     Standard: 2 entries
             [ { teamName, points, rank, originalKey, players[] } ]  Tournament: 3
recap        string | undefined      AI-generated, written after save
```

`players[]` holds player **IDs**, not display names — resolve through the
`players_v2` registry (`playerId -> { displayName, aliases, active }`) for
anything user-facing.

`players_v2/{playerId}`
```
displayName  string
aliases      string[]   lowercased, matched case-insensitively
active       boolean
```

Other collections: `locations` (venue names), `awards` (cached monthly award
citations), `fixtures` / `roasts` (Community tab, see item 42 in
`docs/PLAN.md`), `config/gemini` (API key, unreadable by every client — see
`firestore.rules`), `config/gemini_meta`, `config/roast_settings`.

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

## Access model

Two tiers, kept in step across three files — if you change one, change all
three and redeploy both rules and functions:

- `firestore.rules` — `isOwner()` / `isOrganizer()`
- `functions/index.js` — `OWNER_EMAIL` / `ORGANIZER_EMAILS`, enforced by
  `assertAdmin()` (owner-only) / `assertOrganizer()`
- `app.js` — `SUPER_ADMIN` / `ORGANIZERS`, presentation only; the rules and
  functions are what actually enforce access

Owner-only: the Gemini key/model, roast opt-out settings, and anything
irreversible (deleting a match/roast/fixture, renaming or deleting a player).
Organizer: everything else. See `docs/STATUS.md` §2 for the full table.

## Working style

- Consult `docs/PLAN.md` at the start of every session to see what is done and
  what is next. Update the status markers as you complete items.
- The plan is agreed and scoped. If you think an item should change, say so and
  wait — do not unilaterally expand scope.
- Items explicitly rejected: canvas recap cards, prediction league, YouTube
  auto-embed, fantasy draft, Team Name Hall of Fame. Do not re-propose these;
  they were considered and declined. (An AI roast generator was on this list
  once — it shipped as the Roast Studio and is no longer declined.)

## Style

- Match the existing code's conventions. It is terse and uses template literals
  heavily. Don't reformat files you aren't otherwise changing.
- Dark theme, CSS custom properties defined in `:root`. Reuse them; don't hardcode
  hex values.
- Some existing comments are in Turkish. Leave them; write new ones in English.
