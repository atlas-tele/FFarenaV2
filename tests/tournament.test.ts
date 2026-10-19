import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/tournament";

const NOW = Date.parse("2026-10-18T00:00:00Z");
const iso = (h: number) => new Date(NOW + h * 3600e3).toISOString();
const base = (o: any = {}) => ({ name: "Friday Cup", mode: "squad", format: "points", capacity: 12, regOpensAt: iso(1), regClosesAt: iso(48), startsAt: iso(72),
  scoring: { placementPoints: [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0], killPoints: 1, winBonus: 0 }, roundsConfig: { count: 2, gamesPerRound: 2, qualifiers: [4] }, rewards: { placementXp: [100, 60, 40] }, ...o });
const fail = (f: () => any, code: string, re?: RegExp) => assert.throws(f, (e: any) => e instanceof T.RuleError && e.code === code && (!re || re.test(e.message)));

// ---------- definition + validation ----------
test("tournament definition: valid input is normalised, team size follows the mode", () => {
  const d = T.parseTournament(base(), { now: NOW, requireFuture: true });
  assert.equal(d.teamSize, 4); assert.equal(T.parseTournament(base({ mode: "duo" }), { now: NOW }).teamSize, 2); assert.equal(T.parseTournament(base({ mode: "solo" }), { now: NOW }).teamSize, 1);
  assert.deepEqual(d.roundsConfig, { count: 2, gamesPerRound: 2, qualifiers: [4] }); assert.equal(d.approval, "auto");
});
test("tournament definition: every invalid field is rejected on the server", () => {
  const p = (o: any) => () => T.parseTournament(base(o), { now: NOW, requireFuture: true });
  fail(p({ name: "ab" }), "invalid"); fail(p({ mode: "trio" }), "invalid"); fail(p({ format: "league" }), "invalid"); fail(p({ capacity: 1 }), "invalid"); fail(p({ capacity: 65 }), "invalid", /Capacity/);
  fail(p({ capacity: "12.5" }), "invalid"); fail(p({ regOpensAt: "nonsense" }), "invalid"); fail(p({ regOpensAt: iso(50) }), "invalid", /close after/);
  fail(p({ startsAt: iso(10) }), "invalid", /before registration closes/); fail(p({ startsAt: iso(-5), regOpensAt: iso(-9), regClosesAt: iso(-6) }), "invalid", /future/);
  fail(p({ scoring: { placementPoints: [], killPoints: 1 } }), "invalid"); fail(p({ scoring: { placementPoints: [5, -1], killPoints: 1 } }), "invalid"); fail(p({ scoring: { placementPoints: [5], killPoints: 1.5 } }), "invalid");
  fail(p({ roundsConfig: { count: 3, gamesPerRound: 1, qualifiers: [4] } }), "invalid", /exactly 2/); fail(p({ roundsConfig: { count: 2, gamesPerRound: 1, qualifiers: [12] } }), "invalid", /fewer than/);
  fail(p({ roundsConfig: { count: 3, gamesPerRound: 1, qualifiers: [6, 8] } }), "invalid", /fewer than/); fail(p({ roundsConfig: { count: 2, gamesPerRound: 9, qualifiers: [4] } }), "invalid");
  fail(p({ rewards: { placementXp: [100, -5] } }), "invalid"); fail(p({ rewards: { placementXp: new Array(17).fill(1) } }), "invalid"); fail(p({ approval: "maybe" }), "invalid");
});
test("knockout definition ignores points settings; capacity up to 128", () => {
  const d = T.parseTournament(base({ format: "knockout", capacity: 128, scoring: undefined, roundsConfig: undefined }), { now: NOW });
  assert.equal(d.scoring, null); assert.equal(d.roundsConfig, null);
});
test("status machine only allows the defined transitions", () => {
  assert.ok(T.canTransition("DRAFT", "PUBLISHED")); assert.ok(T.canTransition("REGISTRATION_CLOSED", "REGISTRATION_OPEN"));
  assert.ok(!T.canTransition("DRAFT", "REGISTRATION_OPEN")); assert.ok(!T.canTransition("DRAFT", "IN_PROGRESS") || false); assert.ok(!T.canTransition("COMPLETED", "CANCELLED")); assert.ok(!T.canTransition("CANCELLED", "DRAFT"));
  assert.ok(!T.canTransition("PUBLISHED", "COMPLETED"));
});
test("edit rules: mode/format locked after entries, capacity floor, scoring locked after close", () => {
  const cur = T.parseTournament(base(), { now: NOW });
  const old = (o: any = {}) => ({ status: "REGISTRATION_OPEN" as T.TStatus, mode: cur.mode, format: cur.format, capacity: 12, entryCount: 3, hasEntries: true, scoring: cur.scoring, roundsConfig: cur.roundsConfig, rewards: cur.rewards, approval: "auto", seeding: "registration", ...o });
  assert.equal(T.editBlocker(old(), cur), null);
  assert.match(T.editBlocker(old(), { ...cur, mode: "duo" })!, /Mode and format/); assert.match(T.editBlocker(old(), { ...cur, capacity: 2 })!, /Capacity/);
  assert.match(T.editBlocker(old({ status: "REGISTRATION_CLOSED" }), { ...cur, scoring: { ...cur.scoring!, killPoints: 5 } })!, /locked/);
  assert.match(T.editBlocker(old({ status: "COMPLETED" }), cur)!, /finished/);
  assert.equal(T.editBlocker(old({ status: "DRAFT", hasEntries: false, entryCount: 0 }), { ...cur, mode: "duo" }), null);
});

