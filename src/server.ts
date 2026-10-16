import express, { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import crypto from "crypto";
import { MODE_LABEL, OPEN_MATCH, parseOpenMatch, AVATAR_MAX_BYTES, RANK_META, detectImage, matches, rankProgress, LEVEL, RANKS, THRESHOLDS, badges, levelFromXp, CFG, applyXp, elo, initialXp, istDate, istWeekStart, kd, nextStreak, prevWeekStart, rankFromXp, validStats } from "./logic";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString())) });
const db = admin.firestore();
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const INC = (n: number) => admin.firestore.FieldValue.increment(n);

class HttpErr extends Error { constructor(public code: number, msg: string) { super(msg); } }
const wrap = (f: (req: any, res: Response) => Promise<any>) => (req: Request, res: Response, next: NextFunction) => f(req, res).catch(next);
const str = (v: any, min: number, max: number, name: string) => {
  if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw new HttpErr(400, `${name} must be ${min}-${max} characters`);
  return v.trim();
};
const num = (v: any) => (v === undefined || v === "" ? 0 : Number(v));
const modeOf = (b: any) => ({ matches: num(b?.matches), wins: num(b?.wins), kills: num(b?.kills), deaths: num(b?.deaths), hs: num(b?.hs) });

async function auth(req: any, res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
    const t = await admin.auth().verifyIdToken(h.slice(7));
    const s = await db.doc(`users/${t.uid}`).get(); // role comes ONLY from the database
    req.user = { uid: t.uid, email: t.email, role: s.exists ? s.data()!.role : "none" };
    next();
  } catch { res.status(401).json({ error: "Invalid session" }); }
}
const need = (...roles: string[]) => (req: any, res: Response, next: NextFunction) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" });
const isAdmin = need("owner", "admin");
const audit = (t: FirebaseFirestore.Transaction | null, rec: any) => {
  const ref = db.collection("adminAuditLogs").doc();
  const data = { ...rec, at: TS() };
  return t ? t.create(ref, data) : ref.create(data);
};
const notify = (t: FirebaseFirestore.Transaction, uid: string, text: string) =>
  t.create(db.collection("notifications").doc(), { uid, text, read: false, at: TS() });

/** Immutable XP ledger entry. Deterministic id => the same reward can never be written twice. */
function ledger(t: FirebaseFirestore.Transaction, id: string, uid: string, prev: number, amount: number, reason: string, ref: string, actor: string) {
  const { newBalance, applied } = applyXp(prev, amount);
  t.create(db.doc(`xpLedger/${id}`), { uid, amount: applied, requested: amount, prev, balance: newBalance, reason, ref, actor, at: TS() });
  return newBalance;
}

const kdOf = (p: any) => (p.kdOverride != null ? { value: p.kdOverride, mode: "admin-set" } : { value: kd(p.kills || 0, p.deaths || 0), mode: "calculated" });

// ---- Short-lived read cache for the profile collection (cleared after every write request) ----
const CACHE_MS = process.env.PROFILE_CACHE_MS !== undefined ? Number(process.env.PROFILE_CACHE_MS) : 5000;
let pcache: { at: number; rows: any[] } | null = null;
async function profiles(): Promise<any[]> {
  if (pcache && Date.now() - pcache.at < CACHE_MS) return pcache.rows;
  const s = await db.collection("playerProfiles").get();
  const rows = s.docs.map(d => ({ ...d.data(), uid: d.id }));
  pcache = { at: Date.now(), rows };
  return rows;
}
const activeProfiles = async () => (await profiles()).filter(p => p.status === "active");

const dispName = (p: any): string => p.displayName || p.gameName;
const avatarUrl = (p: any) => (p.avatarV ? `/api/avatars/${p.arenaId}?v=${p.avatarV}` : null);
const shownRank = (p: any): string => p.rankOverride || rankFromXp(p.xp).rank;
const lockedErr = () => new HttpErr(403, "Your profile is locked by an admin, so this change isn't allowed. Contact an admin to unlock it.");
const mustBeUnlocked = async (uid: string) => { const s = await db.doc(`playerProfiles/${uid}`).get(); if (s.exists && s.data()!.locked) throw lockedErr(); };

function card(p: any, self = false) {
  const { rank, stars } = rankFromXp(p.xp), shown = p.rankOverride || rank, prog = rankProgress(p.xp);
  const out: any = { arenaId: p.arenaId, gameName: p.gameName, displayName: dispName(p), avatar: avatarUrl(p), rank: shown, rankIndex: RANKS.indexOf(shown), stars, xp: p.xp, rating: p.rating,
    rankOverride: !!p.rankOverride, progress: p.rankOverride ? null : { nextRank: prog.nextRank, nextAt: prog.nextAt, floor: prog.floor, pct: prog.pct, xpToNext: prog.xpToNext },
    wins: p.wins, losses: p.losses, draws: p.draws, matches: p.matches, winRate: p.matches ? Math.round((p.wins / p.matches) * 100) : 0,
    kd: kdOf(p), stats: p.stats, winStreak: p.winStreak || 0, bestStreak: p.bestStreak || 0, statsSource: p.statsSource, verified: !!p.verified, badges: badges(p), level: levelFromXp(p.xp) };
  if (p.showUid) out.ffUid = p.ffUid;
  if (p.showRealName || self) out.realName = p.realName;
  return out;
}
/** Admin view of a player: everything in the card plus the full UID and lock state (no real-name field). */
const adminCard = (p: any) => { const c = card(p); delete c.realName; return { ...c, ffUid: p.ffUid, locked: !!p.locked, lockReason: p.lockReason || null }; };

/** Last approved results for a player, built from the stored per-match effects (no invented numbers). */
async function recentMatches(uid: string, limit = 8) {
  const [a, b, names] = await Promise.all([db.collection("challenges").where("playerA", "==", uid).get(), db.collection("challenges").where("playerB", "==", uid).get(), nameMap()]);
  return [...a.docs, ...b.docs].map(d => ({ id: d.id, ...d.data() } as any)).filter(c => c.effects && c.result)
    .sort((x, y) => (y.approvedAt?.toMillis?.() || 0) - (x.approvedAt?.toMillis?.() || 0)).slice(0, limit)
    .map(c => { const k = c.playerA === uid ? "A" : "B", e = c.effects[k];
      return { id: c.id, title: c.title, opponent: names.get(k === "A" ? c.playerB : c.playerA) || "Unknown", outcome: e.out, scoreFor: k === "A" ? c.result.scoreA : c.result.scoreB,
        scoreAgainst: k === "A" ? c.result.scoreB : c.result.scoreA, ratingDelta: e.ratingDelta, xp: e.xp, at: c.approvedAt?.toMillis?.() || null }; });
}

let notifIndexOk = true;
async function notificationsFor(uid: string) {
  const col = db.collection("notifications").where("uid", "==", uid);
  if (notifIndexOk) {
    try { return (await col.orderBy("at", "desc").limit(20).get()).docs; }
    catch (e: any) { if (e?.code === 9 || /index/i.test(String(e?.message))) notifIndexOk = false; else throw e; } // falls back until the index exists
  }
  return [...(await col.get()).docs].sort((x, y) => (y.data().at?.toMillis?.() || 0) - (x.data().at?.toMillis?.() || 0)).slice(0, 20);
}

const AUDIT_LABELS: Record<string, string> = { REGISTRATION_APPROVE: "Approved registration", REGISTRATION_REJECT: "Rejected registration", REGISTRATION_CORRECTION: "Requested a correction", PLAYER_ADJUST: "XP / rank change",
  STATS_EDIT: "Stats / K/D correction", STATS_BULK_EDIT: "Bulk stats edit", PROFILE_LOCK: "Locked profile", PROFILE_UNLOCK: "Unlocked profile", PROFILE_EDIT: "Edited player profile", AVATAR_REMOVE: "Removed profile picture",
  RESULT_APPROVE: "Approved result", RESULT_CORRECT: "Corrected result", RESULT_REJECT: "Rejected result", RANK_UPDATE_PUBLISH: "Published rank update", TOURNAMENT_PUBLISH: "Published tournament", CONFIG_EDIT: "Changed config",
  SET_ROLE: "Changed admin role", BOOTSTRAP_OWNER: "Owner claimed", EXPORT: "Exported data", CHALLENGE_CREATE: "Created challenge", CHALLENGE_CANCEL: "Cancelled challenge" };
function auditDetail(x: any): string | null {
  const o = (v: any) => (v === null || v === undefined ? "none" : v);
  if (x.action === "PLAYER_ADJUST") return `XP ${x.prev?.xp} → ${x.next?.xp}` + (o(x.prev?.rankOverride) !== o(x.next?.rankOverride) ? ` · rank override ${o(x.prev?.rankOverride)} → ${o(x.next?.rankOverride)}` : "");
  if (x.action === "STATS_EDIT") return `K/D override ${x.prev?.kdOverride ?? "calculated"} → ${x.next?.kdOverride ?? "calculated"}`;
  if (x.action === "PROFILE_EDIT") return Object.keys(x.next || {}).map(k => `${k}: ${o(x.prev?.[k])} → ${o(x.next[k])}`).join(" · ");
  return null;
}
async function auditView(docs: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const names = new Map(await nameMap());
  const actors = [...new Set(docs.map(d => d.data().actor as string).filter(a => a && !names.has(a)))].slice(0, 20);
  const users = await Promise.all(actors.map(a => db.doc(`users/${a}`).get()));
  users.forEach((u, i) => { if (u.exists) names.set(actors[i], String(u.data()!.email || "").split("@")[0] || "Admin"); });
  return docs.map(d => { const x = d.data(); return { id: d.id, action: x.action, label: AUDIT_LABELS[x.action] || x.action, actor: names.get(x.actor) || "System", target: x.target ? names.get(x.target) || null : null, reason: x.reason || null, detail: auditDetail(x), at: x.at?.toMillis?.() || null }; });
}

const app = express();
// Railway terminates TLS at its proxy. Trust only the nearest proxy hop so rate limiting
// can use the real client IP without trusting arbitrary forwarded headers from the internet.
if (process.env.RAILWAY_ENVIRONMENT || process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  if (_req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (_req.secure || process.env.RAILWAY_ENVIRONMENT) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "20kb", strict: true }));
app.use("/api", (req, res, next) => { if (req.method !== "GET") res.on("finish", () => { pcache = null; }); next(); });
app.use("/api", rateLimit({ windowMs: 60000, limit: Number(process.env.RATE_LIMIT) || 120, standardHeaders: "draft-7", legacyHeaders: false }));

app.get("/health", (_q, r) => r.json({ ok: true }));
app.get("/api/config", (_q, r) => r.json({ apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN, projectId: process.env.FIREBASE_PROJECT_ID, appId: process.env.FIREBASE_APP_ID }));

