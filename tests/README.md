# Firestore rules tests

44 assertions covering every collection the app touches, run against the
official rules emulator. No production access, no credentials.

```bash
npm i --no-save firebase-tools @firebase/rules-unit-testing firebase
npx firebase emulators:start --only firestore --project demo-esl   # port 8085
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node tests/firestore-rules.test.js
```

The test reads `current.rules`; copy `firestore.rules` to that name, or edit the
path at the top of the file. Exit code is non-zero if any assertion mismatches.

What it pins down, beyond the obvious allow/deny pairs:

- The public `fixtures` / `roasts` listeners must carry their `where` clause. An
  unconstrained listen is denied — that is the bug that hid the Roast and Next
  Game cards from everyone except the admin.
- `config/gemini` (the API key) is unreadable by every client, admin included.
  Only Cloud Functions reach it, through the Admin SDK.
- `config/gemini_meta` is admin-readable but client-unwritable.
- `validMatch()` really does reject a non-timestamp date, one team, and four.
- Legacy `matches` / `players` are frozen even for the admin.
