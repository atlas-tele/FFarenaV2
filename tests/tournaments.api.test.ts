import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, store, authState } from "./fake";
import { tombstone } from "../src/tournament";

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "{}"; process.env.BOOTSTRAP_SECRET = "s3cret"; process.env.RATE_LIMIT = "100000"; process.env.PROFILE_CACHE_MS = "0"; process.env.DELETE_PER_HOUR = "1000";
const M = require("module"), orig = M._load;
M._load = function (r: string, ...a: any[]) { return r === "firebase-admin" ? fake : orig.call(this, r, ...a); };
const { app } = require("../src/server");
let srv: any, base = "";
before(() => { srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
beforeEach(() => { store.clear(); authState.deleted.length = 0; authState.disabled.length = 0; authState.failDelete = 0; authState.missing.clear(); });

const call = async (m: string, p: string, uid?: string, body?: any) => {
  const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json", ...(uid ? { Authorization: "Bearer tok:" + uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) as any };
};
const M0 = { matches: 0, wins: 0, kills: 0, deaths: 0, hs: 0 };
const role = (uid: string, r: string) => store.set(`users/${uid}`, { role: r, email: uid + "@x.test" });
const player = (uid: string, n: number, o: any = {}) => { role(uid, "player");
  store.set(`playerProfiles/${uid}`, { uid, arenaId: "FFA-" + String(n).padStart(4, "0"), status: "active", gameName: uid.toUpperCase(), ffUid: "123456" + n, realName: "Real " + uid, showRealName: false, showUid: true, xp: 100, rating: 1000,
    wins: 0, losses: 0, draws: 0, matches: 0, kills: 0, deaths: 0, kdOverride: null, stats: { br: { ...M0 }, cs: { ...M0 } }, statsSource: "self-reported", winStreak: 0, bestStreak: 0, weekly: {}, ...o }); };
const ids = (n: number) => Array.from({ length: n }, (_, i) => "p" + (i + 1));
const setup = (n = 8) => { role("adm", "admin"); role("own", "owner"); ids(n).forEach((u, i) => player(u, i + 1)); };
const P = (u: string) => store.get(`playerProfiles/${u}`);
const H = 3600e3, iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const A = "/api/admin/arena-tournaments", PUB = "/api/arena-tournaments";
const def = (o: any = {}) => ({ name: "Friday Cup", description: "Test", mode: "solo", format: "points", capacity: 8, regOpensAt: iso(-H), regClosesAt: iso(24 * H), startsAt: iso(48 * H),
  scoring: { placementPoints: [12, 9, 8, 7, 6, 5, 4, 3], killPoints: 1, winBonus: 0 }, roundsConfig: (o.capacity ?? 8) > 2 ? { count: 2, gamesPerRound: 1, qualifiers: [2] } : { count: 1, gamesPerRound: 1, qualifiers: [] }, rewards: { placementXp: [100, 60, 40] }, ...o });
async function open(o: any = {}) {
  const c = await call("POST", A, "adm", def(o)); assert.equal(c.s, 201, JSON.stringify(c.b));
  const id = c.b.id as string;
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "PUBLISHED" })).s, 200);
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "REGISTRATION_OPEN" })).s, 200);
  return id;
}
const reg = (id: string, u: string, teamName?: string) => call("POST", `${PUB}/${id}/register`, u, teamName ? { teamName } : {});
const closeAndStart = async (id: string) => { assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "REGISTRATION_CLOSED" })).s, 200); return call("POST", `${A}/${id}/start`, "adm", {}); };
const rows = (order: string[], kills: Record<string, number> = {}) => order.map((entryId, i) => ({ entryId, placement: i + 1, kills: kills[entryId] || 0 }));
const entryOf = async (id: string, u: string) => (await call("GET", `${PUB}/${id}`, u)).b.mine.entry.id as string;
const T0 = (id: string) => store.get(`arenaTournaments/${id}`);
const auditActions = () => [...store.entries()].filter(([k]) => k.startsWith("adminAuditLogs/")).map(([, v]) => v);
const ledgerRows = () => [...store.keys()].filter(k => k.startsWith("xpLedger/"));

// ===================== authorization =====================
test("unauthorized users cannot delete, ban, manage tournaments or confirm results", async () => {
  setup(); const id = await open();
  const attempts: [string, string, any][] = [["POST", `/api/admin/players/p2/delete`, { reason: "x y z", confirm: "FFA-0002" }], ["POST", `/api/admin/players/p2/leaderboard-ban`, { banned: true, reason: "abc" }],
    ["POST", A, def()], ["PATCH", `${A}/${id}`, { name: "Hacked name" }], ["POST", `${A}/${id}/status`, { to: "CANCELLED", reason: "abc" }], ["POST", `${A}/${id}/start`, {}], ["POST", `${A}/${id}/rounds/1/games/1/confirm`, {}],
    ["POST", `${A}/${id}/matches/r1m1/confirm`, {}], ["POST", `${A}/${id}/complete`, {}], ["POST", `${A}/${id}/entries`, { arenaIds: ["FFA-0001"] }], ["GET", `${A}/${id}`, undefined], ["GET", `/api/admin/audit`, undefined]];
  for (const [m, p, b] of attempts) {
    assert.equal((await call(m, p, "p1", b)).s, 403, "player " + m + " " + p);
    assert.equal((await call(m, p, undefined, b)).s, 401, "anonymous " + m + " " + p);
  }
  assert.equal(store.get("users/p2").role, "player"); assert.ok(P("p2")); assert.equal(P("p2").leaderboardBanned, undefined);
});

