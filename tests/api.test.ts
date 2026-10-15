import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, store } from "./fake";
import { istWeekStart } from "../src/logic";

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "{}"; process.env.BOOTSTRAP_SECRET = "s3cret"; process.env.RATE_LIMIT = "100000"; process.env.PROFILE_CACHE_MS = "0";
const M = require("module"), orig = M._load;
M._load = function (r: string, ...a: any[]) { return r === "firebase-admin" ? fake : orig.call(this, r, ...a); };
const { app } = require("../src/server");
let srv: any, base = "";
before(() => { srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
beforeEach(() => store.clear());

const call = async (m: string, p: string, uid?: string, body?: any) => {
  const r = await fetch(base + p, { method: m, headers: { "Content-Type": "application/json", ...(uid ? { Authorization: "Bearer tok:" + uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) as any };
};
const M0 = { matches: 0, wins: 0, kills: 0, deaths: 0, hs: 0 };
const role = (uid: string, r: string) => store.set(`users/${uid}`, { role: r });
const player = (uid: string, arenaId: string, o: any = {}) => { role(uid, "player");
  store.set(`playerProfiles/${uid}`, { uid, arenaId, status: "active", gameName: uid.toUpperCase(), ffUid: "123456", realName: "Real " + uid, showRealName: false, showUid: true, xp: 100, rating: 1000,
    wins: 0, losses: 0, draws: 0, matches: 0, kills: 0, deaths: 0, kdOverride: null, stats: { br: { ...M0 }, cs: { ...M0 } }, statsSource: "self-reported", winStreak: 0, bestStreak: 0, weekly: {}, ...o }); };
const setup = () => { role("adm", "admin"); role("own", "owner"); player("a", "FFA-0001"); player("b", "FFA-0002"); player("c", "FFA-0003"); player("d", "FFA-0004"); };
const challenge = async (a = "a", b = "b") => (await call("POST", "/api/admin/challenges", "adm", { playerA: a, playerB: b, title: "Duel", scheduledAt: "2026-10-20T10:00" })).b.id as string;
const result = (id: string, winner: string) => call("POST", `/api/admin/challenges/${id}/result`, "adm", { winner, scoreA: 1, scoreB: 0 });
const ledgerCount = () => [...store.keys()].filter(k => k.startsWith("xpLedger/")).length;
const P = (u: string) => store.get(`playerProfiles/${u}`);

test("registration: pending cannot play, invalid stats rejected, approval creates profile", async () => {
  setup();
  const ok = { gameName: "Newbie", ffUid: "99887766", realName: "New Bie", br: { matches: 100, wins: 30, kills: 200, deaths: 100, hs: 25 }, cs: M0 };
  assert.equal((await call("POST", "/api/register", "z", { ...ok, br: { ...ok.br, wins: 500 } })).s, 400);
  assert.equal((await call("POST", "/api/register", "n", ok)).s, 200);
  assert.equal((await call("POST", "/api/challenges", "n", { opponent: "a", title: "Hello there" })).s, 403);
  assert.equal((await call("POST", "/api/admin/challenges", "adm", { playerA: "n", playerB: "a", title: "x y z", scheduledAt: "2026-10-20" })).s, 400);
  assert.equal((await call("POST", "/api/admin/registrations/n/approve", "n")).s, 403);
  assert.equal((await call("POST", "/api/admin/registrations/n/approve", "adm")).s, 200);
  assert.equal(P("n").arenaId, "FFA-0001");
  assert.equal(store.get("users/n").role, "player"); assert.equal(P("n").statsSource, "self-reported");
  assert.equal((await call("POST", "/api/admin/registrations/n/approve", "adm")).s, 409);
});
test("owner bootstrap works once and needs the secret", async () => {
  assert.equal((await call("POST", "/api/bootstrap-owner", "o1", { secret: "bad" })).s, 403);
  assert.equal((await call("POST", "/api/bootstrap-owner", "o1", { secret: "s3cret" })).s, 200);
  assert.equal(store.get("users/o1").role, "owner");
  assert.equal((await call("POST", "/api/bootstrap-owner", "o2", { secret: "s3cret" })).s, 409);
});
test("only the owner appoints admins", async () => {
  setup();
  assert.equal((await call("POST", "/api/owner/admins", "adm", { uid: "a", admin: true })).s, 403);
  assert.equal((await call("POST", "/api/owner/admins", "own", { uid: "a", admin: true })).s, 200);
  assert.equal(store.get("users/a").role, "admin");
});
test("players cannot edit protected fields; privacy of public data", async () => {
  setup();
  await call("PATCH", "/api/me/profile", "a", { xp: 9999, rating: 3000, role: "owner", gameName: "NewName" });
  assert.equal(P("a").xp, 100); assert.equal(P("a").rating, 1000); assert.equal(store.get("users/a").role, "player"); assert.equal(P("a").gameName, "NewName");
  const card = await call("GET", "/api/players/FFA-0001");
  assert.ok(!JSON.stringify(card.b).includes("Real a")); assert.equal(card.b.realName, undefined);
  const lb = await call("GET", "/api/leaderboard");
  assert.deepEqual(Object.keys(lb.b.rows[0]).sort(), ["arenaId", "avatar", "displayName", "gameName", "pos", "rank", "rankIndex", "rating", "stars", "value", "xp"]);
  assert.ok(!JSON.stringify(lb.b).includes("ffUid") && !JSON.stringify(lb.b).includes("Real a") && !JSON.stringify(lb.b).includes("\"uid\""));
  await call("PATCH", "/api/me/profile", "a", { showRealName: true });
  assert.equal((await call("GET", "/api/players/FFA-0001")).b.realName, "Real a");
});
test("only admins edit K/D; impossible stats rejected; override is labelled", async () => {
  setup();
  const body = { mode: "br", matches: 10, wins: 5, kills: 20, deaths: 10, hs: 30, kdOverride: 3.5, reason: "manual fix" };
  assert.equal((await call("POST", "/api/admin/stats/a", "a", body)).s, 403);
  assert.equal((await call("POST", "/api/admin/stats/a", "adm", { ...body, wins: 11 })).s, 400);
  assert.equal((await call("POST", "/api/admin/stats/a", "adm", { ...body, reason: "" })).s, 400);
  assert.equal((await call("POST", "/api/admin/stats/a", "adm", body)).s, 200);
  assert.deepEqual((await call("GET", "/api/players/FFA-0001")).b.kd, { value: 3.5, mode: "admin-set" });
  await call("POST", "/api/admin/stats/a", "adm", { ...body, kdOverride: "" });
  assert.deepEqual((await call("GET", "/api/players/FFA-0001")).b.kd, { value: 2, mode: "calculated" });
});
test("bulk stats: preview writes nothing, apply updates", async () => {
  setup();
  const body = { mode: "cs", reason: "season sync", rows: [{ arenaId: "FFA-0001", matches: 10, wins: 5, kills: 20, deaths: 10, hs: 10 }, { arenaId: "FFA-0002", matches: 4, wins: 1, kills: 5, deaths: 3, hs: 5 }] };
  assert.equal((await call("POST", "/api/admin/stats-bulk", "adm", { ...body, preview: true })).s, 200);
  assert.equal(P("a").stats.cs.kills, 0);
  assert.equal((await call("POST", "/api/admin/stats-bulk", "a", body)).s, 403);
  assert.equal((await call("POST", "/api/admin/stats-bulk", "adm", body)).s, 200);
  assert.equal(P("b").stats.cs.kills, 5);
});
test("challenge: admin creates between two different approved players", async () => {
  setup();
  assert.equal((await call("POST", "/api/admin/challenges", "adm", { playerA: "a", playerB: "a", title: "Self", scheduledAt: "2026-10-20" })).s, 400);
  assert.equal((await call("POST", "/api/admin/challenges", "a", { playerA: "a", playerB: "b", title: "Nope", scheduledAt: "2026-10-20" })).s, 403);
  assert.ok(await challenge());
});
test("result approval updates stats once; double approval does not duplicate rewards", async () => {
  setup();
  const id = await challenge();
  assert.equal((await result(id, "A")).s, 200);
  assert.deepEqual([P("a").rating, P("b").rating, P("a").xp, P("b").xp, P("a").wins, P("b").losses], [1016, 984, 125, 105, 1, 1]);
  const n = ledgerCount();
  assert.equal((await result(id, "A")).s, 409);
  assert.equal(ledgerCount(), n); assert.equal(P("a").rating, 1016);
  assert.equal((await call("GET", "/api/me", "a")).b.weekly.done, 1);
  assert.equal(P("a").weekly[istWeekStart()], 1);
});
test("correction reverses old effects and applies new exactly once", async () => {
  setup();
  const id = await challenge();
  await result(id, "A");
  const c = (w: string) => call("POST", `/api/admin/challenges/${id}/correct`, "adm", { winner: w, scoreA: 0, scoreB: 1, reason: "wrong winner" });
  assert.equal((await call("POST", `/api/admin/challenges/${id}/correct`, "adm", { winner: "B", scoreA: 0, scoreB: 1 })).s, 400);
  assert.equal((await c("B")).s, 200);
  assert.deepEqual([P("a").rating, P("b").rating, P("a").xp, P("b").xp, P("a").wins, P("a").losses, P("b").wins, P("b").losses, P("a").matches], [984, 1016, 105, 125, 0, 1, 1, 0, 1]);
  assert.equal(P("a").weeklyWins[istWeekStart()], 0); assert.equal(P("b").weeklyWins[istWeekStart()], 1);
  assert.equal(store.get(`challenges/${id}`).version, 2);
});
test("XP never falls below zero; adjustments are idempotent", async () => {
  setup(); P("a").xp = 10;
  const body = { xp: -100, reason: "penalty", requestId: "req-12345678" };
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "a", body)).s, 403);
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", body)).s, 200);
  assert.equal(P("a").xp, 0); assert.equal(store.get("xpLedger/adj_req-12345678").amount, -10);
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", body)).s, 409);
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", { rankOverride: "Heroic", reason: "event prize", requestId: "req-87654321" })).s, 200);
  assert.equal((await call("GET", "/api/players/FFA-0001")).b.rank, "Heroic");
  await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", { rankOverride: "clear", reason: "undo", requestId: "req-11223344" });
  assert.equal((await call("GET", "/api/players/FFA-0001")).b.rank, "Aura −");
});
test("daily login reward cannot be duplicated", async () => {
  setup();
  assert.equal((await call("POST", "/api/daily-login", "a")).b.already, false);
  assert.equal((await call("POST", "/api/daily-login", "a")).b.already, true);
  assert.equal(P("a").xp, 105); assert.equal(P("a").loginStreak, 1);
});
test("tournament rewards cannot be applied twice; preview writes nothing", async () => {
  setup();
  const t = (await call("POST", "/api/admin/tournaments", "adm", { name: "BR Custom", type: "br-custom", placementXp: [100, 50], killXp: 2 })).b.id;
  const rows = [{ arenaId: "FFA-0001", placement: 1, kills: 5 }, { arenaId: "FFA-0002", placement: 2, kills: 0 }];
  const pv = await call("POST", `/api/admin/tournaments/${t}/publish`, "adm", { rows, preview: true });
  assert.deepEqual(pv.b.rows.map((r: any) => r.reward), [110, 50]); assert.equal(P("a").xp, 100);
  assert.equal((await call("POST", `/api/admin/tournaments/${t}/publish`, "adm", { rows })).s, 200);
  assert.equal((await call("POST", `/api/admin/tournaments/${t}/publish`, "adm", { rows })).s, 409);
  assert.equal(P("a").xp, 210); assert.equal(P("b").xp, 150);
});
test("daily rank update event applies once", async () => {
  setup();
  const body = { eventId: "daily-1", rows: [{ arenaId: "FFA-0001", sg: 3, sl: 1, bg: 1, bl: 0 }] };
  assert.equal((await call("POST", "/api/admin/rank-updates", "adm", body)).s, 200);
  assert.equal(P("a").xp, 150);
  assert.equal((await call("POST", "/api/admin/rank-updates", "adm", body)).s, 409); assert.equal(P("a").xp, 150);
});
test("missions: one claim per week, only when complete", async () => {
  setup(); P("a").weekly = { [istWeekStart()]: 5 };
  assert.equal((await call("POST", "/api/missions/wins2/claim", "a")).s, 400);
  assert.equal((await call("POST", "/api/missions/five/claim", "a")).s, 200);
  assert.equal((await call("POST", "/api/missions/five/claim", "a")).s, 409);
  assert.equal(P("a").xp, 150);
});
test("player challenge flow, spam limits and disputes", async () => {
  setup();
  const mk = await call("POST", "/api/challenges", "a", { opponent: "b", title: "Friendly duel" });
  assert.equal(mk.s, 200);
  assert.equal((await call("POST", "/api/challenges", "a", { opponent: "b", title: "Again please" })).s, 409);
  assert.equal((await call("POST", "/api/challenges", "a", { opponent: "a", title: "Myself!" })).s, 400);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/respond`, "a", { accept: true })).s, 409);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/respond`, "b", { accept: true })).s, 200);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/submit`, "c", { winner: "A" })).s, 403);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/submit`, "a", { winner: "A", scoreA: 1, scoreB: 0 })).s, 200);
  assert.equal(P("a").xp, 100);
  assert.equal((await result(mk.b.id, "A")).s, 200);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/dispute`, "c", { reason: "I was not there at all" })).s, 403);
  assert.equal((await call("POST", `/api/challenges/${mk.b.id}/dispute`, "b", { reason: "The score was wrong" })).s, 200);
  assert.equal(store.get(`challenges/${mk.b.id}`).status, "DISPUTED");
  assert.equal((await call("POST", `/api/admin/challenges/${mk.b.id}/correct`, "adm", { winner: "draw", reason: "replay showed draw" })).s, 200);
  assert.equal(store.get(`challenges/${mk.b.id}`).status, "APPROVED"); assert.equal(store.get(`disputes/${mk.b.id}`).status, "RESOLVED");
});
test("anti-boost review flag appears after 3 matches between same pair in 24h", async () => {
  setup();
  for (let i = 0; i < 3; i++) await result(await challenge(), "A");
  const f = await call("GET", "/api/admin/flags", "adm");
  assert.equal(f.b.length, 1); assert.match(f.b[0].reason, /3 approved matches/);
});
test("teams: separate rating, one team per player, idempotent match", async () => {
  setup();
  const mk = (name: string, m: string[]) => call("POST", "/api/admin/teams", "adm", { name, captain: m[0], members: m });
  const A = await mk("Alpha", ["FFA-0001", "FFA-0002"]);
  assert.equal(A.s, 200);
  assert.equal((await mk("Clash", ["FFA-0002", "FFA-0003"])).s, 400);
  const B = await mk("Beta", ["FFA-0003", "FFA-0004"]);
  assert.equal((await call("POST", "/api/admin/teams", "a", { name: "X1", captain: "FFA-0001", members: ["FFA-0001", "FFA-0002"] })).s, 403);
  const m = { teamA: A.b.id, teamB: B.b.id, winner: "A", requestId: "match-0001" };
  assert.equal((await call("POST", "/api/admin/teams/match", "adm", m)).s, 200);
  assert.equal((await call("POST", "/api/admin/teams/match", "adm", m)).s, 409);
  const t = (await call("GET", "/api/teams")).b;
  assert.deepEqual([t[0].name, t[0].rating, t[1].rating, t[0].matches], ["Alpha", 1016, 984, 1]);
  assert.equal(P("a").rating, 1000); assert.ok(!JSON.stringify(t).includes('"uid"'));
  assert.equal((await call("POST", `/api/admin/teams/${A.b.id}/members`, "adm", { remove: "FFA-0001" })).s, 400);
  assert.equal((await call("POST", `/api/admin/teams/${A.b.id}/members`, "adm", { remove: "FFA-0002" })).s, 200);
});
test("config editor validates, persists and applies live", async () => {
  setup();
  assert.equal((await call("POST", "/api/admin/config", "a", { k: 16, reason: "tune" })).s, 403);
  assert.equal((await call("POST", "/api/admin/config", "adm", { k: 500, reason: "tune" })).s, 400);
  assert.equal((await call("POST", "/api/admin/config", "adm", { thresholds: [0, 5, 4, 9, 10, 11, 12, 13], reason: "bad" })).s, 400);
  assert.equal((await call("POST", "/api/admin/config", "adm", { k: 16, reason: "tune" })).s, 200);
  await result(await challenge(), "A");
  assert.equal(P("a").rating, 1008);
  await call("POST", "/api/admin/config", "adm", { k: 32, reason: "restore" });
  assert.equal(store.get("appConfig/main").k, 32);
});
test("only the owner can export; audit log written for sensitive actions", async () => {
  setup(); await result(await challenge(), "A");
  assert.equal((await call("GET", "/api/admin/export", "adm")).s, 403);
  const ex = await call("GET", "/api/admin/export", "own");
  assert.equal(ex.s, 200); assert.ok(ex.b.adminAuditLogs.some((l: any) => l.action === "RESULT_APPROVE"));
});


// ======================= Overhaul tests =======================
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
const put = async (uid: string, body: Buffer, type = "image/png") => {
  const r = await fetch(base + "/api/me/avatar", { method: "PUT", headers: { "Content-Type": type, Authorization: "Bearer tok:" + uid }, body });
  return { s: r.status, b: await r.json().catch(() => ({})) as any };
};
const lock = (u: string, locked: boolean, by = "adm", reason?: string) => call("POST", `/api/admin/players/${u}/lock`, by, { locked, reason });

test("registration needs no real name; display name stored; correction round trip", async () => {
  setup();
  const reg = { gameName: "Ghost", displayName: "Ghost Rider", ffUid: "5554443", br: M0, cs: M0 };
  assert.equal((await call("POST", "/api/register", "g", reg)).s, 200);
  assert.equal(store.get("registrations/g").displayName, "Ghost Rider"); assert.equal(store.get("registrations/g").realName, null);
  assert.equal((await call("PATCH", "/api/me/registration", "g", { gameName: "Nope" })).s, 409); // nothing requested yet
  assert.equal((await call("POST", "/api/admin/registrations/g/correction", "g", { note: "fix uid please" })).s, 403);
  assert.equal((await call("POST", "/api/admin/registrations/g/correction", "adm", { note: "fix uid please" })).s, 200);
  assert.equal(store.get("registrations/g").status, "NEEDS_CORRECTION");
  assert.equal((await call("POST", "/api/admin/registrations/g/approve", "adm")).s, 409); // must be resubmitted first
  assert.equal((await call("GET", "/api/me", "g")).b.registration.note, "fix uid please");
  assert.equal((await call("PATCH", "/api/me/registration", "g", { ffUid: "12ab" })).s, 400);
  assert.equal((await call("PATCH", "/api/me/registration", "g", { ffUid: "7778889" })).s, 200);
  assert.equal(store.get("registrations/g").status, "PENDING");
  assert.equal((await call("POST", "/api/admin/registrations/g/approve", "adm")).s, 200);
  assert.equal(P("g").displayName, "Ghost Rider"); assert.equal(P("g").ffUid, "7778889"); assert.equal(P("g").locked, false);
});
test("owner bootstrap is refused for pending and approved players even with the right secret", async () => {
  setup(); role("pend", "pending");
  assert.equal((await call("POST", "/api/bootstrap-owner", "pend", { secret: "s3cret" })).s, 403);
  assert.equal((await call("POST", "/api/bootstrap-owner", "a", { secret: "s3cret" })).s, 403);
  assert.equal(store.get("users/pend").role, "pending"); assert.equal(store.get("users/a").role, "player");
  assert.equal(store.has("appConfig/bootstrap"), false);
});
test("profile pictures: validation, ownership, privacy and removal", async () => {
  setup(); role("pend", "pending"); store.set("registrations/pend", { status: "PENDING", gameName: "Pending", ffUid: "123456", br: M0, cs: M0 });
  assert.equal((await put("a", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png")).s, 400); // declared png, real content is not
  assert.equal((await put("a", Buffer.alloc(300, 1))).s, 400);
  assert.equal((await put("a", Buffer.concat([png(), Buffer.alloc(200 * 1024)]))).s, 413);
  { const g = await put("a", png(), "image/gif"); assert.ok(g.s >= 400); } // unsupported type is never accepted
  assert.equal(P("a").avatarV ?? null, null);
  const ok = await put("a", png()); assert.equal(ok.s, 200);
  assert.ok(P("a").avatarV); assert.equal(P("b").avatarV ?? null, null); // only the caller's own picture can change
  const lb = (await call("GET", "/api/leaderboard")).b.rows.find((r: any) => r.arenaId === "FFA-0001");
  assert.match(lb.avatar, /^\/api\/avatars\/FFA-0001\?v=\d+$/);
  const img = await fetch(base + lb.avatar); assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(base + "/api/avatars/FFA-0002")).status, 404);
  assert.equal((await put("pend", png())).s, 200); // pending players may add a picture; it is only visible to admins
  assert.ok(store.get("registrations/pend").avatarV);
  assert.equal((await fetch(base + "/api/admin/avatars/pend", { headers: { Authorization: "Bearer tok:a" } })).status, 403);
  assert.equal((await fetch(base + "/api/admin/avatars/pend", { headers: { Authorization: "Bearer tok:adm" } })).status, 200);
  assert.equal((await put("adm", png())).s, 403); // admins/owners have no player profile
  assert.equal((await call("DELETE", "/api/me/avatar", "a")).s, 200);
  assert.equal(P("a").avatarV, null); assert.equal(store.has("avatars/a"), false);
});
test("profile lock: admin-only, enforced on every player write, separate from approval and role", async () => {
  setup();
  assert.equal((await lock("a", true, "b")).s, 403);
  assert.equal((await lock("nobody", true)).s, 404);
  assert.equal((await call("POST", "/api/admin/players/a/lock", "adm", { locked: "yes" })).s, 400);
  assert.equal((await lock("a", true, "adm", "under review")).s, 200);
  assert.equal((await lock("a", true)).s, 409);
  assert.equal(P("a").locked, true); assert.equal(P("a").status, "active"); assert.equal(store.get("users/a").role, "player");
  assert.equal((await call("PATCH", "/api/me/profile", "a", { gameName: "Sneaky" })).s, 403); assert.notEqual(P("a").gameName, "Sneaky");
  assert.equal((await put("a", png())).s, 403);
  assert.equal((await call("DELETE", "/api/me/avatar", "a")).s, 403);
  assert.equal((await call("POST", "/api/challenges", "a", { opponent: "b", title: "Locked duel" })).s, 403);
  assert.equal((await call("POST", "/api/challenges", "b", { opponent: "a", title: "Duel the locked" })).s, 400);
  assert.equal((await call("POST", "/api/admin/challenges", "adm", { playerA: "a", playerB: "b", title: "Admin duel", scheduledAt: "2026-10-20" })).s, 400);
  const me = (await call("GET", "/api/me", "a")).b; assert.deepEqual(me.lock, { locked: true, reason: "under review" });
  const pub = JSON.stringify((await call("GET", "/api/players/FFA-0001")).b); assert.ok(!pub.includes("under review") && !pub.includes("locked"));
  assert.equal((await call("POST", "/api/daily-login", "a")).s, 200); // account basics keep working while locked
  assert.equal((await lock("a", false, "adm")).s, 200);
  assert.equal((await call("PATCH", "/api/me/profile", "a", { gameName: "Allowed" })).s, 200);
  const d = (await call("GET", "/api/admin/players/a", "adm")).b;
  assert.deepEqual(d.lockHistory.map((h: any) => h.locked), [false, true]); assert.equal(d.lockHistory[1].reason, "under review");
  assert.ok(d.history.some((h: any) => h.label === "Locked profile"));
});
test("players cannot reach admin screens or change protected fields", async () => {
  setup();
  for (const [m, p] of [["GET", "/api/admin/overview"], ["GET", "/api/admin/players"], ["GET", "/api/admin/players/b"], ["GET", "/api/admin/audit"], ["GET", "/api/admin/registrations"]])
    assert.equal((await call(m, p, "a")).s, 403, p);
  assert.equal((await call("PATCH", "/api/admin/players/b/profile", "a", { gameName: "Hacked" })).s, 403);
  await call("PATCH", "/api/me/profile", "a", { locked: false, status: "pending", arenaId: "FFA-9999", avatarV: 5, kdOverride: 99, rankOverride: "Heroic", displayName: "Fine Name" });
  assert.equal(P("a").arenaId, "FFA-0001"); assert.equal(P("a").kdOverride, null); assert.equal(P("a").rankOverride, undefined); assert.equal(P("a").displayName, "Fine Name"); assert.equal(P("a").avatarV, undefined);
  assert.equal((await call("GET", "/api/admin/overview")).s, 401);
});
test("admin overview, player list filters/search and detail use real data", async () => {
  setup(); role("p1", "pending"); store.set("registrations/p1", { status: "PENDING", gameName: "Pendy", ffUid: "444555", br: M0, cs: M0, createdAt: { toMillis: () => 1 } });
  role("r1", "rejected"); store.set("registrations/r1", { status: "REJECTED", gameName: "Rejy", ffUid: "666777", br: M0, cs: M0, reason: "dup" });
  store.set("registrations/a", { status: "APPROVED", gameName: "A", ffUid: "123456", br: M0, cs: M0 }); await lock("b", true, "adm");
  const o = (await call("GET", "/api/admin/overview", "adm")).b;
  assert.deepEqual(o.totals, { registered: 3, approved: 4, pending: 1, correction: 0, rejected: 1, locked: 1 });
  const names = async (q: string) => (await call("GET", `/api/admin/players?${q}`, "adm")).b.map((r: any) => r.gameName).sort();
  assert.deepEqual(await names("status=all"), ["A", "B", "C", "D", "Pendy", "Rejy"]);
  assert.deepEqual(await names("status=pending"), ["Pendy"]); assert.deepEqual(await names("status=rejected"), ["Rejy"]); assert.deepEqual(await names("status=locked"), ["B"]);
  assert.deepEqual(await names("status=active"), ["A", "C", "D"]); assert.deepEqual(await names("status=all&q=666777"), ["Rejy"]); assert.deepEqual(await names("status=all&q=ffa-0003"), ["C"]);
  assert.deepEqual(await names(""), ["A", "B", "C", "D"]); // default stays "approved players", as before
  const row = (await call("GET", "/api/admin/players?status=approved&q=A", "adm")).b.find((r: any) => r.gameName === "A");
  assert.equal(row.ffUid, "123456"); assert.equal(row.status, "approved"); assert.equal(row.rank, "Aura −");
  const det = (await call("GET", "/api/admin/players/a", "adm")).b; assert.equal(det.profile.ffUid, "123456"); assert.equal(det.profile.realName, undefined); assert.equal(det.approved, true);
  assert.equal((await call("GET", "/api/admin/players/p1", "adm")).b.registration.status, "PENDING");
  assert.equal((await call("GET", "/api/admin/players/zzz", "adm")).s, 404);
});
test("leaderboard: paging, search and global positions with the original tie-break", async () => {
  setup(); P("c").xp = 500; P("d").xp = 500; P("b").displayName = "Shadow";
  const all = (await call("GET", "/api/leaderboard")).b; assert.equal(all.total, 4);
  assert.deepEqual(all.rows.map((r: any) => r.arenaId), ["FFA-0003", "FFA-0004", "FFA-0001", "FFA-0002"]); // xp desc, ties by FF Arena ID
  const page = (await call("GET", "/api/leaderboard?limit=2&offset=2")).b; assert.deepEqual(page.rows.map((r: any) => r.pos), [3, 4]);
  const hit = (await call("GET", "/api/leaderboard?q=shad")).b; assert.equal(hit.rows.length, 1); assert.equal(hit.rows[0].displayName, "Shadow"); assert.equal(hit.rows[0].pos, 4);
  assert.equal((await call("GET", "/api/leaderboard?q=nomatch")).b.rows.length, 0);
  assert.equal((await call("GET", "/api/leaderboard?tab=rating&limit=9999")).b.limit, 100);
});
test("XP adjustment preview writes nothing and matches the real result", async () => {
  setup(); P("a").xp = 40;
  const body = { xp: -100, reason: "penalty", rankOverride: "Gold" };
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "a", { ...body, preview: true })).s, 403);
  assert.equal((await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", { ...body, xp: 1.5, preview: true })).s, 400);
  const pv = (await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", { ...body, preview: true })).b;
  assert.deepEqual([pv.before, pv.requested, pv.applied, pv.after, pv.rankAfter], [40, -100, -40, 0, "Gold"]);
  assert.equal(P("a").xp, 40); assert.equal(ledgerCount(), 0);
  const real = await call("POST", "/api/admin/players/FFA-0001/adjust", "adm", { ...body, requestId: "req-aaaa1111" });
  assert.equal(real.s, 200); assert.deepEqual([real.b.before, real.b.after, real.b.rank], [40, 0, "Gold"]);
  assert.equal((await call("GET", "/api/admin/audit", "adm")).b[0].detail?.startsWith("XP 40 → 0"), true);
});
test("admin profile edits are validated and audited; me shows recent matches and progress", async () => {
  setup();
  assert.equal((await call("PATCH", "/api/admin/players/a/profile", "adm", { ffUid: "abc" })).s, 400);
  assert.equal((await call("PATCH", "/api/admin/players/a/profile", "adm", {})).s, 400);
  assert.equal((await call("PATCH", "/api/admin/players/a/profile", "adm", { gameName: "Fixed", ffUid: "99887766", reason: "typo" })).s, 200);
  assert.equal(P("a").gameName, "Fixed"); assert.equal(P("a").ffUid, "99887766");
  const id = await challenge(); await result(id, "A");
  const me = (await call("GET", "/api/me", "a")).b;
  assert.equal(me.recent.length, 1); assert.deepEqual([me.recent[0].outcome, me.recent[0].ratingDelta, me.recent[0].opponent], ["W", 16, "B"]);
  assert.equal(me.card.progress.nextRank, "Bronze"); assert.equal(me.card.progress.xpToNext, 375);
  const pub = (await call("GET", "/api/players/FFA-0001")).b; assert.equal(pub.recent.length, 1);
  const meta = (await call("GET", "/api/meta")).b; assert.equal(meta.ranks.length, 8); assert.equal(meta.ranks[7].name, "Heroic");
});
