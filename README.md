# FF Arena

Express + TypeScript backend, Firebase Auth, Firestore, and a mobile-first installable PWA served by one Railway service. The UI includes **Classic**, **Pink**, **Esports**, and **Modern** themes. **Esports** is the default for anyone without a saved theme choice; a theme someone already picked is kept (same `theme` key in `localStorage`).

## Latest maintenance pass
- Fixed score validation so `NaN`/infinity, fractional scores, and scores that contradict the submitted winner are rejected.
- Added baseline security response headers, disabled Express fingerprinting, disabled API caching, and configured a single trusted proxy hop for Railway rate limiting.
- Made admin notifications await their writes so failed writes aren't silently abandoned.
- Fixed the stats editor so omitting a K/D override preserves the current override; sending `null` or an empty value explicitly clears it.
- Updated rank star display to show a visible 1–5 stars within a rank, including five stars at the top of a rank band.
- Expanded owner export to page through collections and include teams, notifications, users, config, flags, and related data instead of silently stopping at the first 5,000 documents.
- Added a calmer Classic theme, a Pink theme, an Esports theme, and retained Modern as a fourth option. Theme choice persists in the browser.
- Improved phone layout, accessible focus states, touch target sizes, bottom navigation scrolling, and iPhone safe-area spacing. Added iOS web-app metadata and a PNG Apple touch icon.
- Updated the service worker with cache versioning, old-cache cleanup, offline navigation fallback, and a rule never to cache API responses.

The maintenance pass does not imply a live deployment: configure Firebase/Railway and verify against your own project before inviting players. See the testing notes below for what could and could not be verified in this environment.

## Esports overhaul (this release)
Everything below lives in the existing app: same Express/TypeScript backend, Firebase Auth, Firestore through the Admin SDK, `public/` frontend, PWA, `/health`, start command and environment variable names.

**Frontend** (`public/index.html`, `app.css`, `app.js`, `admin.js`): a mobile-first design system with four themes, bottom navigation on phones and a sidebar on desktop, bottom-sheet dialogs instead of `prompt()`/`alert()`, skeleton loaders, empty/error states and `prefers-reduced-motion` support. `admin.js` is only downloaded by admins. The public leaderboard renders while Firebase loads, with one auth listener and short GET de-duplication.

**Player**: dashboard (picture, display name, in-game name, FF Arena ID, rank artwork and progress, XP, rating, matches, win rate, K/D, recent results), profile editing, profile picture upload with preview/crop, theme choice, password-reset email. Values that don't exist show "—", never made-up numbers. K/D is labelled **Self-reported** or **Reviewed by admin**; nothing claims Garena verification.

**Admin**: Overview, Pending registrations (approve / reject / request a correction), All players (search by display name, in-game name, UID or FF Arena ID; status filters), Player details, visual Rank management, XP adjustment form with live preview, Stats & K/D correction, Profile locks, Recent changes, Settings (themes, rules config as a form, owner-only admin appointment and export). Bulk rank updates remain under **Advanced** in Rank management with explicit selection, preview and confirmation. Match, tournament, team and flag tools use forms instead of prompts.

### Rank artwork
`RANK_META` in `src/logic.ts` holds each rank's tier, colours and motif next to the existing rank names and thresholds. `GET /api/meta` serves it and the browser draws original SVG emblems from it (no game assets). If the metadata or a symbol is missing, a neutral emblem is shown. Ranking rules and calculations are unchanged; a player can never pick a rank.

### Profile pictures: where they are stored
Firebase Storage is **not** configured in this project (no bucket variable, no Storage rules), so pictures use a separate Firestore collection, `avatars/{uid}`, never the player document. The browser crops and shrinks the photo to a small square (WebP, JPEG fallback) and the server accepts only JPEG/PNG/WebP detected by file signature, at most 150 KB, 12 changes per hour per user. The player document keeps only a small `avatarV` version number used for cache busting. Public pictures are served from `/api/avatars/<FF Arena ID>?v=<n>` only for approved players; a pending player's picture is visible to that player and to admins only. No setup is needed. If you later want Firebase Storage, you would create a bucket, add it to the Admin SDK initialisation and swap the three small read/write helpers around `avatars/`; this has not been built or tested.