// ===================== leaderboard ban =====================
test("leaderboard ban hides the player from rankings (backend), keeps everything else, and unban restores", async () => {
  setup(4); P("p1").xp = 900; P("p2").xp = 800;
  const lb = async () => (await call("GET", "/api/leaderboard")).b.rows.map((r: any) => r.arenaId);
  assert.deepEqual((await lb()).slice(0, 2), ["FFA-0001", "FFA-0002"]);
  assert.equal((await call("POST", "/api/admin/players/p1/leaderboard-ban", "adm", { banned: true })).s, 400); // reason required
  assert.equal((await call("POST", "/api/admin/players/p1/leaderboard-ban", "adm", { banned: true, reason: "Boosting suspicion" })).s, 200);
  assert.ok(!(await lb()).includes("FFA-0001")); assert.equal((await call("GET", "/api/leaderboard?q=P1")).b.total, 0); // not even via search
  assert.equal((await call("GET", "/api/leaderboard?tab=rating")).b.rows.some((r: any) => r.arenaId === "FFA-0001"), false);
  assert.equal(P("p1").xp, 900); assert.equal(store.get("users/p1").role, "player"); assert.deepEqual(authState.deleted, []); // nothing deleted or suspended
  assert.equal((await call("GET", "/api/leaderboard")).b.rows[0].pos, 1); // positions close up, no gap
  const me = await call("GET", "/api/me", "p1"); assert.equal(me.b.leaderboard.hidden, true); assert.match(me.b.leaderboard.reason, /Boosting/);
  assert.equal((await call("GET", "/api/admin/players?status=banned", "adm")).b.length, 1);
  assert.equal((await call("POST", "/api/admin/players/p1/leaderboard-ban", "adm", { banned: true, reason: "again again" })).s, 409);
  await call("PATCH", "/api/me/profile", "p1", { leaderboardBanned: false, gameName: "Sneaky" }); assert.equal(P("p1").leaderboardBanned, true); // a player can't lift their own ban
  assert.equal((await call("POST", "/api/admin/players/p1/leaderboard-ban", "p1", { banned: false })).s, 403);
  assert.equal((await call("POST", "/api/admin/players/p1/leaderboard-ban", "adm", { banned: false })).s, 200);
  assert.ok((await lb()).includes("FFA-0001")); assert.equal(P("p1").leaderboardBanned, false);
  const acts = auditActions().filter(a => a.action.startsWith("LEADERBOARD_"));
  assert.deepEqual(acts.map(a => a.action).sort(), ["LEADERBOARD_BAN", "LEADERBOARD_UNBAN"]);
  const ban = acts.find(a => a.action === "LEADERBOARD_BAN"); assert.equal(ban.actor, "adm"); assert.equal(ban.target, "p1"); assert.equal(ban.reason, "Boosting suspicion"); assert.ok(ban.at);
  assert.equal((await call("POST", "/api/admin/players/zzz/leaderboard-ban", "adm", { banned: true, reason: "abc" })).s, 404);
});

