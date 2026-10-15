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

**What was and was not verified for this release.** In the authoring environment there was no network, so `npm ci` could not install Express or Firebase: the TypeScript build and the Express API tests were **not run**. What was run: the pure-logic tests (14 passing), an esbuild syntax pass over `src/server.ts` and the tests, a loose type check of the server against stubbed module types, and a headless-Chromium run of the real frontend against a small mock API with Firebase stubbed (59 checks: phone/tablet/desktop layouts, no horizontal overflow at 320 px, themes, avatar crop and upload request, XP/rank/K/D previews and confirmation steps, lock banners, admin screens, reduced motion; no console errors). That run proves the UI logic, not the live backend, real Firebase sign-in, Railway, a real Android phone or Safari. Run the tests in CI and do one manual pass on your deployment (register, approve, upload a picture, adjust XP, lock/unlock, approve a result) before inviting players. The stand-in does not emulate Firestore rules, indexes or real concurrency.

## Install on iPhone
1. Deploy the site over HTTPS and open its Railway domain in **Safari**.
2. Tap **Share** in Safari, then **Add to Home Screen**.
3. Keep the site online for sign-in and player data. The PWA can show its shell offline, but API-backed features need a connection.

Theme selector: choose **Classic** for the default clean interface, **Pink**, **Esports**, or **Modern**. The choice is stored locally in that browser.