// ---- Public: rank metadata, leaderboard (gaming identities only) and player cards ----
app.get("/api/meta", (_q, r) => {
  r.setHeader("Cache-Control", "public, max-age=60");
  r.json({ ranks: RANKS.map((name, i) => ({ name, threshold: THRESHOLDS[i], ...RANK_META[name] })), levelBase: LEVEL.base, avatarMaxBytes: AVATAR_MAX_BYTES });
});
app.get("/api/leaderboard", wrap(async (req, res) => {
  const field = req.query.tab === "rating" ? "rating" : "xp";
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 50)), offset = Math.max(0, parseInt(String(req.query.offset)) || 0);
  const q = String(req.query.q || "").slice(0, 40);
  // Same ordering and tie-break as before: value desc, then FF Arena ID. Positions are global even when searching.
  const ranked = (await activeProfiles()).sort((a, b) => b[field] - a[field] || a.arenaId.localeCompare(b.arenaId)).map((p, i) => ({ p, pos: i + 1 }));
  const hits = q ? ranked.filter(x => matches(q, dispName(x.p), x.p.gameName, x.p.arenaId)) : ranked;
  const rows = hits.slice(offset, offset + limit).map(({ p, pos }) => { const r = shownRank(p);
    return { pos, arenaId: p.arenaId, gameName: p.gameName, displayName: dispName(p), avatar: avatarUrl(p), rank: r, rankIndex: RANKS.indexOf(r), stars: rankFromXp(p.xp).stars, xp: p.xp, rating: p.rating, value: p[field] }; });
  res.json({ criteria: `Sorted by ${field} (desc); ties broken by FF Arena ID`, total: hits.length, offset, limit, rows });
}));
app.get("/api/players/:arenaId", wrap(async (req, res) => {
  const p = (await activeProfiles()).find(x => x.arenaId === req.params.arenaId);
  if (!p) throw new HttpErr(404, "Player not found");
  res.json({ ...card(p), recent: await recentMatches(p.uid) });
}));

// ---- Profile pictures. Stored in their own collection (never inside the player document) ----
// Firebase Storage is not configured in this project, so this needs no extra setup. The browser resizes pictures
// to a small square before upload; the server enforces type (by magic bytes) and a hard size cap.
const avatarHits = new Map<string, number[]>();
const avatarThrottle = (uid: string) => {
  const now = Date.now(), h = (avatarHits.get(uid) || []).filter(t => now - t < 3600e3);
  if (h.length >= 12) throw new HttpErr(429, "Too many picture changes. Try again in a while.");
  avatarHits.set(uid, [...h, now]);
};
async function sendAvatar(uid: string, res: Response, cache: string) {
  const s = await db.doc(`avatars/${uid}`).get();
  if (!s.exists) throw new HttpErr(404, "No picture");
  const d = s.data()!;
  res.setHeader("Content-Type", d.contentType); res.setHeader("Cache-Control", cache); res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.send(Buffer.from(d.data));
}
app.get("/api/avatars/:arenaId", wrap(async (req, res) => {
  const p = (await activeProfiles()).find(x => x.arenaId === req.params.arenaId);
  if (!p || !p.avatarV) throw new HttpErr(404, "No picture");
  await sendAvatar(p.uid, res, req.query.v ? "public, max-age=31536000, immutable" : "no-cache");
}));
app.get("/api/me/avatar", auth, wrap(async (req, res) => sendAvatar(req.user.uid, res, "private, no-cache")));
app.get("/api/admin/avatars/:uid", auth, isAdmin, wrap(async (req, res) => sendAvatar(req.params.uid, res, "private, no-cache")));
const rawImage = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: AVATAR_MAX_BYTES + 1024 });
/** Updates the small version marker that lives on whichever record the person currently has (profile or registration). */
async function setAvatarMarker(uid: string, v: number | null) {
  const pref = db.doc(`playerProfiles/${uid}`);
  if ((await pref.get()).exists) await pref.update({ avatarV: v }); else await db.doc(`registrations/${uid}`).update({ avatarV: v });
}
app.put("/api/me/avatar", auth, need("player", "pending"), rawImage, wrap(async (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpErr(400, "Send the picture as a JPEG, PNG or WebP image");
  if (body.length > AVATAR_MAX_BYTES) throw new HttpErr(413, `Picture is too large (max ${Math.round(AVATAR_MAX_BYTES / 1024)} KB)`);
  const type = detectImage(body);
  if (!type) throw new HttpErr(400, "That file isn't a JPEG, PNG or WebP image");
  if (req.user.role === "player") await mustBeUnlocked(req.user.uid);
  avatarThrottle(req.user.uid);
  const v = Date.now();
  await db.doc(`avatars/${req.user.uid}`).set({ data: body, contentType: type, size: body.length, at: TS() });
  await setAvatarMarker(req.user.uid, v);
  res.json({ ok: true, v });
}));
app.delete("/api/me/avatar", auth, need("player", "pending"), wrap(async (req, res) => {
  if (req.user.role === "player") await mustBeUnlocked(req.user.uid);
  await db.doc(`avatars/${req.user.uid}`).delete();
  await setAvatarMarker(req.user.uid, null);
  res.json({ ok: true });
}));

// ---- Owner bootstrap (one time, secret from Railway variables) ----
const bootTries = new Map<string, number[]>();
app.post("/api/bootstrap-owner", auth, wrap(async (req, res) => {
  const recent = (bootTries.get(req.user.uid) || []).filter(t => Date.now() - t < 15 * 60e3);
  if (recent.length >= 5) throw new HttpErr(429, "Too many attempts. Wait 15 minutes and try again.");
  bootTries.set(req.user.uid, [...recent, Date.now()]);
  // One-time bootstrap only for a brand-new account: pending, rejected and approved players can never claim ownership.
  if (req.user.role !== "none") throw new HttpErr(403, "Owner setup is only available to a new account that hasn't registered as a player.");
  const secret = process.env.BOOTSTRAP_SECRET, given = typeof req.body?.secret === "string" ? req.body.secret : "";
  const same = !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!same) throw new HttpErr(403, "Invalid bootstrap secret");
  await db.runTransaction(async t => {
    const flag = db.doc("appConfig/bootstrap");
    if ((await t.get(flag)).exists) throw new HttpErr(409, "Owner already exists");
    t.create(flag, { owner: req.user.uid, at: TS() });
    t.set(db.doc(`users/${req.user.uid}`), { role: "owner", email: req.user.email, createdAt: TS() }, { merge: true });
    audit(t, { actor: req.user.uid, action: "BOOTSTRAP_OWNER", target: req.user.uid });
  });
  res.json({ ok: true });
}));

// ---- Registration ----
app.post("/api/register", auth, wrap(async (req, res) => {
  if (req.user.role !== "none") throw new HttpErr(409, "Already registered");
  const b = req.body || {};
  const gameName = str(b.gameName, 2, 20, "Game name");
  const ffUid = str(b.ffUid, 6, 15, "Free Fire UID");
  if (!/^\d+$/.test(ffUid)) throw new HttpErr(400, "UID must be digits only");
  const displayName = b.displayName ? str(b.displayName, 2, 20, "Display name") : null;
  const realName = b.realName ? str(b.realName, 2, 60, "Name") : null; // optional and no longer asked for; kept so older clients still work
  const br = modeOf(b.br), cs = modeOf(b.cs);
  const e = validStats(br) || validStats(cs);
  if (e) throw new HttpErr(400, e);
  const admins = await db.collection("users").where("role", "in", ["owner", "admin"]).get();
  await db.runTransaction(async t => {
    t.create(db.doc(`users/${req.user.uid}`), { role: "pending", email: req.user.email, createdAt: TS() });
    t.create(db.doc(`registrations/${req.user.uid}`), { status: "PENDING", gameName, displayName, ffUid, realName, br, cs, source: "self-reported", createdAt: TS() });
    admins.docs.forEach(a => notify(t, a.id, `New registration: ${gameName}`));
  });
  res.json({ ok: true, status: "PENDING" });
}));

app.get("/api/me", auth, wrap(async (req, res) => {
  const uid = req.user.uid, role = req.user.role, out: any = { uid, role };
  const [r, p, notes, recent] = await Promise.all([["pending", "rejected"].includes(role) ? db.doc(`registrations/${uid}`).get() : null, db.doc(`playerProfiles/${uid}`).get(), notificationsFor(uid),
    role === "player" ? recentMatches(uid, 10) : Promise.resolve([])]);
  if (r) {
    const d = r.exists ? r.data()! : null;
    out.registration = d ? { status: d.status, reason: d.reason || null, note: d.note || null, gameName: d.gameName, displayName: d.displayName || null, ffUid: d.ffUid, br: d.br, cs: d.cs, hasAvatar: !!d.avatarV, avatarV: d.avatarV || null } : null;
  }
  if (p.exists) {
    const d = p.data()!, now = new Date();
    out.card = card(d, true);
    out.settings = { showRealName: !!d.showRealName, showUid: !!d.showUid };
    out.lock = { locked: !!d.locked, reason: d.lockReason || null };
    out.weekly = { target: CFG.weeklyTarget, done: d.weekly?.[istWeekStart(now)] || 0, previous: d.weekly?.[prevWeekStart(now)] || 0 };
    out.loginStreak = d.loginStreak || 0;
    out.recent = recent;
  }
  out.notifications = notes.map(x => ({ id: x.id, text: x.data().text, read: x.data().read, at: x.data().at?.toMillis?.() || null }));
  res.json(out);
}));

app.patch("/api/me/profile", auth, need("player"), wrap(async (req, res) => {
  const ref = db.doc(`playerProfiles/${req.user.uid}`), snap = await ref.get();
  if (!snap.exists) throw new HttpErr(404, "No player profile");
  if (snap.data()!.locked) throw lockedErr();
  const upd: any = {}; // only whitelisted fields can ever be set by a player
  if (req.body.gameName !== undefined) upd.gameName = str(req.body.gameName, 2, 20, "In-game name");
  if (req.body.displayName !== undefined) upd.displayName = req.body.displayName === "" || req.body.displayName === null ? null : str(req.body.displayName, 2, 20, "Display name");
  if (req.body.showRealName !== undefined) upd.showRealName = !!req.body.showRealName;
  if (req.body.showUid !== undefined) upd.showUid = !!req.body.showUid;
  if (!Object.keys(upd).length) throw new HttpErr(400, "Nothing to change");
  await ref.update(upd);
  res.json({ ok: true });
}));

/** A player whose registration needs a correction can fix their own submission and send it back to the queue. */
app.patch("/api/me/registration", auth, need("pending"), wrap(async (req, res) => {
  const b = req.body || {}, ref = db.doc(`registrations/${req.user.uid}`);
  const admins = await db.collection("users").where("role", "in", ["owner", "admin"]).get();
  await db.runTransaction(async t => {
    const r = await t.get(ref);
    if (!r.exists || r.data()!.status !== "NEEDS_CORRECTION") throw new HttpErr(409, "No correction was requested");
    const d = r.data()!, upd: any = { status: "PENDING", note: null };
    if (b.gameName !== undefined) upd.gameName = str(b.gameName, 2, 20, "In-game name");
    if (b.displayName !== undefined) upd.displayName = b.displayName === "" || b.displayName === null ? null : str(b.displayName, 2, 20, "Display name");
    if (b.ffUid !== undefined) { upd.ffUid = str(String(b.ffUid), 6, 15, "Free Fire UID"); if (!/^\d+$/.test(upd.ffUid)) throw new HttpErr(400, "UID must be digits only"); }
    const br = b.br ? modeOf(b.br) : d.br, cs = b.cs ? modeOf(b.cs) : d.cs, e = validStats(br) || validStats(cs);
    if (e) throw new HttpErr(400, e);
    Object.assign(upd, { br, cs });
    t.update(ref, upd);
    admins.docs.forEach(a => notify(t, a.id, `Registration updated: ${upd.gameName || d.gameName}`));
  });
  res.json({ ok: true, status: "PENDING" });
}));