// ===================== account deletion =====================
test("deleting a player removes their account and records but leaves other players' data intact", async () => {
  setup(4);
  store.set("avatars/p1", { data: Buffer.alloc(20), contentType: "image/png" }); store.set("registrations/p1", { status: "APPROVED", gameName: "P1" }); store.set("lockHistory/p1", { entries: [] });
  store.set("notifications/n1", { uid: "p1", text: "hi" }); store.set("notifications/n2", { uid: "p2", text: "keep" });
  store.set("xpLedger/l1", { uid: "p1", amount: 5 }); store.set("xpLedger/l2", { uid: "p2", amount: 5 });
  store.set("challenges/ch-done", { playerA: "p1", playerB: "p2", status: "APPROVED", effects: { A: {}, B: {} }, result: { winner: "A", scoreA: 1, scoreB: 0 }, title: "Old duel" });
  store.set("challenges/ch-open", { playerA: "p3", playerB: "p1", status: "SCHEDULED", title: "Open duel" });
  store.set("teams/t1", { name: "Duo", captain: "p1", members: ["p1", "p2"], rating: 1000, wins: 0, losses: 0, draws: 0, matches: 0 });
  store.set("openMatches/m1", { creatorUid: "p1", title: "Mine", status: "OPEN", participants: ["p1", "p2"], participantCount: 2, capacity: 4, mode: "br", scheduledAt: new Date(Date.now() + H) });
  store.set("openMatches/m2", { creatorUid: "p2", title: "Theirs", status: "OPEN", participants: ["p2", "p1"], participantCount: 2, capacity: 4, mode: "br", scheduledAt: new Date(Date.now() + H) });
  store.set("appConfig/counters", { players: 4 });
  const id = await open({ capacity: 8 }); await reg(id, "p1"); await reg(id, "p2");
  const before2 = JSON.stringify(P("p2")), before3 = JSON.stringify(P("p3"));

  const pv = await call("GET", "/api/admin/players/p1/delete-preview", "adm");
  assert.equal(pv.s, 200); assert.equal(pv.b.arenaId, "FFA-0001"); assert.equal(pv.b.confirmPhrase, "FFA-0001"); assert.match(pv.b.email, /^p\*+@x\.test$/); assert.equal(pv.b.tournaments, 1); assert.equal(pv.b.openChallenges, 0 + 1);
  assert.equal((await call("POST", "/api/admin/players/p1/delete", "adm", { reason: "Requested by player" })).s, 400); // no confirmation
  assert.equal((await call("POST", "/api/admin/players/p1/delete", "adm", { reason: "Requested by player", confirm: "FFA-0002" })).s, 400); // wrong player
  assert.ok(P("p1"));
  const del = await call("POST", "/api/admin/players/p1/delete", "adm", { reason: "Requested by player", confirm: "FFA-0001" });
  assert.equal(del.s, 200, JSON.stringify(del.b));

  for (const k of ["users/p1", "playerProfiles/p1", "registrations/p1", "avatars/p1", "lockHistory/p1", "notifications/n1", "xpLedger/l1"]) assert.equal(store.has(k), false, k + " should be gone");
  assert.deepEqual(authState.deleted, ["p1"]);
  assert.equal(JSON.stringify(P("p2")), before2); assert.equal(JSON.stringify(P("p3")), before3); // other players' profiles are byte-for-byte unchanged
  assert.ok(store.has("notifications/n2") && store.has("xpLedger/l2")); assert.ok(store.has("users/p2"));
  const done = store.get("challenges/ch-done"); assert.equal(done.playerA, tombstone("p1")); assert.equal(done.playerB, "p2"); assert.equal(done.result.scoreA, 1); // result kept for the opponent
  assert.equal(store.get("challenges/ch-open").status, "CANCELLED"); assert.equal(store.get("challenges/ch-open").playerB, tombstone("p1"));
  assert.deepEqual(store.get("teams/t1").members, ["p2"]); assert.equal(store.get("teams/t1").captain, "p2");
  assert.equal(store.get("openMatches/m1").status, "CANCELLED"); assert.deepEqual(store.get("openMatches/m2").participants, ["p2"]); assert.equal(store.get("openMatches/m2").status, "OPEN");
  assert.equal(T0(id).entryCount, 1); assert.equal(store.has(`arenaTournaments/${id}/players/p1`), false); assert.equal(store.get("appConfig/counters").players, 4); // arena IDs never reused
  const pub = await call("GET", `${PUB}/${id}`); assert.equal(pub.b.entries.length, 1);
  assert.ok(!JSON.stringify(pub.b).includes("p1")); // nothing identifying left on public pages
  // audit: who + when + why, and no secrets
  const log = auditActions().filter(a => a.action.startsWith("PLAYER_DELETE")); assert.deepEqual(log.map(a => a.action).sort(), ["PLAYER_DELETE", "PLAYER_DELETE_START"]);
  assert.ok(log.every(a => a.actor === "adm" && a.at && a.reason === "Requested by player" && a.targetLabel.includes("FFA-0001"))); assert.ok(!JSON.stringify(log).match(/token|password|secret|@x\.test/i));
  // the deleted account cannot come back with a still-valid token, nor be deleted twice
  assert.equal((await call("GET", "/api/me", "p1")).s, 401); assert.equal((await call("POST", "/api/register", "p1", { gameName: "Back", ffUid: "99999999", br: M0, cs: M0 })).s, 401);
  assert.equal((await call("POST", "/api/admin/players/p1/delete", "adm", { reason: "again again", confirm: "FFA-0001" })).s, 409);
  assert.equal((await call("GET", "/api/admin/audit", "adm")).s, 200);
});
test("deletion is safe to retry after a Firebase Auth outage and the account is locked out in the meantime", async () => {
  setup(3); store.set("notifications/n1", { uid: "p1", text: "hi" });
  authState.failDelete = 1;
  const body = { reason: "Requested by player", confirm: "FFA-0001" };
  const r1 = await call("POST", "/api/admin/players/p1/delete", "adm", body);
  assert.equal(r1.s, 502); assert.match(r1.b.error, /paused at “auth”/); assert.match(r1.b.error, /Press Delete again/);
  assert.equal(store.get("users/p1").role, "deleting");   assert.equal((await call("POST", "/api/challenges", "p1", { opponent: "p2", title: "Still here?" })).s, 403); // locked out already
  assert.equal(store.get("deletionJobs/p1").status, "IN_PROGRESS"); assert.equal(store.get("deletionJobs/p1").failedStep, "auth"); assert.equal(store.has("notifications/n1"), false); // earlier steps stay done
  assert.ok(P("p1")); // profile still there until the account is really gone
  const r2 = await call("POST", "/api/admin/players/p1/delete", "adm", body); assert.equal(r2.s, 200, JSON.stringify(r2.b));
  assert.equal(store.get("deletionJobs/p1").status, "COMPLETED"); assert.equal(store.has("playerProfiles/p1"), false); assert.deepEqual(authState.deleted, ["p1"]);
  assert.equal(auditActions().filter(a => a.action === "PLAYER_DELETE_START").length, 1); // no duplicate start record on resume
});
test("deletion tolerates an auth account that is already gone, and refuses admins and yourself", async () => {
  setup(3); authState.missing.add("p2");
  assert.equal((await call("POST", "/api/admin/players/p2/delete", "adm", { reason: "cleanup now", confirm: "FFA-0002" })).s, 200);
  assert.equal((await call("POST", "/api/admin/players/adm/delete", "adm", { reason: "me me me", confirm: "x" })).s, 400);
  assert.equal((await call("POST", "/api/admin/players/own/delete", "adm", { reason: "no way", confirm: "x" })).s, 409);
  role("p3", "admin"); assert.equal((await call("POST", "/api/admin/players/p3/delete", "adm", { reason: "no way", confirm: "FFA-0003" })).s, 409);
  assert.equal((await call("GET", "/api/admin/players/own/delete-preview", "adm")).b.blocked !== null, true);
  assert.equal((await call("POST", "/api/admin/players/nobody/delete", "adm", { reason: "none here", confirm: "x" })).s, 404);
});
test("deleting a pending registrant (no profile yet) works with the game name as confirmation", async () => {
  setup(2); role("r1", "pending"); store.set("registrations/r1", { status: "PENDING", gameName: "Newbie", ffUid: "99887766", br: M0, cs: M0 });
  assert.equal((await call("POST", "/api/admin/players/r1/delete", "adm", { reason: "spam signup", confirm: "Newbie" })).s, 200);
  assert.equal(store.has("registrations/r1"), false); assert.equal(store.has("users/r1"), false); assert.deepEqual(authState.deleted, ["r1"]);
});
test("deleting a player mid-tournament keeps the results and anonymises the player", async () => {
  setup(4); const id = await open({ capacity: 4, format: "knockout", scoring: undefined, roundsConfig: undefined });
  for (const u of ids(4)) await reg(id, u);
  await closeAndStart(id);
  const before = (await call("GET", `${A}/${id}`, "adm")).b;
  assert.equal((await call("POST", "/api/admin/players/p1/delete", "adm", { reason: "Requested by player", confirm: "FFA-0001" })).s, 200);
  const after2 = (await call("GET", `${A}/${id}`, "adm")).b;
  assert.equal(after2.entries.length, before.entries.length); // history not erased
  const e = after2.entries.find((x: any) => x.status === "WITHDRAWN"); assert.ok(e); assert.equal(e.members[0].displayName, "Deleted player"); assert.equal(e.withdrawnReason, "account_deleted");
  assert.equal(after2.state.bracket.rounds[0].matches.length, 2); // bracket intact; admin records the walkover
});

