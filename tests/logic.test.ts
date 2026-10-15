import test from "node:test";
import assert from "node:assert/strict";
import { applyXp, elo, initialXp, istDate, istWeekStart, kd, nextStreak, rankFromXp, validStats } from "../src/logic";

test("XP never falls below zero", () => { assert.deepEqual(applyXp(5, -30), { newBalance: 0, applied: -5 }); });
test("elo: equal ratings, win/draw", () => {
  assert.deepEqual(elo(1000, 1000, 1), { a: 1016, b: 984 });
  assert.deepEqual(elo(1000, 1000, 0.5), { a: 1000, b: 1000 });
});
test("rank thresholds", () => {
  assert.equal(rankFromXp(0).rank, "Aura −"); assert.equal(rankFromXp(500).rank, "Bronze");
  assert.equal(rankFromXp(5000).rank, "Aura +"); assert.equal(rankFromXp(99999).rank, "Heroic");
  assert.equal(rankFromXp(0).stars, 1);
  assert.equal(rankFromXp(499).stars, 5);
  assert.equal(rankFromXp(500).stars, 1);
});
test("K/D handles zero deaths", () => { assert.equal(kd(10, 0), 10); assert.equal(kd(10, 4), 2.5); });
test("IST date and week boundary", () => {
  assert.equal(istDate(new Date("2026-10-14T18:29:00Z")), "2026-10-14");
  assert.equal(istDate(new Date("2026-10-14T18:30:00Z")), "2026-10-15");
  assert.equal(istWeekStart(new Date("2026-10-18T18:29:00Z")), "2026-10-12");
  assert.equal(istWeekStart(new Date("2026-10-18T18:30:00Z")), "2026-10-19");
});
test("login streak", () => {
  assert.equal(nextStreak("2026-10-14", "2026-10-14", 3), 3);
  assert.equal(nextStreak("2026-10-13", "2026-10-14", 3), 4);
  assert.equal(nextStreak("2026-10-11", "2026-10-14", 3), 1);
});
test("impossible stats rejected", () => {
  assert.ok(validStats({ matches: 10, wins: 11, kills: 5, deaths: 5, hs: 20 }));
  assert.ok(validStats({ matches: 0, wins: 0, kills: 5, deaths: 0, hs: 0 }));
  assert.ok(validStats({ matches: 10, wins: 5, kills: 5, deaths: 5, hs: 120 }));
  assert.equal(validStats({ matches: 100, wins: 40, kills: 300, deaths: 200, hs: 30 }), null);
});
test("initial XP is capped", () => {
  const m = { matches: 100, wins: 40, kills: 300, deaths: 200, hs: 30 };
  assert.ok(initialXp([{ ...m, kills: 6000, deaths: 1 }, m]) <= 3000);
});

import { badges } from "../src/logic";
test("badges", () => { assert.deepEqual(badges({ wins: 10, matches: 12, bestStreak: 3, xp: 100 }), ["First Win", "10 Wins", "3-Win Streak"]); assert.deepEqual(badges({ wins: 0, matches: 0, xp: 0 }), []); });

import { levelFromXp } from "../src/logic";
test("levels", () => { assert.equal(levelFromXp(0), 1); assert.equal(levelFromXp(100), 2); assert.equal(levelFromXp(400), 3); });

import { rankProgress, detectImage, matches, AVATAR_MAX_BYTES, RANK_META, RANKS } from "../src/logic";
test("every rank has presentation metadata and tiers ascend", () => {
  RANKS.forEach((r, i) => { assert.ok(RANK_META[r], r); assert.equal(RANK_META[r].tier, i); });
});
test("rank progress toward the next rank", () => {
  const p = rankProgress(850); // between Bronze (500) and Silver (1200)
  assert.equal(p.rank, "Bronze"); assert.equal(p.nextRank, "Silver"); assert.equal(p.nextAt, 1200); assert.equal(p.xpToNext, 350); assert.equal(p.pct, 50);
  const top = rankProgress(99999); assert.equal(top.rank, "Heroic"); assert.equal(top.nextRank, null); assert.equal(top.pct, 100);
  assert.equal(rankProgress(0).rank, "Aura −");
});
test("avatar images are recognised by magic bytes only", () => {
  const pad = (a: number[]) => Buffer.from([...a, ...new Array(20).fill(0)]);
  assert.equal(detectImage(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectImage(Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(detectImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(detectImage(Buffer.from("GIF89a" + "x".repeat(20))), null);
  assert.ok(AVATAR_MAX_BYTES <= 200 * 1024);
});
test("search matching is case-insensitive and null-safe", () => {
  assert.ok(matches("sha", "Shadow", null)); assert.ok(matches("", "x")); assert.ok(matches("0001", undefined, "FFA-0001")); assert.ok(!matches("zzz", "Shadow", "FFA-0001"));
});