app.post("/api/daily-login", auth, need("player"), wrap(async (req, res) => {
  const today = istDate(), ref = db.doc(`playerProfiles/${req.user.uid}`);
  const out = await db.runTransaction(async t => {
    const p = (await t.get(ref)).data()!;
    if (p.lastLogin === today) return { already: true, streak: p.loginStreak };
    const streak = nextStreak(p.lastLogin || null, today, p.loginStreak || 0);
    const xp = ledger(t, `login_${req.user.uid}_${today}`, req.user.uid, p.xp, CFG.loginXp, "Daily login", today, "system");
    t.update(ref, { lastLogin: today, loginStreak: streak, xp, ...rankFromXp(xp) });
    return { already: false, streak };
  });
  res.json(out);
}));

// ---- Admin: registrations ----
app.get("/api/admin/registrations", auth, isAdmin, wrap(async (req, res) => {
  const st = String(req.query.status || "PENDING").toUpperCase();
  const s = st === "ALL" ? await db.collection("registrations").get() : await db.collection("registrations").where("status", "==", st).get();
  res.json(s.docs.map(d => { const x = d.data(); return { uid: d.id, status: x.status, gameName: x.gameName, displayName: x.displayName || x.gameName, ffUid: x.ffUid, realName: x.realName ?? null, br: x.br, cs: x.cs,
    kd: kd((x.br?.kills || 0) + (x.cs?.kills || 0), (x.br?.deaths || 0) + (x.cs?.deaths || 0)), avatar: x.avatarV ? `/api/admin/avatars/${d.id}` : null, note: x.note || null, reason: x.reason || null, at: x.createdAt?.toMillis?.() || null }; })
    .sort((a, b) => (a.at || 0) - (b.at || 0)));
}));
app.post("/api/admin/registrations/:uid/correction", auth, isAdmin, wrap(async (req, res) => {
  const note = str(req.body.note, 3, 200, "Note"), uid = req.params.uid, rref = db.doc(`registrations/${uid}`);
  await db.runTransaction(async t => {
    const r = await t.get(rref);
    if (!r.exists || r.data()!.status !== "PENDING") throw new HttpErr(409, "Not pending");
    t.update(rref, { status: "NEEDS_CORRECTION", note, reviewedBy: req.user.uid });
    notify(t, uid, `Please update your registration: ${note}`);
    audit(t, { actor: req.user.uid, action: "REGISTRATION_CORRECTION", target: uid, reason: note });
  });
  res.json({ ok: true });
}));
app.post("/api/admin/registrations/:uid/:action", auth, isAdmin, wrap(async (req, res) => {
  const { uid, action } = req.params;
  if (!["approve", "reject"].includes(action)) throw new HttpErr(400, "Bad action");
  const reason = action === "reject" ? str(req.body.reason, 3, 200, "Reason") : "";
  await db.runTransaction(async t => {
    const rref = db.doc(`registrations/${uid}`), cref = db.doc("appConfig/counters");
    const [r, c] = await Promise.all([t.get(rref), t.get(cref)]);
    if (!r.exists || r.data()!.status !== "PENDING") throw new HttpErr(409, "Not pending");
    const d = r.data()!;
    if (action === "reject") {
      t.update(rref, { status: "REJECTED", reason, reviewedBy: req.user.uid });
      t.update(db.doc(`users/${uid}`), { role: "rejected" });
      notify(t, uid, `Registration rejected: ${reason}`);
    } else {
      const n = (c.exists ? c.data()!.players : 0) + 1;
      const arenaId = "FFA-" + String(n).padStart(4, "0");
      const xp = initialXp([d.br, d.cs]);
      t.set(cref, { players: n }, { merge: true });
      t.create(db.doc(`playerProfiles/${uid}`), { uid, arenaId, status: "active", gameName: d.gameName, displayName: d.displayName || null, avatarV: d.avatarV || null, locked: false, ffUid: d.ffUid, realName: d.realName ?? null,
        showRealName: false, showUid: true, xp, rating: CFG.startRating, wins: 0, losses: 0, draws: 0, matches: 0, kills: d.br.kills + d.cs.kills,
        deaths: d.br.deaths + d.cs.deaths, kdOverride: null, stats: { br: d.br, cs: d.cs }, statsSource: "self-reported", verified: false,
        winStreak: 0, bestStreak: 0, weekly: {}, createdAt: TS(), ...rankFromXp(xp) });
      t.create(db.doc(`xpLedger/init_${uid}`), { uid, amount: xp, prev: 0, balance: xp, reason: "Initial score (self-reported stats)", ref: "init", actor: req.user.uid, at: TS() });
      t.update(rref, { status: "APPROVED", reviewedBy: req.user.uid });
      t.update(db.doc(`users/${uid}`), { role: "player" });
      notify(t, uid, `Welcome! You are ${arenaId}`);
    }
    audit(t, { actor: req.user.uid, action: `REGISTRATION_${action.toUpperCase()}`, target: uid, reason });
  });
  res.json({ ok: true });
}));

const profRow = (p: any) => ({ uid: p.uid, arenaId: p.arenaId, gameName: p.gameName, displayName: dispName(p), ffUid: p.ffUid, status: "approved", locked: !!p.locked, lockReason: p.lockReason || null,
  rank: shownRank(p), rankIndex: RANKS.indexOf(shownRank(p)), xp: p.xp, rating: p.rating, kd: kdOf(p).value, avatar: avatarUrl(p), avatarProtected: false });
const regRow = (id: string, d: any) => ({ uid: id, arenaId: null, gameName: d.gameName, displayName: d.displayName || d.gameName, ffUid: d.ffUid, locked: false, rank: null, rankIndex: null, xp: null, rating: null,
  status: d.status === "REJECTED" ? "rejected" : d.status === "NEEDS_CORRECTION" ? "correction" : "pending", kd: kd((d.br?.kills || 0) + (d.cs?.kills || 0), (d.br?.deaths || 0) + (d.cs?.deaths || 0)),
  avatar: d.avatarV ? `/api/admin/avatars/${id}` : null, avatarProtected: !!d.avatarV });
app.get("/api/admin/players", auth, isAdmin, wrap(async (req, res) => {
  const status = String(req.query.status || "approved"), q = String(req.query.q || "").slice(0, 40);
  const needRegs = !["approved", "locked", "active"].includes(status);
  const [prof, regs] = await Promise.all([profiles(), needRegs ? db.collection("registrations").get() : null]);
  let rows: any[] = prof.filter(p => p.status === "active").map(profRow);
  if (regs) rows = rows.concat(regs.docs.filter(d => d.data().status !== "APPROVED").map(d => regRow(d.id, d.data())));
  rows = rows.filter(r => status === "all" || (status === "locked" ? r.locked : status === "active" ? r.status === "approved" && !r.locked : r.status === status)).filter(r => matches(q, r.displayName, r.gameName, r.ffUid, r.arenaId));
  res.json(rows.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))));
}));
app.get("/api/admin/players/:uid", auth, isAdmin, wrap(async (req, res) => {
  const uid = req.params.uid;
  const [p, r, lh, logs] = await Promise.all([db.doc(`playerProfiles/${uid}`).get(), db.doc(`registrations/${uid}`).get(), db.doc(`lockHistory/${uid}`).get(), db.collection("adminAuditLogs").where("target", "==", uid).get()]);
  if (!p.exists && !r.exists) throw new HttpErr(404, "Player not found");
  const rd = r.exists ? r.data()! : null;
  const history = await auditView([...logs.docs].sort((x, y) => (y.data().at?.toMillis?.() || 0) - (x.data().at?.toMillis?.() || 0)).slice(0, 20));
  res.json({ uid, approved: p.exists, profile: p.exists ? adminCard(p.data()) : null, recent: p.exists ? await recentMatches(uid, 5) : [],
    registration: rd ? { status: rd.status, gameName: rd.gameName, displayName: rd.displayName || null, ffUid: rd.ffUid, br: rd.br, cs: rd.cs, note: rd.note || null, reason: rd.reason || null,
      avatar: rd.avatarV && !p.exists ? `/api/admin/avatars/${uid}` : null } : null,
    lock: { locked: p.exists ? !!p.data()!.locked : false, reason: p.exists ? p.data()!.lockReason || null : null }, lockHistory: lh.exists ? [...lh.data()!.entries].reverse() : [], history });
}));
app.post("/api/admin/players/:uid/lock", auth, isAdmin, wrap(async (req, res) => {
  if (typeof req.body.locked !== "boolean") throw new HttpErr(400, "locked must be true or false");
  const locked: boolean = req.body.locked, reason = req.body.reason ? str(req.body.reason, 3, 200, "Reason") : "", uid = req.params.uid;
  const ref = db.doc(`playerProfiles/${uid}`), href = db.doc(`lockHistory/${uid}`);
  await db.runTransaction(async t => {
    const [p, h] = await Promise.all([t.get(ref), t.get(href)]);
    if (!p.exists) throw new HttpErr(404, "Player not found");
    if (!!p.data()!.locked === locked) throw new HttpErr(409, locked ? "Profile is already locked" : "Profile is already unlocked");
    const entries = [...(h.exists ? h.data()!.entries : []), { locked, reason, by: String(req.user.email || "admin").split("@")[0], at: Date.now() }].slice(-25);
    t.update(ref, { locked, lockReason: locked ? reason || null : null, lockedAt: locked ? TS() : null });
    t.set(href, { entries });
    notify(t, uid, locked ? `Your profile was locked${reason ? ": " + reason : ""}` : "Your profile was unlocked");
    audit(t, { actor: req.user.uid, action: locked ? "PROFILE_LOCK" : "PROFILE_UNLOCK", target: uid, reason });
  });
  res.json({ ok: true, locked });
}));
app.patch("/api/admin/players/:uid/profile", auth, isAdmin, wrap(async (req, res) => {
  const b = req.body || {}, upd: any = {}, uid = req.params.uid;
  if (b.gameName !== undefined) upd.gameName = str(b.gameName, 2, 20, "In-game name");
  if (b.displayName !== undefined) upd.displayName = b.displayName === "" || b.displayName === null ? null : str(b.displayName, 2, 20, "Display name");
  if (b.ffUid !== undefined) { upd.ffUid = str(String(b.ffUid), 6, 15, "Free Fire UID"); if (!/^\d+$/.test(upd.ffUid)) throw new HttpErr(400, "UID must be digits only"); }
  if (!Object.keys(upd).length) throw new HttpErr(400, "Nothing to change");
  const reason = b.reason ? str(b.reason, 3, 200, "Reason") : "", ref = db.doc(`playerProfiles/${uid}`);
  await db.runTransaction(async t => {
    const p = await t.get(ref);
    if (!p.exists) throw new HttpErr(404, "Player not found");
    const prev: any = {}; for (const k of Object.keys(upd)) prev[k] = p.data()![k] ?? null;
    t.update(ref, upd);
    audit(t, { actor: req.user.uid, action: "PROFILE_EDIT", target: uid, reason, prev, next: upd });
  });
  res.json({ ok: true });
}));
app.delete("/api/admin/players/:uid/avatar", auth, isAdmin, wrap(async (req, res) => {
  const uid = req.params.uid;
  if (!(await db.doc(`avatars/${uid}`).get()).exists) throw new HttpErr(404, "No picture");
  await db.doc(`avatars/${uid}`).delete();
  await setAvatarMarker(uid, null);
  await audit(null, { actor: req.user.uid, action: "AVATAR_REMOVE", target: uid });
  res.json({ ok: true });
}));
app.get("/api/admin/overview", auth, isAdmin, wrap(async (_q, res) => {
  const [prof, regs, recent, logs, names] = await Promise.all([profiles(), db.collection("registrations").get(), db.collection("challenges").orderBy("approvedAt", "desc").limit(5).get(),
    db.collection("adminAuditLogs").orderBy("at", "desc").limit(8).get(), nameMap()]);
  const count = (st: string) => regs.docs.filter(d => d.data().status === st).length, active = prof.filter(p => p.status === "active");
  res.json({ totals: { registered: regs.size, approved: active.length, pending: count("PENDING"), correction: count("NEEDS_CORRECTION"), rejected: count("REJECTED"), locked: active.filter(p => p.locked).length },
    recentMatches: recent.docs.filter(d => d.data().effects).map(d => { const c = d.data(); return { id: d.id, title: c.title, a: names.get(c.playerA), b: names.get(c.playerB), winner: c.result?.winner, scoreA: c.result?.scoreA, scoreB: c.result?.scoreB, at: c.approvedAt?.toMillis?.() || null }; }),
    recentChanges: await auditView(logs.docs) });
}));
app.get("/api/admin/audit", auth, isAdmin, wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 40));
  res.json(await auditView((await db.collection("adminAuditLogs").orderBy("at", "desc").limit(limit).get()).docs));
}));

