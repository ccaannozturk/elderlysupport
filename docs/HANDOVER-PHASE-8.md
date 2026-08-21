# Handover — Phase 8: Roast Studio fixture paste (no AI, drops teams, keeps role markers)

**Status: proposed, not started.** Written for a fresh agent with no memory
of the session that diagnosed it — read this whole file before touching
code. Nothing here has shipped.

**Independent of Phase 7.** `docs/HANDOVER-PHASE-7.md` covers three
unrelated items (the `queryStats` tournament/Elo gap, award-citation
removal, and public-data freshness) and was handed to a different agent.
This phase touches `window.onFixturePasteInput` in `app.js`,
`parseLineup`'s prompt in `functions/index.js`, and the fixture rendering
path — none of which Phase 7 modifies. The two can proceed in parallel; if
both are in flight, expect only trivial merge contact in `functions/index.js`
(Phase 7 deletes `generateAwardsCopy` around line 1432; this phase edits the
`parseLineup` prompt around line 391).

Once done, fold a summary into `docs/PLAN.md` under `## Phase 8` and delete
this file — matching how every other phase is recorded there.

---

## The problem

### The report

The maintainer pasted a real 3-team announcement into Roast Studio → Tab B
(Next Fixture) and it "couldn't pick up the names properly, it was looking
for neymar in the list, didn't recognize Kenta (R)". Their question was why
the Magic Paste rules didn't apply here.

### Diagnosis (reproduced against the exact paste)

**Because Magic Paste was never involved.** There are two unrelated
lineup parsers in this codebase:

- `parseLineup` (Cloud Function, `functions/index.js` ~line 302) — injects
  the roster into Gemini. Its prompt already handles Tournament (3-team)
  format, team-name headers, `Vs` separator lines, nickname/prefix
  resolution, and role-tag stripping. This is what the Admin tab's Magic
  Paste box uses.
- `window.onFixturePasteInput` (`app.js` ~line 4655) — a client-side regex
  parser with **zero AI involvement**, wired to the `fixtureSquadsPaste`
  textarea via `oninput`. This is what Roast Studio uses.

Running the maintainer's paste through the fixture parser's logic reproduces
three distinct failures:

1. **Team names are resolved as players.** The block-cleanup regex only
   strips literal prefixes matching `team a|squad a|yellow|blue|red`. A real
   team name like `"Neymark Senior 🇸🇦👴 in 🔴:"` survives and is passed to
   `resolvePlayerInput` as if it were a person — hence "looking for neymar".
2. **`(R)` role markers are not stripped.** `"Kenta (R)"` and `"Jonne (R)"`
   reach the resolver verbatim and fail. Note this is **also a gap in
   `parseLineup`'s prompt**, which lists `(Ref)`, `(Referee)`, `(GK)`,
   `(Keeper)`, `(c)`, `(Captain)` but not the bare `(R)` the maintainer
   actually uses. Fix it in both places.
3. **The third team is silently dropped.** The `vs`-splitter correctly
   produces 3 blocks, then the code takes only `rawBlocks[0]` and
   `rawBlocks[1]` and labels them "Squad A"/"Squad B". No warning is shown.

### Fixture 2-squad assumption is stack-wide

Confirmed by grep — this is not just the parser:

- `app.js` ~2542–2544 — `recordResultShortcut` prefill reads `squads[0]`,
  `squads[1]`
- `app.js` ~5015–5021 — same, in the fixture→match handoff
- `app.js` ~5129 — `selectFeaturedFixture` requires `squads.length >= 2`
- `app.js` ~5219–5220 — the Community "Next Game" card renders `sq1`/`sq2`
  only, with a hardcoded two-column layout
- `functions/index.js` ~2017 — `generateFixturePreview` requires
  `squads.length >= 2`

### Decision taken

**Support 3 teams properly** (maintainer's call, 2026-08-21). This matches how
tournament nights are actually announced in the group.

### The fix

1. **Route the fixture paste through `parseLineup`**, exactly as the Admin
   tab's Magic Paste does (`app.js` ~line 951 shows the call pattern,
   including its existing fall-back-to-local-parser behaviour on AI
   failure). Do **not** improve the regex parser in place — that would be a
   third parser to keep in step. Keep a local fallback only as
   `parseMagicPaste` already does, and make it fail loudly rather than
   silently dropping input.
2. **Add `(R)` to the role-tag list in `parseLineup`'s prompt**
   (`functions/index.js` ~line 391), alongside the existing `(Ref)`/`(GK)`
   variants. Check the local fallback parser strips it too.
3. **Extend fixtures to 3 squads** across every site listed above:
   - `saveFixture` already stores `squads` as an opaque array and needs no
     change beyond its `>= 2` guard; verify.
   - `generateFixturePreview` needs to handle a 3-way preview/prediction,
     not just A-vs-B. Its prompt will need rewriting for a 3-team framing.
   - The Community "Next Game" card needs a 3-squad layout. **Mind the
     mobile case** — Phase 2 item 7 fixed a nearly identical problem where a
     fixed multi-column layout broke at 360px. Follow that pattern (CSS grid,
     stacking on narrow screens) rather than adding a third `col-*`.
   - `recordResultShortcut` must prefill a Tournament match (3 teams, ranks)
     when the fixture has 3 squads, and a Standard match when it has 2.
   - `selectFeaturedFixture` and the fixture list rendering must not assume
     exactly 2.
4. **Keep 2-squad fixtures working.** Both shapes must coexist — the code
   should branch on `squads.length`, not switch wholesale to 3.

### Verification

- Paste the maintainer's exact 3-team announcement (it is in the session
  history; reconstruct an equivalent with real roster names) and confirm:
  all three teams resolve, `(R)` players resolve, no team name is treated as
  a player, and the fixture saves with 3 squads.
- Paste a normal 2-team announcement and confirm nothing regressed.
- Render both in the Community tab at 360px and at desktop width.
- Confirm Record Result prefills a Tournament match from a 3-squad fixture.

---

## Suggested order of work

1. **Parsing first, data shape second.** Routing the paste through
   `parseLineup` and adding `(R)` to the role-tag list are independently
   useful, much lower risk, and fix the maintainer's immediate complaint.
   Ship and verify that before starting the 3-squad work.
2. **Then the 3-squad extension**, which touches the fixture data shape and
   four rendering/handoff sites.

Each gets its own commit, and a line-item writeup folded into `docs/PLAN.md`
under `## Phase 8` when done — see how Phases 1–6 are recorded there for the
format to match.
