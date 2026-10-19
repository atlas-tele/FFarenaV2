// Permanent player deletion. Runs as a resumable job (deletionJobs/{uid}) so a crash or a Firebase Auth outage half-way never leaves
// the account in an unknown state: calling the endpoint again with the same confirmation simply continues from the failed step.
//
// What happens to each kind of record:
//   Auth account, users/, registrations/, playerProfiles/, avatars/, lockHistory/, notifications, xpLedger rows, legacy tournamentResults rows -> deleted
//   Tournament entries before the start -> player removed (team reverts to "forming"); after the start -> the player's uid becomes a tombstone, results stay
//   Open challenges / open matches -> cancelled / player removed (opponents are notified); approved challenges keep their result for the opponent (uid -> tombstone)
//   Legacy teams -> member removed (captain reassigned); disputes -> tombstone; review flags about the player -> resolved
//   adminAuditLogs -> KEPT on purpose (accountability); the arena ID counter is never decremented, so an FF Arena ID is never reused
import * as T from "./tournament";
import { detachPlayerFromTournaments } from "./tournaments";

const STEPS = ["lockout", "tournaments", "openMatches", "challenges", "disputes", "teams", "flags", "personalRecords", "auth", "accountDocs"] as const;
type Step = typeof STEPS[number];
const OPEN_CHALLENGE = ["PROPOSED", "SCHEDULED", "PENDING_REVIEW", "DISPUTED", "REJECTED"];
const maskEmail = (e: any) => { const s = String(e || ""), [u, dom] = s.split("@"); return dom ? `${u.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, u.length - 1)))}@${dom}` : "(no email on file)"; };