app.post("/api/owner/admins", auth, need("owner"), wrap(async (req, res) => {
  const uid = str(req.body.uid, 1, 128, "uid");
  await db.runTransaction(async t => {
    const u = await t.get(db.doc(`users/${uid}`));
    if (!u.exists) throw new HttpErr(404, "User not found");
    if (u.data()!.role === "owner") throw new HttpErr(400, "Cannot change owner");
    const role = req.body.admin ? "admin" : "player";
    t.update(db.doc(`users/${uid}`), { role });
    audit(t, { actor: req.user.uid, action: "SET_ROLE", target: uid, prev: u.data()!.role, next: role });
  });
  res.json({ ok: true });
}));

// ---- Admin: challenges + results ----
app.post("/api/admin/challenges", auth, isAdmin, wrap(async (req, res) => {
  const { playerA, playerB } = req.body;
  if (!playerA || !playerB || playerA === playerB) throw new HttpErr(400, "Pick two different players");
  const [a, b] = await Promise.all([db.doc(`playerProfiles/${playerA}`).get(), db.doc(`playerProfiles/${playerB}`).get()]);
  if (!a.exists || !b.exists || a.data()!.status !== "active" || b.data()!.status !== "active") throw new HttpErr(400, "Both players must be approved");
  if (a.data()!.locked || b.data()!.locked) throw new HttpErr(400, "A locked player can't be added to a challenge");
  const when = new Date(req.body.scheduledAt);
  if (isNaN(+when)) throw new HttpErr(400, "Invalid date");
  const ref = await db.collection("challenges").add({ playerA, playerB, type: "1v1", title: str(req.body.title, 3, 80, "Title"),
    rules: String(req.body.rules || "").slice(0, 500), notes: String(req.body.notes || "").slice(0, 500), scheduledAt: when,
    status: "SCHEDULED", createdBy: req.user.uid, createdAt: TS() });
  await audit(null, { actor: req.user.uid, action: "CHALLENGE_CREATE", target: ref.id });
  const names = await nameMap();
  await announceChallenge(`New match scheduled: ${names.get(playerA) || "A player"} vs ${names.get(playerB) || "a player"} — “${String(req.body.title).trim()}”`, []);
  res.json({ id: ref.id });
}));
app.get("/api/admin/challenges", auth, isAdmin, wrap(async (_req, res) => {
  const s = await db.collection("challenges").orderBy("createdAt", "desc").limit(50).get();
  const names = new Map((await db.collection("playerProfiles").get()).docs.map(d => [d.id, d.data().gameName]));
  res.json(s.docs.map(d => { const c = d.data(); return { id: d.id, title: c.title, status: c.status, a: names.get(c.playerA), b: names.get(c.playerB), scheduledAt: c.scheduledAt?.toDate?.() ?? null }; }));
}));
app.post("/api/admin/challenges/:id/cancel", auth, isAdmin, wrap(async (req, res) => {
  const ref = db.doc(`challenges/${req.params.id}`);
  await db.runTransaction(async t => {
    const c = await t.get(ref);
    if (!c.exists || ["APPROVED", "CANCELLED"].includes(c.data()!.status)) throw new HttpErr(409, "Cannot cancel");
    t.update(ref, { status: "CANCELLED" });
    audit(t, { actor: req.user.uid, action: "CHALLENGE_CANCEL", target: ref.id });
  });
  res.json({ ok: true });
}));

// ---- Admin: stats + K/D control ----
app.post("/api/admin/stats/:uid", auth, isAdmin, wrap(async (req, res) => {
  const mode = req.body.mode;
  if (!["br", "cs"].includes(mode)) throw new HttpErr(400, "Mode must be br or cs");
  const reason = str(req.body.reason, 3, 200, "Reason");
  const s = modeOf(req.body);
  const e = validStats(s);
  if (e) throw new HttpErr(400, e);
  const hasKo = Object.prototype.hasOwnProperty.call(req.body, "kdOverride");
  const ko = !hasKo ? undefined : (req.body.kdOverride === null || req.body.kdOverride === "" ? null : Number(req.body.kdOverride));
  if (ko !== undefined && ko !== null && (!Number.isFinite(ko) || ko < 0 || ko > 100)) throw new HttpErr(400, "K/D must be 0-100");
  const ref = db.doc(`playerProfiles/${req.params.uid}`);
  await db.runTransaction(async t => {
    const p = await t.get(ref);
    if (!p.exists) throw new HttpErr(404, "Player not found");
    const d = p.data()!, stats = { ...d.stats, [mode]: s };
    // Omitted override means leave unchanged; explicit null/empty clears it.
    const patch: any = { stats, kills: stats.br.kills + stats.cs.kills, deaths: stats.br.deaths + stats.cs.deaths, statsSource: "admin-edited" };
    if (ko !== undefined) patch.kdOverride = ko;
    t.update(ref, patch);
    audit(t, { actor: req.user.uid, action: "STATS_EDIT", target: req.params.uid, reason, prev: { stats: d.stats, kdOverride: d.kdOverride }, next: { stats, ...(ko !== undefined ? { kdOverride: ko } : { kdOverride: d.kdOverride }) } });
  });
  res.json({ ok: true });
}));

// ===================== Phase 2 features =====================
const MISSIONS = [
  { key: "five", title: "Complete 5 approved challenges", target: 5, field: "weekly", xp: 50 },
  { key: "wins2", title: "Win 2 approved matches", target: 2, field: "weeklyWins", xp: 30 },
  { key: "custom", title: "Join a tournament / BR custom", target: 1, field: "weeklyTourn", xp: 20 },
];
const OPEN = ["PROPOSED", "SCHEDULED", "PENDING_REVIEW", "DISPUTED"];
const nameMap = async () => new Map((await profiles()).map(p => [p.uid as string, dispName(p) as string]));
const byArena = async (arenaId: string) => {
  const s = await db.collection("playerProfiles").where("arenaId", "==", String(arenaId)).limit(1).get();
  if (s.empty) throw new HttpErr(404, `Unknown player ${arenaId}`);
  return s.docs[0];
};
const notifyNow = (uid: string, text: string) => db.collection("notifications").add({ uid, text, read: false, at: TS() });
const notifyAdmins = async (text: string) => { const admins = await db.collection("users").where("role", "in", ["owner", "admin"]).get(); await Promise.all(admins.docs.map(a => notifyNow(a.id, text))); };
/** Tells every approved player about a new challenge. Best effort: a failure here never fails the challenge itself. */
async function announceChallenge(text: string, skip: string[]) {
  try { await Promise.all((await activeProfiles()).filter(p => !skip.includes(p.uid)).map(p => notifyNow(p.uid, text))); }
  catch (e) { console.error("challenge announcement failed", e); }
}
const resultOk = (b: any) => {
  if (!["A", "B", "draw"].includes(b.winner)) throw new HttpErr(400, "Winner must be A, B or draw");
  const scoreA = num(b.scoreA), scoreB = num(b.scoreB);
  if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA < 0 || scoreB < 0 || !Number.isInteger(scoreA) || !Number.isInteger(scoreB)) throw new HttpErr(400, "Scores must be finite, non-negative whole numbers");
  if (b.winner === "A" && scoreA <= scoreB) throw new HttpErr(400, "Player A must have the higher score");
  if (b.winner === "B" && scoreB <= scoreA) throw new HttpErr(400, "Player B must have the higher score");
  if (b.winner === "draw" && scoreA !== scoreB) throw new HttpErr(400, "A draw must have equal scores");
  return { winner: b.winner as string, scoreA, scoreB, notes: String(b.notes || "").slice(0, 300) };
};
const xpFor = (o: string) => (o === "W" ? CFG.winXp : o === "D" ? CFG.drawXp : CFG.lossXp);

app.get("/api/players", auth, need("player", "admin", "owner"), wrap(async (_q, res) => {
  res.json((await activeProfiles()).map(p => ({ uid: p.uid, arenaId: p.arenaId, gameName: p.gameName, displayName: dispName(p), avatar: avatarUrl(p), locked: !!p.locked })));
}));