### Data changes (backward compatible, nothing migrated or deleted)
New optional fields with safe defaults: `playerProfiles.displayName`, `avatarV`, `locked`, `lockReason`, `lockedAt`; `registrations.displayName`, `avatarV`, `note` and status `NEEDS_CORRECTION`; collections `avatars/{uid}` and `lockHistory/{uid}`. Old records keep working: a missing `displayName` falls back to `gameName`, a missing `locked` means unlocked. `gameName` is the Free Fire in-game name. **Real names are no longer asked for.** Registration accepts an optional `realName` so older clients and existing data keep working, but the UI never asks for or shows it.

### Profile locks
Admin-only (`POST /api/admin/players/:uid/lock`). A locked player cannot edit profile fields or the picture, create/accept/submit challenges, and cannot be added to an admin-created challenge; they can still sign in/out, claim daily login and dispute a result. Checked on the backend for every one of those routes. Locking is independent of approval and roles.

### Owner claim
Unchanged in purpose and still one-time: sign up, then use **Owner setup** on the registration screen with `BOOTSTRAP_SECRET`. Hardened: constant-time comparison, 5 tries per 15 minutes per account, only accounts that have not registered can claim it (pending, rejected and approved players cannot), the secret is never sent to the browser or logged. After the owner exists the secret is useless; remove or rotate it. If you had already registered as a player before claiming, set your own `users/<uid>.role` to `owner` once in the Firestore console.

### One manual step: Firestore index (recommended)
Notifications are read newest-first with a limit. This needs a composite index (`firestore.indexes.json`). Without it the app still works (it falls back to reading and sorting in memory), only slower as notifications accumulate. Create it with `firebase deploy --only firestore:indexes`, or open the link Firestore prints in the Railway logs the first time.

### Performance changes
Profile collection reads are shared through a 5-second cache that is cleared after every write (`PROFILE_CACHE_MS` overrides it); the leaderboard is paged (30 rows, search server-side) instead of returning everything; the leaderboard no longer re-reads all profiles for every name lookup; static text assets are gzipped once per file version and revalidated with ETags; the service worker serves cached assets instantly and refreshes them in the background; avatars are small, immutable-cached files. These come from reading the code, not from before/after benchmarks on your Railway instance.

## Challenge announcements and community results
- **Announcements:** when a player challenges another player (`POST /api/challenges`), every other approved player gets a notification such as *Alex challenged Bea: “Sunday showdown”*. The opponent keeps their existing personal *You have a new challenge* notice (no duplicate) and the challenger isn't notified of their own action. When an admin schedules a match (`POST /api/admin/challenges`), all approved players are told (*New match scheduled: A vs B*). Rejected or invalid requests announce nothing, and if sending the announcements fails the challenge itself still succeeds. Notifications appear in the existing **Notifications** list on Home (the latest 20).
- **Recent matches for everyone:** `GET /api/recent-matches?limit=15` (signed-in player, admin or owner; max 30) returns the latest approved results from all players: both display names and avatars, title, winner, score and time, newest first. It contains no uids, UIDs or real names. Corrected results show their corrected values. On Home, **Recent matches** has an **Everyone** tab (default) and a **Mine** tab (your own results, as before).
- Not included: a notification when a result is approved for players outside the match (the community feed covers that), and mute/opt-out settings.

## Open matches (player-created public matches)
Any approved, unlocked player can host a public match and choose how many players it holds. It is published immediately, with no admin approval, and appears on the **Play** page under **Open Matches**. Other players join with one tap until it starts. Open matches are separate from admin-run challenges and never change XP, rating, the ledger or any player statistic, whether they are joined, filled or cancelled.

**Routes** (all require a signed-in account whose role is `player`; admins/owners, pending, rejected and new accounts get 403, no token gets 401):

| Route | What it does |
|---|---|
| `GET /api/open-matches` | Open matches that haven't started (or started in the last 2 hours), soonest first, max 50. Each item has `title`, `mode`/`modeLabel`, `scheduledAt` (ms), `capacity`, `occupied`, `remaining`, `full`, `started`, `creatorName`, `creator`, `players`, plus per-viewer flags `isCreator`, `joined`, `canJoin`, `canCancel`. No raw uids are returned. |
| `POST /api/open-matches` | Create and publish. Body: `{ title, mode, scheduledAt, capacity }`. Returns 201 and the new match. |
| `POST /api/open-matches/:id/join` | Join in a Firestore transaction. 404 missing, 403 locked/unapproved, 409 cancelled, started, already joined or full. |
| `POST /api/open-matches/:id/cancel` | Creator only (403 otherwise), only while `OPEN` (409 otherwise). Joined players get a notification. |

