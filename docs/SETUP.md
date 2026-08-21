# Setup — what to do, in order

**Status: this ran once, historically, to get the project from a bare
Firebase project to what's live today.** Steps 1–6 are kept as a record of
that and as onboarding for a second machine (or a second organizer who wants
a local dev environment); they are not things to redo. Section 7 (deploying
a rules change) is the one part of this file still followed for every
change — read `docs/STATUS.md` for the project's current state instead of
inferring it from here.

---

## 0. Before anything: check one Firebase setting

Firebase Console → **Authentication → Settings → User actions**.

If **"Enable create (sign-up)"** is on, disable it. With it on, anyone can register
an account in ten seconds, and the old rules let any signed-in account write to
`matches` and `players`. Disabling it closes that path entirely.

While you're there, confirm the only account listed is yours.

---

## 1. Drop the pack into the repo

Copy the files into your local clone of `elderly-support-league`, preserving the
folder structure:

```
elderly-support-league/
├── CLAUDE.md               <- new
├── firebase.json           <- new
├── firestore.rules         <- new
├── firestore.indexes.json  <- new
├── .firebaserc             <- new
├── .gitignore              <- new
├── docs/
│   ├── PLAN.md             <- new
│   └── SETUP.md            <- new (this file)
├── scripts/
│   └── backup.js           <- new
├── data/                   <- empty for now
├── index.html              <- yours, unchanged
├── app.js                  <- yours, unchanged
└── README.md               <- yours, unchanged
```

```bash
git add -A
git commit -m "Add project context, plan, emulator config and backup script"
git push
```

---

## 2. Take a backup — do this before anything touches the data

Needs Node 18 or newer (`node --version` to check).

```bash
node scripts/backup.js
```

Writes `backups/backup-2026-08-07T....json`. No credentials needed — your
collections are publicly readable, so it reads over the public REST API.

```bash
git add backups/ && git commit -m "Baseline backup before Stage A" && git push
```

**This is your rollback point.** The CSV export from the admin panel is not
sufficient — it drops document IDs, `originalKey`, and timestamps.

---

## 3. Install the Firebase CLI and start the emulator

```bash
npm install -g firebase-tools
firebase login
firebase emulators:start
```

- App: http://localhost:5000
- Emulator dashboard: http://localhost:4000

The emulator starts empty. Import your backup through the dashboard's Firestore
tab, or ask Claude Code to write a small seed script from the backup JSON.

A note on `firebase login`: it authenticates **you** on this machine, and any
terminal command run afterwards inherits those credentials. That includes commands
Claude Code runs. `CLAUDE.md` forbids it from deploying, but stay alert when
reviewing commands — if you see `firebase deploy` proposed, stop it.

---

## 4. Deploy the updated rules — yourself

Read `firestore.rules` first. The changes are documented in the header comment;
the important one is that `players` write drops from "any signed-in user" to
admin-only.

```bash
firebase deploy --only firestore:rules
```

Then confirm the app still works — you should be able to log in, add a match, and
see the leaderboard render.

---

## 5. Start Claude Code

```bash
cd /path/to/elderly-support-league
claude
```

It picks up the git repo and `CLAUDE.md` automatically from the working directory —
no configuration needed. VS Code is optional; Claude Code runs in the terminal.

First message, historically:

> Read CLAUDE.md and docs/PLAN.md. We're starting Stage A. Create the
> `stage-a-fixes` branch and start with item 3 (escaping and roster writes).
> Show me your plan before you edit anything.

That workflow — one or two items at a time, review each diff, test against the
emulator, merge to `main` when verified — carried through every stage since.
For what's next, open `docs/PLAN.md`: anything unchecked, or a fresh request
from the maintainer, is fair game.

---

## 6. Roster mapping (done — kept as a record)

Stage B was blocked until the maintainer produced `data/roster-mapping.csv` —
the authoritative mapping from every name string that had ever appeared to a
canonical player. That file exists and Stage B shipped; this section is left
as a reference for what the file had to contain, in case the registry ever
needs a second pass (a new merge, a new split).