// ---- Player-created challenges ----
app.get("/api/challenges/mine", auth, need("player"), wrap(async (req, res) => {
  const [a, b] = await Promise.all([db.collection("challenges").where("playerA", "==", req.user.uid).get(), db.collection("challenges").where("playerB", "==", req.user.uid).get()]);
  const names = await nameMap();
  res.json([...a.docs, ...b.docs].map(d => { const c = d.data(); return { id: d.id, title: c.title, status: c.status, a: names.get(c.playerA), b: names.get(c.playerB), meIsB: c.playerB === req.user.uid, at: c.createdAt?.toMillis?.() || 0 }; })
    .sort((x, y) => y.at - x.at).slice(0, 30));
}));
app.post("/api/challenges", auth, need("player"), wrap(async (req, res) => {
  const opp = req.body.opponent;
  if (!opp || opp === req.user.uid) throw new HttpErr(400, "Pick another player");
  await mustBeUnlocked(req.user.uid);
  const o = await db.doc(`playerProfiles/${opp}`).get();
  if (!o.exists || o.data()!.status !== "active") throw new HttpErr(400, "Opponent must be an approved player");
  if (o.data()!.locked) throw new HttpErr(400, "That player's profile is locked, so they can't take part right now");
  const open = (await db.collection("challenges").where("playerA", "==", req.user.uid).get()).docs.map(d => d.data()).filter(c => OPEN.includes(c.status));
  if (open.length >= 5) throw new HttpErr(429, "Too many open challenges");
  if (open.some(c => c.playerB === opp)) throw new HttpErr(409, "You already have an open challenge with this player");
  const ref = await db.collection("challenges").add({ playerA: req.user.uid, playerB: opp, type: "1v1", title: str(req.body.title, 3, 80, "Title"),
    rules: String(req.body.rules || "").slice(0, 500), notes: "", scheduledAt: new Date(), status: "PROPOSED", createdBy: req.user.uid, createdAt: TS() });
  await notifyNow(opp, "You have a new challenge");
  const names = await nameMap(); // everyone else hears about it; the opponent already got the personal notice above
  await announceChallenge(`${names.get(req.user.uid) || "A player"} challenged ${names.get(opp) || "a player"}: “${String(req.body.title).trim()}”`, [req.user.uid, opp]);
  res.json({ id: ref.id });
}));
app.post("/api/challenges/:id/respond", auth, need("player"), wrap(async (req, res) => {
  await mustBeUnlocked(req.user.uid);
  const ref = db.doc(`challenges/${req.params.id}`);
  let from = "";
  await db.runTransaction(async t => {
    const c = await t.get(ref);
    if (!c.exists || c.data()!.playerB !== req.user.uid || c.data()!.status !== "PROPOSED") throw new HttpErr(409, "Cannot respond");
    from = c.data()!.playerA;
    t.update(ref, req.body.accept ? { status: "SCHEDULED" } : { status: "CANCELLED", declined: true });
    notify(t, from, req.body.accept ? "Challenge accepted" : "Challenge declined");
  });
  res.json({ ok: true });
}));
app.post("/api/challenges/:id/submit", auth, need("player"), wrap(async (req, res) => {
  const sub = { ...resultOk(req.body), by: req.user.uid };
  await mustBeUnlocked(req.user.uid);
  const ref = db.doc(`challenges/${req.params.id}`);
  await db.runTransaction(async t => {
    const c = await t.get(ref);
    if (!c.exists) throw new HttpErr(404, "Not found");
    const d = c.data()!;
    if (![d.playerA, d.playerB].includes(req.user.uid)) throw new HttpErr(403, "Not your challenge");
    if (!["SCHEDULED", "REJECTED"].includes(d.status)) throw new HttpErr(409, "Result cannot be submitted now");
    t.update(ref, { status: "PENDING_REVIEW", submission: sub });
  });
  await notifyAdmins("A result is waiting for review");
  res.json({ ok: true });
}));
app.post("/api/challenges/:id/dispute", auth, need("player"), wrap(async (req, res) => {
  const reason = str(req.body.reason, 10, 500, "Reason"), ref = db.doc(`challenges/${req.params.id}`);
  await db.runTransaction(async t => {
    const c = await t.get(ref);
    if (!c.exists) throw new HttpErr(404, "Not found");
    const d = c.data()!;
    if (![d.playerA, d.playerB].includes(req.user.uid)) throw new HttpErr(403, "Not your challenge");
    if (!["APPROVED", "PENDING_REVIEW"].includes(d.status)) throw new HttpErr(409, "Cannot dispute now");
    if (d.status === "APPROVED" && Date.now() - d.approvedAt.toMillis() > 7 * 864e5) throw new HttpErr(409, "Dispute window (7 days) has passed");
    t.create(db.doc(`disputes/${req.params.id}`), { challenge: req.params.id, by: req.user.uid, reason, status: "OPEN", at: TS() });
    t.update(ref, { status: "DISPUTED", prevStatus: d.status });
  });
  await notifyAdmins("A result was disputed");
  res.json({ ok: true });
}));

// ---- Admin: review queue, approve / correct / reject ----
app.get("/api/admin/review", auth, isAdmin, wrap(async (_q, res) => {
  const [s, dp, names] = await Promise.all([db.collection("challenges").where("status", "in", ["PENDING_REVIEW", "DISPUTED"]).get(), db.collection("disputes").where("status", "==", "OPEN").get(), nameMap()]);
  const dm = new Map(dp.docs.map(d => [d.id, d.data().reason]));
  res.json({ items: s.docs.map(d => { const c = d.data(); return { id: d.id, title: c.title, status: c.status, a: names.get(c.playerA), b: names.get(c.playerB), submission: c.submission || null, dispute: dm.get(d.id) || null, hasEffects: !!c.effects }; }) });
}));

/** Applies (mode=approve) or corrects (mode=correct) a result. Correction first reverses the previous effects
 *  (rating delta, XP via ledger, W/L/D counters) and then applies the new ones, all in ONE transaction.
 *  Ledger ids include the version, so each version can be applied exactly once.
 *  Note: reversal subtracts the stored rating delta; later matches by the same players are not recomputed. */
async function settle(req: any, id: string, mode: "approve" | "correct") {
  const r = resultOk(req.body);
  const reason = mode === "correct" ? str(req.body.reason, 3, 200, "Reason") : "";
  const cref = db.doc(`challenges/${id}`), dref = db.doc(`disputes/${id}`);
  await db.runTransaction(async t => {
    const c = await t.get(cref);
    if (!c.exists) throw new HttpErr(404, "Challenge not found");
    const cd = c.data()!;
    if (cd.status === "CANCELLED") throw new HttpErr(409, "Challenge cancelled");
    if (mode === "approve" && cd.effects) throw new HttpErr(409, "Result already approved (use correction)");
    if (mode === "correct" && !cd.effects) throw new HttpErr(409, "Nothing to correct");
    const [pa, pb, dp] = await Promise.all([t.get(db.doc(`playerProfiles/${cd.playerA}`)), t.get(db.doc(`playerProfiles/${cd.playerB}`)), t.get(dref)]);
    const A = pa.data()!, B = pb.data()!;
    if (A.status !== "active" || B.status !== "active") throw new HttpErr(400, "Players must be active");
    const old = cd.effects, ver = (cd.version || 0) + 1, wk = old?.wk || istWeekStart();
    const baseA = A.rating - (old?.A.ratingDelta || 0), baseB = B.rating - (old?.B.ratingDelta || 0);
    const e = elo(baseA, baseB, r.winner === "A" ? 1 : r.winner === "B" ? 0 : 0.5);
    const effects: any = { wk };
    for (const s of [
      { key: "A", uid: cd.playerA, ref: pa.ref, p: A, base: baseA, rating: e.a, out: r.winner === "A" ? "W" : r.winner === "B" ? "L" : "D" },
      { key: "B", uid: cd.playerB, ref: pb.ref, p: B, base: baseB, rating: e.b, out: r.winner === "B" ? "W" : r.winner === "A" ? "L" : "D" }]) {
      const o = old?.[s.key];
      let xp = s.p.xp;
      if (o) xp = ledger(t, `${id}_${s.uid}_rev${ver}`, s.uid, xp, -o.xp, `Reverse result v${ver - 1}`, id, req.user.uid);
      const before = xp;
      xp = ledger(t, `${id}_${s.uid}_v${ver}`, s.uid, xp, xpFor(s.out), `Challenge ${s.out} (v${ver})`, id, req.user.uid);
      effects[s.key] = { out: s.out, ratingDelta: s.rating - s.base, xp: xp - before };
      const cnt = (k: string, v: string) => (s.p[k] || 0) - (o?.out === v ? 1 : 0) + (s.out === v ? 1 : 0);
      const first = o ? {} : { winStreak: s.out === "W" ? (s.p.winStreak || 0) + 1 : 0, bestStreak: Math.max(s.p.bestStreak || 0, s.out === "W" ? (s.p.winStreak || 0) + 1 : 0), [`weekly.${wk}`]: INC(1) };
      t.update(s.ref, { xp, rating: s.rating, matches: s.p.matches + (o ? 0 : 1), wins: cnt("wins", "W"), losses: cnt("losses", "L"), draws: cnt("draws", "D"),
        [`weeklyWins.${wk}`]: INC((s.out === "W" ? 1 : 0) - (o?.out === "W" ? 1 : 0)), ...first, ...rankFromXp(xp) });
      notify(t, s.uid, `${mode === "correct" ? "Result corrected" : "Result approved"}: ${s.out === "W" ? "Win" : s.out === "L" ? "Loss" : "Draw"} (rating ${s.rating})`);
    }
    t.update(cref, { status: "APPROVED", version: ver, effects, result: r, approvedBy: req.user.uid, approvedAt: TS() });
    if (dp.exists && dp.data()!.status === "OPEN") t.update(dref, { status: "RESOLVED", resolution: "corrected", by: req.user.uid });
    audit(t, { actor: req.user.uid, action: mode === "correct" ? "RESULT_CORRECT" : "RESULT_APPROVE", target: id, reason, prev: old || null, next: { ...r, effects } });
  });
}
app.post("/api/admin/challenges/:id/result", auth, isAdmin, wrap(async (req, res) => { await settle(req, req.params.id, "approve"); await checkBoost(req.params.id).catch(() => {}); res.json({ ok: true }); }));
app.post("/api/admin/challenges/:id/correct", auth, isAdmin, wrap(async (req, res) => { await settle(req, req.params.id, "correct"); res.json({ ok: true }); }));
app.post("/api/admin/challenges/:id/reject", auth, isAdmin, wrap(async (req, res) => {
  const reason = str(req.body.reason, 3, 200, "Reason"), ref = db.doc(`challenges/${req.params.id}`);
  await db.runTransaction(async t => {
    const c = await t.get(ref);
    if (!c.exists || c.data()!.effects || !["PENDING_REVIEW", "DISPUTED"].includes(c.data()!.status)) throw new HttpErr(409, "Cannot reject");
    t.update(ref, { status: "REJECTED", rejectReason: reason });
    [c.data()!.playerA, c.data()!.playerB].forEach(u => notify(t, u, `Result rejected: ${reason}`));
    audit(t, { actor: req.user.uid, action: "RESULT_REJECT", target: ref.id, reason });
  });
  res.json({ ok: true });
}));
app.post("/api/admin/disputes/:id/dismiss", auth, isAdmin, wrap(async (req, res) => {
  const note = str(req.body.note, 3, 200, "Note"), cref = db.doc(`challenges/${req.params.id}`), dref = db.doc(`disputes/${req.params.id}`);
  await db.runTransaction(async t => {
    const [c, d] = await Promise.all([t.get(cref), t.get(dref)]);
    if (!d.exists || d.data()!.status !== "OPEN") throw new HttpErr(409, "No open dispute");
    t.update(cref, { status: c.data()!.prevStatus || "APPROVED" });
    t.update(dref, { status: "RESOLVED", resolution: "dismissed", note, by: req.user.uid });
    notify(t, d.data()!.by, `Dispute dismissed: ${note}`);
    audit(t, { actor: req.user.uid, action: "DISPUTE_DISMISS", target: req.params.id, reason: note });
  });
  res.json({ ok: true });
}));

