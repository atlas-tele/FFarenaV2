// Tournament system routes. Collections (all new; nothing existing is read-modified except XP via the existing ledger):
//   arenaTournaments/{tid}                      definition + status + entryCount (capacity counter, only changed inside transactions)
//   arenaTournaments/{tid}/entries/{eid}        one solo player or one team: { name, captain, members[], invited[], status, counted, ... }
//   arenaTournaments/{tid}/players/{uid}        one-per-player lock {entryId}; created with create() so two entries can never hold the same player
//   arenaTournaments/{tid}/state/main           round/bracket state (points: rounds+games, knockout: bracket)
//   arenaTournaments/{tid}/rewards/{uid}        XP reward record (one per player; the XP ledger id is deterministic as well)
//   arenaTournaments/{tid}/disputes/{id}        player-reported issues that block confirmation until an admin resolves them
//   arenaTournaments/{tid}/shots/{id}           optional result screenshots (admin-only access)
//   arenaInvites/{tid}_{eid}_{uid}              team invitations (lookup index for "my invitations")
import express from "express";
import crypto from "crypto";
import * as T from "./tournament";
import { detectImage } from "./logic";

export const SHOT_MAX_BYTES = 500 * 1024;
const MAX_SHOTS = 60;

export function registerTournamentRoutes(d: any) {
  const { app, db, HttpErr } = d;
  const tref = (id: string) => db.doc(`arenaTournaments/${id}`);
  const ecol = (id: string) => db.collection(`arenaTournaments/${id}/entries`);
  const eref = (id: string, eid: string) => db.doc(`arenaTournaments/${id}/entries/${eid}`);
  const lref = (id: string, uid: string) => db.doc(`arenaTournaments/${id}/players/${uid}`);
  const sref = (id: string) => db.doc(`arenaTournaments/${id}/state/main`);
  const iref = (id: string, eid: string, uid: string) => db.doc(`arenaInvites/${id}_${eid}_${uid}`);
  const dcol = (id: string) => db.collection(`arenaTournaments/${id}/disputes`);
  const pref = (uid: string) => db.doc(`playerProfiles/${uid}`);

  const pid = (v: any, what = "Tournament") => { if (typeof v !== "string" || !/^[\w-]{1,64}$/.test(v)) throw new HttpErr(404, `${what} not found`); return v; };
  const pint = (v: any, what: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpErr(404, `${what} not found`); return n; };
  /** Rule violations become 400 (bad input), 404 or 409 (not allowed in the current state). */
  const h = (fn: (req: any, res: any) => Promise<any>) => d.wrap(async (req: any, res: any) => {
    try { await fn(req, res); } catch (e: any) { if (e instanceof T.RuleError) throw new HttpErr(e.code === "invalid" ? 400 : e.code === "notfound" ? 404 : 409, e.message); throw e; }
  });
  const reason = (v: any, min = 3, req = true) => { if (!req && (v === undefined || v === null || v === "")) return ""; return d.str(v, min, 200, "Reason"); };
  const ms = (v: any) => d.tms(v);
  const now = () => Date.now();

  // ---- shared reads ----
  async function people(): Promise<Map<string, any>> { return new Map((await d.profiles()).map((p: any) => [p.uid as string, p])); }
  const who = (p: any) => (p ? { arenaId: p.arenaId, displayName: d.dispName(p), avatar: d.avatarUrl(p) } : { arenaId: null, displayName: "Deleted player", avatar: null });
  function entryView(e: any, ppl: Map<string, any>, admin = false) {
    const members = (e.members || []).map((u: string) => who(ppl.get(u)));
    const out: any = { id: e.id, name: e.name || members[0]?.displayName || "Entry", members, status: e.status, captain: who(ppl.get(e.captain)).arenaId };
    if (admin) Object.assign(out, { invited: (e.invited || []).map((u: string) => who(ppl.get(u))), counted: !!e.counted, source: e.source || "player", memberDeleted: !!e.memberDeleted, withdrawnReason: e.withdrawnReason || null, createdAt: ms(e.createdAt) });
    return out;
  }
  async function loadEntries(id: string): Promise<any[]> { return (await ecol(id).get()).docs.map((x: any) => ({ id: x.id, ...x.data() })); }
  async function notifyMany(uids: string[], text: string) {
    const list = [...new Set(uids)].filter(u => u && !T.isTombstone(u));
    try { for (let i = 0; i < list.length; i += 400) { const b = db.batch(); list.slice(i, i + 400).forEach(u => b.create(db.collection("notifications").doc(), { uid: u, text, read: false, at: d.TS() })); await b.commit(); } }
    catch (e) { console.error("tournament notification failed", e); } // informational only; never fails the action
  }

  function regState(t: any, at = now()): "not_open" | "open" | "closed" | "full" {
    if (t.status === "PUBLISHED") return "not_open";
    if (t.status !== "REGISTRATION_OPEN") return "closed";
    if (at < ms(t.regOpensAt)) return "not_open";
    if (at > ms(t.regClosesAt)) return "closed";
    if ((t.entryCount || 0) >= t.capacity) return "full";
    return "open";
  }
  const REG_MSG: Record<string, string> = { not_open: "Registration hasn't opened yet", closed: "Registration is closed", full: "This tournament is full" };

  function summary(id: string, t: any, extra: any = {}) {
    return { id, name: t.name, description: t.description || "", mode: t.mode, modeLabel: T.MODES[t.mode as T.Mode].label, teamSize: t.teamSize, format: t.format, formatLabel: T.FORMAT_LABEL[t.format as T.Format],
      status: t.status, statusLabel: T.STATUS_LABEL[t.status as T.TStatus], regOpensAt: ms(t.regOpensAt), regClosesAt: ms(t.regClosesAt), startsAt: ms(t.startsAt), capacity: t.capacity, entryCount: t.entryCount || 0,
      spotsLeft: Math.max(0, t.capacity - (t.entryCount || 0)), registration: regState(t), approval: t.approval || "auto", placementXp: t.rewards?.placementXp || [], ...extra };
  }
  const defOut = (t: any) => ({ rules: t.rules || "", scoring: t.scoring || null, roundsConfig: t.roundsConfig || null, seeding: t.seeding || "registration", rewards: t.rewards || { placementXp: [] } });

  // ---- result views ----
  const gameView = (g: T.PGame, full: boolean) => (g.status === "CONFIRMED" || (full && g.status === "SUBMITTED") ? { n: g.n, status: g.status, rows: g.rows, note: g.note, shotId: full ? g.shotId : null,
    submittedBy: full ? g.submittedBy : null, submittedAt: full ? g.submittedAt : null, confirmedAt: g.confirmedAt, confirmedBy: full ? g.confirmedBy : null, corrections: full ? g.corrections : g.corrections.length } : { n: g.n, status: "EMPTY", rows: [], note: "", corrections: full ? [] : 0 });
  function pointsView(st: T.PointsState, full: boolean) {
    return st.rounds.map(r => {
      const confirmed = T.roundStandings(r);
      const draft = full ? T.applyTieOrders(T.computeStandings(r.entryIds, r.games.filter(g => g.status !== "EMPTY")), r.tieOrders) : null;
      return { number: r.number, status: r.status, entryIds: r.entryIds, qualifiers: r.qualifiers, games: r.games.map(g => gameView(g, full)), standings: r.status === "PENDING" ? [] : confirmed, draftStandings: draft, tieOrders: full ? r.tieOrders : r.tieOrders.length };
    });
  }
  function bracketView(b: T.Bracket, full: boolean) {
    return { size: b.size, rounds: b.rounds.map((round, i) => ({ number: i + 1, name: T.roundName(i + 1, b.rounds.length), matches: round.map(m => {
      const shown = m.status === "SUBMITTED" && !full ? "READY" : m.status;
      const hide = m.status === "SUBMITTED" && !full;
      return { id: m.id, a: m.a, b: m.b, status: shown, winner: hide ? null : m.winner, scoreA: hide ? null : m.scoreA, scoreB: hide ? null : m.scoreB, walkover: hide ? false : m.walkover, forfeitBoth: hide ? false : m.forfeitBoth,
        note: hide ? "" : m.note, ...(full ? { submittedBy: m.submittedBy, submittedAt: m.submittedAt, confirmedBy: m.confirmedBy, confirmedAt: m.confirmedAt, shotId: m.shotId, corrections: m.corrections, pendingWinner: m.status === "SUBMITTED" ? m.winner : null } : { confirmedAt: m.confirmedAt }) };
    }) })) };
  }
  const stateView = (st: any, full: boolean) => (!st ? null : st.format === "points" ? { format: "points", rounds: pointsView(st, full) } : { format: "knockout", bracket: bracketView(st, full) });

  // ============================ Public + player endpoints ============================
  app.get("/api/arena-tournaments", d.softAuth, h(async (req, res) => {
    const [snap, ppl] = await Promise.all([db.collection("arenaTournaments").get(), people()]);
    const viewer = req.user?.uid as string | undefined, admin = ["owner", "admin"].includes(req.user?.role);
    const rows = snap.docs.filter((x: any) => admin || x.data().status !== "DRAFT");
    const mine = new Map<string, any>();
    if (viewer) await Promise.all(rows.map(async (x: any) => { const l = await lref(x.id, viewer).get(); if (l.exists) { const e = await eref(x.id, l.data().entryId).get(); if (e.exists) mine.set(x.id, { entryId: e.id, status: e.data().status }); } }));
    const out = rows.map((x: any) => { const t = x.data(); const ch = t.champion && t.finalRanks ? t.finalRanks.find((r: any) => r.entryId === t.champion) : null;
      return summary(x.id, t, { mine: mine.get(x.id) || null, championName: t.championName || null, hasChampion: !!ch }); });
    const order: Record<string, number> = { IN_PROGRESS: 0, REGISTRATION_OPEN: 1, PUBLISHED: 2, REGISTRATION_CLOSED: 3, DRAFT: 4, COMPLETED: 5, CANCELLED: 6 };
    res.json(out.sort((a: any, b: any) => order[a.status] - order[b.status] || (a.status === "COMPLETED" ? b.startsAt - a.startsAt : a.startsAt - b.startsAt)).slice(0, 100));
  }));

  app.get("/api/arena-tournaments/invites", d.auth, d.need("player"), h(async (req, res) => {
    const snap = await db.collection("arenaInvites").where("inviteeUid", "==", req.user.uid).where("status", "==", "PENDING").get();
    const ppl = await people(), out: any[] = [];
    for (const x of snap.docs) {
      const iv = x.data(), [t, e] = await Promise.all([tref(iv.tournamentId).get(), eref(iv.tournamentId, iv.entryId).get()]);
      if (!t.exists || !e.exists || e.data().status !== "FORMING" || !(e.data().invited || []).includes(req.user.uid)) continue;
      out.push({ tournamentId: iv.tournamentId, tournamentName: t.data().name, entryId: iv.entryId, teamName: e.data().name, captain: who(ppl.get(e.data().captain)), registration: regState(t.data()), at: ms(iv.at) });
    }
    res.json(out);
  }));

  app.get("/api/arena-tournaments/:id", d.softAuth, h(async (req, res) => {
    const id = pid(req.params.id), [ts, ss, ppl] = await Promise.all([tref(id).get(), sref(id).get(), people()]);
    const admin = ["owner", "admin"].includes(req.user?.role);
    if (!ts.exists || (ts.data().status === "DRAFT" && !admin)) throw new HttpErr(404, "Tournament not found");
    const t = ts.data(), viewer = req.user?.uid as string | undefined;
    const all = await loadEntries(id);
    const pub = all.filter(e => ["REGISTERED", "WITHDRAWN", "DISQUALIFIED"].includes(e.status) && (e.status === "REGISTERED" || ["IN_PROGRESS", "COMPLETED"].includes(t.status)));
    let mine: any = null;
    if (viewer) {
      const e = all.find(x => x.members?.includes(viewer) && !["WITHDRAWN", "REJECTED"].includes(x.status));
      const inv = all.filter(x => x.status === "FORMING" && (x.invited || []).includes(viewer)).map(x => ({ entryId: x.id, teamName: x.name, captain: who(ppl.get(x.captain)) }));
      mine = { entry: e ? { ...entryView(e, ppl, true), isCaptain: e.captain === viewer, needs: Math.max(0, t.teamSize - e.members.length), pendingApproval: e.status === "PENDING_APPROVAL" } : null, invitations: inv };
    }
    const finalRanks = t.finalRanks ? t.finalRanks.map((r: any) => { const e = all.find(x => x.id === r.entryId); return { ...r, entry: e ? entryView(e, ppl) : null }; }) : null;
    res.json({ ...summary(id, t), ...defOut(t), entries: pub.map(e => entryView(e, ppl)), state: stateView(ss.exists ? ss.data() : null, false), finalRanks,
      champion: t.champion ? entryView(all.find(x => x.id === t.champion) || { id: t.champion, members: [], status: "REGISTERED" }, ppl) : null, mine, completedAt: t.completedAt ? ms(t.completedAt) : null });
  }));

  // ---- registration ----
  async function ensureEligible(t: any, uid: string, prof: any) {
    if (!prof.exists || prof.data().status !== "active") throw new HttpErr(403, "Only approved players can join tournaments");
    if (prof.data().locked) throw d.lockedErr();
  }
  app.post("/api/arena-tournaments/:id/register", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), uid = req.user.uid;
    d.throttle(`t-reg:${uid}`, 20, 600e3, "Too many registration attempts. Try again in a few minutes.");
    const teamName = req.body?.teamName === undefined ? undefined : d.str(req.body.teamName, 2, 30, "Team name");
    const eid = db.collection(`arenaTournaments/${id}/entries`).doc().id;
    let outStatus = "";
    await db.runTransaction(async (t: any) => {
      const [ts, lk, pr] = await Promise.all([t.get(tref(id)), t.get(lref(id, uid)), t.get(pref(uid))]);
      if (!ts.exists || ts.data().status === "DRAFT") throw new HttpErr(404, "Tournament not found");
      const td = ts.data(), rs = regState(td);
      if (rs !== "open") throw new HttpErr(409, REG_MSG[rs]);
      await ensureEligible(td, uid, pr);
      if (lk.exists) throw new HttpErr(409, "You're already registered in this tournament");
      const solo = td.teamSize === 1;
      if (!solo && !teamName) throw new HttpErr(400, "Give your team a name (2-30 characters)");
      const status = solo ? (td.approval === "manual" ? "PENDING_APPROVAL" : "REGISTERED") : "FORMING";
      t.create(eref(id, eid), { name: solo ? null : teamName, captain: uid, members: [uid], invited: [], status, counted: solo, source: "player", createdAt: d.TS() });
      t.create(lref(id, uid), { entryId: eid, at: d.TS() });
      if (solo) t.update(tref(id), { entryCount: (td.entryCount || 0) + 1 });
      outStatus = status;
    });
    res.status(201).json({ ok: true, entryId: eid, status: outStatus });
  }));

  app.post("/api/arena-tournaments/:id/entries/:eid/invite", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), eid = pid(req.params.eid, "Team"), uid = req.user.uid;
    d.throttle(`t-inv:${uid}`, 30, 600e3, "Too many invitations. Try again in a few minutes.");
    const target = await d.byArena(String(req.body?.arenaId || "").slice(0, 20));
    const inv = target.id as string;
    if (inv === uid) throw new HttpErr(400, "You're already on your team");
    await db.runTransaction(async (t: any) => {
      const [ts, es, il, ip] = await Promise.all([t.get(tref(id)), t.get(eref(id, eid)), t.get(lref(id, inv)), t.get(pref(inv))]);
      if (!ts.exists || !es.exists) throw new HttpErr(404, "Team not found");
      const td = ts.data(), e = es.data();
      const rs = regState(td); if (rs !== "open" && rs !== "full") throw new HttpErr(409, REG_MSG[rs]);
      if (e.captain !== uid) throw new HttpErr(403, "Only the team captain can invite players");
      if (e.status !== "FORMING") throw new HttpErr(409, "This team is already complete");
      if (!ip.exists || ip.data().status !== "active") throw new HttpErr(400, "That player isn't an approved player");
      if (ip.data().locked) throw new HttpErr(400, "That player's profile is locked, so they can't join right now");
      if (il.exists) throw new HttpErr(409, "That player is already in a team in this tournament");
      if (e.members.includes(inv) || (e.invited || []).includes(inv)) throw new HttpErr(409, "That player is already on or invited to your team");
      if (e.members.length + (e.invited || []).length >= td.teamSize) throw new HttpErr(409, `A ${T.MODES[td.mode as T.Mode].label} team has ${td.teamSize} players. Wait for a reply or ask someone to decline first`);
      t.update(eref(id, eid), { invited: [...(e.invited || []), inv] });
      t.set(iref(id, eid, inv), { tournamentId: id, entryId: eid, inviteeUid: inv, inviterUid: uid, status: "PENDING", at: d.TS() });
      d.notify(t, inv, `You were invited to join “${e.name}” in ${td.name}`);
    });
    res.json({ ok: true });
  }));

  app.post("/api/arena-tournaments/:id/entries/:eid/respond", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), eid = pid(req.params.eid, "Team"), uid = req.user.uid, accept = req.body?.accept === true;
    await db.runTransaction(async (t: any) => {
      const [ts, es, lk, pr] = await Promise.all([t.get(tref(id)), t.get(eref(id, eid)), t.get(lref(id, uid)), t.get(pref(uid))]);
      if (!ts.exists || !es.exists) throw new HttpErr(404, "Team not found");
      const td = ts.data(), e = es.data();
      if (e.status !== "FORMING" || !(e.invited || []).includes(uid)) throw new HttpErr(409, "That invitation is no longer valid");
      const invited = e.invited.filter((u: string) => u !== uid);
      if (accept) {
        const rs = regState(td); if (rs !== "open" && rs !== "full") throw new HttpErr(409, REG_MSG[rs]);
        await ensureEligible(td, uid, pr);
        if (lk.exists) throw new HttpErr(409, "You're already registered in this tournament");
        if (e.members.length >= td.teamSize) throw new HttpErr(409, "That team is already full");
        t.update(eref(id, eid), { members: [...e.members, uid], invited });
        t.create(lref(id, uid), { entryId: eid, at: d.TS() });
        d.notify(t, e.captain, `${d.dispName(pr.data())} joined your team “${e.name}”`);
      } else {
        t.update(eref(id, eid), { invited });
        d.notify(t, e.captain, `${pr.exists ? d.dispName(pr.data()) : "A player"} declined to join “${e.name}”`);
      }
      t.set(iref(id, eid, uid), { status: accept ? "ACCEPTED" : "DECLINED", resolvedAt: d.TS() }, { merge: true });
    });
    res.json({ ok: true, accepted: accept });
  }));

  app.post("/api/arena-tournaments/:id/entries/:eid/confirm", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), eid = pid(req.params.eid, "Team"), uid = req.user.uid;
    let status = "";
    await db.runTransaction(async (t: any) => {
      const [ts, es] = await Promise.all([t.get(tref(id)), t.get(eref(id, eid))]);
      if (!ts.exists || !es.exists) throw new HttpErr(404, "Team not found");
      const td = ts.data(), e = es.data(), rs = regState(td);
      if (rs !== "open") throw new HttpErr(409, REG_MSG[rs]);
      if (e.captain !== uid) throw new HttpErr(403, "Only the team captain can submit the team");
      if (e.status !== "FORMING") throw new HttpErr(409, "This team is already submitted");
      if (e.members.length !== td.teamSize) throw new HttpErr(409, `A ${T.MODES[td.mode as T.Mode].label} team needs exactly ${td.teamSize} players (you have ${e.members.length})`);
      status = td.approval === "manual" ? "PENDING_APPROVAL" : "REGISTERED";
      t.update(eref(id, eid), { status, counted: true, invited: [] });
      t.update(tref(id), { entryCount: (td.entryCount || 0) + 1 });
      for (const u of e.invited || []) t.set(iref(id, eid, u), { status: "CANCELLED", resolvedAt: d.TS() }, { merge: true });
    });
    await notifyMany((await eref(id, eid).get()).data().members.filter((u: string) => u !== uid), status === "PENDING_APPROVAL" ? "Your team was submitted and is waiting for admin approval" : "Your team is registered");
    res.json({ ok: true, status });
  }));

  /** Releases a whole entry (locks, counter, pending invitations). Must be called inside a transaction after all reads. */
  function releaseEntry(t: any, id: string, td: any, eid: string, e: any, status: string, why: string) {
    t.update(eref(id, eid), { status, counted: false, withdrawnReason: why, withdrawnAt: d.TS() });
    for (const u of e.members) t.delete(lref(id, u));
    for (const u of e.invited || []) t.set(iref(id, eid, u), { status: "CANCELLED", resolvedAt: d.TS() }, { merge: true });
    if (e.counted) t.update(tref(id), { entryCount: Math.max(0, (td.entryCount || 0) - 1) });
  }

  app.post("/api/arena-tournaments/:id/entries/:eid/leave", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), eid = pid(req.params.eid, "Team"), uid = req.user.uid;
    let others: string[] = [];
    await db.runTransaction(async (t: any) => {
      const [ts, es] = await Promise.all([t.get(tref(id)), t.get(eref(id, eid))]);
      if (!ts.exists || !es.exists) throw new HttpErr(404, "Entry not found");
      const td = ts.data(), e = es.data();
      if (!e.members.includes(uid)) throw new HttpErr(403, "You're not part of this entry");
      if (!["FORMING", "PENDING_APPROVAL", "REGISTERED"].includes(e.status)) throw new HttpErr(409, "This entry is no longer active");
      if (td.status !== "REGISTRATION_OPEN" && td.status !== "PUBLISHED") throw new HttpErr(409, "Registration has closed. Ask an admin to withdraw you");
      others = e.members.filter((u: string) => u !== uid);
      if (e.captain === uid || e.members.length === 1) releaseEntry(t, id, td, eid, e, "WITHDRAWN", "left");
      else {
        t.update(eref(id, eid), { members: others, status: "FORMING", counted: false });
        t.delete(lref(id, uid));
        if (e.counted) t.update(tref(id), { entryCount: Math.max(0, (td.entryCount || 0) - 1) });
      }
    });
    await notifyMany(others, "A team member left. Check your team in the tournament.");
    res.json({ ok: true });
  }));

  app.post("/api/arena-tournaments/:id/disputes", d.auth, d.need("player"), h(async (req, res) => {
    const id = pid(req.params.id), uid = req.user.uid, why = d.str(req.body?.reason, 10, 500, "Reason");
    d.throttle(`t-dis:${uid}`, 6, 3600e3, "Too many reports. Try again later.");
    const [ts, lk] = await Promise.all([tref(id).get(), lref(id, uid).get()]);
    if (!ts.exists || ts.data().status !== "IN_PROGRESS") throw new HttpErr(409, "Results can only be questioned while the tournament is in progress");
    if (!lk.exists) throw new HttpErr(403, "Only players in this tournament can report an issue");
    const refr = req.body?.matchId ? { matchId: String(req.body.matchId).slice(0, 12) } : { round: pint(req.body?.round, "Round"), game: pint(req.body?.game, "Game") };
    const open = await dcol(id).where("by", "==", uid).where("status", "==", "OPEN").get();
    if (open.size >= 3) throw new HttpErr(429, "You already have open reports. An admin will review them first.");
    await dcol(id).add({ ref: refr, by: uid, reason: why, status: "OPEN", at: d.TS() });
    await d.notifyAdmins(`A tournament result was questioned in “${ts.data().name}”`);
    res.status(201).json({ ok: true });
  }));

  // ============================ Admin: create, edit, status ============================
  const A = "/api/admin/arena-tournaments";
  const storedInput = (t: any) => ({ name: t.name, description: t.description, rules: t.rules, mode: t.mode, format: t.format, approval: t.approval || "auto", capacity: t.capacity, regOpensAt: ms(t.regOpensAt), regClosesAt: ms(t.regClosesAt),
    startsAt: ms(t.startsAt), scoring: t.scoring, roundsConfig: t.roundsConfig, seeding: t.seeding || "registration", rewards: t.rewards });
  const docOf = (def: T.TournamentDef) => ({ ...def });

  app.get(A, d.auth, d.isAdmin, h(async (_req, res) => {
    const snap = await db.collection("arenaTournaments").get();
    res.json(snap.docs.map((x: any) => summary(x.id, x.data())).sort((a: any, b: any) => b.startsAt - a.startsAt));
  }));

  app.post(A, d.auth, d.isAdmin, h(async (req, res) => {
    const def = T.parseTournament(req.body, { requireFuture: true });
    const ref = db.collection("arenaTournaments").doc();
    await db.runTransaction(async (t: any) => {
      t.create(ref, { ...docOf(def), status: "DRAFT", entryCount: 0, currentRound: null, champion: null, finalRanks: null, shots: [], createdBy: req.user.uid, createdAt: d.TS() });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_CREATE", target: ref.id, targetLabel: def.name, summary: `${T.MODES[def.mode].label} · ${T.FORMAT_LABEL[def.format]} · capacity ${def.capacity}` });
    });
    res.status(201).json({ id: ref.id });
  }));

  app.get(`${A}/:id`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), [ts, ss, ppl, all, dis] = await Promise.all([tref(id).get(), sref(id).get(), people(), loadEntries(id), dcol(id).get()]);
    if (!ts.exists) throw new HttpErr(404, "Tournament not found");
    const t = ts.data();
    res.json({ ...summary(id, t), ...defOut(t), createdBy: t.createdBy, entries: all.map(e => entryView(e, ppl, true)).sort((a: any, b: any) => a.createdAt - b.createdAt), state: stateView(ss.exists ? ss.data() : null, true), seedValue: t.seedValue ?? null,
      finalRanks: t.finalRanks || null, champion: t.champion || null, shots: (t.shots || []).map((s: any) => ({ ...s, at: ms(s.at) })), nextStatuses: T.TRANSITIONS[t.status as T.TStatus].filter(s => s !== "IN_PROGRESS" && s !== "COMPLETED"),
      disputes: dis.docs.map((x: any) => ({ id: x.id, ...x.data(), at: ms(x.data().at), by: who(ppl.get(x.data().by)).displayName })).sort((a: any, b: any) => b.at - a.at) });
  }));

  app.patch(`${A}/:id`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id);
    await db.runTransaction(async (t: any) => {
      const [ts, any] = await Promise.all([t.get(tref(id)), t.get(ecol(id).limit(1))]);
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const old = ts.data(), merged = { ...storedInput(old), ...(req.body || {}) };
      const def = T.parseTournament(merged);
      const block = T.editBlocker({ status: old.status, mode: old.mode, format: old.format, capacity: old.capacity, entryCount: old.entryCount || 0, hasEntries: !any.empty, scoring: old.scoring, roundsConfig: old.roundsConfig, rewards: old.rewards, approval: old.approval || "auto", seeding: old.seeding || "registration" }, def);
      if (block) throw new HttpErr(409, block);
      const before: any = storedInput(old), after: any = storedInput({ ...def });
      const changed = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (!changed.length) throw new HttpErr(400, "Nothing has changed");
      t.update(tref(id), { ...docOf(def), updatedAt: d.TS() });
      const pick = (o: any) => Object.fromEntries(changed.filter(k => !["description", "rules"].includes(k)).map(k => [k, o[k]]));
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_EDIT", target: id, targetLabel: def.name, summary: `Changed: ${changed.join(", ")}`, prev: pick(before), next: pick(after) });
    });
    res.json({ ok: true });
  }));

  app.post(`${A}/:id/status`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), to = req.body?.to as T.TStatus;
    if (!(to in T.STATUS_LABEL)) throw new HttpErr(400, "Unknown status");
    if (to === "IN_PROGRESS") throw new HttpErr(400, "Use Start tournament to begin it");
    if (to === "COMPLETED") throw new HttpErr(400, "Use Complete tournament so rewards are paid once");
    const why = to === "CANCELLED" ? reason(req.body?.reason) : reason(req.body?.reason, 3, false);
    let members: string[] = [], name = "";
    await db.runTransaction(async (t: any) => {
      const [ts, es] = await Promise.all([t.get(tref(id)), t.get(ecol(id))]);
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const td = ts.data(); name = td.name;
      if (!T.canTransition(td.status, to)) throw new HttpErr(409, `A ${T.STATUS_LABEL[td.status as T.TStatus].toLowerCase()} tournament can't move to ${T.STATUS_LABEL[to].toLowerCase()}`);
      if (to === "REGISTRATION_OPEN" && ms(td.regClosesAt) <= now()) throw new HttpErr(409, "The registration closing time has already passed. Edit the dates first");
      members = es.docs.flatMap((x: any) => (["REGISTERED", "PENDING_APPROVAL", "FORMING"].includes(x.data().status) ? x.data().members : []));
      t.update(tref(id), { status: to, statusChangedAt: d.TS(), ...(to === "CANCELLED" ? { cancelReason: why } : {}) });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_STATUS", target: id, targetLabel: td.name, reason: why, summary: `${T.STATUS_LABEL[td.status as T.TStatus]} → ${T.STATUS_LABEL[to]}`, prev: td.status, next: to });
    });
    if (to === "CANCELLED") await notifyMany(members, `“${name}” was cancelled: ${why}`);
    if (to === "REGISTRATION_OPEN") await d.announceAll?.(`Registration is open for “${name}”`);
    res.json({ ok: true, status: to });
  }));

  // ============================ Admin: entries ============================
  app.post(`${A}/:id/entries`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), ids = req.body?.arenaIds;
    if (!Array.isArray(ids) || ids.some((x: any) => typeof x !== "string")) throw new HttpErr(400, "Send the players' FF Arena IDs");
    if (new Set(ids).size !== ids.length) throw new HttpErr(400, "A player is listed twice");
    const docs: any[] = []; for (const a of ids) docs.push(await d.byArena(a.slice(0, 20)));
    const eid = db.collection(`arenaTournaments/${id}/entries`).doc().id;
    await db.runTransaction(async (t: any) => {
      const [ts, ...rest] = await Promise.all([t.get(tref(id)), ...docs.map(x => t.get(lref(id, x.id))), ...docs.map(x => t.get(pref(x.id)))]);
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const td = ts.data();
      if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(td.status)) throw new HttpErr(409, "Entries can only be added before the tournament starts");
      if (docs.length !== td.teamSize) throw new HttpErr(400, `A ${T.MODES[td.mode as T.Mode].label} entry has exactly ${td.teamSize} player${td.teamSize > 1 ? "s" : ""} (you gave ${docs.length})`);
      if ((td.entryCount || 0) >= td.capacity) throw new HttpErr(409, "This tournament is full");
      const locks = rest.slice(0, docs.length), profs = rest.slice(docs.length);
      profs.forEach((p: any) => { if (!p.exists || p.data().status !== "active") throw new HttpErr(400, "Every player must be an approved player"); if (p.data().locked) throw new HttpErr(400, `${d.dispName(p.data())}'s profile is locked`); });
      locks.forEach((l: any, i: number) => { if (l.exists) throw new HttpErr(409, `${d.dispName(profs[i].data())} is already registered in this tournament`); });
      const name = td.teamSize === 1 ? null : d.str(req.body?.name, 2, 30, "Team name");
      t.create(eref(id, eid), { name, captain: docs[0].id, members: docs.map(x => x.id), invited: [], status: "REGISTERED", counted: true, source: "admin", createdAt: d.TS() });
      docs.forEach(x => t.create(lref(id, x.id), { entryId: eid, at: d.TS() }));
      t.update(tref(id), { entryCount: (td.entryCount || 0) + 1 });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_ENTRY_ADD", target: id, targetLabel: td.name, summary: `Registered ${name || docs[0].data().gameName}` });
    });
    await notifyMany(docs.map(x => x.id), "An admin registered you for a tournament");
    res.status(201).json({ ok: true, entryId: eid });
  }));

  async function entryAction(req: any, res: any, kind: "approve" | "reject" | "remove") {
    const id = pid(req.params.id), eid = pid(req.params.eid, "Entry"), why = kind === "approve" ? "" : reason(req.body?.reason);
    let members: string[] = [], name = "";
    await db.runTransaction(async (t: any) => {
      const [ts, es] = await Promise.all([t.get(tref(id)), t.get(eref(id, eid))]);
      if (!ts.exists || !es.exists) throw new HttpErr(404, "Entry not found");
      const td = ts.data(), e = es.data(); members = e.members; name = e.name || "entry";
      const live = ["FORMING", "PENDING_APPROVAL", "REGISTERED"].includes(e.status);
      if (kind === "approve") {
        if (e.status !== "PENDING_APPROVAL") throw new HttpErr(409, "This entry isn't waiting for approval");
        t.update(eref(id, eid), { status: "REGISTERED", approvedBy: req.user.uid });
      } else if (kind === "reject") {
        if (!live) throw new HttpErr(409, "This entry is already closed");
        if (td.status === "IN_PROGRESS" || td.status === "COMPLETED") throw new HttpErr(409, "Use Withdraw for a tournament that has started");
        releaseEntry(t, id, td, eid, e, "REJECTED", why);
      } else {
        if (!["REGISTERED", "PENDING_APPROVAL", "FORMING"].includes(e.status)) throw new HttpErr(409, "This entry is already closed");
        if (td.status === "COMPLETED" || td.status === "CANCELLED") throw new HttpErr(409, "This tournament is finished");
        if (td.status === "IN_PROGRESS") t.update(eref(id, eid), { status: "WITHDRAWN", withdrawnReason: why, withdrawnAt: d.TS() }); // keeps its place in rosters so results stay consistent
        else releaseEntry(t, id, td, eid, e, "WITHDRAWN", why);
      }
      d.audit(t, { actor: req.user.uid, action: kind === "approve" ? "TOURNEY_ENTRY_APPROVE" : kind === "reject" ? "TOURNEY_ENTRY_REJECT" : "TOURNEY_ENTRY_REMOVE", target: id, targetLabel: td.name, reason: why, summary: `${name} (${e.members.length} player${e.members.length > 1 ? "s" : ""})` });
    });
    await notifyMany(members, kind === "approve" ? "Your tournament entry was approved" : kind === "reject" ? `Your tournament entry was rejected: ${why}` : `You were withdrawn from a tournament: ${why}`);
    res.json({ ok: true });
  }
  app.post(`${A}/:id/entries/:eid/approve`, d.auth, d.isAdmin, h((req, res) => entryAction(req, res, "approve")));
  app.post(`${A}/:id/entries/:eid/reject`, d.auth, d.isAdmin, h((req, res) => entryAction(req, res, "reject")));
  app.post(`${A}/:id/entries/:eid/remove`, d.auth, d.isAdmin, h((req, res) => entryAction(req, res, "remove")));

  // ============================ Admin: start ============================
  app.post(`${A}/:id/start`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), preview = req.body?.preview === true;
    const seedIn = req.body?.seedValue === undefined ? null : Number(req.body.seedValue);
    if (seedIn !== null && (!Number.isInteger(seedIn) || seedIn < 0 || seedIn > 2 ** 31)) throw new HttpErr(400, "Bad seed value");
    let out: any = {}, notify: string[] = [], tname = "";
    const plan = (td: any, es: any[]) => {
      if (td.status !== "REGISTRATION_CLOSED") throw new HttpErr(409, "Close registration before starting the tournament");
      if (es.some(e => e.status === "PENDING_APPROVAL")) throw new HttpErr(409, "Approve or reject the pending entries first");
      const ready = es.filter(e => e.status === "REGISTERED");
      if (ready.length < 2) throw new HttpErr(409, "At least two registered entries are needed");
      if (td.format === "points" && td.roundsConfig.count > 1 && ready.length <= td.roundsConfig.qualifiers[0]) throw new HttpErr(409, `Only ${ready.length} entries registered, but ${td.roundsConfig.qualifiers[0]} are meant to qualify from round 1. Edit the qualifiers first`);
      const seedValue = td.seeding === "random" ? (seedIn ?? crypto.randomInt(1, 2 ** 31)) : null;
      if (td.format === "knockout") { const seeded = T.seedEntries(ready.map(e => ({ id: e.id, at: ms(e.createdAt) })), td.seeding || "registration", seedValue ?? 0); return { state: T.generateBracket(seeded), ready, seedValue }; }
      return { state: T.newPointsState(td.roundsConfig, T.seedEntries(ready.map(e => ({ id: e.id, at: ms(e.createdAt) })), "registration")), ready, seedValue };
    };
    await db.runTransaction(async (t: any) => {
      const [ts, es] = await Promise.all([t.get(tref(id)), t.get(ecol(id))]);
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const td = ts.data(); tname = td.name;
      const p = plan(td, es.docs.map((x: any) => ({ id: x.id, ...x.data() })));
      if (preview) { out = { preview: true, seedValue: p.seedValue, entries: p.ready.length, state: stateView(p.state, true) }; return; }
      t.set(sref(id), p.state);
      t.update(tref(id), { status: "IN_PROGRESS", currentRound: 1, seedValue: p.seedValue, startedAt: d.TS() });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_START", target: id, targetLabel: td.name, summary: `Started with ${p.ready.length} entries${p.seedValue !== null ? ` (random seed ${p.seedValue})` : ""}` });
      notify = p.ready.flatMap((e: any) => e.members); out = { ok: true };
    });
    if (!preview) await notifyMany(notify, `“${tname}” has started`);
    res.json(out);
  }));

  // ============================ Admin: screenshots (optional, never counted as verified data) ============================
  const rawShot = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: SHOT_MAX_BYTES + 1024 });
  app.put(`${A}/:id/shots`, d.auth, d.isAdmin, rawShot, h(async (req, res) => {
    const id = pid(req.params.id), body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpErr(400, "Send the screenshot as a JPEG, PNG or WebP image");
    if (body.length > SHOT_MAX_BYTES) throw new HttpErr(413, `Screenshot is too large (max ${Math.round(SHOT_MAX_BYTES / 1024)} KB)`);
    const type = detectImage(body); if (!type) throw new HttpErr(400, "That file isn't a JPEG, PNG or WebP image");
    const sid = crypto.randomBytes(8).toString("hex");
    await db.runTransaction(async (t: any) => {
      const ts = await t.get(tref(id));
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const shots = ts.data().shots || [];
      if (shots.length >= MAX_SHOTS) throw new HttpErr(409, "This tournament has reached its screenshot limit");
      t.create(db.doc(`arenaTournaments/${id}/shots/${sid}`), { data: body, contentType: type, size: body.length, by: req.user.uid, at: d.TS() });
      t.update(tref(id), { shots: [...shots, { id: sid, size: body.length, by: req.user.uid, at: new Date(), label: String(req.query.label || "").slice(0, 30) }] });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_SHOT", target: id, targetLabel: ts.data().name, summary: `Attached a screenshot (${Math.round(body.length / 1024)} KB). It is a reference only, not verified data` });
    });
    res.status(201).json({ ok: true, shotId: sid });
  }));
  app.get(`${A}/:id/shots/:sid`, d.auth, d.isAdmin, h(async (req, res) => {
    const s = await db.doc(`arenaTournaments/${pid(req.params.id)}/shots/${pid(req.params.sid, "Screenshot")}`).get();
    if (!s.exists) throw new HttpErr(404, "Screenshot not found");
    const x = s.data();
    res.setHeader("Content-Type", x.contentType); res.setHeader("Cache-Control", "private, no-store"); res.setHeader("Content-Security-Policy", "default-src 'none'"); res.send(Buffer.from(x.data));
  }));
  /** Reads (inside the transaction) that a screenshot id really belongs to this tournament. */
  async function shotRead(t: any, id: string, shotId: any) {
    if (shotId === undefined || shotId === null || shotId === "") return null;
    const sid = pid(shotId, "Screenshot"), s = await t.get(db.doc(`arenaTournaments/${id}/shots/${sid}`));
    if (!s.exists) throw new HttpErr(400, "That screenshot doesn't belong to this tournament");
    return sid;
  }
  /** Open player reports that point at the given match/game. */
  async function openDisputeFor(t: any, id: string, pred: (ref: any) => boolean) {
    const s = await t.get(dcol(id).where("status", "==", "OPEN"));
    return s.docs.filter((x: any) => pred(x.data().ref)).length;
  }

  // ============================ Admin: points rounds ============================
  const needT = (ts: any, format: T.Format) => {
    if (!ts.exists) throw new HttpErr(404, "Tournament not found");
    const td = ts.data();
    if (td.format !== format) throw new HttpErr(409, `This is a ${T.FORMAT_LABEL[td.format as T.Format]} tournament`);
    if (td.status !== "IN_PROGRESS") throw new HttpErr(409, td.status === "COMPLETED" ? "This tournament is finished, so results are locked. Use an XP adjustment for any correction" : "The tournament isn't in progress");
    return td;
  };

  app.post(`${A}/:id/rounds/:n/games/:g/submit`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), n = pint(req.params.n, "Round"), g = pint(req.params.g, "Game"), b = req.body || {};
    let out: any = {};
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "points"), st = ss.data() as T.PointsState;
      const shotId = await shotRead(t, id, b.shotId);
      const was = st.rounds[n - 1]?.games[g - 1]?.status;
      const next = T.submitPointsGame(st, n, g, b.rows, td.scoring, req.user.uid, now(), { note: typeof b.note === "string" ? b.note : "", reason: b.reason, shotId });
      const r = next.rounds[n - 1], draft = T.applyTieOrders(T.computeStandings(r.entryIds, r.games.filter(x => x.status !== "EMPTY")), r.tieOrders);
      out = { preview: b.preview === true, rows: r.games[g - 1].rows, standings: draft };
      if (b.preview === true) return;
      t.set(sref(id), next);
      d.audit(t, { actor: req.user.uid, action: was === "CONFIRMED" ? "TOURNEY_RESULT_CORRECT" : "TOURNEY_RESULT_SUBMIT", target: id, targetLabel: td.name, reason: was === "CONFIRMED" ? String(b.reason).trim() : undefined,
        summary: `Round ${n} game ${g}: ${r.games[g - 1].rows.length} rows${was === "CONFIRMED" ? " (correction, needs confirming again)" : " (awaiting confirmation)"}` });
    });
    res.json(out);
  }));

  app.post(`${A}/:id/rounds/:n/games/:g/confirm`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), n = pint(req.params.n, "Round"), g = pint(req.params.g, "Game");
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "points");
      if (await openDisputeFor(t, id, r => r && r.round === n && r.game === g)) throw new HttpErr(409, "A player reported an issue with this game. Resolve it before confirming");
      const next = T.confirmPointsGame(ss.data(), n, g, req.user.uid, now());
      t.set(sref(id), next);
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_RESULT_CONFIRM", target: id, targetLabel: td.name, summary: `Round ${n} game ${g} confirmed` });
    });
    res.json({ ok: true });
  }));

  app.post(`${A}/:id/rounds/:n/tie`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), n = pint(req.params.n, "Round"), ids = req.body?.ids, why = reason(req.body?.reason);
    if (!Array.isArray(ids) || ids.some((x: any) => typeof x !== "string")) throw new HttpErr(400, "Send the tied entries in the order they should finish");
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "points"), next = T.resolveTie(ss.data(), n, ids, req.user.uid, now(), why);
      t.set(sref(id), next);
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_TIE_RESOLVE", target: id, targetLabel: td.name, reason: why, summary: `Round ${n}: ordered ${ids.length} tied entries`, next: ids });
    });
    res.json({ ok: true });
  }));

  app.post(`${A}/:id/rounds/:n/advance`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), n = pint(req.params.n, "Round"), preview = req.body?.preview === true;
    let out: any = {}, members: string[] = [], tname = "";
    await db.runTransaction(async (t: any) => {
      const [ts, ss, es] = await Promise.all([t.get(tref(id)), t.get(sref(id)), t.get(ecol(id))]);
      const td = needT(ts, "points"); tname = td.name;
      const open = await openDisputeFor(t, id, r => r && r.round === n);
      const plan = T.planAdvance(ss.data(), n, td.roundsConfig, open);
      const next = T.applyAdvance(ss.data(), n, td.roundsConfig, open);
      out = { preview, standings: plan.standings, qualifiers: plan.qualifiers, eliminated: ss.data().rounds[n - 1].entryIds.filter((e: string) => !plan.qualifiers.includes(e)) };
      if (preview) return;
      t.set(sref(id), next);
      t.update(tref(id), { currentRound: n + 1 });
      members = es.docs.filter((x: any) => plan.qualifiers.includes(x.id)).flatMap((x: any) => x.data().members);
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_ROUND_ADVANCE", target: id, targetLabel: td.name, summary: `Round ${n} → round ${n + 1}: ${plan.qualifiers.length} qualified, ${out.eliminated.length} eliminated`, next: plan.qualifiers });
    });
    if (!preview) await notifyMany(members, `You advanced to round ${n + 1} of “${tname}”`);
    res.json(out);
  }));

  app.post(`${A}/:id/rounds/:n/reopen`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), n = pint(req.params.n, "Round"), why = reason(req.body?.reason);
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "points"), next = T.reopenRound(ss.data(), n);
      t.set(sref(id), next); t.update(tref(id), { currentRound: n });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_ROUND_REOPEN", target: id, targetLabel: td.name, reason: why, summary: `Round ${n} reopened for corrections. Round ${n + 1} was cleared` });
    });
    res.json({ ok: true });
  }));

  // ============================ Admin: knockout matches ============================
  const withdrawnSet = (es: any) => new Set<string>(es.docs.filter((x: any) => ["WITHDRAWN", "DISQUALIFIED"].includes(x.data().status)).map((x: any) => x.id));
  app.post(`${A}/:id/matches/:mid/submit`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), mid = pid(req.params.mid, "Match"), b = req.body || {};
    let out: any = {};
    await db.runTransaction(async (t: any) => {
      const [ts, ss, es] = await Promise.all([t.get(tref(id)), t.get(sref(id)), t.get(ecol(id))]);
      const td = needT(ts, "knockout"), st = ss.data() as T.Bracket;
      const shotId = await shotRead(t, id, b.shotId);
      const before = st.rounds.flat().find(m => m.id === mid);
      const next = T.submitMatch(st, mid, { winner: b.winner, scoreA: b.scoreA, scoreB: b.scoreB, walkover: b.walkover === true, forfeitBoth: b.forfeitBoth === true, note: typeof b.note === "string" ? b.note : "", reason: b.reason, shotId }, req.user.uid, now(), withdrawnSet(es));
      out = { preview: b.preview === true, bracket: bracketView(next, true) };
      if (b.preview === true) return;
      t.set(sref(id), next);
      const m = next.rounds.flat().find(x => x.id === mid)!;
      d.audit(t, { actor: req.user.uid, action: before?.status === "CONFIRMED" ? "TOURNEY_RESULT_CORRECT" : "TOURNEY_RESULT_SUBMIT", target: id, targetLabel: td.name, reason: before?.status === "CONFIRMED" ? String(b.reason).trim() : undefined,
        summary: `${m.id}: ${m.forfeitBoth ? "double forfeit" : m.walkover ? "walkover" : "winner entered"} (awaiting confirmation)` });
    });
    res.json(out);
  }));
  app.post(`${A}/:id/matches/:mid/confirm`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), mid = pid(req.params.mid, "Match");
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "knockout");
      if (await openDisputeFor(t, id, r => r && r.matchId === mid)) throw new HttpErr(409, "A player reported an issue with this match. Resolve it before confirming");
      const next = T.confirmMatch(ss.data(), mid, req.user.uid, now());
      const problems = T.bracketProblems(next); if (problems.length) throw new HttpErr(409, "The bracket would become inconsistent: " + problems[0]);
      t.set(sref(id), next);
      const m = next.rounds.flat().find(x => x.id === mid)!, r = next.rounds[m.round];
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_RESULT_CONFIRM", target: id, targetLabel: td.name, summary: `${mid} confirmed${r ? ` and the winner placed in ${r[Math.floor(m.index / 2)].id}` : " (final)"}` });
    });
    res.json({ ok: true });
  }));
  app.post(`${A}/:id/matches/:mid/reopen`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), mid = pid(req.params.mid, "Match"), why = reason(req.body?.reason);
    await db.runTransaction(async (t: any) => {
      const [ts, ss] = await Promise.all([t.get(tref(id)), t.get(sref(id))]);
      const td = needT(ts, "knockout"), next = T.reopenMatch(ss.data(), mid, req.user.uid, now(), why);
      t.set(sref(id), next);
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_MATCH_REOPEN", target: id, targetLabel: td.name, reason: why, summary: `${mid} reopened` });
    });
    res.json({ ok: true });
  }));

  // ============================ Admin: disputes ============================
  app.post(`${A}/:id/disputes/:did/resolve`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), did = pid(req.params.did, "Report"), note = reason(req.body?.note);
    await db.runTransaction(async (t: any) => {
      const [ts, ds] = await Promise.all([t.get(tref(id)), t.get(dcol(id).doc(did))]);
      if (!ds.exists || ds.data().status !== "OPEN") throw new HttpErr(409, "That report isn't open");
      t.update(dcol(id).doc(did), { status: "RESOLVED", note, resolvedBy: req.user.uid, resolvedAt: d.TS() });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_DISPUTE_RESOLVE", target: id, targetLabel: ts.data().name, reason: note, summary: "Resolved a player report" });
    });
    res.json({ ok: true });
  }));

  // ============================ Admin: complete + rewards ============================
  app.post(`${A}/:id/complete`, d.auth, d.isAdmin, h(async (req, res) => {
    const id = pid(req.params.id), preview = req.body?.preview === true;
    let out: any = {}, rewarded: string[] = [], tname = "";
    const ppl = await people();
    await db.runTransaction(async (t: any) => {
      const [ts, ss, es] = await Promise.all([t.get(tref(id)), t.get(sref(id)), t.get(ecol(id))]);
      if (!ts.exists) throw new HttpErr(404, "Tournament not found");
      const td = ts.data(); tname = td.name;
      if (td.status === "COMPLETED") throw new HttpErr(409, "This tournament is already completed");
      if (td.status !== "IN_PROGRESS") throw new HttpErr(409, "The tournament isn't in progress");
      const entries = es.docs.map((x: any) => ({ id: x.id, ...x.data() })), members = new Map<string, string[]>(entries.map((e: any) => [e.id, e.members]));
      const slots = (td.rewards?.placementXp || []).length;
      const ranks: T.FinalRank[] = td.format === "points" ? T.planFinish(ss.data(), td.roundsConfig, slots) : T.knockoutRanks(ss.data());
      const rewards = T.rewardsFor(ranks, members, td.rewards?.placementXp || []);
      const real = rewards.filter(r => !T.isTombstone(r.uid));
      const profs = await Promise.all(real.map(r => t.get(pref(r.uid))));
      const paid = real.filter((r, i) => profs[i].exists && profs[i].data().status === "active");
      const entryOf = (eid: string) => entries.find((e: any) => e.id === eid);
      const champEntry = ranks.find(r => r.rank === 1) ? entryOf(ranks.find(r => r.rank === 1)!.entryId) : null;
      const champName = champEntry ? entryView(champEntry, ppl).name : null;
      out = { preview, champion: champName, standings: ranks.map(r => ({ ...r, name: entryView(entryOf(r.entryId) || { id: r.entryId, members: [] }, ppl).name })),
        rewards: paid.map(r => ({ uid: undefined, entryId: r.entryId, rank: r.rank, xp: r.xp, name: d.dispName(profs[real.indexOf(r)].data()) })), skipped: rewards.length - paid.length };
      if (preview) return;
      paid.forEach(r => {
        const p = profs[real.indexOf(r)].data(), xp = d.ledger(t, T.rewardLedgerId(id, r.uid), r.uid, p.xp, r.xp, `Tournament: ${td.name} (#${r.rank})`, id, req.user.uid);
        t.update(pref(r.uid), { xp, ...d.rankFromXp(xp) });
        t.create(db.doc(`arenaTournaments/${id}/rewards/${r.uid}`), { uid: r.uid, entryId: r.entryId, rank: r.rank, xp: r.xp, ledgerId: T.rewardLedgerId(id, r.uid), at: d.TS(), by: req.user.uid });
      });
      rewarded = paid.map(r => r.uid);
      t.update(tref(id), { status: "COMPLETED", completedAt: d.TS(), champion: ranks[0]?.entryId || null, championName: champName, finalRanks: ranks.filter(r => r.rank <= 16).map(r => ({ entryId: r.entryId, rank: r.rank, points: r.points ?? null })) });
      d.audit(t, { actor: req.user.uid, action: "TOURNEY_COMPLETE", target: id, targetLabel: td.name, summary: `Completed. Champion: ${champName || "none"}. ${paid.length} player(s) rewarded ${paid.reduce((s, r) => s + r.xp, 0)} XP in total` });
    });
    if (!preview) {
      await notifyMany(rewarded, `“${tname}” is complete. Your XP reward was added`);
      await d.announceAll?.(`“${tname}” is complete. Champion: ${out.champion || "TBD"}`);
    }
    res.json(out);
  }));
}

