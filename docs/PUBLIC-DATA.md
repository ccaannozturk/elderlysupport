# Public league data — the read-only contract

One file, regenerated on demand, served as a static asset by GitHub Pages:

```
https://<your-pages-domain>/public-data/league.json
```

Anyone may fetch it. No API key, no login, no Firebase SDK, no CORS setup —
GitHub Pages sends `Access-Control-Allow-Origin: *`, so a browser can read it
directly too. It is roughly 155 KB (minified; Pages gzips it on the way out).

This file exists so outside consumers (currently a WhatsApp chatbot) never touch
Firestore. That means they cannot cost the project anything, cannot be rate
limited by the league's quota, and cannot break when the internal schema
changes.

---

## For whoever is building against this

### Fetch it, cache it

```js
const res  = await fetch('https://<your-pages-domain>/public-data/league.json');
const data = await res.json();
```

**Cache the result and refresh at most every 10–15 minutes.** It only changes
when the maintainer regenerates it, which is a manual step after match entry.
Re-fetching per chat message is pure waste.

### Shape

```jsonc
{
  "schemaVersion": 2,          // bumped if the shape changes in a breaking way
  "generatedAt": "2026-08-21T14:00:00.000Z",
  "counts":    { "matches": 65, "players": 68, "venues": 5 },
  "dateRange": { "first": "2026-01-07", "last": "2026-08-15" },
  "venues":    ["Sporthal Calvijn", "..."],

  "players": [
    {
      "name": "Hector",           // display name; there are no ids in this file
      "appearances": 40,
      "won": 12, "drawn": 14, "lost": 14,
      "points": 38,               // 3 per win, 1 per draw
      "pointsPerGame": 0.95,
      "winRate": 30,              // percent, rounded
      "standardAppearances": 34,  // Standard matches only
      "goalsFor": 177,            // Standard matches only (see below)
      "goalsAgainst": 190,
      "goalDifference": -13,
      "firstAppearance": "2026-01-07",
      "lastAppearance": "2026-08-15",

      // --- the site's own models (schemaVersion 2) ---
      "elo": 1360,
      "eloProvisional": false,    // true under 5 appearances — do not rank these
      "streaks": {
        "currentWin": 2, "currentLoss": 0, "currentUnbeaten": 8,
        "longestWin": 3, "longestLoss": 2, "longestUnbeaten": 11
      },
      "recentForm": ["W","W","D","W","W"],   // oldest to newest
      "debutDate": "7/1/2026",
      "attendanceRate": 60,       // percent of games played since their debut
      "gamesSinceDebut": 65,
      "nemesis": { "name": "Ole", "playedAgainst": 15, "won": 4, "drawn": 3, "lost": 8 },
      "duoSplits": [              // top 5 by meetings: record WITH vs AGAINST
        { "name": "Hector",
          "together": { "played": 11, "won": 4, "drawn": 4, "lost": 3, "wr": 36 },
          "opposed":  { "played": 13, "won": 8, "drawn": 1, "lost": 4, "wr": 62 } }
      ]
    }
  ],

  "eloLeaderboard": [            // non-provisional players, best first
    { "name": "Can", "elo": 1360, "appearances": 39 }
  ],
  "pairs": [                     // every duo with at least one game together
    { "players": ["Hector","Stefan"], "played": 13, "won": 6, "drawn": 4,
      "lost": 3, "winRate": 46, "pointsPerGame": 1.69 }
  ],
  "optimalLineup": [ { "name": "Can", "elo": 1360, "appearances": 39 } ],
  "ironMen": [ { "name": "Hector", "appearances": 40, "attendanceRate": 62 } ],
  "oneCapWonders": ["Jeremy", "Alex"],

  "matches": [                    // newest first
    {
      "id": "abc123",
      "date": "2026-08-15",       // YYYY-MM-DD
      "venue": "Zeeburgereiland - Outdoor",
      "type": "Standard",         // "Standard" | "Tournament"
      "result": "Pech GeZwollen", // winning team name, or "draw", or null
      "youtube": null,            // https URL or null
      "teams": [
        { "name": "Eclipse united", "score": 9,  "players": ["Anderson", "Enes"] },
        { "name": "Pech GeZwollen", "score": 13, "players": ["Can", "Sam"] }
      ]
    }
  ]
}
```

### The five things that will trip you up

1. **Two match types.** `Standard` is two teams with `score`. `Tournament` is
   three teams with `rank` (1/2/3), `points` (3/1/0) and `shirtColour`, and
   **no goals at all**. Almost every statistic has to handle both.

2. **Tournament matches record no goals.** `goalsFor` / `goalsAgainst` /
   `goalDifference` count Standard matches only — that is what
   `standardAppearances` is for. Never divide goals by `appearances`; divide by
   `standardAppearances`.

3. **`shirtColour` is not rank.** In a tournament, colour (yellow/blue/red) is
   fixed per team slot and says nothing about who won.

4. **Names, not ids.** Player identity is resolved before export, so
   `"Daniel Gomez"` and `"Daniel Müller"` are already distinct and correct.
   Match on the exact `name` string. Do not try to re-merge names that look
   similar — the league has a `Javi Farres` and a `Javi Bernardo` who are two
   different people, and an `Anderson` who is not `Anderson Brazil`.

5. **Small samples lie.** Someone with 2 appearances and a 100% win rate is not
   the best player. The site requires 10 appearances before ranking anyone on
   points-per-game, and marks Elo `eloProvisional` under 5 appearances — respect
   both. `eloLeaderboard` already excludes provisional players; use it rather
   than sorting `players` by `elo` yourself.

### What is not in here, and why

- Nothing model-related any more. Elo, chemistry (`pairs`), streaks, form,
  nemesis, duo splits and attendance are all exported as of `schemaVersion 2`,
  and they are computed by `stats-core.js` — **the same file the website loads**.
  They are not a reimplementation, so they cannot disagree with the site.
  **Do not compute your own rating.** If you need a figure that is not here,
  ask for it to be exported rather than deriving a second version of it.
- **Roasts.** Some players have opted out of being roasted. That opt-out is
  enforced on the site and does not automatically travel. **Do not generate
  roasts, insults, or mocking commentary about named players from this data.**
  Stats questions, yes. Personal jabs, no.
- **Upcoming fixtures.** Not currently exported. Easy to add if the bot needs
  "when is the next game" — ask.
- **Anything private.** This file is built from collections that are already
  world-readable. No email addresses, no credentials, no admin data.

### Attribution and staleness

Show `generatedAt` if a user asks how fresh the data is, and check
`schemaVersion` — if it is not `1`, something changed and your parsing may need
updating.

---

## For the maintainer: regenerating it

**It refreshes itself.** `.github/workflows/refresh-public-data.yml` regenerates
and commits the file every 6 hours, and the workflow only commits when the data
actually changed, so a quiet week produces no commits at all.

To publish immediately after a match night, go to **Actions → Refresh public
league data → Run workflow**. Pages serves the new file a minute or two later.

By hand, if you prefer:

```bash
node scripts/export-public.js
git add public-data/league.json
git commit -m "Refresh public league export"
git push
```

No credentials are involved anywhere — the script reads the public REST API,
exactly like `scripts/backup.js`, and the workflow needs only the built-in
`GITHUB_TOKEN`.

### Where the numbers come from

`scripts/export-public.js` requires `stats-core.js`, which `index.html` also
loads. There is one implementation of Elo, chemistry, streaks and the rest, and
both the website and this export run it. `tests/elo-parity.test.js` additionally
pins `functions/index.js` (which keeps its own copy, since Cloud Functions only
upload the `functions/` directory) to the same results.