// ===================== registration =====================
test("solo registration: one entry per player, no duplicates, only approved players, closed/locked states", async () => {
  setup(3); const id = await open({ capacity: 2 });
  assert.equal((await reg(id, "p1")).s, 201); assert.equal((await reg(id, "p1")).s, 409);
  role("pend", "pending"); assert.equal((await reg(id, "pend")).s, 403);
  P("p3").locked = true; assert.equal((await reg(id, "p3")).s, 403);
  assert.equal((await reg(id, "p2")).s, 201); assert.equal(T0(id).entryCount, 2);
  P("p3").locked = false; const full = await reg(id, "p3"); assert.equal(full.s, 409); assert.match(full.b.error, /full/);
  const draft = (await call("POST", A, "adm", def())).b.id; assert.equal((await reg(draft, "p1")).s, 404); // drafts are invisible
  assert.equal((await call("GET", `${PUB}/${draft}`, "p1")).s, 404); assert.equal((await call("GET", `${PUB}/${draft}`, "adm")).s, 200);
  const late = (await call("POST", A, "adm", def({ regOpensAt: iso(-3 * H), regClosesAt: iso(-H) }))).b.id;
  await call("POST", `${A}/${late}/status`, "adm", { to: "PUBLISHED" }); assert.equal((await call("POST", `${A}/${late}/status`, "adm", { to: "REGISTRATION_OPEN" })).s, 409); // window already over
  assert.equal((await call("GET", PUB)).b.some((t: any) => t.id === draft), false);
});
test("capacity can never be exceeded, even when many players register at the same instant", async () => {
  setup(8); const id = await open({ capacity: 3 });
  const results = await Promise.all(ids(8).map(u => reg(id, u)));
  assert.equal(results.filter(r => r.s === 201).length, 3); assert.equal(results.filter(r => r.s === 409).length, 5);
  assert.equal(T0(id).entryCount, 3); const es = [...store.keys()].filter(k => k.startsWith(`arenaTournaments/${id}/entries/`)); assert.equal(es.length, 3);
  assert.equal([...store.keys()].filter(k => k.startsWith(`arenaTournaments/${id}/players/`)).length, 3);
});
test("the same player registering twice at the same instant only gets one entry", async () => {
  setup(2); const id = await open();
  const r = await Promise.all([reg(id, "p1"), reg(id, "p1"), reg(id, "p1")]);
  assert.equal(r.filter(x => x.s === 201).length, 1); assert.equal(T0(id).entryCount, 1);
});
test("duo needs exactly two players: invite, accept, then the captain submits; an incomplete team cannot take a slot", async () => {
  setup(6); const id = await open({ mode: "duo", capacity: 2 });
  assert.equal((await reg(id, "p1")).s, 400); // team name required
  const r = await reg(id, "p1", "Twin Peaks"); assert.equal(r.s, 201); assert.equal(r.b.status, "FORMING"); const eid = r.b.entryId;
  assert.equal(T0(id).entryCount, 0); // not counted until complete
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1")).s, 409); // only 1 of 2 players
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p2", { arenaId: "FFA-0003" })).s, 403); // not the captain
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0001" })).s, 400);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0002" })).s, 200);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0003" })).s, 409); // team of 2: 1 member + 1 invited is already full
  assert.equal((await call("GET", `${PUB}/invites`, "p2")).b.length, 1);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p3", { accept: true })).s, 409); // not invited
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p2", { accept: true })).s, 200);
  assert.equal((await reg(id, "p2", "Other")).s, 409); // already in a team
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p2")).s, 403);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1")).s, 200); assert.equal(T0(id).entryCount, 1);
  assert.equal(store.get(`arenaTournaments/${id}/entries/${eid}`).status, "REGISTERED"); assert.equal(store.get(`arenaTournaments/${id}/entries/${eid}`).members.length, 2);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1")).s, 409); assert.equal(T0(id).entryCount, 1);
  const e2 = (await reg(id, "p4", "Second")).b.entryId; await call("POST", `${PUB}/${id}/entries/${e2}/invite`, "p4", { arenaId: "FFA-0005" }); await call("POST", `${PUB}/${id}/entries/${e2}/respond`, "p5", { accept: true });
  assert.equal((await call("POST", `${PUB}/${id}/entries/${e2}/confirm`, "p4")).s, 200); assert.equal(T0(id).entryCount, 2);
  const full = await reg(id, "p6", "Third"); assert.equal(full.s, 409); assert.match(full.b.error, /full/); // both slots are taken, so no new team can even form
  const view = (await call("GET", `${PUB}/${id}`, "p2")).b; assert.equal(view.mine.entry.isCaptain, false); assert.equal(view.mine.entry.members.length, 2); assert.equal(view.entries.length, 2);
});
test("a decline frees the slot; a member leaving a submitted team reopens it and frees the capacity", async () => {
  setup(4); const id = await open({ mode: "duo", capacity: 2 });
  const eid = (await reg(id, "p1", "Duo A")).b.entryId; await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0002" });
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p2", { accept: false })).s, 200);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0003" })).s, 200); await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p3", { accept: true });
  await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1"); assert.equal(T0(id).entryCount, 1);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/leave`, "p3")).s, 200);
  assert.equal(T0(id).entryCount, 0); assert.equal(store.get(`arenaTournaments/${id}/entries/${eid}`).status, "FORMING"); assert.equal(store.has(`arenaTournaments/${id}/players/p3`), false);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/leave`, "p1")).s, 200); // captain disbands
  assert.equal(store.get(`arenaTournaments/${id}/entries/${eid}`).status, "WITHDRAWN"); assert.equal(store.has(`arenaTournaments/${id}/players/p1`), false);
  assert.equal((await reg(id, "p1", "Fresh start")).s, 201);
});
test("squad needs exactly four players", async () => {
  setup(6); const id = await open({ mode: "squad", capacity: 4 });
  const eid = (await reg(id, "p1", "Squad Up")).b.entryId;
  for (const [u, n] of [["p2", 2], ["p3", 3]] as const) { assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-000" + n })).s, 200); await call("POST", `${PUB}/${id}/entries/${eid}/respond`, u, { accept: true }); }
  const three = await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1"); assert.equal(three.s, 409); assert.match(three.b.error, /exactly 4/);
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0004" })).s, 200); await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p4", { accept: true });
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p1", { arenaId: "FFA-0005" })).s, 409); // squad is already full
  assert.equal((await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p1")).s, 200);
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0005", "FFA-0006"], name: "Short" })).s, 400); // admin path enforces size too
});
test("admin registration enforces size, duplicates and capacity; manual approval holds the slot until approved", async () => {
  setup(6); const id = await open({ mode: "duo", capacity: 2, approval: "manual" });
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0001", "FFA-0001"], name: "Dup" })).s, 400);
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0001", "FFA-0002"], name: "Alpha" })).s, 201);
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0002", "FFA-0003"], name: "Beta" })).s, 409); // p2 already registered
  const eid = (await reg(id, "p3", "Self")).b.entryId; await call("POST", `${PUB}/${id}/entries/${eid}/invite`, "p3", { arenaId: "FFA-0004" }); await call("POST", `${PUB}/${id}/entries/${eid}/respond`, "p4", { accept: true });
  const sub = await call("POST", `${PUB}/${id}/entries/${eid}/confirm`, "p3"); assert.equal(sub.s, 200);
  assert.equal(store.get(`arenaTournaments/${id}/entries/${eid}`).status, "PENDING_APPROVAL"); assert.equal(T0(id).entryCount, 2);
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0005", "FFA-0006"], name: "Gamma" })).s, 409); // full, the pending team holds a slot
  assert.equal((await call("POST", `${A}/${id}/entries/${eid}/reject`, "adm", { reason: "Wrong roster" })).s, 200); assert.equal(T0(id).entryCount, 1);
  assert.equal((await call("POST", `${A}/${id}/entries`, "adm", { arenaIds: ["FFA-0005", "FFA-0006"], name: "Gamma" })).s, 201);
  const acts = auditActions().map(a => a.action); assert.ok(acts.includes("TOURNEY_ENTRY_REJECT") && acts.includes("TOURNEY_ENTRY_ADD"));
});
test("status transitions and edits are validated on the server", async () => {
  setup(3); const c = await call("POST", A, "adm", def()); const id = c.b.id;
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "REGISTRATION_OPEN" })).s, 409); assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "IN_PROGRESS" })).s, 400); assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "COMPLETED" })).s, 400);
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "bogus" })).s, 400);
  assert.equal((await call("POST", A, "adm", def({ mode: "trio" }))).s, 400); assert.equal((await call("POST", A, "adm", def({ capacity: 1 }))).s, 400); assert.equal((await call("POST", A, "adm", def({ startsAt: iso(-H) }))).s, 400);
  assert.equal((await call("PATCH", `${A}/${id}`, "adm", { name: "Renamed cup" })).s, 200); assert.equal(T0(id).name, "Renamed cup");
  assert.equal((await call("PATCH", `${A}/${id}`, "adm", { name: "Renamed cup" })).s, 400); // nothing changed
  await call("POST", `${A}/${id}/status`, "adm", { to: "PUBLISHED" }); await call("POST", `${A}/${id}/status`, "adm", { to: "REGISTRATION_OPEN" }); await reg(id, "p1");
  assert.equal((await call("PATCH", `${A}/${id}`, "adm", { mode: "duo" })).s, 409); // locked once someone registered
  assert.equal((await call("PATCH", `${A}/${id}`, "adm", { capacity: 1 })).s, 400); assert.equal((await call("PATCH", `${A}/${id}`, "adm", { capacity: 9 })).s, 200); assert.equal(T0(id).capacity, 9);
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "CANCELLED" })).s, 400); // reason required
  assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "CANCELLED", reason: "Not enough interest" })).s, 200);
  assert.equal((await reg(id, "p2")).s, 409); assert.equal((await call("POST", `${A}/${id}/status`, "adm", { to: "PUBLISHED" })).s, 409);
  assert.ok(auditActions().filter(a => a.action === "TOURNEY_STATUS").length >= 3); assert.ok(auditActions().some(a => a.action === "TOURNEY_EDIT" && a.actor === "adm" && a.targetLabel));
});

// ===================== points format =====================
async function pointsRun() {
  setup(4); const id = await open({ capacity: 4, roundsConfig: { count: 2, gamesPerRound: 1, qualifiers: [2] } });
  for (const u of ids(4)) await reg(id, u);
  const st = await closeAndStart(id); assert.equal(st.s, 200, JSON.stringify(st.b));
  const e: Record<string, string> = {}; for (const u of ids(4)) e[u] = await entryOf(id, u);
  return { id, e };
}
test("points tournament: submit, preview, confirm, tie-aware advance, final, rewards once", async () => {
  const { id, e } = await pointsRun(); const g = `${A}/${id}/rounds/1/games/1`;
  assert.equal(T0(id).status, "IN_PROGRESS");
  // preview computes without saving
  const pv = await call("POST", `${g}/submit`, "adm", { rows: rows([e.p3, e.p1, e.p2, e.p4], { [e.p3]: 4 }), preview: true }); assert.equal(pv.s, 200);
  assert.equal(pv.b.rows.find((r: any) => r.entryId === e.p3).points, 12 + 4); assert.equal((await call("GET", `${A}/${id}`, "adm")).b.state.rounds[0].games[0].status, "EMPTY");
  assert.equal((await call("POST", `${g}/submit`, "adm", { rows: rows([e.p3, e.p1, e.p2]) })).s, 400); // missing a participant
  assert.equal((await call("POST", `${g}/submit`, "adm", { rows: [...rows([e.p3, e.p1, e.p2, e.p4]).slice(0, 3), { entryId: "ghost", placement: 4, kills: 0 }] })).s, 400);
  assert.equal((await call("POST", `${g}/submit`, "adm", { rows: rows([e.p3, e.p1, e.p2, e.p4], { [e.p3]: 4 }) })).s, 200);
  // UNCONFIRMED results advance nobody and are invisible to players
  assert.equal((await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {})).s, 409); assert.equal((await call("GET", `${A}/${id}`, "adm")).b.state.rounds[1].entryIds.length, 0);
  const publicView = (await call("GET", `${PUB}/${id}`, "p1")).b.state.rounds[0]; assert.equal(publicView.games[0].status, "EMPTY"); assert.deepEqual(publicView.standings.map((s: any) => s.points), [0, 0, 0, 0]);
  assert.equal((await call("POST", `${g}/confirm`, "p1")).s, 403);
  assert.equal((await call("POST", `${g}/confirm`, "adm")).s, 200); assert.equal((await call("POST", `${g}/confirm`, "adm")).s, 409);
  const pub2 = (await call("GET", `${PUB}/${id}`)).b.state.rounds[0]; assert.equal(pub2.standings[0].entryId, e.p3);
  const adv = await call("POST", `${A}/${id}/rounds/1/advance`, "adm", { preview: true }); assert.equal(adv.s, 200); assert.deepEqual(adv.b.qualifiers, [e.p3, e.p1]); assert.equal((await call("GET", `${A}/${id}`, "adm")).b.state.rounds[1].entryIds.length, 0); // preview changed nothing
  assert.equal((await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {})).s, 200); assert.equal((await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {})).s, 409); // second click can't advance again
  let d1 = (await call("GET", `${A}/${id}`, "adm")).b.state.rounds; assert.deepEqual(d1[1].entryIds.sort(), [e.p3, e.p1].sort()); assert.equal(d1[0].games[0].status, "CONFIRMED"); // previous round preserved
  assert.equal((await call("GET", `${PUB}/${id}`, "p3")).b.mine.entry.id, e.p3);
  // correction after advancing: blocked until the round is reopened, then recalculated without duplicating anything
  const fix = { rows: rows([e.p2, e.p3, e.p1, e.p4]), reason: "Placements were swapped" };
  assert.equal((await call("POST", `${g}/submit`, "adm", fix)).s, 409);
  assert.equal((await call("POST", `${A}/${id}/rounds/1/reopen`, "adm", {})).s, 400);
  assert.equal((await call("POST", `${A}/${id}/rounds/1/reopen`, "adm", { reason: "Fix placements" })).s, 200);
  assert.equal((await call("POST", `${g}/submit`, "adm", { rows: rows([e.p2, e.p3, e.p1, e.p4]) })).s, 400); // correcting a confirmed game needs a reason
  assert.equal((await call("POST", `${g}/submit`, "adm", fix)).s, 200); assert.equal((await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {})).s, 409); // must be re-confirmed
  await call("POST", `${g}/confirm`, "adm"); assert.equal((await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {})).s, 200);
  d1 = (await call("GET", `${A}/${id}`, "adm")).b.state.rounds; assert.deepEqual(d1[1].entryIds.sort(), [e.p2, e.p3].sort()); assert.equal(d1[0].games[0].corrections.length, 1); assert.equal(d1[0].games[0].corrections[0].reason, "Placements were swapped");
  // final round + completion
  assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 409); // final not confirmed yet
  const g2 = `${A}/${id}/rounds/2/games/1`; await call("POST", `${g2}/submit`, "adm", { rows: rows([e.p3, e.p2]) });
  assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 409); assert.equal(P("p3").xp, 100); // unconfirmed => no rewards
  await call("POST", `${g2}/confirm`, "adm");
  const xpBefore = ids(4).map(u => P(u).xp), ledgerBefore = ledgerRows().length;
  const pvc = await call("POST", `${A}/${id}/complete`, "adm", { preview: true }); assert.equal(pvc.s, 200); assert.equal(pvc.b.champion, "P3"); assert.deepEqual(pvc.b.rewards.map((r: any) => r.xp), [100, 60, 40]); assert.equal(ledgerRows().length, ledgerBefore);
  assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 200);
  assert.equal(P("p3").xp, 200); assert.equal(P("p2").xp, 160); assert.equal(P("p1").xp, 140); assert.equal(P("p4").xp, 100); // 3rd place was knocked out in round 1 but still ranks 3rd
  assert.equal(P("p3").rank !== undefined, true);
  assert.equal(ledgerRows().length, ledgerBefore + 3); assert.ok(store.has(`xpLedger/tour2_${id}_p3`)); assert.equal(store.get(`xpLedger/tour2_${id}_p3`).ref, id); assert.equal(store.get(`arenaTournaments/${id}/rewards/p3`).xp, 100);
  // retries cannot pay twice, and results are locked afterwards
  assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 409); assert.equal(P("p3").xp, 200); assert.equal(ledgerRows().length, ledgerBefore + 3);
  assert.equal((await call("POST", `${g2}/submit`, "adm", { rows: rows([e.p2, e.p3]), reason: "late change" })).s, 409);
  const pubFinal = (await call("GET", `${PUB}/${id}`)).b; assert.equal(pubFinal.status, "COMPLETED"); assert.equal(pubFinal.champion.name, "P3"); assert.equal(pubFinal.finalRanks[0].rank, 1);
  assert.deepEqual(ids(4).map(u => P(u).matches), [0, 0, 0, 0]); assert.deepEqual(ids(4).map(u => P(u).rating), [1000, 1000, 1000, 1000]); // normal match stats untouched
  const acts = auditActions().map(a => a.action); for (const a of ["TOURNEY_START", "TOURNEY_RESULT_SUBMIT", "TOURNEY_RESULT_CONFIRM", "TOURNEY_ROUND_ADVANCE", "TOURNEY_ROUND_REOPEN", "TOURNEY_RESULT_CORRECT", "TOURNEY_COMPLETE"]) assert.ok(acts.includes(a), a);
  assert.ok(xpBefore.length === 4);
  const log = (await call("GET", "/api/admin/audit?category=tournament&limit=100", "adm")).b; assert.ok(log.length >= 8); assert.ok(log.every((l: any) => l.actor === "adm" || l.actor === "System" || typeof l.actor === "string"));
});
test("a tie at the cutoff blocks advancement until the admin orders the tied entries", async () => {
  setup(3); const id = await open({ capacity: 3, scoring: { placementPoints: [5, 5, 5], killPoints: 0, winBonus: 0 }, roundsConfig: { count: 2, gamesPerRound: 1, qualifiers: [2] } });
  for (const u of ids(3)) await reg(id, u); await closeAndStart(id);
  const e: Record<string, string> = {}; for (const u of ids(3)) e[u] = await entryOf(id, u);
  const g = `${A}/${id}/rounds/1/games/1`;
  const dead = ids(3).map(u => ({ entryId: e[u], pointsOverride: 5 })); // a genuine dead heat
  await call("POST", `${g}/submit`, "adm", { rows: dead }); await call("POST", `${g}/confirm`, "adm");
  const blocked = await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {}); assert.equal(blocked.s, 409); assert.match(blocked.b.error, /tied/);
  assert.equal((await call("POST", `${A}/${id}/rounds/1/tie`, "adm", { ids: [e.p1, e.p2], reason: "partial" })).s, 400);
  assert.equal((await call("POST", `${A}/${id}/rounds/1/tie`, "adm", { ids: [e.p3, e.p1, e.p2] })).s, 400); // reason required
  assert.equal((await call("POST", `${A}/${id}/rounds/1/tie`, "adm", { ids: [e.p3, e.p1, e.p2], reason: "Replay review ruling" })).s, 200);
  const ok = await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {}); assert.equal(ok.s, 200); assert.deepEqual(ok.b.qualifiers, [e.p3, e.p1]); assert.deepEqual(ok.b.eliminated, [e.p2]);
  assert.ok(auditActions().some(a => a.action === "TOURNEY_TIE_RESOLVE" && a.reason === "Replay review ruling"));
});
test("a failed reward transaction pays nobody (all-or-nothing) and leaves the tournament in progress", async () => {
  const { id, e } = await pointsRun();
  await call("POST", `${A}/${id}/rounds/1/games/1/submit`, "adm", { rows: rows([e.p1, e.p2, e.p3, e.p4]) }); await call("POST", `${A}/${id}/rounds/1/games/1/confirm`, "adm"); await call("POST", `${A}/${id}/rounds/1/advance`, "adm", {});
  await call("POST", `${A}/${id}/rounds/2/games/1/submit`, "adm", { rows: rows([e.p2, e.p1]) }); await call("POST", `${A}/${id}/rounds/2/games/1/confirm`, "adm");
  store.set(`xpLedger/tour2_${id}_p1`, { uid: "p1", amount: 60, note: "already paid once" }); // simulates a previous partial payout of the same reward
  const r = await call("POST", `${A}/${id}/complete`, "adm", {}); assert.equal(r.s, 409);
  assert.equal(P("p2").xp, 100); assert.equal(P("p1").xp, 100); assert.equal(T0(id).status, "IN_PROGRESS"); assert.equal(store.has(`arenaTournaments/${id}/rewards/p2`), false);
});

// ===================== knockout format =====================
test("knockout: byes, confirmed-only advancement, correction rules, champion and rewards", async () => {
  setup(5); const id = await open({ format: "knockout", capacity: 8, scoring: undefined, roundsConfig: undefined, rewards: { placementXp: [100, 60, 40] } });
  for (const u of ids(5)) await reg(id, u);
  assert.equal((await call("POST", `${A}/${id}/start`, "adm", {})).s, 409); // registration still open
  const pre = await call("POST", `${A}/${id}/status`, "adm", { to: "REGISTRATION_CLOSED" }); assert.equal(pre.s, 200);
  const pv = await call("POST", `${A}/${id}/start`, "adm", { preview: true }); assert.equal(pv.s, 200); assert.equal(pv.b.state.bracket.size, 8); assert.equal(pv.b.state.bracket.rounds[0].matches.filter((m: any) => m.status === "BYE").length, 3);
  assert.equal(T0(id).status, "REGISTRATION_CLOSED"); assert.equal(store.has(`arenaTournaments/${id}/state/main`), false); // preview wrote nothing
  assert.equal((await call("POST", `${A}/${id}/start`, "adm", {})).s, 200); assert.equal((await call("POST", `${A}/${id}/start`, "adm", {})).s, 409);
  const det = async () => (await call("GET", `${A}/${id}`, "adm")).b.state.bracket.rounds as any[];
  const play = async (mid: string, w: string) => { assert.equal((await call("POST", `${A}/${id}/matches/${mid}/submit`, "adm", { winner: w })).s, 200); };
  const confirm = (mid: string) => call("POST", `${A}/${id}/matches/${mid}/confirm`, "adm");
  let rs = await det(); const real = rs[0].matches.find((m: any) => m.status === "READY"); assert.ok(real);
  assert.equal((await call("POST", `${A}/${id}/matches/r2m1/submit`, "adm", { winner: rs[1].matches[0].a })).s, 409); // entrants not decided yet
  await play(real.id, real.a);
  rs = await det(); const nextOf = rs[1].matches[Math.floor((Number(real.id.split("m")[1]) - 1) / 2)]; assert.equal(nextOf.status, "PENDING"); assert.equal([nextOf.a, nextOf.b].filter(Boolean).length, 1); // only the bye entrant is there: the unconfirmed winner is NOT
  const pubView = (await call("GET", `${PUB}/${id}`, "p1")).b.state.bracket.rounds[0].matches.find((m: any) => m.id === real.id); assert.equal(pubView.winner, null); assert.equal(pubView.status, "READY"); // players don't see unconfirmed winners
  assert.equal((await call("POST", `${A}/${id}/matches/${real.id}/confirm`, "p1")).s, 403);
  assert.equal((await confirm(real.id)).s, 200); assert.equal((await confirm(real.id)).s, 409);
  rs = await det(); assert.equal(rs[1].matches.filter((m: any) => m.status === "READY").length, 2); // the bye-vs-bye match and the one the confirmed winner joined
  // play out the rest, always taking side "a"
  for (let guard = 0; guard < 10; guard++) { rs = await det(); const m = rs.flatMap(r => r.matches).find((x: any) => x.status === "READY"); if (!m) break; await play(m.id, m.a); assert.equal((await confirm(m.id)).s, 200); }
  rs = await det(); const fin = rs[2].matches[0]; assert.equal(fin.status, "CONFIRMED");
  // correct the semifinal that fed the final? locked because the final has a result
  const sf = rs[1].matches.find((m: any) => m.status === "CONFIRMED"); const bad = await call("POST", `${A}/${id}/matches/${sf.id}/submit`, "adm", { winner: sf.b, reason: "wrong side" }); assert.equal(bad.s, 409); assert.match(bad.b.error, /Reopen that match first/);
  assert.equal((await call("POST", `${A}/${id}/matches/${fin.id}/reopen`, "adm", { reason: "Final entered wrongly" })).s, 200);
  rs = await det(); assert.equal(rs[2].matches[0].status, "READY"); assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 409); // champion not decided
  await play(fin.id, fin.b); await confirm(fin.id); // different winner this time
  const x1 = (await call("POST", `${A}/${id}/complete`, "adm", {})); assert.equal(x1.s, 200, JSON.stringify(x1.b));
  const xp = ids(5).map(u => P(u).xp - 100); assert.equal(xp.filter(v => v === 100).length, 1); assert.equal(xp.filter(v => v === 60).length, 1); assert.equal(xp.filter(v => v === 40).length, 2); assert.equal(xp.filter(v => v === 0).length, 1); // 1st, 2nd, joint 3rd x2, one more with nothing
  assert.equal((await call("POST", `${A}/${id}/complete`, "adm", {})).s, 409); assert.equal(ids(5).map(u => P(u).xp - 100).join(), xp.join());
  assert.equal(ledgerRows().filter(k => k.includes("tour2_")).length, 4);
  const final = (await call("GET", `${PUB}/${id}`)).b; assert.equal(final.status, "COMPLETED"); assert.ok(final.champion.name); assert.equal(final.finalRanks.filter((r: any) => r.rank === 3).length, 2);
});
test("knockout withdrawals need an explicit, confirmed walkover; a player can report a result issue that blocks confirmation", async () => {
  setup(4); const id = await open({ format: "knockout", capacity: 4, scoring: undefined, roundsConfig: undefined });
  for (const u of ids(4)) await reg(id, u); await closeAndStart(id);
  const e: Record<string, string> = {}; for (const u of ids(4)) e[u] = await entryOf(id, u);
  let rs = (await call("GET", `${A}/${id}`, "adm")).b.state.bracket.rounds; const m1 = rs[0].matches[0]; const [a, b] = [m1.a, m1.b];
  const loserUser = Object.keys(e).find(u => e[u] === b)!, winUser = Object.keys(e).find(u => e[u] === a)!;
  assert.equal((await call("POST", `${A}/${id}/entries/${b}/remove`, "adm", { reason: "Player left the community" })).s, 200);
  assert.equal(store.get(`arenaTournaments/${id}/entries/${b}`).status, "WITHDRAWN");
  assert.equal((await call("POST", `${A}/${id}/matches/${m1.id}/submit`, "adm", { winner: a })).s, 400); // must be flagged a walkover
  assert.equal((await call("POST", `${A}/${id}/matches/${m1.id}/submit`, "adm", { winner: a, walkover: true })).s, 200);
  assert.equal((await call("GET", `${A}/${id}`, "adm")).b.state.bracket.rounds[1].matches[0].a, null); // not advanced before confirmation
  // a player in the tournament can report an issue; confirming is blocked until an admin resolves it
  assert.equal((await call("POST", `${PUB}/${id}/disputes`, winUser, { matchId: m1.id, reason: "short" })).s, 400);
  assert.equal((await call("POST", `${PUB}/${id}/disputes`, winUser, { matchId: m1.id, reason: "The walkover is wrong, he was online" })).s, 201);
  const blocked = await call("POST", `${A}/${id}/matches/${m1.id}/confirm`, "adm"); assert.equal(blocked.s, 409); assert.match(blocked.b.error, /reported an issue/);
  const openReports = (await call("GET", `${A}/${id}`, "adm")).b.disputes.filter((x: any) => x.status === "OPEN"); assert.ok(openReports.length >= 1);
  for (const x of openReports) assert.equal((await call("POST", `${A}/${id}/disputes/${x.id}/resolve`, "adm", { note: "Checked the logs" })).s, 200);
  assert.equal((await call("POST", `${A}/${id}/matches/${m1.id}/confirm`, "adm")).s, 200);
  assert.equal((await call("GET", `${A}/${id}`, "adm")).b.state.bracket.rounds[1].matches[0].a, a); // advanced only after confirmation
  assert.equal(loserUser.length > 0, true);
});
test("a screenshot is validated, stored privately for admins only, and never counts as verified data", async () => {
  setup(2); const id = await open({ capacity: 2 }); for (const u of ids(2)) await reg(id, u);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const put = (uid: string | undefined, body: Buffer, type = "image/png") => fetch(`${base}${A}/${id}/shots`, { method: "PUT", headers: { "Content-Type": type, ...(uid ? { Authorization: "Bearer tok:" + uid } : {}) }, body });
  assert.equal((await put("p1", png)).status, 403); assert.equal((await put(undefined, png)).status, 401);
  assert.equal((await put("adm", Buffer.from("not an image at all, just text"))).status, 400); // wrong bytes even though the header says png
  assert.equal((await put("adm", Buffer.alloc(600 * 1024, 1), "image/png")).status, 413);
  const ok = await put("adm", png); assert.equal(ok.status, 201); const sid = (await ok.json() as any).shotId;
  const get = (uid?: string) => fetch(`${base}${A}/${id}/shots/${sid}`, { headers: uid ? { Authorization: "Bearer tok:" + uid } : {} });
  assert.equal((await get("p1")).status, 403); assert.equal((await get("adm")).status, 200); assert.equal((await get("adm")).headers.get("cache-control"), "private, no-store");
  const detail = (await call("GET", `${A}/${id}`, "adm")).b; assert.equal(detail.shots.length, 1); assert.ok(!JSON.stringify((await call("GET", `${PUB}/${id}`, "p1")).b).includes(sid)); // players never see storage ids
  assert.ok(auditActions().some(a => a.action === "TOURNEY_SHOT" && /not verified/.test(a.summary)));
});