// ---- Weekly missions (progress is automatic; each reward is claimable once per week) ----
// ===================== Open matches (player-created, public, publish immediately) =====================
// Collection `openMatches/{autoId}`:
//   creatorUid: string          uid of the player who created it (server-set, never taken from the request)
//   creatorName: string         display name snapshot at creation time
//   title: string               3-60 chars
//   mode: "br" | "cs"           Battle Royale or Clash Squad
//   scheduledAt: Timestamp      start time (between 1 minute and 30 days after creation)
//   capacity: number            total slots INCLUDING the creator (br 2-50, cs 2-8)
//   participants: string[]      uids; the creator is always participants[0], so the creator occupies one slot
//   participantCount: number    always participants.length (kept for easy display and future queries)
//   status: "OPEN" | "CANCELLED"   created as OPEN with no admin approval; only the creator can cancel while OPEN
//   createdAt: Timestamp, cancelledAt?: Timestamp, cancelledBy?: string
// Open matches never touch XP, rating, ledgers or player statistics.
const tms = (v: any): number => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);
const throttles = new Map<string, number[]>();
const throttle = (key: string, max: number, windowMs: number, msg: string) => {
  const now = Date.now(), hits = (throttles.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) throw new HttpErr(429, msg);
  throttles.set(key, [...hits, now]);
};
const MATCH_CREATE_PER_HOUR = Number(process.env.OPEN_MATCH_CREATE_PER_HOUR) || 10, MATCH_JOIN_PER_10MIN = Number(process.env.OPEN_MATCH_JOIN_PER_10MIN) || 40;
const matchId = (v: any): string => { if (typeof v !== "string" || !/^[\w-]{1,64}$/.test(v)) throw new HttpErr(404, "Match not found"); return v; };
function matchView(id: string, d: any, uid: string, people: Map<string, any>) {
  const parts: string[] = d.participants || [], occupied = parts.length, started = tms(d.scheduledAt) <= Date.now(), open = d.status === "OPEN";
  const who = (u: string) => { const p = people.get(u); return { arenaId: p?.arenaId ?? null, displayName: p ? dispName(p) : "Player", avatar: p ? avatarUrl(p) : null }; };
  const creator = who(d.creatorUid);
  return { id, title: d.title, mode: d.mode, modeLabel: MODE_LABEL[d.mode], status: d.status, scheduledAt: tms(d.scheduledAt), capacity: d.capacity, occupied, remaining: Math.max(0, d.capacity - occupied),
    full: occupied >= d.capacity, started, creatorName: people.get(d.creatorUid) ? creator.displayName : d.creatorName, creator, isCreator: d.creatorUid === uid, joined: parts.includes(uid),
    canJoin: open && !started && occupied < d.capacity && !parts.includes(uid), canCancel: open && d.creatorUid === uid, players: parts.map(who) };
}
// ---- Community feed: recent approved results, visible to every signed-in account ----
app.get("/api/recent-matches", auth, need("player", "admin", "owner"), wrap(async (req, res) => {
  const limit = Math.min(30, Math.max(1, parseInt(String(req.query.limit)) || 15));
  const [snap, all] = await Promise.all([db.collection("challenges").orderBy("approvedAt", "desc").limit(60).get(), profiles()]);
  const who = new Map(all.map(p => [p.uid as string, { arenaId: p.arenaId, displayName: dispName(p), avatar: avatarUrl(p) }]));
  const one = (u: string) => who.get(u) || { arenaId: null, displayName: "Player", avatar: null };
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() } as any)).filter(c => c.effects && c.result).slice(0, limit)
    .map(c => ({ id: c.id, title: c.title, a: one(c.playerA), b: one(c.playerB), winner: c.result.winner, scoreA: c.result.scoreA, scoreB: c.result.scoreB, at: c.approvedAt?.toMillis?.() || null })));
}));

app.get("/api/open-matches", auth, need("player"), wrap(async (req, res) => {
  const [snap, all] = await Promise.all([db.collection("openMatches").where("status", "==", "OPEN").get(), activeProfiles()]);
  const people = new Map(all.map(p => [p.uid as string, p])), floor = Date.now() - OPEN_MATCH.graceMs;
  const rows = snap.docs.filter(d => tms(d.data().scheduledAt) >= floor).sort((a, b) => tms(a.data().scheduledAt) - tms(b.data().scheduledAt)).slice(0, 50);
  res.json(rows.map(d => matchView(d.id, d.data(), req.user.uid, people)));
}));
app.post("/api/open-matches", auth, need("player"), wrap(async (req, res) => {
  const v = parseOpenMatch(req.body);
  if (!v.ok) throw new HttpErr(400, v.error);
  const uid = req.user.uid, pref = await db.doc(`playerProfiles/${uid}`).get();
  if (!pref.exists || pref.data()!.status !== "active") throw new HttpErr(403, "Only approved players can create matches");
  if (pref.data()!.locked) throw lockedErr();
  throttle(`om-create:${uid}`, MATCH_CREATE_PER_HOUR, 3600e3, "You're creating matches too quickly. Try again later.");
  // Best-effort cap on simultaneously open matches per creator (not transactional: two perfectly simultaneous creates could overshoot by one).
  const mine = await db.collection("openMatches").where("creatorUid", "==", uid).where("status", "==", "OPEN").get();
  if (mine.docs.filter(d => tms(d.data().scheduledAt) > Date.now()).length >= OPEN_MATCH.maxActivePerCreator) throw new HttpErr(409, `You already have ${OPEN_MATCH.maxActivePerCreator} open matches. Cancel one or wait for it to start.`);
  const doc = { creatorUid: uid, creatorName: dispName(pref.data()!), title: v.value.title, mode: v.value.mode, scheduledAt: v.value.scheduledAt, capacity: v.value.capacity,
    participants: [uid], participantCount: 1, status: "OPEN", createdAt: TS() }; // published immediately; the creator holds the first slot
  const ref = await db.collection("openMatches").add(doc);
  res.status(201).json(matchView(ref.id, (await ref.get()).data(), uid, new Map([[uid, pref.data()]])));
}));
app.post("/api/open-matches/:id/join", auth, need("player"), wrap(async (req, res) => {
  const id = matchId(req.params.id), uid = req.user.uid, ref = db.doc(`openMatches/${id}`), pref = db.doc(`playerProfiles/${uid}`);
  throttle(`om-join:${uid}`, MATCH_JOIN_PER_10MIN, 600e3, "Too many join attempts. Try again in a few minutes.");
  let creator = "", title = "", filled = 0, cap = 0;
  await db.runTransaction(async t => { // reads and the write happen in one transaction, so simultaneous joins can't exceed capacity
    const [m, p] = await Promise.all([t.get(ref), t.get(pref)]);
    if (!m.exists) throw new HttpErr(404, "Match not found");
    if (!p.exists || p.data()!.status !== "active") throw new HttpErr(403, "Only approved players can join matches");
    if (p.data()!.locked) throw lockedErr();
    const d = m.data()!, parts: string[] = d.participants || [];
    if (d.status !== "OPEN") throw new HttpErr(409, "This match was cancelled");
    if (tms(d.scheduledAt) <= Date.now()) throw new HttpErr(409, "This match has already started");
    if (parts.includes(uid)) throw new HttpErr(409, "You already joined this match");
    if (parts.length >= d.capacity) throw new HttpErr(409, "This match is full");
    t.update(ref, { participants: [...parts, uid], participantCount: parts.length + 1 });
    if (d.creatorUid !== uid) notify(t, d.creatorUid, `${dispName(p.data()!)} joined “${d.title}” (${parts.length + 1}/${d.capacity})`);
    creator = d.creatorUid; title = d.title; filled = parts.length + 1; cap = d.capacity;
  });
  res.json({ ok: true, occupied: filled, remaining: cap - filled });
}));
app.post("/api/open-matches/:id/cancel", auth, need("player"), wrap(async (req, res) => {
  const id = matchId(req.params.id), uid = req.user.uid, ref = db.doc(`openMatches/${id}`);
  await db.runTransaction(async t => {
    const m = await t.get(ref);
    if (!m.exists) throw new HttpErr(404, "Match not found");
    const d = m.data()!;
    if (d.creatorUid !== uid) throw new HttpErr(403, "Only the creator can cancel this match");
    if (d.status !== "OPEN") throw new HttpErr(409, "This match is no longer open");
    t.update(ref, { status: "CANCELLED", cancelledAt: TS(), cancelledBy: uid }); // no XP, rating or stats are touched
    for (const u of (d.participants as string[]).filter(x => x !== uid)) notify(t, u, `“${d.title}” was cancelled by its creator`);
  });
  res.json({ ok: true });
}));

app.get("/api/missions", auth, need("player"), wrap(async (req, res) => {
  const wk = istWeekStart(), p = (await db.doc(`playerProfiles/${req.user.uid}`).get()).data()!;
  const cl = await Promise.all(MISSIONS.map(m => db.doc(`xpLedger/mission_${req.user.uid}_${wk}_${m.key}`).get()));
  res.json(MISSIONS.map((m, i) => ({ key: m.key, title: m.title, target: m.target, xp: m.xp, progress: Math.min(m.target, p[m.field]?.[wk] || 0), claimed: cl[i].exists })));
}));
app.post("/api/missions/:key/claim", auth, need("player"), wrap(async (req, res) => {
  const m = MISSIONS.find(x => x.key === req.params.key);
  if (!m) throw new HttpErr(404, "Unknown mission");
  const wk = istWeekStart(), ref = db.doc(`playerProfiles/${req.user.uid}`), lid = `mission_${req.user.uid}_${wk}_${m.key}`;
  await db.runTransaction(async t => {
    const [p, l] = await Promise.all([t.get(ref), t.get(db.doc(`xpLedger/${lid}`))]);
    if (l.exists) throw new HttpErr(409, "Already claimed");
    if ((p.data()![m.field]?.[wk] || 0) < m.target) throw new HttpErr(400, "Mission not complete");
    const xp = ledger(t, lid, req.user.uid, p.data()!.xp, m.xp, `Mission: ${m.title}`, wk, "system");
    t.update(ref, { xp, ...rankFromXp(xp) });
  });
  res.json({ ok: true });
}));