// ---------- scoring ----------
const S: T.Scoring = { placementPoints: [12, 9, 8, 7], killPoints: 2, winBonus: 3 };
test("points: placement + kills + win bonus; placements beyond the table score only kills", () => {
  assert.equal(T.rowPoints(S, { placement: 1, kills: 5 }), 12 + 10 + 3); assert.equal(T.rowPoints(S, { placement: 4, kills: 0 }), 7);
  assert.equal(T.rowPoints(S, { placement: 9, kills: 3 }), 6); assert.equal(T.rowPoints(S, { placement: 1, kills: 9, noShow: true }), 0); assert.equal(T.rowPoints(S, { placement: 1, kills: 9, pointsOverride: 40 }), 40);
});
test("game rows: every participant needs one row, unique placements, no strangers, no duplicates", () => {
  const ids = ["a", "b", "c"], row = (entryId: string, placement: any, kills = 0, x: any = {}) => ({ entryId, placement, kills, ...x });
  const ok = T.scoreGame([row("a", 2, 3), row("b", 1, 1), row("c", 3, 0)], ids, S);
  assert.deepEqual(ok.map(r => r.points), [9 + 6, 12 + 2 + 3, 8]);
  fail(() => T.scoreGame([row("a", 1), row("b", 1), row("c", 3)], ids, S), "invalid", /twice/); fail(() => T.scoreGame([row("a", 1), row("b", 2)], ids, S), "invalid", /Every participant/);
  fail(() => T.scoreGame([row("a", 1), row("b", 2), row("z", 3)], ids, S), "invalid", /isn't in this round/); fail(() => T.scoreGame([row("a", 1), row("a", 2), row("c", 3)], ids, S), "invalid", /twice/);
  fail(() => T.scoreGame([row("a", 0), row("b", 2), row("c", 3)], ids, S), "invalid"); fail(() => T.scoreGame([row("a", 1, -1), row("b", 2), row("c", 3)], ids, S), "invalid"); fail(() => T.scoreGame([row("a", 1, 1.5), row("b", 2), row("c", 3)], ids, S), "invalid");
  const ns = T.scoreGame([row("a", 1, 2), row("b", 2, 0), row("c", null, 0, { noShow: true })], ids, S); assert.equal(ns[2].points, 0); // no-show doesn't consume a placement
  fail(() => T.scoreGame([row("a", 1), row("b", 3), row("c", null, 0, { noShow: true })], ids, S), "invalid"); // only 2 present, so placements must be 1-2
  const direct = T.scoreGame([row("a", null, 0, { pointsOverride: 33 }), row("b", 1, 0), row("c", 2, 0)], ids, S); assert.equal(direct[0].points, 33);
});

// ---------- standings, ties ----------
const game = (rows: [string, number | null, number][], S2 = S) => ({ rows: rows.map(([entryId, placement, kills]) => ({ entryId, placement, kills, noShow: placement === null, pointsOverride: null, points: T.rowPoints(S2, { placement, kills, noShow: placement === null }) })) });
test("standings: points, then kills, then best placement; fully level entries are flagged tied, never silently ordered", () => {
  const st = T.computeStandings(["a", "b", "c", "d"], [game([["a", 1, 0], ["b", 2, 0], ["c", 3, 0], ["d", 4, 0]]), game([["a", 4, 0], ["b", 3, 0], ["c", 2, 0], ["d", 1, 0]])]);
  // a: 12+3+7+... compute: a=12+3(win bonus)+7=22; d=7+12+3=22; b=9+8=17; c=8+9=17
  assert.deepEqual(st.map(s => [s.entryId, s.points]), [["a", 22], ["d", 22], ["b", 17], ["c", 17]]);
  assert.ok(st[0].tied && st[1].tied && st[0].rank === 1 && st[1].rank === 1 && st[2].rank === 3);
  const k = T.computeStandings(["a", "b"], [game([["a", 2, 5], ["b", 1, 0]], { placementPoints: [10, 10], killPoints: 1, winBonus: 0 })]); // a: 10+5 vs b: 10 -> kills decide
  assert.equal(k[0].entryId, "a"); assert.equal(k[0].tied, false);
  const bp = T.computeStandings(["a", "b"], [game([["a", 1, 0], ["b", 2, 0]], { placementPoints: [5, 5], killPoints: 0, winBonus: 0 })]); // same points, same kills -> best placement decides
  assert.equal(bp[0].entryId, "a"); assert.equal(bp[0].tied, false);
});
test("ties: a tie at the cutoff blocks qualification until an admin orders exactly that group", () => {
  const st = T.computeStandings(["a", "b", "c", "d"], [game([["a", 1, 0], ["b", 2, 0], ["c", 3, 0], ["d", 4, 0]]), game([["a", 4, 0], ["b", 3, 0], ["c", 2, 0], ["d", 1, 0]])]);
  fail(() => T.qualifiersFrom(st, 1), "state", /tied/); // a and d tied for 1st, only one may advance
  assert.deepEqual(T.qualifiersFrom(st, 2).sort(), ["a", "d"]); // a tie fully inside the cut is harmless
  const done = T.applyTieOrders(st, [{ ids: ["d", "a"] }]);
  assert.deepEqual(T.qualifiersFrom(done, 1), ["d"]); assert.deepEqual(done.map(s => s.rank), [1, 2, 3, 3]);
  assert.equal(T.applyTieOrders(st, [{ ids: ["a", "b"] }]).some(s => s.resolved), false); // not a tied group
  assert.equal(T.applyTieOrders(st, [{ ids: ["a"] }]).some(s => s.resolved), false);
  const three = T.computeStandings(["x", "y", "z"], []); // all level
  assert.equal(T.applyTieOrders(three, [{ ids: ["x", "y"] }]).some(s => s.resolved), false); // must name the whole group
  assert.ok(T.applyTieOrders(three, [{ ids: ["z", "x", "y"] }]).every(s => s.resolved));
});

// ---------- points rounds: confirm, advance, correct ----------
const cfg: T.RoundsConfig = { count: 2, gamesPerRound: 2, qualifiers: [2] };
const rows = (order: string[], kills: Record<string, number> = {}) => order.map((id, i) => ({ entryId: id, placement: i + 1, kills: kills[id] || 0 }));
function played() {
  let st = T.newPointsState(cfg, ["a", "b", "c", "d"]);
  st = T.submitPointsGame(st, 1, 1, rows(["a", "b", "c", "d"]), S, "adm", 1);
  st = T.confirmPointsGame(st, 1, 1, "adm", 2);
  st = T.submitPointsGame(st, 1, 2, rows(["b", "a", "d", "c"]), S, "adm", 3);
  return st;
}
test("round advance needs confirmed games; unconfirmed submissions never advance anyone", () => {
  const st = played();
  fail(() => T.applyAdvance(st, 1, cfg), "state", /confirmed/);
  assert.equal(st.rounds[1].entryIds.length, 0);
  const ok = T.confirmPointsGame(st, 1, 2, "adm", 4);
  const adv = T.applyAdvance(ok, 1, cfg);
  assert.equal(adv.rounds[0].status, "ADVANCED"); assert.equal(adv.rounds[1].status, "ACTIVE");
  // a: 12+3 + 9 = 24 ; b: 9 + 12+3 = 24 -> tie for first, but both fit in the top 2 so no tie-break is needed
  assert.deepEqual([...adv.rounds[1].entryIds].sort(), ["a", "b"]); assert.deepEqual(adv.rounds[0].qualifiers.length, 2);
});
test("advancing twice or after advancing is refused; previous round results are preserved", () => {
  const ok = T.confirmPointsGame(played(), 1, 2, "adm", 4), adv = T.applyAdvance(ok, 1, cfg);
  fail(() => T.applyAdvance(adv, 1, cfg), "state", /already advanced/);
  assert.equal(adv.rounds[0].games.length, 2); assert.equal(adv.rounds[0].games[0].status, "CONFIRMED"); assert.equal(adv.rounds[0].games[0].rows.length, 4);
});
test("correction: confirmed games need a reason, go back to unconfirmed, and are blocked after advancing until the round is reopened", () => {
  const ok = T.confirmPointsGame(played(), 1, 2, "adm", 4);
  fail(() => T.submitPointsGame(ok, 1, 2, rows(["a", "b", "c", "d"]), S, "adm", 5), "invalid", /reason/);
  const fixed = T.submitPointsGame(ok, 1, 2, rows(["a", "b", "c", "d"]), S, "adm", 5, { reason: "wrong order" });
  assert.equal(fixed.rounds[0].games[1].status, "SUBMITTED"); assert.equal(fixed.rounds[0].games[1].corrections.length, 1); assert.equal(fixed.rounds[0].games[1].corrections[0].prevPoints.b, 12 + 3);
  fail(() => T.applyAdvance(fixed, 1, cfg), "state", /confirmed/); // the corrected game must be re-confirmed
  const adv = T.applyAdvance(ok, 1, cfg);
  fail(() => T.submitPointsGame(adv, 1, 2, rows(["a", "b", "c", "d"]), S, "adm", 6, { reason: "late fix" }), "state", /already advanced/);
  const re = T.reopenRound(adv, 1);
  assert.equal(re.rounds[0].status, "ACTIVE"); assert.equal(re.rounds[1].status, "PENDING"); assert.deepEqual(re.rounds[1].entryIds, []);
  let fixed2 = T.submitPointsGame(re, 1, 2, rows(["c", "d", "a", "b"]), S, "adm", 7, { reason: "late fix" }); fixed2 = T.confirmPointsGame(fixed2, 1, 2, "adm", 8);
  const again = T.applyAdvance(fixed2, 1, cfg);
  assert.equal(again.rounds[1].entryIds.length, 2); assert.equal(new Set(again.rounds[1].entryIds).size, 2); // re-advance replaces the roster, it never appends
  assert.deepEqual([...again.rounds[1].entryIds].sort(), ["a", "c"]); // recalculated from the corrected results
});
test("cannot reopen a round once the next round has results", () => {
  const adv = T.applyAdvance(T.confirmPointsGame(played(), 1, 2, "adm", 4), 1, cfg);
  const g = T.submitPointsGame(adv, 2, 1, rows(adv.rounds[1].entryIds), S, "adm", 9);
  fail(() => T.reopenRound(g, 1), "state", /next round already has results/);
});
test("level on points but separated by kills or best placement is NOT a tie; nobody is left to chance", () => {
  const c1: T.RoundsConfig = { count: 2, gamesPerRound: 1, qualifiers: [2] };
  const S2: T.Scoring = { placementPoints: [10, 5, 5], killPoints: 0, winBonus: 0 };
  let st = T.newPointsState(c1, ["a", "b", "c"]);
  st = T.confirmPointsGame(T.submitPointsGame(st, 1, 1, rows(["a", "b", "c"]), S2, "adm", 1), 1, 1, "adm", 2);
  const standings = T.roundStandings(st.rounds[0]); // b and c both have 5 points, b placed 2nd and c 3rd, so the best-placement rule orders them
  assert.deepEqual(standings.map(s => [s.entryId, s.tied]), [["a", false], ["b", false], ["c", false]]);
  assert.deepEqual([...T.applyAdvance(st, 1, c1).rounds[1].entryIds].sort(), ["a", "b"]);
});
test("resolveTie only accepts exactly one tied group and lets advancement proceed", () => {
  const c: T.RoundsConfig = { count: 2, gamesPerRound: 1, qualifiers: [2] };
  const S3: T.Scoring = { placementPoints: [5, 5, 5], killPoints: 0, winBonus: 0 };
  // identical performance: everyone scores 5 with placement ... use override to force a perfect dead heat (no placement, equal points, no kills)
  let st = T.newPointsState(c, ["x", "y", "z"]);
  const dead = [{ entryId: "x", pointsOverride: 5 }, { entryId: "y", pointsOverride: 5 }, { entryId: "z", pointsOverride: 5 }];
  st = T.confirmPointsGame(T.submitPointsGame(st, 1, 1, dead, S3, "adm", 1), 1, 1, "adm", 2);
  fail(() => T.applyAdvance(st, 1, c), "state", /tied/);
  fail(() => T.resolveTie(st, 1, ["x", "y"], "adm", 3, "because"), "invalid"); // not the whole group
  const res = T.resolveTie(st, 1, ["y", "z", "x"], "adm", 3, "Admin ruling after replay review");
  fail(() => T.resolveTie(st, 1, ["y", "z", "x"], "adm", 3, ""), "invalid", /reason/);
  const adv = T.applyAdvance(res, 1, c);
  assert.deepEqual([...adv.rounds[1].entryIds].sort(), ["y", "z"]);
  // correcting results invalidates the stored order automatically (it no longer names a current tie group)
  const changed = T.submitPointsGame(T.reopenRound(adv, 1), 1, 1, [{ entryId: "x", pointsOverride: 9 }, { entryId: "y", pointsOverride: 5 }, { entryId: "z", pointsOverride: 5 }], S3, "adm", 4, { reason: "fixed x" });
  const reconf = T.confirmPointsGame(changed, 1, 1, "adm", 5);
  fail(() => T.qualifiersFrom(T.roundStandings(reconf.rounds[0]), 2), "state", /tied/); // y and z are level again for the last place, and the old ruling was about a different group
});
test("finishing: final ranks need confirmed games and no ties inside rewarded places", () => {
  const c: T.RoundsConfig = { count: 1, gamesPerRound: 1, qualifiers: [] };
  let st = T.newPointsState(c, ["a", "b", "c"]);
  fail(() => T.planFinish(st, c, 3), "state", /confirmed/);
  st = T.confirmPointsGame(T.submitPointsGame(st, 1, 1, rows(["b", "a", "c"]), S, "adm", 1), 1, 1, "adm", 2);
  const ranks = T.planFinish(st, c, 3); assert.deepEqual(ranks.map(r => [r.entryId, r.rank]), [["b", 1], ["a", 2], ["c", 3]]);
});
test("finishing: entries eliminated earlier rank below the finalists, later exits first, level entries share a rank", () => {
  const c: T.RoundsConfig = { count: 3, gamesPerRound: 1, qualifiers: [4, 2] };
  const S2: T.Scoring = { placementPoints: [10, 8, 6, 4, 2, 2], killPoints: 0, winBonus: 0 };
  let st = T.newPointsState(c, ["a", "b", "c", "d", "e", "f"]);
  st = T.confirmPointsGame(T.submitPointsGame(st, 1, 1, rows(["a", "b", "c", "d", "e", "f"]), S2, "x", 1), 1, 1, "x", 2); // e and f have 2 each but placements 5 and 6
  st = T.applyAdvance(st, 1, c);
  st = T.confirmPointsGame(T.submitPointsGame(st, 2, 1, rows(["d", "c", "b", "a"]), S2, "x", 3), 2, 1, "x", 4); st = T.applyAdvance(st, 2, c); // d and c reach the final
  st = T.confirmPointsGame(T.submitPointsGame(st, 3, 1, rows(["c", "d"]), S2, "x", 5), 3, 1, "x", 6);
  const r = T.planFinish(st, c, 6);
  assert.deepEqual(r.map(x => [x.entryId, x.rank]), [["c", 1], ["d", 2], ["b", 3], ["a", 4], ["e", 5], ["f", 6]]); // round-2 exits (b, a) outrank round-1 exits (e, f)
  const level = T.planFinish(T.confirmPointsGame(T.submitPointsGame(T.applyAdvance(T.confirmPointsGame(T.submitPointsGame(T.newPointsState({ count: 2, gamesPerRound: 1, qualifiers: [2] }, ["a", "b", "c", "d"]), 1, 1,
    [{ entryId: "a", placement: 1, kills: 0 }, { entryId: "b", placement: 2, kills: 0 }, { entryId: "c", pointsOverride: 3 }, { entryId: "d", pointsOverride: 3 }], S2, "x", 1), 1, 1, "x", 2), 1, { count: 2, gamesPerRound: 1, qualifiers: [2] }), 2, 1, rows(["a", "b"]), S2, "x", 3), 2, 1, "x", 4), { count: 2, gamesPerRound: 1, qualifiers: [2] }, 3);
  assert.deepEqual(level.map(x => x.rank), [1, 2, 3, 3]); // c and d are level: both are joint 3rd
});

// ---------- knockout ----------
const ids = (n: number) => Array.from({ length: n }, (_, i) => "e" + (i + 1));
test("seed order is the standard bracket order", () => { assert.deepEqual(T.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]); assert.deepEqual(T.seedOrder(2), [1, 2]); });
test("bracket size and byes for every field size 2..33", () => {
  for (let n = 2; n <= 33; n++) {
    const b = T.generateBracket(ids(n)), size = b.size;
    assert.ok(size >= n && size / 2 < n, `size for ${n}`);
    const byes = b.rounds[0].filter(m => m.status === "BYE").length;
    assert.equal(byes, size - n, `byes for ${n}`);
    assert.equal(b.rounds.flat().length, size - 1);
    assert.deepEqual(T.bracketProblems(b), [], `problems for ${n}`);
    // every real entry appears exactly once in round 1
    const first = b.rounds[0].flatMap(m => [m.a, m.b]).filter(Boolean); assert.equal(new Set(first).size, n);
    // the top seeds receive the byes
    for (const m of b.rounds[0]) if (m.status === "BYE") assert.ok(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"].includes(m.winner as string) || n > 16);
  }
  const b = T.generateBracket(ids(5)); // 8 slots, 3 byes: e1, e2, e3 skip round 1
  assert.deepEqual(b.rounds[0].filter(m => m.status === "BYE").map(m => m.winner), ["e1", "e2", "e3"]);
  assert.equal(b.rounds[1][0].a, "e1"); assert.equal(b.rounds[1][0].status, "PENDING"); // opponent is the e4-vs-e5 winner
  fail(() => T.generateBracket(["solo"]), "state"); fail(() => T.generateBracket(["a", "a"]), "invalid");
});
test("round names follow the size of the bracket", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(r => T.roundName(r, 5)), ["Round of 32", "Round of 16", "Quarterfinals", "Semifinals", "Final"]);
});
const none = new Set<string>();
test("knockout: a result advances nobody until it is confirmed", () => {
  let b = T.generateBracket(ids(4)); // e1-e4, e2-e3
  b = T.submitMatch(b, "r1m1", { winner: "e1" }, "adm", 1, none);
  assert.equal(b.rounds[1][0].a, null); assert.equal(b.rounds[1][0].status, "PENDING"); assert.deepEqual(T.bracketProblems(b), []);
  b = T.confirmMatch(b, "r1m1", "adm", 2);
  assert.equal(b.rounds[1][0].a, "e1"); assert.equal(b.rounds[1][0].status, "PENDING"); // still waiting for the other semifinal
  b = T.confirmMatch(T.submitMatch(b, "r1m2", { winner: "e3", scoreA: 1, scoreB: 2 }, "adm", 3, none), "r1m2", "adm", 4);
  assert.equal(b.rounds[1][0].status, "READY"); assert.equal(b.rounds[1][0].b, "e3");
  fail(() => T.submitMatch(T.generateBracket(ids(4)), "r2m1", { winner: "e1" }, "adm", 1, none), "state", /waiting/); // can't result a match whose entrants aren't known
  fail(() => T.confirmMatch(T.generateBracket(ids(4)), "r1m1", "adm", 1), "state", /no submitted result/);
});
test("knockout: validation of winners, scores and double confirmation", () => {
  const b0 = T.generateBracket(ids(4));
  fail(() => T.submitMatch(b0, "r1m1", { winner: "e2" }, "adm", 1, none), "invalid", /one of the two/); fail(() => T.submitMatch(b0, "r1m1", { winner: "e1", scoreA: 1, scoreB: 3 }, "adm", 1, none), "invalid", /higher score/);
  fail(() => T.submitMatch(b0, "nope", { winner: "e1" }, "adm", 1, none), "notfound");
  const done = T.confirmMatch(T.submitMatch(b0, "r1m1", { winner: "e1" }, "adm", 1, none), "r1m1", "adm", 2);
  fail(() => T.confirmMatch(done, "r1m1", "adm", 3), "state", /already confirmed/);
  fail(() => T.submitMatch(done, "r1m1", { winner: "e4" }, "adm", 3, none), "invalid", /reason/);
});
test("knockout: full 6-entry bracket with byes plays through to a champion, rewards by rank", () => {
  let b = T.generateBracket(ids(6)); // size 8, byes for e1 and e2
  const play = (id: string, w: string) => { b = T.confirmMatch(T.submitMatch(b, id, { winner: w }, "adm", 1, none), id, "adm", 2); assert.deepEqual(T.bracketProblems(b), []); };
  const r1 = b.rounds[0].filter(m => m.status === "READY"); assert.equal(r1.length, 2);
  for (const m of r1) play(m.id, m.a as string);
  const qf = b.rounds[1].filter(m => m.status === "READY"); assert.equal(qf.length, 2);
  for (const m of qf) play(m.id, m.a as string);
  const fin = b.rounds[2][0]; assert.equal(fin.status, "READY"); play(fin.id, fin.b as string);
  assert.equal(T.bracketChampion(b), fin.b);
  const ranks = T.knockoutRanks(b); assert.equal(ranks[0].rank, 1); assert.equal(ranks[1].rank, 2); assert.equal(ranks.filter(r => r.rank === 3).length, 2); assert.equal(ranks.length, 6);
  const members = new Map(ids(6).map(e => [e, [e + "_p1", e + "_p2"]]));
  const rw = T.rewardsFor(ranks, members, [100, 60, 40]);
  assert.equal(rw.length, 8); assert.equal(rw.filter(r => r.rank === 1).every(r => r.xp === 100), true); assert.equal(rw.filter(r => r.rank === 3).length, 4); // joint third: both teams, both players, 40 XP each
  assert.equal(new Set(rw.map(r => r.uid)).size, rw.length); // nobody is paid twice
});
test("knockout: correction needs a clean downstream, reopen rolls back from the latest match, no double advancement", () => {
  let b = T.generateBracket(ids(4));
  const play = (id: string, w: string) => { b = T.confirmMatch(T.submitMatch(b, id, { winner: w }, "adm", 1, none), id, "adm", 2); };
  play("r1m1", "e1"); play("r1m2", "e2"); // e2 beat e3
  assert.equal(b.rounds[1][0].status, "READY");
  // correct semifinal 2 while the final has no result yet: the final slot is cleared until the new result is confirmed
  b = T.submitMatch(b, "r1m2", { winner: "e3", reason: "wrong winner entered" }, "adm", 5, none);
  assert.equal(b.rounds[1][0].b, null); assert.equal(b.rounds[1][0].status, "PENDING"); assert.deepEqual(T.bracketProblems(b), []);
  b = T.confirmMatch(b, "r1m2", "adm", 6);
  assert.equal(b.rounds[1][0].b, "e3"); assert.equal(b.rounds[0][1].corrections.length, 1); assert.equal(b.rounds[0][1].corrections[0].prevWinner, "e2");
  play("r2m1", "e1");
  // now the final has a result: the semifinal is locked until the final is reopened
  fail(() => T.submitMatch(b, "r1m2", { winner: "e2", reason: "again" }, "adm", 7, none), "state", /Reopen that match first/);
  fail(() => T.reopenMatch(b, "r1m2", "adm", 8, "oops"), "state", /Reopen that match first/);
  b = T.reopenMatch(b, "r2m1", "adm", 9, "final entered wrongly");
  assert.equal(b.rounds[1][0].status, "READY"); assert.equal(T.bracketChampion(b), null);
  b = T.reopenMatch(b, "r1m2", "adm", 10, "replay shows e2 won"); assert.equal(b.rounds[1][0].b, null);
  play("r1m2", "e2"); play("r2m1", "e2");
  assert.equal(T.bracketChampion(b), "e2"); assert.deepEqual(T.bracketProblems(b), []);
  // every entry is in the final at most once
  const fin = b.rounds[1][0]; assert.notEqual(fin.a, fin.b);
});
test("knockout: withdrawals need an explicit walkover that also has to be confirmed; double forfeit voids the match", () => {
  let b = T.generateBracket(ids(4));
  const wd = new Set(["e4"]);
  fail(() => T.submitMatch(b, "r1m1", { winner: "e1" }, "adm", 1, wd), "invalid", /walkover/);
  fail(() => T.submitMatch(b, "r1m1", { winner: "e4", walkover: true }, "adm", 1, wd), "invalid", /withdrawn entry can't win/);
  fail(() => T.submitMatch(b, "r1m2", { winner: "e2", walkover: true }, "adm", 1, wd), "invalid", /needs the opponent/);
  b = T.submitMatch(b, "r1m1", { winner: "e1", walkover: true }, "adm", 1, wd);
  assert.equal(b.rounds[1][0].a, null); // still unconfirmed => not advanced
  b = T.confirmMatch(b, "r1m1", "adm", 2); assert.equal(b.rounds[1][0].a, "e1");
  // both withdrawn in the other semifinal
  const both = new Set(["e2", "e3", "e4"]);
  fail(() => T.submitMatch(b, "r1m2", { forfeitBoth: true }, "adm", 3, new Set(["e2"])), "invalid", /Both entries/);
  b = T.confirmMatch(T.submitMatch(b, "r1m2", { forfeitBoth: true, note: "both left" }, "adm", 3, both), "r1m2", "adm", 4);
  assert.equal(b.rounds[1][0].status, "BYE"); assert.equal(b.rounds[1][0].winner, "e1"); // the other side is dead, e1 walks into the final without an invented opponent
});
test("seeding: registration order is stable; random is deterministic for a stored seed", () => {
  const es = [{ id: "c", at: 3 }, { id: "a", at: 1 }, { id: "b", at: 1 }];
  assert.deepEqual(T.seedEntries(es, "registration"), ["a", "b", "c"]);
  assert.deepEqual(T.seedEntries(es, "random", 42), T.seedEntries(es, "random", 42));
  assert.notDeepEqual(T.seedEntries(ids(20).map((id, at) => ({ id, at })), "random", 1), T.seedEntries(ids(20).map((id, at) => ({ id, at })), "random", 2));
});

// ---------- rewards + deletion helpers ----------
test("rewards: only rewarded ranks, per player, ids are deterministic so a retry cannot pay twice", () => {
  const ranks = [{ entryId: "t1", rank: 1 }, { entryId: "t2", rank: 2 }, { entryId: "t3", rank: 3 }, { entryId: "t4", rank: 4 }];
  const m = new Map([["t1", ["p1", "p2"]], ["t2", ["p3"]], ["t3", ["p4"]], ["t4", ["p5"]]]);
  const rw = T.rewardsFor(ranks, m, [100, 50, 0]);
  assert.deepEqual(rw.map(r => [r.uid, r.xp]), [["p1", 100], ["p2", 100], ["p3", 50]]);
  assert.equal(T.rewardLedgerId("T", "p1"), "tour2_T_p1"); assert.equal(T.rewardLedgerId("T", "p1"), T.rewardLedgerId("T", "p1"));
});
test("tombstones are stable, opaque and recognisable", () => {
  assert.equal(T.tombstone("uid-1"), T.tombstone("uid-1")); assert.notEqual(T.tombstone("uid-1"), T.tombstone("uid-2")); assert.ok(!T.tombstone("uid-1").includes("uid-1")); assert.ok(T.isTombstone(T.tombstone("x"))); assert.ok(!T.isTombstone("abc"));
});