Format:

```csv
raw_name,player_id,display_name,notes
Anderson,anderson,Anderson,
Anderson Brazil,anderson_brazil,Anderson Brazil,
Anderson Müller,anderson,Anderson,merged - same person
Guille,guille,Guille,
Guillermo,guille,Guille,merged
Javi Farres,javi_farres,Javi Farres,split from "Javi"
Javi Bernardo,javi_bernardo,Javi Bernardo,split from "Javi"
Chrys,chrys,Chrys,
Chris D.,chris_d,Chris D.,different person from Chrys
```

Every distinct string across all 61 matches must appear exactly once. The migration
script deliberately fails loudly on any unmapped name rather than guessing.

Take your time with this file — it's the one input that can't be automated, and
everything downstream inherits its decisions.

---

## 7. Deploying a rules change (the repeatable procedure)

Use this any time `firestore.rules` changes. Written for the Phase 1 fixtures /
roasts change, but the steps are the same every time.

### Why the order matters

Rules and client queries have to agree. Deploy **rules first, then the client**:

| | old client (unconstrained listen) | new client (`where('status','==',…)`) |
|---|---|---|
| **old rules** (`status != 'draft'`) | denied — today's bug | may or may not be admitted; do not rely on it |
| **new rules** (`status == 'scheduled'`) | denied — same as today, no regression | works |

Rules-first is safe in both directions. Client-first has a window where the
public queries may still be denied.

### 1. Get the branch locally and read the diff

```bash
git fetch origin claude/community-chemistry-review-nmwjac
git checkout claude/community-chemistry-review-nmwjac
git diff main -- firestore.rules
```

Read it. Two `allow read` conditions change, nothing else. Never deploy rules
from a branch that does not contain the change — deploying from `main` would
push the *old* rules back over a good deploy.

### 2. Confirm which account and project the CLI will use

```bash
firebase login:list          # must be the admin account
firebase use                 # must print elderly-support-league
```

`firebase login` authenticates *you* on this machine and every later command
inherits it, including commands an agent runs. If `login:list` shows the wrong
account, `firebase logout` then `firebase login`.

### 3. Test against the emulator first (optional, ~2 minutes)

```bash
firebase emulators:start --import=./emulator-data
```

Open http://localhost:5000 in a **private window** (so you are signed out) and
open the Community tab. You want the Next Game and Roast cards to render and the
DevTools console to be free of `permission-denied`. Then sign in as admin and
confirm Roast Studio still lists drafts and played fixtures.

### 4. Deploy the rules — only the rules

```bash
firebase deploy --only firestore:rules
```

`--only firestore:rules` matters: a bare `firebase deploy` would also push
Functions and Hosting. Propagation is a few seconds.

### 5. Verify in production, signed out

Open the live site in a **private window**. On the Community tab:

- Next Game and Roast of the Week render (assuming a scheduled fixture and a
  published roast exist).
- No amber warning banner at the top of the tab. Phase 1 makes a denied feed
  visible instead of silent, so that banner *is* the failure signal.
- DevTools console shows no `permission-denied` / "Missing or insufficient
  permissions".

Then sign in as admin and confirm Roast Studio still sees drafts.

### 6. Then ship the client

Merge the branch to `main`. GitHub Pages serves `main`, so that is what puts the
matching client queries live. Hard-refresh afterwards — the service worker caches
`app.js`, so a soft reload can keep serving the old one.

### If something looks wrong

Rules deploys are versioned. Firebase Console → Firestore → Rules → **History**,
pick the previous version, Restore. Faster than re-deploying from a revert
commit, and it does not touch data. The Rules Playground on the same screen will
simulate a read against a specific document path if you want to check a condition
without deploying.

### No index deploy needed

The Phase 1 public queries are single-field equality filters, sorted client-side
on purpose. Adding an `orderBy` alongside the `where` would require a composite
index and a second deploy — that was avoided deliberately.
