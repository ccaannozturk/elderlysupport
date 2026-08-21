# Public league data — the read-only contract

One file, regenerated on demand, served as a static asset by GitHub Pages:

```
https://<your-pages-domain>/public-data/league.json
```

Anyone may fetch it. No API key, no login, no Firebase SDK, no CORS setup —
GitHub Pages sends `Access-Control-Allow-Origin: *`, so a browser can read it
directly too. It is roughly 75 KB.

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
  "schemaVersion": 1,          // bumped if the shape changes in a breaking way
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
      "lastAppearance": "2026-08-15"
    }
  ],

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
   points-per-game; apply something similar before making a claim.

### What is not in here, and why

- **Elo ratings, chemistry, streaks, form.** These are the site's opinionated
  models. Reimplementing them elsewhere would produce numbers that quietly
  disagree with the website, which is worse than not having them. If you need
  them, ask — better to export them than to invent a second formula.
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

```bash
node scripts/export-public.js
git add public-data/league.json
git commit -m "Refresh public league export"
git push
```

Pages serves the new file within a minute or two. No credentials are involved —
the script reads the public REST API, exactly like `scripts/backup.js`.

Do this after entering matches, whenever you want the bot to be current. If it
becomes a chore, it can be automated with a GitHub Action on a schedule.
