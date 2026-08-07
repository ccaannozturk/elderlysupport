# Setup — what to do, in order

You only need to do this once. Roughly 30 minutes.

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

First message, roughly:

> Read CLAUDE.md and docs/PLAN.md. We're starting Stage A. Create the
> `stage-a-fixes` branch and start with item 3 (escaping and roster writes).
> Show me your plan before you edit anything.

Work through Stage A one or two items at a time. Review each diff, test against
the emulator, then merge to `main` when the whole stage is done and verified.

---

## 6. Your homework for Stage B

Stage B is blocked until you produce `data/roster-mapping.csv` — the authoritative
mapping from every name string that has ever appeared to a canonical player.

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
