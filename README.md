# Elderly Support League

A single-page match tracker and leaderboard for a recreational football/futsal
group in Amsterdam (est. 2020). Live at:

**https://ccaannozturk.github.io/elderlysupport/**

## What it does

- Tracks **Standard** (two teams, goals) and **Tournament** (three teams, ranked)
  matches, mobile-first — entry happens on a phone at the sports hall.
- Computes a full statistics engine: Elo ratings, streaks and form, chemistry
  between pairs (filterable, sortable, with a focus mode for small screens),
  nemesis/rivalry, attendance, milestones, an optimal-lineup finder.
- A **Community tab**: next fixture, roast of the week, weekly power rankings,
  monthly awards — honest about small samples rather than blank when data is
  thin.
- **AI tools** (Gemini, via Cloud Functions): paste a raw WhatsApp lineup
  message and it becomes a structured match; auto-generated match recaps;
  natural-language stats Q&A; alias suggestions when adding a player.
- Installable as a PWA, works offline for reads, deep-linkable
  (`?player=`, `?match=`, `?roast=`, `?fixture=`).
- Publishes a read-only **`public-data/league.json`** — the same statistics
  the site itself computes, refreshed automatically, so a third party (a
  chatbot, a script) can build on the data without touching Firestore or
  needing credentials. See [`docs/PUBLIC-DATA.md`](docs/PUBLIC-DATA.md).

## Tech stack

Vanilla HTML/CSS/JS. No build step, no bundler, no framework — open
`index.html` and it runs. Bootstrap 5 for layout, Firebase (Firestore + Auth,
**compat** SDK) for data, Cloud Functions (Node 22) for anything that touches
the Gemini API.

`stats-core.js` holds every statistical engine and is loaded by both the
browser and the Node scripts that build the public export — one
implementation, so the website's numbers and the exported data can never
disagree.

## Access model

Two tiers, enforced independently in `firestore.rules`, `functions/index.js`,
and the client UI:

- **Organizer** — day-to-day running of the league: match entry, players,
  venues, fixtures, roasts, every AI tool.
- **Owner** — additionally: the Gemini API key/model (billing), roast opt-out
  settings, and anything irreversible (deleting a match, roast, fixture, or
  renaming/deleting a player).

## Local development

```bash
firebase emulators:start --import=./emulator-data
```

Serves the app at `localhost:5000` against a local Firestore, seeded from a
backup. See [`docs/SETUP.md`](docs/SETUP.md) for first-time setup.

## Documentation

| File | What it's for |
|---|---|
| `CLAUDE.md` | Project constraints and conventions for anyone (human or agent) editing this code |
| `docs/STATUS.md` | Current state: architecture, features, Cloud Functions, testing |
| `docs/PLAN.md` | The itemized build log — what shipped, what was declined, and why |
| `docs/SETUP.md` | First-time environment setup and the rules-deploy procedure |
| `docs/PUBLIC-DATA.md` | The contract for `public-data/league.json` |
| `docs/SERVICE_WORKER.md` | PWA caching strategy and the emergency kill switch |

---
*Maintained by [Can Öztürk](https://github.com/ccaannozturk).*