// ---- Tournaments / BR customs (publishing is idempotent: DRAFT -> PUBLISHED once) ----
app.get("/api/tournaments", wrap(async (_q, res) => {
  const s = await db.collection("tournaments").orderBy("createdAt", "desc").limit(20).get();
  res.json(s.docs.map(d => ({ id: d.id, name: d.data().name, type: d.data().type, status: d.data().status })));
}));
app.post("/api/admin/tournaments", auth, isAdmin, wrap(async (req, res) => {
  const px = req.body.placementXp, kx = num(req.body.killXp);
  if (!Array.isArray(px) || px.length < 1 || px.length > 50 || px.some((n: any) => !Number.isFinite(n) || n < -500 || n > 1000)) throw new HttpErr(400, "placementXp must be 1-50 numbers (-500..1000)");
  if (!(kx >= 0 && kx <= 20)) throw new HttpErr(400, "killXp must be 0-20");
  const ref = await db.collection("tournaments").add({ name: str(req.body.name, 3, 80, "Name"), type: req.body.type === "br-custom" ? "br-custom" : "tournament",
    date: String(req.body.date || ""), rules: String(req.body.rules || "").slice(0, 500), placementXp: px, killXp: kx, status: "DRAFT", createdBy: req.user.uid, createdAt: TS() });
  await audit(null, { actor: req.user.uid, action: "TOURNAMENT_CREATE", target: ref.id });
  res.json({ id: ref.id });
}));
app.post("/api/admin/tournaments/:id/publish", auth, isAdmin, wrap(async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40) throw new HttpErr(400, "Provide 1-40 result rows");
  const id = req.params.id, tref = db.doc(`tournaments/${id}`);
  const docs: any[] = [];
  for (const r of rows) {
    const pl = Number(r.placement), k = Number(r.kills || 0);
    if (!Number.isInteger(pl) || pl < 1 || pl > 100 || !Number.isInteger(k) || k < 0 || k > 100) throw new HttpErr(400, "Invalid placement/kills");
    const d = await byArena(r.arenaId);
    if (docs.some(x => x.d.id === d.id)) throw new HttpErr(400, `Duplicate player ${r.arenaId}`);
    docs.push({ d, pl, k });
  }
  const t0 = (await tref.get()).data();
  if (!t0) throw new HttpErr(404, "Tournament not found");
  const rewards = docs.map(x => ({ uid: x.d.id, gameName: x.d.data().gameName, placement: x.pl, kills: x.k, reward: (t0.placementXp[x.pl - 1] || 0) + x.k * t0.killXp }));
  if (req.body.preview) return res.json({ rows: rewards });
  const wk = istWeekStart();
  await db.runTransaction(async t => {
    const tt = await t.get(tref);
    const ps = await Promise.all(rewards.map(r => t.get(db.doc(`playerProfiles/${r.uid}`))));
    if (tt.data()!.status !== "DRAFT") throw new HttpErr(409, "Already published");
    rewards.forEach((r, i) => {
      const xp = ledger(t, `t_${id}_${r.uid}`, r.uid, ps[i].data()!.xp, r.reward, `Tournament: ${tt.data()!.name}`, id, req.user.uid);
      t.update(ps[i].ref, { xp, [`weeklyTourn.${wk}`]: INC(1), ...rankFromXp(xp) });
      t.create(db.doc(`tournamentResults/${id}_${r.uid}`), { tournament: id, uid: r.uid, placement: r.placement, kills: r.kills, reward: r.reward });
      notify(t, r.uid, `Tournament result: #${r.placement} (+${r.reward} XP)`);
    });
    t.update(tref, { status: "PUBLISHED", publishedBy: req.user.uid });
    audit(t, { actor: req.user.uid, action: "TOURNAMENT_PUBLISH", target: id, next: rewards });
  });
  res.json({ ok: true });
}));

// ---- Admin: XP adjust / rank override, and bulk daily rank updates ----
app.post("/api/admin/players/:arenaId/adjust", auth, isAdmin, wrap(async (req, res) => {
  const reason = str(req.body.reason, 3, 200, "Reason");
  const amount = num(req.body.xp), ov = req.body.rankOverride;
  if (!Number.isInteger(amount) || Math.abs(amount) > 5000) throw new HttpErr(400, "XP must be a whole number within ±5000");
  if (ov && ov !== "clear" && !RANKS.includes(ov)) throw new HttpErr(400, "Unknown rank");
  const d = await byArena(req.params.arenaId);
  if (req.body.preview) { // nothing is written; the numbers come from the same rules the real change uses
    const p = d.data(), { newBalance, applied } = applyXp(p.xp, amount), nextOv = ov === "clear" ? null : ov || p.rankOverride || null;
    return res.json({ before: p.xp, requested: amount, applied, after: newBalance, rankBefore: p.rankOverride || rankFromXp(p.xp).rank, rankAfter: nextOv || rankFromXp(newBalance).rank, overrideBefore: p.rankOverride || null, overrideAfter: nextOv });
  }
  const rid = str(req.body.requestId, 8, 64, "requestId");
  if (!/^[\w-]+$/.test(rid)) throw new HttpErr(400, "Bad requestId");
  let out: any = {};
  await db.runTransaction(async t => {
    const p = (await t.get(d.ref)).data()!, upd: any = {};
    let xp = p.xp;
    if (amount) { xp = ledger(t, `adj_${rid}`, d.id, p.xp, amount, `Admin adjustment: ${reason}`, rid, req.user.uid); Object.assign(upd, { xp }, rankFromXp(xp)); }
    else if ((await t.get(db.doc(`adjustments/${rid}`))).exists) throw new HttpErr(409, "Already applied");
    if (ov) upd.rankOverride = ov === "clear" ? null : ov; // override changes the displayed rank only; clear => derived from XP
    if (!Object.keys(upd).length) throw new HttpErr(400, "Nothing to change");
    t.create(db.doc(`adjustments/${rid}`), { by: req.user.uid, at: TS() });
    t.update(d.ref, upd);
    audit(t, { actor: req.user.uid, action: "PLAYER_ADJUST", target: d.id, reason, prev: { xp: p.xp, rankOverride: p.rankOverride || null }, next: { xp, rankOverride: upd.rankOverride ?? p.rankOverride ?? null }, requestId: rid });
    out = { before: p.xp, after: xp, rank: (upd.rankOverride === undefined ? p.rankOverride : upd.rankOverride) || rankFromXp(xp).rank };
  });
  res.json({ ok: true, ...out });
}));
app.post("/api/admin/rank-updates", auth, isAdmin, wrap(async (req, res) => {
  const eventId = str(req.body.eventId, 3, 50, "Event ID");
  if (!/^[\w-]+$/.test(eventId)) throw new HttpErr(400, "Event ID: letters, digits, - and _ only");
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40) throw new HttpErr(400, "Provide 1-40 rows");
  const list: any[] = [];
  for (const r of rows) {
    const n = [r.sg, r.sl, r.bg, r.bl].map(v => Number(v || 0));
    if (n.some(v => !Number.isInteger(v) || v < 0 || v > 50)) throw new HttpErr(400, "Values must be whole numbers 0-50");
    const d = await byArena(r.arenaId);
    if (list.some(x => x.d.id === d.id)) throw new HttpErr(400, `Duplicate player ${r.arenaId}`);
    list.push({ d, delta: (n[0] - n[1]) * 10 + (n[2] - n[3]) * 30 }); // +/-10 XP per star, +/-30 XP per BR rank
  }
  if (req.body.preview) return res.json({ rows: list.map(x => ({ gameName: x.d.data().gameName, delta: x.delta })) });
  await db.runTransaction(async t => {
    const ev = db.doc(`rankUpdates/${eventId}`);
    const e = await t.get(ev);
    const ps = await Promise.all(list.map(x => t.get(x.d.ref)));
    if (e.exists) throw new HttpErr(409, "This event ID was already published");
    t.create(ev, { by: req.user.uid, at: TS(), count: list.length });
    list.forEach((x, i) => {
      const xp = ledger(t, `ru_${eventId}_${x.d.id}`, x.d.id, (ps[i] as any).data().xp, x.delta, `Rank update ${eventId}`, eventId, req.user.uid);
      t.update(x.d.ref, { xp, ...rankFromXp(xp) });
      notify(t, x.d.id, `XP update: ${x.delta >= 0 ? "+" : ""}${x.delta}`);
    });
    audit(t, { actor: req.user.uid, action: "RANK_UPDATE_PUBLISH", target: eventId, next: list.map(x => ({ uid: x.d.id, delta: x.delta })) });
  });
  res.json({ ok: true });
}));

// ---- Owner-only JSON export (download only; never stored or served publicly) ----
app.get("/api/admin/export", auth, need("owner"), wrap(async (req, res) => {
  const out: any = { exportedAt: new Date().toISOString() };
  for (const c of ["users", "playerProfiles", "registrations", "challenges", "disputes", "xpLedger", "tournaments", "tournamentResults", "rankUpdates", "adminAuditLogs", "teams", "teamMatches", "notifications", "missions", "appConfig", "dailyLogins", "disputeEvidence"]) {
    const rows: any[] = []; let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    while (true) {
      let q: FirebaseFirestore.Query = db.collection(c).orderBy(admin.firestore.FieldPath.documentId()).limit(500);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get(); if (page.empty) break;
      rows.push(...page.docs.map(d => ({ id: d.id, ...d.data() }))); cursor = page.docs[page.docs.length - 1];
      if (page.size < 500) break;
    }
    out[c] = rows;
  }
  await audit(null, { actor: req.user.uid, action: "EXPORT" });
  res.setHeader("Content-Disposition", "attachment; filename=ff-arena-export.json");
  res.json(out);
}));

// ===================== Phase 3 features =====================
// ---- Config editor (values persisted in appConfig/main, applied live) ----
const CONFIG_RANGES: Record<string, [number, number]> = { k: [1, 100], winXp: [0, 500], drawXp: [0, 500], lossXp: [0, 500], loginXp: [0, 500], weeklyTarget: [1, 50], teamMax: [2, 10], levelBase: [10, 5000] };
const thresholdsOk = (t: any) => Array.isArray(t) && t.length === RANKS.length && t[0] === 0 && t.every((n, i) => Number.isFinite(n) && (i === 0 || n > t[i - 1]));
function applyConfig(c: any) {
  for (const k of Object.keys(CONFIG_RANGES)) if (typeof c[k] === "number") { if (k === "levelBase") LEVEL.base = c[k]; else (CFG as any)[k] = c[k]; }
  if (thresholdsOk(c.thresholds)) THRESHOLDS.splice(0, THRESHOLDS.length, ...c.thresholds);
}
const currentConfig = () => ({ k: CFG.k, winXp: CFG.winXp, drawXp: CFG.drawXp, lossXp: CFG.lossXp, loginXp: CFG.loginXp, weeklyTarget: CFG.weeklyTarget, teamMax: CFG.teamMax, levelBase: LEVEL.base, thresholds: [...THRESHOLDS] });
async function loadConfig() { const s = await db.doc("appConfig/main").get(); if (s.exists) applyConfig(s.data()!); }
app.get("/api/admin/config", auth, isAdmin, wrap(async (_q, res) => res.json(currentConfig())));
app.post("/api/admin/config", auth, isAdmin, wrap(async (req, res) => {
  const reason = str(req.body.reason, 3, 200, "Reason"), next: any = {};
  for (const [k, [lo, hi]] of Object.entries(CONFIG_RANGES)) if (req.body[k] !== undefined) {
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpErr(400, `${k} must be ${lo}-${hi}`);
    next[k] = n;
  }
  if (req.body.thresholds !== undefined) { if (!thresholdsOk(req.body.thresholds)) throw new HttpErr(400, "thresholds: 8 increasing numbers starting at 0"); next.thresholds = req.body.thresholds; }
  if (!Object.keys(next).length) throw new HttpErr(400, "Nothing to change");
  const prev = currentConfig();
  await db.doc("appConfig/main").set(next, { merge: true });
  applyConfig(next);
  await audit(null, { actor: req.user.uid, action: "CONFIG_EDIT", reason, prev, next });
  res.json(currentConfig());
}));