/** Removes a deleted player from every tournament. Safe to run again: it only touches entries that still mention the uid. */
export async function detachPlayerFromTournaments(d: any, uid: string, tomb: string) {
  const { db } = d, tourneys = await db.collection("arenaTournaments").get();
  const res = { entriesUpdated: 0, followUps: [] as string[] };
  for (const tdoc of tourneys.docs) {
    const id = tdoc.id, col = db.collection(`arenaTournaments/${id}/entries`);
    const [a, b] = await Promise.all([col.where("members", "array-contains", uid).get(), col.where("invited", "array-contains", uid).get()]);
    const ids = new Set<string>([...a.docs, ...b.docs].map((x: any) => x.id));
    for (const eid of ids) {
      await db.runTransaction(async (t: any) => {
        const [ts, es] = await Promise.all([t.get(db.doc(`arenaTournaments/${id}`)), t.get(db.doc(`arenaTournaments/${id}/entries/${eid}`))]);
        if (!ts.exists || !es.exists) return;
        const td = ts.data(), e = es.data(), upd: any = {};
        const inMembers = (e.members || []).includes(uid), live = ["FORMING", "PENDING_APPROVAL", "REGISTERED"].includes(e.status), started = ["IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(td.status);
        if ((e.invited || []).includes(uid)) upd.invited = e.invited.filter((u: string) => u !== uid);
        if (inMembers) {
          if (!started && live) {
            const rest = e.members.filter((u: string) => u !== uid);
            upd.members = rest;
            if (e.captain === uid) upd.captain = rest[0] || tomb;
            if (!rest.length) Object.assign(upd, { status: "WITHDRAWN", counted: false, withdrawnReason: "account_deleted" });
            else if (e.status !== "FORMING") Object.assign(upd, { status: "FORMING", counted: false });
            if (e.counted && (upd.counted === false)) t.update(db.doc(`arenaTournaments/${id}`), { entryCount: Math.max(0, (td.entryCount || 0) - 1) });
            if (rest.length) upd.memberDeleted = true;
          } else {
            upd.members = e.members.map((u: string) => (u === uid ? tomb : u)); // history keeps its shape; the person is gone
            if (e.captain === uid) upd.captain = tomb;
            upd.memberDeleted = true;
            if (td.status === "IN_PROGRESS" && live && e.members.length === 1) { Object.assign(upd, { status: "WITHDRAWN", withdrawnReason: "account_deleted" }); res.followUps.push(`${td.name}: a solo entry was withdrawn. Confirm any walkover or no-show`); }
          }
          t.delete(db.doc(`arenaTournaments/${id}/players/${uid}`));
        }
        if (Object.keys(upd).length) t.update(db.doc(`arenaTournaments/${id}/entries/${eid}`), upd);
      });
      res.entriesUpdated++;
    }
    const [rw, ds] = await Promise.all([db.doc(`arenaTournaments/${id}/rewards/${uid}`).get(), db.collection(`arenaTournaments/${id}/disputes`).where("by", "==", uid).get()]);
    if (rw.exists) await rw.ref.delete();
    for (const x of ds.docs) await x.ref.update({ by: tomb });
    await db.doc(`arenaTournaments/${id}/players/${uid}`).delete();
  }
  const inv = await Promise.all([db.collection("arenaInvites").where("inviteeUid", "==", uid).get(), db.collection("arenaInvites").where("inviterUid", "==", uid).get()]);
  for (const x of [...inv[0].docs, ...inv[1].docs]) await x.ref.delete();
  return res;
}