export function registerAccountDeletion(d: any) {
  const { app, db, HttpErr } = d;
  const jref = (uid: string) => db.doc(`deletionJobs/${uid}`);

  /** Deletes every document matching a query, in batches (a retry only sees what is left). */
  async function deleteWhere(q: () => any) {
    for (let guard = 0; guard < 200; guard++) {
      const s = await q().limit(400).get(); if (s.empty) return;
      const b = db.batch(); s.docs.forEach((x: any) => b.delete(x.ref)); await b.commit();
      if (s.size < 400) return;
    }
  }
  const sanitizeErr = (e: any) => String(e?.code || e?.message || "error").replace(/[^\w .:/-]/g, "").slice(0, 120);

  async function target(uid: string) {
    const [u, p, r, job] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`playerProfiles/${uid}`).get(), db.doc(`registrations/${uid}`).get(), jref(uid).get()]);
    if (!u.exists && !p.exists && !r.exists && !job.exists) throw new HttpErr(404, "Player not found");
    const prof = p.exists ? p.data() : null, reg = r.exists ? r.data() : null;
    const phrase = job.exists ? job.data().confirmPhrase : prof ? prof.arenaId : reg ? reg.gameName : null;
    return { user: u.exists ? u.data() : null, prof, reg, job: job.exists ? job.data() : null, phrase };
  }
  function guard(req: any, uid: string, x: any) {
    if (uid === req.user.uid) throw new HttpErr(400, "You can't delete your own account here");
    const role = x.user?.role;
    if (role === "owner" || role === "admin") throw new HttpErr(409, "This account is an admin. Remove the admin role first (owners can't be deleted here)");
  }

  app.get("/api/admin/players/:uid/delete-preview", d.auth, d.isAdmin, d.wrap(async (req: any, res: any) => {
    const uid = String(req.params.uid).slice(0, 128), x = await target(uid);
    const name = x.prof ? d.dispName(x.prof) : x.reg?.displayName || x.reg?.gameName || "Unknown";
    let tournaments = 0;
    for (const t of (await db.collection("arenaTournaments").get()).docs) if ((await db.doc(`arenaTournaments/${t.id}/players/${uid}`).get()).exists) tournaments++;
    const [a, b] = await Promise.all([db.collection("challenges").where("playerA", "==", uid).get(), db.collection("challenges").where("playerB", "==", uid).get()]);
    const ch = [...a.docs, ...b.docs].map((c: any) => c.data());
    res.json({ uid, displayName: name, gameName: x.prof?.gameName || x.reg?.gameName || null, arenaId: x.prof?.arenaId || null, ffUid: x.prof?.ffUid || x.reg?.ffUid || null, email: maskEmail(x.user?.email),
      role: x.user?.role || "none", xp: x.prof?.xp ?? null, matches: x.prof?.matches ?? null, blocked: (x.user?.role === "owner" || x.user?.role === "admin") ? "This account is an admin" : uid === req.user.uid ? "This is your own account" : null,
      confirmPhrase: x.phrase, tournaments, openChallenges: ch.filter(c => OPEN_CHALLENGE.includes(c.status)).length, approvedChallenges: ch.filter(c => c.effects).length,
      job: x.job ? { status: x.job.status, failedStep: x.job.failedStep || null, lastError: x.job.lastError || null, steps: x.job.steps || {} } : null,
      willDelete: ["Sign-in account", "Profile, registration and picture", "Notifications and XP history", "Open challenges and open matches (cancelled, opponents notified)", "Tournament entries before the start"],
      willKeep: ["Approved challenge results (opponent's rating and XP are unchanged; the player shows as “Deleted player”)", "Tournament results after the start (shown as “Deleted player”)", "Admin audit log entries, which exist for accountability"] });
  }));

  app.get("/api/admin/deletions", d.auth, d.isAdmin, d.wrap(async (_req: any, res: any) => {
    const s = await db.collection("deletionJobs").orderBy("startedAt", "desc").limit(30).get();
    res.json(s.docs.map((x: any) => { const j = x.data(); return { label: j.label, status: j.status, failedStep: j.failedStep || null, lastError: j.lastError || null, startedAt: d.tms(j.startedAt), completedAt: j.completedAt ? d.tms(j.completedAt) : null, uid: j.status === "COMPLETED" ? null : x.id }; }));
  }));

  app.post("/api/admin/players/:uid/delete", d.auth, d.isAdmin, d.wrap(async (req: any, res: any) => {
    const uid = String(req.params.uid).slice(0, 128);
    d.throttle(`del:${req.user.uid}`, Number(process.env.DELETE_PER_HOUR) || 10, 3600e3, "Too many deletions in the last hour. Slow down and double-check each one.");
    const why = d.str(req.body?.reason, 3, 200, "Reason"), x = await target(uid);
    guard(req, uid, x);
    if (x.job?.status === "COMPLETED") throw new HttpErr(409, "This account was already deleted");
    if (typeof req.body?.confirm !== "string" || req.body.confirm.trim() !== x.phrase) throw new HttpErr(400, `Type ${x.phrase} exactly to confirm`);
    const label = x.prof ? `${x.prof.arenaId} · ${x.prof.gameName}` : `${x.reg?.gameName || "registrant"} (not approved)`;
    const tomb = T.tombstone(uid), resume = !!x.job;

    if (!resume) await db.runTransaction(async (t: any) => {
      const [j, u] = await Promise.all([t.get(jref(uid)), t.get(db.doc(`users/${uid}`))]);
      if (j.exists) return; // two admins clicking at once: the second simply resumes the first's job
      t.create(jref(uid), { status: "IN_PROGRESS", label, arenaId: x.prof?.arenaId || null, confirmPhrase: x.phrase, tombstone: tomb, actor: req.user.uid, reason: why, steps: {}, startedAt: d.TS() });
      if (u.exists) t.update(db.doc(`users/${uid}`), { role: "deleting" }); // immediate lock-out: every API check reads the role from here
      d.audit(t, { actor: req.user.uid, action: "PLAYER_DELETE_START", target: uid, targetLabel: label, reason: why, summary: "Permanent account deletion started" });
    });

    const done = (await jref(uid).get()).data().steps || {};
    const mark = async (s: Step) => { done[s] = true; await jref(uid).update({ [`steps.${s}`]: true, failedStep: null, lastError: null }); };
    const todo = async (s: Step, fn: () => Promise<any>) => { if (done[s]) return; await fn(); await mark(s); };
    const summary: any = {};
    try {
      await todo("lockout", async () => {
        try { await d.admin.auth().updateUser(uid, { disabled: true }); await d.admin.auth().revokeRefreshTokens(uid); } catch (e: any) { if (e?.code !== "auth/user-not-found") throw e; }
      });
      await todo("tournaments", async () => { Object.assign(summary, await detachPlayerFromTournaments(d, uid, tomb)); });
      await todo("openMatches", async () => {
        const s = await db.collection("openMatches").where("participants", "array-contains", uid).get();
        for (const m of s.docs) await db.runTransaction(async (t: any) => {
          const c = await t.get(m.ref); if (!c.exists) return;
          const o = c.data(), rest = (o.participants || []).filter((p: string) => p !== uid), cancel = o.creatorUid === uid && o.status === "OPEN";
          t.update(m.ref, { participants: rest, participantCount: rest.length, ...(o.creatorUid === uid ? { creatorUid: tomb, creatorName: "Deleted player" } : {}), ...(cancel ? { status: "CANCELLED", cancelledAt: d.TS(), cancelledBy: "system" } : {}) });
          if (cancel) rest.forEach((p: string) => d.notify(t, p, `“${o.title}” was cancelled because its creator's account was removed`));
        });
      });
      await todo("challenges", async () => {
        for (const f of ["playerA", "playerB"]) {
          const s = await db.collection("challenges").where(f, "==", uid).get();
          for (const c of s.docs) await db.runTransaction(async (t: any) => {
            const cs = await t.get(c.ref); if (!cs.exists) return;
            const o = cs.data(), other = f === "playerA" ? o.playerB : o.playerA;
            const upd: any = { [f]: tomb };
            if (o.createdBy === uid) upd.createdBy = tomb;
            if (o.submission?.by === uid) upd["submission.by"] = tomb;
            if (!o.effects && OPEN_CHALLENGE.concat("CANCELLED").includes(o.status) && o.status !== "CANCELLED") { upd.status = "CANCELLED"; upd.cancelReason = "player_deleted"; if (other && !T.isTombstone(other)) d.notify(t, other, `A challenge was cancelled because ${f === "playerA" ? "its creator" : "your opponent"}'s account was removed`); }
            t.update(c.ref, upd);
          });
        }
      });
      await todo("disputes", async () => { const s = await db.collection("disputes").where("by", "==", uid).get(); for (const x of s.docs) await x.ref.update({ by: tomb }); });
      await todo("teams", async () => {
        const s = await db.collection("teams").where("members", "array-contains", uid).get();
        for (const tm of s.docs) await db.runTransaction(async (t: any) => {
          const c = await t.get(tm.ref); if (!c.exists) return;
          const o = c.data(), rest = o.members.filter((m: string) => m !== uid);
          t.update(tm.ref, { members: rest, ...(o.captain === uid ? { captain: rest[0] || tomb } : {}), ...(rest.length ? {} : { inactive: true }) });
        });
      });
      await todo("flags", async () => {
        const s = await db.collection("flags").where("status", "==", "OPEN").get();
        for (const f of s.docs.filter((x: any) => (x.data().pair || []).includes(uid))) await f.ref.update({ status: "RESOLVED", note: "Player account deleted", by: "system" });
      });
      await todo("personalRecords", async () => {
        await deleteWhere(() => db.collection("notifications").where("uid", "==", uid));
        await deleteWhere(() => db.collection("xpLedger").where("uid", "==", uid));
        await deleteWhere(() => db.collection("tournamentResults").where("uid", "==", uid));
        await db.doc(`avatars/${uid}`).delete(); await db.doc(`lockHistory/${uid}`).delete();
      });
      await todo("auth", async () => { try { await d.admin.auth().deleteUser(uid); } catch (e: any) { if (e?.code !== "auth/user-not-found") throw e; } }); // already gone counts as success
      await todo("accountDocs", async () => {
        await db.doc(`playerProfiles/${uid}`).delete(); await db.doc(`registrations/${uid}`).delete(); await db.doc(`users/${uid}`).delete();
      });
    } catch (e: any) {
      const step = STEPS.find(s => !done[s]) || "unknown";
      console.error("player deletion paused at", step, e?.code || e?.message);
      await jref(uid).update({ failedStep: step, lastError: sanitizeErr(e), lastAttemptAt: d.TS() }).catch(() => {});
      throw new HttpErr(502, `Deletion paused at “${step}” (${sanitizeErr(e)}). The account is already locked out. Press Delete again to continue where it stopped.`);
    }
    await db.runTransaction(async (t: any) => {
      t.update(jref(uid), { status: "COMPLETED", completedAt: d.TS() });
      d.audit(t, { actor: req.user.uid, action: "PLAYER_DELETE", target: uid, targetLabel: label, reason: why, summary: `Account permanently deleted${resume ? " (resumed after an interruption)" : ""}` });
    });
    d.invalidateProfiles?.();
    res.json({ ok: true, followUps: summary.followUps || [] });
  }));
}
