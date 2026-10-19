# FF Arena V2 update: tournaments, leaderboard ban, player deletion, audit log

Everything here is **additive**. No existing collection was migrated, reset or rewritten, the Firebase project ID and Railway
config are untouched, and no new packages or environment variables are required.

## 1. What changed (every significant file)

| File | Change |
|---|---|
| `src/tournament.ts` (new) | Pure rules, no I/O: validation, status machine, scoring, standings, tie-breaks, round advancement, knockout brackets with byes, corrections, rewards |
| `src/tournaments.ts` (new) | All tournament API routes (player + admin), team invites, results, advancement, screenshots, reports, completion/XP, plus cleanup used by account deletion |
| `src/accountDeletion.ts` (new) | Admin delete-player: preview, typed confirmation, resumable job (`deletionJobs/{uid}`) |
| `src/server.ts` | Leaderboard ban endpoint + backend filter, `softAuth`, deleted-token block, richer audit log (labels, `summary`, filters), export includes new collections, small safety patches (see §6), routes wired in |
| `public/tournaments.js` (new) | Player pages: list, details, registration, team invites, standings, bracket, final results, report-a-problem |
| `public/admin-tournaments.js` (new) | Admin console: create/edit, status, entries/approvals, results entry + preview + confirm, ties, advance/reopen, bracket controls, screenshots, completion with reward preview |
| `public/admin.js` | Ban/Unban + Delete buttons on the player screen, "Hidden from leaderboard" filter, audit-log filters/search, route to the tournament console |
| `public/app.js`, `app.css`, `sw.js` | "Events" nav item and routes, tournament styles (bracket, standings), service-worker cache `v3` to `v4` |
| `tests/fake.ts` | Test Firestore now emulates transaction conflicts+retry, batches, deletes, Auth deletion; fixes the old export test |
| `tests/tournament.test.ts`, `tests/tournaments.api.test.ts` (new) | 49 new tests |

## 2. Behaviour decisions (so nothing surprises you)

* **Leaderboard ban** only hides the player from `/api/leaderboard` (all tabs and search), enforced in the backend query. Positions close up. XP, rank,
  stats, history, profile and the sign-in account are untouched; the banned player can still play, join tournaments and earn XP. Their direct profile
  page still opens by FF Arena ID. They see the notice and reason through `/api/me` (`leaderboard.hidden`). Players cannot change it (profile edits are whitelisted).
* **Delete player** is permanent and different from ban. Admins and owners can't be deleted (demote first) and you can't delete yourself.
* **Tournaments live in new collections** (`arenaTournaments/...`, `arenaInvites`, `deletionJobs`). The older "BR custom" tournaments are unchanged and separate.
* Tournament XP goes through the existing XP ledger and the existing rank rules. Normal match XP/rating is not touched, and tournament play does not count toward the weekly "tournament" mission.
* Team workflow: captain creates team, invites by FF Arena ID, invitees accept, captain submits the full roster (this is what takes a capacity slot).
  Admins can also register a full team directly. Optional per-tournament manual approval.
* Tie rules (points): total points, then kills, then best single-game placement. Anything still level is **never** decided automatically. Ties that
  affect qualifiers or rewarded places need an admin ruling (audited). Entries eliminated earlier rank below finalists by exit round; level ones share a rank.
* Knockout: standard seeding; byes go to the top seeds; a result advances nobody until confirmed; corrections are only allowed while the next match has
  no result (reopen from the latest match backwards); withdrawals need an explicit walkover that is also confirmed.

## 3. Deleting a player: exactly what happens

Removed: sign-in account, profile, registration, picture, notifications, XP-ledger rows, legacy tournament-result rows, tournament entries before the start.
Cancelled/cleaned: open challenges, open matches they created, legacy team membership, review flags.
Kept on purpose: approved challenge results and post-start tournament results (the person shows as "Deleted player", uid replaced by an opaque tombstone),
and admin audit-log entries (accountability). The FF Arena ID counter is never reduced, so IDs are never reused.
If Firebase Auth or Firestore fails part-way, the account is already locked out; open the player again and press Delete to continue. The `deletionJobs` document
keeps the arena ID, actor, reason and step status (no email, token or secret).

## 4. Setup

* **Firebase indexes: none new.** All new queries are equality / array-contains / single-field.
* **Firestore rules: no change** (deny-all stays; everything goes through the backend).
* **Environment variables: none required.** Optional: `DELETE_PER_HOUR` (default 10 deletions/admin/hour).
* The existing service account must be allowed to manage Firebase Authentication users (it normally is, as an Admin SDK key). Test with one throwaway account first.