// ---- Anti-boosting review flags (a flag is a prompt to review, never a cheating verdict) ----
async function checkBoost(id: string) {
  const c = (await db.doc(`challenges/${id}`).get()).data()!;
  const [x, y] = await Promise.all([db.collection("challenges").where("playerA", "==", c.playerA).get(), db.collection("challenges").where("playerA", "==", c.playerB).get()]);
  const n = [...x.docs, ...y.docs].map(d => d.data()).filter(m => m.effects && [m.playerA, m.playerB].includes(c.playerA) && [m.playerA, m.playerB].includes(c.playerB) && m.approvedAt?.toMillis?.() > Date.now() - 864e5).length;
  if (n >= 3) {
    await db.doc(`flags/${id}`).set({ challenge: id, pair: [c.playerA, c.playerB], count: n, reason: `${n} approved matches between the same two players within 24h`, status: "OPEN", at: TS() });
    await notifyAdmins("Review flag: repeated matches between the same two players (needs review, not a finding)");
  }
}
app.get("/api/admin/flags", auth, isAdmin, wrap(async (_q, res) => {
  const [s, names] = await Promise.all([db.collection("flags").where("status", "==", "OPEN").get(), nameMap()]);
  res.json(s.docs.map(d => ({ id: d.id, reason: d.data().reason, players: d.data().pair.map((u: string) => names.get(u)) })));
}));
app.post("/api/admin/flags/:id/resolve", auth, isAdmin, wrap(async (req, res) => {
  const note = str(req.body.note, 3, 200, "Note"), ref = db.doc(`flags/${req.params.id}`);
  if (!(await ref.get()).exists) throw new HttpErr(404, "Flag not found");
  await ref.update({ status: "RESOLVED", note, by: req.user.uid });
  await audit(null, { actor: req.user.uid, action: "FLAG_RESOLVE", target: req.params.id, reason: note });
  res.json({ ok: true });
}));

// ---- Mass stats editor (one mode, many players, preview then apply, one audit entry) ----
app.post("/api/admin/stats-bulk", auth, isAdmin, wrap(async (req, res) => {
  const mode = req.body.mode, reason = str(req.body.reason, 3, 200, "Reason"), rows = req.body.rows;
  if (!["br", "cs"].includes(mode)) throw new HttpErr(400, "Mode must be br or cs");
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 30) throw new HttpErr(400, "Provide 1-30 rows");
  const list: any[] = [];
  for (const r of rows) {
    const s = modeOf(r), e = validStats(s);
    if (e) throw new HttpErr(400, `${r.arenaId}: ${e}`);
    const ko = r.kdOverride === undefined || r.kdOverride === null || r.kdOverride === "" ? null : Number(r.kdOverride);
    if (ko !== null && (!Number.isFinite(ko) || ko < 0 || ko > 100)) throw new HttpErr(400, `${r.arenaId}: K/D must be 0-100`);
    const d = await byArena(r.arenaId);
    if (list.some(x => x.d.id === d.id)) throw new HttpErr(400, `Duplicate player ${r.arenaId}`);
    list.push({ d, s, ko });
  }
  if (req.body.preview) return res.json({ rows: list.map(x => ({ gameName: x.d.data().gameName, before: x.d.data().stats[mode], after: x.s, kdOverride: x.ko })) });
  await db.runTransaction(async t => {
    const ps = await Promise.all(list.map(x => t.get(x.d.ref)));
    const changes: any[] = [];
    list.forEach((x, i) => {
      const p = (ps[i] as any).data(), stats = { ...p.stats, [mode]: x.s };
      t.update(x.d.ref, { stats, kills: stats.br.kills + stats.cs.kills, deaths: stats.br.deaths + stats.cs.deaths, kdOverride: x.ko, statsSource: "admin-edited" });
      changes.push({ uid: x.d.id, prev: { [mode]: p.stats[mode], kdOverride: p.kdOverride ?? null }, next: { [mode]: x.s, kdOverride: x.ko } });
    });
    audit(t, { actor: req.user.uid, action: "STATS_BULK_EDIT", reason, changes });
  });
  res.json({ ok: true });
}));

// ---- Teams: separate team rating (never mixed with individual rating) ----
app.get("/api/teams", wrap(async (_q, res) => {
  const [s, names, all] = await Promise.all([db.collection("teams").get(), nameMap(), profiles()]);
  const arena = new Map(all.map(p => [p.uid as string, p.arenaId as string]));
  res.json(s.docs.map(d => { const t = d.data(); return { id: d.id, name: t.name, captain: names.get(t.captain), captainId: arena.get(t.captain), members: t.members.map((u: string) => names.get(u)), memberIds: t.members.map((u: string) => arena.get(u)), rating: t.rating, wins: t.wins, losses: t.losses, draws: t.draws, matches: t.matches, winRate: t.matches ? Math.round((t.wins / t.matches) * 100) : 0 }; })
    .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)));
}));
app.get("/api/teams/:id/matches", wrap(async (req, res) => {
  const [a, b, tm] = await Promise.all([db.collection("teamMatches").where("teamA", "==", req.params.id).get(), db.collection("teamMatches").where("teamB", "==", req.params.id).get(), db.collection("teams").get()]);
  const names = new Map(tm.docs.map(d => [d.id, d.data().name]));
  res.json([...a.docs, ...b.docs].map(d => d.data()).sort((x, y) => (y.at?.toMillis?.() || 0) - (x.at?.toMillis?.() || 0)).slice(0, 30)
    .map(m => ({ teamA: names.get(m.teamA), teamB: names.get(m.teamB), winner: m.winner, ratingA: m.ratingA, ratingB: m.ratingB })));
}));
const inTeam = async (uid: string) => !(await db.collection("teams").where("members", "array-contains", uid).get()).empty;
app.post("/api/admin/teams", auth, isAdmin, wrap(async (req, res) => {
  const name = str(req.body.name, 2, 30, "Team name"), ids = req.body.members;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length < 2 || ids.length > CFG.teamMax) throw new HttpErr(400, `A team needs 2-${CFG.teamMax} different members`);
  const docs: any[] = [];
  for (const a of ids) docs.push(await byArena(a));
  const cap = await byArena(req.body.captain);
  if (!docs.some(d => d.id === cap.id)) throw new HttpErr(400, "Captain must be a member");
  for (const d of docs) { if (d.data().status !== "active") throw new HttpErr(400, "Members must be active"); if (await inTeam(d.id)) throw new HttpErr(400, `${d.data().gameName} is already in a team`); }
  if (!(await db.collection("teams").where("name", "==", name).get()).empty) throw new HttpErr(409, "Team name taken");
  const ref = await db.collection("teams").add({ name, captain: cap.id, members: docs.map(d => d.id), rating: CFG.startRating, wins: 0, losses: 0, draws: 0, matches: 0, createdAt: TS() });
  await audit(null, { actor: req.user.uid, action: "TEAM_CREATE", target: ref.id });
  res.json({ id: ref.id });
}));
app.post("/api/admin/teams/match", auth, isAdmin, wrap(async (req, res) => {
  const { teamA, teamB, winner } = req.body, rid = str(req.body.requestId, 8, 64, "requestId");
  if (!/^[\w-]+$/.test(rid)) throw new HttpErr(400, "Bad requestId");
  if (!teamA || !teamB || teamA === teamB) throw new HttpErr(400, "Pick two different teams");
  if (!["A", "B", "draw"].includes(winner)) throw new HttpErr(400, "Winner must be A, B or draw");
  await db.runTransaction(async t => {
    const [a, b, m] = await Promise.all([t.get(db.doc(`teams/${teamA}`)), t.get(db.doc(`teams/${teamB}`)), t.get(db.doc(`teamMatches/${rid}`))]);
    if (!a.exists || !b.exists) throw new HttpErr(404, "Team not found");
    if (m.exists) throw new HttpErr(409, "Match already recorded");
    const A = a.data()!, B = b.data()!, e = elo(A.rating, B.rating, winner === "A" ? 1 : winner === "B" ? 0 : 0.5);
    const up = (T: any, ref: any, out: string, rating: number) => t.update(ref, { rating, matches: T.matches + 1, wins: T.wins + (out === "W" ? 1 : 0), losses: T.losses + (out === "L" ? 1 : 0), draws: T.draws + (out === "D" ? 1 : 0) });
    up(A, a.ref, winner === "A" ? "W" : winner === "B" ? "L" : "D", e.a);
    up(B, b.ref, winner === "B" ? "W" : winner === "A" ? "L" : "D", e.b);
    t.create(db.doc(`teamMatches/${rid}`), { teamA, teamB, winner, ratingA: e.a, ratingB: e.b, by: req.user.uid, at: TS() });
    audit(t, { actor: req.user.uid, action: "TEAM_MATCH", target: rid, next: { teamA, teamB, winner, ratingA: e.a, ratingB: e.b } });
  });
  res.json({ ok: true });
}));
app.post("/api/admin/teams/:id/members", auth, isAdmin, wrap(async (req, res) => {
  const add = req.body.add ? await byArena(req.body.add) : null, rem = req.body.remove ? await byArena(req.body.remove) : null;
  if (!add && !rem) throw new HttpErr(400, "Provide add or remove");
  if (add && (add.data().status !== "active" || await inTeam(add.id))) throw new HttpErr(400, "Player unavailable");
  const ref = db.doc(`teams/${req.params.id}`);
  await db.runTransaction(async t => {
    const tm = await t.get(ref);
    if (!tm.exists) throw new HttpErr(404, "Team not found");
    let m: string[] = tm.data()!.members;
    if (add) { if (m.length >= CFG.teamMax) throw new HttpErr(400, "Team is full"); m = [...m, add.id]; }
    if (rem) { if (!m.includes(rem.id)) throw new HttpErr(400, "Not a member"); if (rem.id === tm.data()!.captain) throw new HttpErr(400, "Cannot remove the captain"); m = m.filter(u => u !== rem.id); }
    t.update(ref, { members: m });
    audit(t, { actor: req.user.uid, action: "TEAM_MEMBERS", target: ref.id, prev: tm.data()!.members, next: m });
  });
  res.json({ ok: true });
}));

// ---- Static files: gzip for text assets (computed once per file version) and revalidation instead of stale caches ----
const PUB = path.join(process.cwd(), "public");
const TEXT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const gz = new Map<string, { body: Buffer; etag: string }>();
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path === "/health") return next();
  const rel = req.path === "/" ? "/index.html" : req.path, type = TEXT_TYPES[path.extname(rel)];
  if (!type || !/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) return next();
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return next();
  try {
    const key = `${file}:${fs.statSync(file).mtimeMs}`;
    let e = gz.get(key);
    if (!e) { const raw = fs.readFileSync(file); e = { body: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20)}"` }; gz.set(key, e); }
    res.setHeader("ETag", e.etag); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === e.etag) return res.status(304).end();
    res.setHeader("Content-Type", type); res.setHeader("Content-Encoding", "gzip"); res.end(e.body);
  } catch { next(); }
});
app.use(express.static(PUB, { etag: true, setHeaders: r => r.setHeader("Cache-Control", "no-cache") }));
app.use((err: any, _q: Request, res: Response, _n: NextFunction) => {
  if (err instanceof HttpErr) return res.status(err.code).json({ error: err.message });
  if ((err as any)?.code === 6) return res.status(409).json({ error: "Already applied" });
  if (err?.status === 413) return res.status(413).json({ error: "That file is too large" });
  if (err?.status >= 400 && err?.status < 500 && err?.expose) return res.status(err.status).json({ error: "Invalid request" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});
export { app };
if (require.main === module) loadConfig().catch(() => {}).then(() => app.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => console.log("FF Arena running")));