**Validation** (server side, rules in `parseOpenMatch` in `src/logic.ts`): title 3-60 characters; mode `br` (Battle Royale) or `cs` (Clash Squad), long names are accepted too; capacity is a whole number that **includes the creator**, 2-50 for Battle Royale and 2-8 for Clash Squad; start time must be between 1 minute and 30 days from now. Locked profiles cannot create or join (a locked creator can still cancel their own match). Limits: 3 open matches per creator at a time (best effort, checked just before the write, so two perfectly simultaneous creates could overshoot by one), 10 creations per hour and 40 joins per 10 minutes per player (`OPEN_MATCH_CREATE_PER_HOUR` / `OPEN_MATCH_JOIN_PER_10MIN` override), on top of the global API rate limit. The creator, status, participants and counts are always set by the server; anything of that kind in the request body is ignored.

**Schema**: collection `openMatches/{autoId}`.
```
creatorUid: string        server-set from the signed-in user
creatorName: string       display name when created
title: string
mode: "br" | "cs"
scheduledAt: Timestamp
capacity: number          total slots including the creator
participants: string[]    uids; participants[0] is always the creator, so the creator occupies one slot
participantCount: number  always participants.length
status: "OPEN" | "CANCELLED"
createdAt: Timestamp      cancelledAt?: Timestamp   cancelledBy?: string
```
Joining reads and writes the match in one transaction, so simultaneous joins can't exceed `capacity` or add the same player twice. The list query filters on `status` only (a single-field index Firestore creates by itself), so there is **no new index to deploy**. `firestore.rules` is unchanged (clients still have no direct access). Matches stay in the collection after they start or are cancelled; there is no cleanup job yet.

Not included: leaving a match, kicking players, editing a match, reminders, and recording results for open matches. Results still go through admin challenges and tournaments.

## 1. Firebase (console.firebase.google.com)
1. Create a project. **Build > Authentication > Get started > Email/Password > Enable.**
2. **Build > Firestore Database > Create database** (production mode). Then open **Rules**, paste `firestore.rules`, Publish (clients are fully blocked; the backend uses the Admin SDK).
3. **Project settings > Your apps > Web (</>)**: register an app. Copy `apiKey`, `authDomain`, `projectId`, `appId`.
4. **Project settings > Service accounts > Generate new private key.** Open the downloaded JSON and copy ALL its text into the Railway variable below. Never paste it in chat or GitHub.
5. **Authentication > Settings > Authorized domains**: add your Railway domain after step 8.

## 2. GitHub
Create a repo, then **Add file > Upload files**. Upload the contents of the zip *after extracting it* (keep the `src`, `tests`, `public` folders; you can drag extracted folders in Chrome on Android or create files with **Add file > Create new file** and typing `src/server.ts` as the name). Do not upload `node_modules` or `.env`.

## 3. Railway
1. **New Project > Deploy from GitHub repo** > pick the repo.
2. **Variables**: add `FIREBASE_SERVICE_ACCOUNT_JSON`, `BOOTSTRAP_SECRET` (long random), `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` (see `.env.example`).
3. **Settings > Networking > Generate domain.** Health check: `/health`.

## 4. Create the first owner
Open the site, sign up, then on the registration screen use the **Owner setup** box with your `BOOTSTRAP_SECRET`. It works once only. After that, remove or rotate the secret.

## Business rules
- Weeks and days use IST. Week = Monday to Sunday. Only admin-approved challenges (win, loss or draw) count toward the weekly 5. Cancelled challenges never count.
- XP floor is 0. Ranks derive from XP (5 stars per rank). K/D = kills/deaths (zero deaths = kills); an admin K/D override stays until cleared.
- Elo K=32, start 1000. Win +25 XP, draw +10, loss +5, daily login +5 (edit `CFG` in `src/logic.ts`).
- Idempotency: result approval is guarded by challenge status and deterministic ledger IDs (`<challenge>_<uid>`, `login_<uid>_<date>`), so repeats fail instead of duplicating.