## 5. Deploy (phone-friendly)

1. Before deploying, as owner: Admin > Settings > Export data (backup). Optionally also use Firebase's Firestore export.
2. On GitHub's website, replace the repo files with this project's contents (upload the changed files listed in §1, keep `package.json`/lock as they are).
3. Railway redeploys automatically (`npm run build`, then `npm start`). Check `/health`.
4. Open the app twice (the service worker updates on the second open). The new **Events** tab and **Admin > Tournaments** appear.
5. Smoke-check with throwaway data: create a draft tournament, publish it, register a test player, then cancel it.

## 6. Small changes to existing behaviour

* Leaderboard excludes banned players. Audit page is now filterable. Deleted accounts get 401 even with a still-valid token.
* Safety patches: correcting an old challenge whose player was deleted now returns a clear 409 instead of crashing; the legacy teams list hides teams with zero members; export includes tournament data (not screenshots).

## 7. Rollback (keeps production data)

All new data lives in new collections/fields that the old code simply ignores.
1. Railway > Deployments > redeploy the previous successful deployment (or revert the commit on GitHub).
2. Do **not** delete `arenaTournaments`, `arenaInvites`, `deletionJobs` or the `leaderboardBanned*` profile fields. They are harmless to the old version, and removing them loses tournament history.
3. Effects of rolling back: old code doesn't know about the ban, so banned players reappear on the leaderboard until you roll forward again (the ban data is preserved). Unfinished tournaments pause. Completed tournament XP stays (it is in the ledger).
4. **Account deletions are permanent and cannot be rolled back.** Restoring one means re-registering the player (new FF Arena ID) or restoring from your export/Firestore backup.

## 8. Testing report (actual results)

`npm run build`: passes (TypeScript, no errors). `npm test`: **91 tests, 90 pass, 1 fail.**
* `tests/logic.test.ts`: 14/14 pass. `tests/tournament.test.ts` (new): 28/28 pass. `tests/tournaments.api.test.ts` (new): 21/21 pass.
* `tests/api.test.ts`: 27/28 pass. The one failure, *"player challenge flow, spam limits and disputes"*, **fails on the original upload too**: it expects 403 where the
  existing server validates the body first and answers 400. I did not change that behaviour. (A second original failure, the export test, only lacked `FieldPath` in the test fake and now passes.)
* New tests cover: unauthorized access (every sensitive endpoint, player and anonymous), ban/unban (hidden in the backend, search, self-service blocked, audit), deletion
  (others' data unchanged, Auth deleted, retry after Auth outage, locked out mid-way, admin/self refused, token can't come back, mid-tournament anonymising), solo/duo/squad sizes,
  invites, duplicates (including simultaneous requests), capacity overflow under 8 simultaneous registrations, manual approval, status/edit rules, points scoring, ties,
  advancement, corrections and reopen without duplicate advancement, unconfirmed results advancing nobody, byes for every field size 2-33, knockout corrections/walkovers/void,
  player reports blocking confirmation, reward idempotency (second completion rejected; pre-existing ledger row aborts everything), results locked after completion, screenshots (type/size/admin-only).
* **Not verified:** nothing was run against real Firebase, Railway, or a real phone/browser. Tests use an in-memory Firestore stand-in (with conflict+retry emulation, which approximates but is not
  identical to Firestore). The new screens were additionally exercised in a headless DOM (jsdom) against the real API (render + form handling), which is not a visual/touch test, so please check layout on your Android phone and an iPhone.

## 9. Known limitations

* Points tournaments model one lobby per game (no automatic lobby splitting). Capacity limits: 64 entries (points), 128 (knockout).
* No third-place match. Results are locked once a tournament is completed; use an audited XP adjustment for later corrections.
* Screenshots are stored in Firestore (max 500 KB, 60 per tournament), visible to admins only, never OCR'd or treated as verified.
* Deleting a player scans all tournaments (fine for a community of your size, slower for thousands).
* Audit-log filtering looks at the newest 300 entries (avoids a new index). Old `PROFILE_EDIT` log entries may still contain a deleted player's previous in-game name/UID (logs are kept on purpose).
* The player-side notice for a leaderboard ban is delivered via `/api/me` and a notification; there is no dedicated banner on the profile screen yet.