## What is included
- Registration and approval, owner bootstrap, admin roles (owner appoints admins), player cards with privacy settings, leaderboards (XP, rating) and a team leaderboard.
- 1v1 challenges created by admins or players, result submission, review queue, approve / reject / correct, disputes (7-day window), duplicate and spam limits, anti-boost review flags (3 matches between the same pair in 24h; a flag asks for review and is never a cheating verdict).
- XP ledger (floor at 0, idempotent), Elo rating, 8 ranks with 5 stars, levels (`floor(sqrt(xp/base))+1`), daily login (IST), weekly 5-challenge target (IST, Monday-Sunday), weekly missions, badges.
- Tournaments / BR customs (preview, idempotent publish), bulk daily rank updates, mass stats editor with K/D override, XP adjust and rank override.
- Teams: 2-5 members (configurable), one team per player, separate team rating, team match history, team leaderboard.
- Config editor (K-factor, XP values, rank thresholds, level base, weekly target, team size). Saved in Firestore and applied immediately. Changing thresholds changes displayed ranks from stored XP.
- Owner JSON export. It is download-only and not stored anywhere.
- Audit log is append-only; no screen exists to delete it.

Correction caveat: reversal subtracts the stored rating change; later matches by the same players are not recomputed. Win streaks are not recalculated on correction.

## Still outstanding / manual verification
- **Backup restore:** owner export is available, but an import/restore workflow is not implemented. Keep downloaded exports somewhere private and safe.
- **Evidence uploads:** results accept text notes, but screenshot/file uploads and private evidence storage are not implemented.
- **Season management:** seasonal rating/XP resets and archive screens are not implemented; lifetime stats remain.
- **Corrections:** result corrections reverse the old stored rating delta but do not recompute all later matches for those players; win streaks also aren't rebuilt from full match history after a correction.
- **Admin UI:** routine admin work no longer uses browser prompts or raw JSON. The mass stats editor (`/api/admin/stats-bulk`) has no screen yet; single-player stats correction does.
- **Pictures:** no moderation queue beyond an admin's *Remove picture* action; no server-side image re-encoding (the browser shrinks it and the server enforces type and size).
- **Stats granularity:** K/D override remains a single player-wide override, not independent BR and CS overrides. BR rank positions from daily updates currently award XP but are not stored as a separate official BR rank.
- **Navigation:** player/admin navigation is role-aware, but separate BR, CS, weekly leaderboard views and a player team-join-request workflow are not implemented yet.

These are known gaps, not features to assume are present.

## Testing
Run `npm ci`, then `npm run build`, then `npm test` locally or in Railway CI. The suite covers pure rules (including rank progress and image-signature checks) and API tests that run the real Express app against an in-memory Firestore stand-in (`tests/fake.ts`): permissions, privacy, duplicate-reward prevention, corrections, teams, config, plus the new registration/correction flow, avatars, profile locks, owner-bootstrap hardening, admin lists, XP preview and leaderboard paging.

**What was and was not verified (open-matches release).** The authoring environment has no network access, so the real `express`, `firebase-admin` and `@types/*` packages could not be installed: **`npm run build` (the real `tsc`) was not run, and the tests were not run with real Express.** What was run: the pure-logic tests, and all 54 tests in `tests/` (39 API tests, 15 logic tests, all passing) against a small Express stand-in written only for this purpose (routing, JSON/raw body parsing, error handlers; it is not part of the repo) and the in-memory Firestore in `tests/fake.ts`; an esbuild syntax pass and a loose type check against stubbed module types; and a headless-Chromium run of the real frontend, served by the real `server.ts` routes through that stand-in, with Firebase sign-in stubbed (34 checks: create, join, race for the last slot, cancel, locked player, validation messages, four themes, 320 px width, challenge announcement and the community Recent matches tab). A mutation check confirmed the concurrent-join test fails if joining isn't transactional. Please run `npm ci && npm run build && npm test` in CI and do one manual pass on your deployment with two real accounts (create, join, cancel) before inviting players.

Test-fixture notes: `tests/fake.ts` now re-runs a transaction when a document it read changed before commit (as Firestore does), supports `FieldPath.documentId()` and `startAfter`, so the concurrency and owner-export tests are meaningful. Two older tests that were already failing on the original upload were fixed: the owner-export test (the fake lacked `FieldPath`/`startAfter`) and a challenge test that sent a result without scores to a route that validates the body first. No application behaviour was changed for either. The fake still does not emulate Firestore security rules, indexes or true parallelism.

## Install on iPhone
1. Deploy the site over HTTPS and open its Railway domain in **Safari**.
2. Tap **Share** in Safari, then **Add to Home Screen**.
3. Keep the site online for sign-in and player data. The PWA can show its shell offline, but API-backed features need a connection.

Theme selector: choose **Classic** for the default clean interface, **Pink**, **Esports**, or **Modern**. The choice is stored locally in that browser.
