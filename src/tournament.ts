import crypto from "crypto";

// Pure tournament rules (no I/O, no Firebase) so every rule can be unit-tested.
// Routes in tournaments.ts load/store the state and call these functions inside Firestore transactions.

export type Mode = "solo" | "duo" | "squad";
export type Format = "points" | "knockout";
export type TStatus = "DRAFT" | "PUBLISHED" | "REGISTRATION_OPEN" | "REGISTRATION_CLOSED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export const MODES: Record<Mode, { size: number; label: string }> = { solo: { size: 1, label: "Solo" }, duo: { size: 2, label: "Duo" }, squad: { size: 4, label: "Squad" } };
export const FORMAT_LABEL: Record<Format, string> = { points: "Battle Royale Points", knockout: "Knockout" };
export const STATUS_LABEL: Record<TStatus, string> = { DRAFT: "Draft", PUBLISHED: "Published", REGISTRATION_OPEN: "Registration open", REGISTRATION_CLOSED: "Registration closed", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled" };
export const LIMITS = { nameMin: 3, nameMax: 80, descMax: 1000, rulesMax: 2000, capacityMin: 2, capacityMax: { points: 64, knockout: 128 } as Record<Format, number>, roundsMax: 5, gamesMax: 6,
  pointsMax: 1000, killPointsMax: 100, xpMax: 2000, rewardSlots: 16, placementSlots: 64, killsMax: 60 };

/** Allowed status changes. IN_PROGRESS and COMPLETED are only reachable through start/complete (they have side effects). */
export const TRANSITIONS: Record<TStatus, TStatus[]> = {
  DRAFT: ["PUBLISHED", "CANCELLED"], PUBLISHED: ["REGISTRATION_OPEN", "CANCELLED"], REGISTRATION_OPEN: ["REGISTRATION_CLOSED", "CANCELLED"],
  REGISTRATION_CLOSED: ["REGISTRATION_OPEN", "IN_PROGRESS", "CANCELLED"], IN_PROGRESS: ["COMPLETED", "CANCELLED"], COMPLETED: [], CANCELLED: [],
};
export const canTransition = (from: TStatus, to: TStatus) => (TRANSITIONS[from] || []).includes(to);

/** Business-rule violation. `code` lets the API choose a status (400 bad input, 409 wrong state). */
export class RuleError extends Error { constructor(public code: "invalid" | "state" | "notfound", msg: string) { super(msg); } }
const bad = (m: string) => new RuleError("invalid", m);
const wrong = (m: string) => new RuleError("state", m);

const toInt = (v: any): number | null => {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};
const intIn = (v: any, lo: number, hi: number, name: string) => { const n = toInt(v); if (n === null || n < lo || n > hi) throw bad(`${name} must be a whole number from ${lo} to ${hi}`); return n; };
const text = (v: any, min: number, max: number, name: string) => { if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw bad(`${name} must be ${min}-${max} characters`); return v.trim(); };
const optText = (v: any, max: number, name: string) => { if (v === undefined || v === null || v === "") return ""; if (typeof v !== "string" || v.trim().length > max) throw bad(`${name} must be at most ${max} characters`); return v.trim(); };
const date = (v: any, name: string) => { const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null; if (!d || !Number.isFinite(d.getTime())) throw bad(`${name} must be a valid date and time`); return d; };

// ===================== Tournament definition =====================
export interface Scoring { placementPoints: number[]; killPoints: number; winBonus: number }
export interface RoundsConfig { count: number; gamesPerRound: number; qualifiers: number[] }
export interface TournamentDef {
  name: string; description: string; rules: string; mode: Mode; teamSize: number; format: Format; approval: "auto" | "manual"; capacity: number;
  regOpensAt: Date; regClosesAt: Date; startsAt: Date; scoring: Scoring | null; roundsConfig: RoundsConfig | null; seeding: "registration" | "random"; rewards: { placementXp: number[] };
}

/** Validates and normalises a tournament definition from untrusted input. Throws RuleError(invalid). */
export function parseTournament(b: any, opts: { now?: number; requireFuture?: boolean } = {}): TournamentDef {
  if (!b || typeof b !== "object") throw bad("Send the tournament details as JSON");
  const now = opts.now ?? Date.now();
  const name = text(b.name, LIMITS.nameMin, LIMITS.nameMax, "Name");
  const description = optText(b.description, LIMITS.descMax, "Description"), rules = optText(b.rules, LIMITS.rulesMax, "Rules");
  const mode = b.mode as Mode; if (!MODES[mode]) throw bad("Mode must be solo, duo or squad");
  const format = b.format as Format; if (format !== "points" && format !== "knockout") throw bad("Format must be points or knockout");
  const approval = b.approval === undefined || b.approval === "auto" ? "auto" : b.approval === "manual" ? "manual" : (() => { throw bad("Approval must be auto or manual"); })();
  const capacity = intIn(b.capacity, LIMITS.capacityMin, LIMITS.capacityMax[format], "Capacity");
  const regOpensAt = date(b.regOpensAt, "Registration opening"), regClosesAt = date(b.regClosesAt, "Registration closing"), startsAt = date(b.startsAt, "Start time");
  if (regOpensAt >= regClosesAt) throw bad("Registration must close after it opens");
  if (regClosesAt > startsAt) throw bad("The tournament can't start before registration closes");
  if (opts.requireFuture && startsAt.getTime() <= now) throw bad("The start time must be in the future");
  const seeding = b.seeding === "random" ? "random" : "registration";
  const px = b.rewards?.placementXp ?? [];
  if (!Array.isArray(px) || px.length > LIMITS.rewardSlots) throw bad(`Placement XP can have at most ${LIMITS.rewardSlots} entries`);
  const placementXp = px.map((v: any, i: number) => intIn(v, 0, LIMITS.xpMax, `Placement XP #${i + 1}`));
  let scoring: Scoring | null = null, roundsConfig: RoundsConfig | null = null;
  if (format === "points") {
    const s = b.scoring || {};
    if (!Array.isArray(s.placementPoints) || s.placementPoints.length < 1 || s.placementPoints.length > LIMITS.placementSlots) throw bad(`Placement points need 1-${LIMITS.placementSlots} numbers`);
    scoring = { placementPoints: s.placementPoints.map((v: any, i: number) => intIn(v, 0, LIMITS.pointsMax, `Placement points #${i + 1}`)),
      killPoints: intIn(s.killPoints ?? 0, 0, LIMITS.killPointsMax, "Points per kill"), winBonus: intIn(s.winBonus ?? 0, 0, LIMITS.pointsMax, "Win bonus") };
    const r = b.roundsConfig || {};
    const count = intIn(r.count ?? 1, 1, LIMITS.roundsMax, "Number of rounds"), gamesPerRound = intIn(r.gamesPerRound ?? 1, 1, LIMITS.gamesMax, "Games per round");
    const q = r.qualifiers ?? [];
    if (!Array.isArray(q) || q.length !== count - 1) throw bad(`Give exactly ${count - 1} qualifier number(s), one for each round except the last`);
    const qualifiers = q.map((v: any, i: number) => intIn(v, 2, capacity, `Qualifiers after round ${i + 1}`));
    qualifiers.forEach((v: number, i: number) => { const prev = i === 0 ? capacity : qualifiers[i - 1]; if (v >= prev) throw bad(`Qualifiers after round ${i + 1} must be fewer than the ${i === 0 ? "capacity" : "previous round"} (${prev})`); });
    roundsConfig = { count, gamesPerRound, qualifiers };
  }
  return { name, description, rules, mode, teamSize: MODES[mode].size, format, approval, capacity, regOpensAt, regClosesAt, startsAt, scoring, roundsConfig, seeding, rewards: { placementXp } };
}

/** What may change after creation. Returns an error message, or null when the edit is allowed. */
export function editBlocker(old: { status: TStatus; mode: Mode; format: Format; capacity: number; entryCount: number; hasEntries: boolean; scoring: any; roundsConfig: any; rewards: any; approval: string; seeding: string },
  next: TournamentDef): string | null {
  if (old.status === "COMPLETED" || old.status === "CANCELLED") return "A finished or cancelled tournament can't be edited";
  if (old.hasEntries && (next.mode !== old.mode || next.format !== old.format)) return "Mode and format can't change once players have registered";
  if (next.capacity < old.entryCount) return `Capacity can't be lower than the ${old.entryCount} current entries`;
  if (old.status === "IN_PROGRESS" || old.status === "REGISTRATION_CLOSED") {
    const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(old.scoring, next.scoring) || !same(old.roundsConfig, next.roundsConfig) || next.capacity !== old.capacity || next.approval !== old.approval || next.seeding !== old.seeding)
      return "Scoring, rounds, capacity, approval and seeding are locked once registration has closed";
    if (old.status === "IN_PROGRESS" && !same(old.rewards, next.rewards)) return "Rewards are locked once the tournament has started";
  }
  return null;
}

// ===================== Points format =====================
export interface GameRow { entryId: string; placement: number | null; kills: number; noShow: boolean; pointsOverride: number | null; points: number }

/** Points for one row. Placement points + kills * killPoints + win bonus, unless an admin typed total points directly. */
export function rowPoints(s: Scoring, r: { placement: number | null; kills: number; noShow?: boolean; pointsOverride?: number | null }): number {
  if (r.noShow) return 0;
  if (r.pointsOverride !== null && r.pointsOverride !== undefined) return r.pointsOverride;
  const p = r.placement as number;
  return (s.placementPoints[p - 1] ?? 0) + r.kills * s.killPoints + (p === 1 ? s.winBonus : 0);
}

/** Validates admin-entered rows for ONE game against the round's participants and computes the points. */
export function scoreGame(raw: any, participants: string[], s: Scoring): GameRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad("Enter a result row for every participant");
  const part = new Set(participants), seen = new Set<string>(), placements = new Set<number>(), out: GameRow[] = [];
  const active = raw.filter((r: any) => r && r.noShow !== true).length;
  for (const r of raw) {
    if (!r || typeof r !== "object" || typeof r.entryId !== "string") throw bad("Each row needs an entry");
    if (!part.has(r.entryId)) throw bad("A row refers to an entry that isn't in this round");
    if (seen.has(r.entryId)) throw bad("An entry appears twice");
    seen.add(r.entryId);
    const noShow = r.noShow === true;
    let placement: number | null = null, kills = 0, override: number | null = null;
    if (!noShow) {
      const hasOverride = r.pointsOverride !== undefined && r.pointsOverride !== null && r.pointsOverride !== "";
      if (hasOverride) override = intIn(r.pointsOverride, 0, 10000, "Total points");
      const hasPlacement = r.placement !== undefined && r.placement !== null && r.placement !== "";
      if (hasPlacement || !hasOverride) {
        placement = intIn(r.placement, 1, Math.max(1, active), "Placement");
        if (placements.has(placement)) throw bad(`Placement ${placement} is used twice`);
        placements.add(placement);
      }
      kills = intIn(r.kills ?? 0, 0, LIMITS.killsMax, "Kills");
    }
    out.push({ entryId: r.entryId, placement, kills, noShow, pointsOverride: override, points: rowPoints(s, { placement, kills, noShow, pointsOverride: override }) });
  }
  if (seen.size !== part.size) throw bad(`Every participant needs a row (${seen.size} of ${part.size} entered). Use "no show" for absent entries`);
  return out;
}

export interface Standing { entryId: string; points: number; kills: number; wins: number; best: number | null; played: number; perGame: number[]; rank: number; tied: boolean; resolved?: boolean }
export interface ConfirmedGame { rows: GameRow[] }

/** Deterministic standings: points desc, kills desc, best single-game placement (lower is better). Anything still level is flagged `tied`. */
export function computeStandings(entryIds: string[], games: ConfirmedGame[]): Standing[] {
  const base = new Map<string, Standing>(entryIds.map(id => [id, { entryId: id, points: 0, kills: 0, wins: 0, best: null, played: 0, perGame: [], rank: 0, tied: false }]));
  for (const g of games) for (const r of g.rows) {
    const s = base.get(r.entryId); if (!s) continue;
    s.points += r.points; s.kills += r.kills; s.played += r.noShow ? 0 : 1; s.perGame.push(r.points);
    if (r.placement === 1) s.wins++;
    if (r.placement !== null && (s.best === null || r.placement < s.best)) s.best = r.placement;
  }
  const key = (s: Standing) => [-s.points, -s.kills, s.best ?? 1e9];
  const list = [...base.values()].sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  let i = 0;
  while (i < list.length) {
    let j = i; const k = key(list[i]).join();
    while (j + 1 < list.length && key(list[j + 1]).join() === k) j++;
    // Level entries are ordered by id ONLY so the list is stable to display; the `tied` flag still blocks decisions that depend on the order.
    const group = list.slice(i, j + 1).sort((a, b) => a.entryId.localeCompare(b.entryId));
    group.forEach((s, n) => { list[i + n] = s; s.rank = i + 1; s.tied = group.length > 1; });
    i = j + 1;
  }
  return list;
}

export interface TieOrder { ids: string[] }
/** Applies admin tie resolutions. An order only counts if it names exactly one currently-tied group. Stale orders are ignored. */
export function applyTieOrders(standings: Standing[], orders: TieOrder[]): Standing[] {
  const out = standings.map(s => ({ ...s }));
  for (const o of orders || []) {
    const ids = new Set(o.ids);
    if (ids.size !== o.ids.length || ids.size < 2) continue;
    const idx = out.map((s, i) => (ids.has(s.entryId) ? i : -1)).filter(i => i >= 0);
    if (idx.length !== ids.size) continue;
    const members = idx.map(i => out[i]);
    if (!members.every(m => m.tied && !m.resolved && m.rank === members[0].rank)) continue;
    if (out.filter(x => x.tied && !x.resolved && x.rank === members[0].rank).length !== ids.size) continue; // must name the whole group, not part of it
    const start = idx[0];
    if (idx.some((v, n) => v !== start + n)) continue;
    o.ids.forEach((id, n) => { const m = out[start + n] = { ...members.find(x => x.entryId === id)! }; m.rank = start + n + 1; m.tied = false; m.resolved = true; });
  }
  return out;
}

/** Tie groups that make a decision ambiguous: any group of 2+ whose first position is inside the first `positions` places and which is not resolved. */
export function blockingTies(standings: Standing[], positions: number): Standing[][] {
  const groups = new Map<number, Standing[]>();
  for (const s of standings) if (s.tied && !s.resolved) { if (!groups.has(s.rank)) groups.set(s.rank, []); groups.get(s.rank)!.push(s); }
  return [...groups.values()].filter(g => g.length > 1 && g[0].rank <= positions);
}

/** Round qualifiers. Throws if a tie straddles the cutoff, so nobody is advanced arbitrarily. */
export function qualifiersFrom(standings: Standing[], count: number): string[] {
  const ties = blockingTies(standings, count).filter(g => g[0].rank - 1 + g.length > count);
  if (ties.length) throw wrong("Players are tied at the qualification cutoff. Resolve the tie first.");
  return standings.slice(0, count).map(s => s.entryId);
}

// ---- Points state (stored in arenaTournaments/{id}/state/main) ----
export interface PGame { n: number; status: "EMPTY" | "SUBMITTED" | "CONFIRMED"; rows: GameRow[]; note: string; shotId: string | null; submittedBy: string | null; submittedAt: number | null; confirmedBy: string | null; confirmedAt: number | null; version: number;
  corrections: { by: string; at: number; reason: string; prevPoints: Record<string, number> }[] }
export interface PRound { number: number; status: "PENDING" | "ACTIVE" | "ADVANCED"; entryIds: string[]; games: PGame[]; tieOrders: { ids: string[]; by: string; at: number; reason: string }[]; qualifiers: string[] }
export interface PointsState { format: "points"; rounds: PRound[] }

const blankGame = (n: number): PGame => ({ n, status: "EMPTY", rows: [], note: "", shotId: null, submittedBy: null, submittedAt: null, confirmedBy: null, confirmedAt: null, version: 0, corrections: [] });
export function newPointsState(cfg: RoundsConfig, entryIds: string[]): PointsState {
  return { format: "points", rounds: Array.from({ length: cfg.count }, (_, i) => ({ number: i + 1, status: i === 0 ? "ACTIVE" : "PENDING", entryIds: i === 0 ? [...entryIds] : [],
    games: Array.from({ length: cfg.gamesPerRound }, (_, g) => blankGame(g + 1)), tieOrders: [], qualifiers: [] } as PRound)) };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const roundOf = (st: PointsState, n: number) => { const r = st.rounds[n - 1]; if (!r) throw new RuleError("notfound", "Round not found"); return r; };
const gameOf = (r: PRound, g: number) => { const x = r.games[g - 1]; if (!x) throw new RuleError("notfound", "Game not found"); return x; };

export function submitPointsGame(st: PointsState, n: number, g: number, rowsIn: any, s: Scoring, actor: string, now: number, opts: { note?: string; reason?: string; shotId?: string | null } = {}): PointsState {
  const out = clone(st), r = roundOf(out, n), game = gameOf(r, g);
  if (r.status !== "ACTIVE") throw wrong(r.status === "ADVANCED" ? "This round has already advanced. Reopen it before changing results." : "This round isn't active yet");
  const rows = scoreGame(rowsIn, r.entryIds, s);
  if (game.status === "CONFIRMED") {
    const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
    if (reason.length < 3) throw bad("A reason is required to correct a confirmed result");
    game.corrections.push({ by: actor, at: now, reason, prevPoints: Object.fromEntries(game.rows.map(x => [x.entryId, x.points])) });
  }
  Object.assign(game, { status: "SUBMITTED", rows, note: (opts.note || "").slice(0, 300), shotId: opts.shotId ?? game.shotId, submittedBy: actor, submittedAt: now, confirmedBy: null, confirmedAt: null, version: game.version + 1 });
  return out;
}
export function confirmPointsGame(st: PointsState, n: number, g: number, actor: string, now: number): PointsState {
  const out = clone(st), r = roundOf(out, n), game = gameOf(r, g);
  if (r.status !== "ACTIVE") throw wrong("This round isn't active");
  if (game.status !== "SUBMITTED") throw wrong(game.status === "CONFIRMED" ? "This game is already confirmed" : "There is no submitted result to confirm");
  game.status = "CONFIRMED"; game.confirmedBy = actor; game.confirmedAt = now;
  return out;
}
export const confirmedGames = (r: PRound): ConfirmedGame[] => r.games.filter(x => x.status === "CONFIRMED");
export const roundStandings = (r: PRound) => applyTieOrders(computeStandings(r.entryIds, confirmedGames(r)), r.tieOrders);

export function resolveTie(st: PointsState, n: number, ids: string[], by: string, now: number, reason: string): PointsState {
  const out = clone(st), r = roundOf(out, n);
  if (r.status !== "ACTIVE") throw wrong("Ties can only be resolved while the round is active");
  if (r.games.some(x => x.status !== "CONFIRMED")) throw wrong("Confirm all games before resolving ties");
  if (reason.trim().length < 3) throw bad("A reason is required to resolve a tie");
  const before = computeStandings(r.entryIds, confirmedGames(r));
  const test = applyTieOrders(before, [{ ids }]);
  if (!test.some(s => s.resolved)) throw bad("That list isn't exactly one group of tied entries");
  r.tieOrders = [...r.tieOrders.filter(o => !o.ids.some(id => ids.includes(id))), { ids, by, at: now, reason: reason.trim() }];
  return out;
}

export interface AdvancePlan { standings: Standing[]; qualifiers: string[]; isLast: boolean }
/** Pure check + plan for advancing round n. Throws if anything required is missing. */
export function planAdvance(st: PointsState, n: number, cfg: RoundsConfig, openDisputes = 0): AdvancePlan {
  const r = roundOf(st, n);
  if (r.status !== "ACTIVE") throw wrong(r.status === "ADVANCED" ? "This round has already advanced" : "This round isn't active");
  if (n >= cfg.count) throw wrong("This is the final round. Complete the tournament instead");
  if (r.games.some(g => g.status !== "CONFIRMED")) throw wrong("Every game in the round must be confirmed first");
  if (openDisputes > 0) throw wrong("Resolve the open dispute for this round first");
  const standings = roundStandings(r);
  return { standings, qualifiers: qualifiersFrom(standings, cfg.qualifiers[n - 1]), isLast: false };
}
export function applyAdvance(st: PointsState, n: number, cfg: RoundsConfig, openDisputes = 0): PointsState {
  const plan = planAdvance(st, n, cfg, openDisputes), out = clone(st), r = roundOf(out, n), next = roundOf(out, n + 1);
  r.status = "ADVANCED"; r.qualifiers = plan.qualifiers;
  next.status = "ACTIVE"; next.entryIds = [...plan.qualifiers]; next.games = next.games.map(g => blankGame(g.n)); next.tieOrders = []; next.qualifiers = [];
  return out;
}
/** Undo an advance so a confirmed result can be corrected. Only allowed while the next round has no results. */
export function reopenRound(st: PointsState, n: number): PointsState {
  const out = clone(st), r = roundOf(out, n), next = out.rounds[n];
  if (r.status !== "ADVANCED") throw wrong("Only an advanced round can be reopened");
  if (next && next.games.some(g => g.status !== "EMPTY")) throw wrong("The next round already has results. Remove or correct those first");
  r.status = "ACTIVE"; r.qualifiers = [];
  if (next) { next.status = "PENDING"; next.entryIds = []; next.tieOrders = []; }
  return out;
}

export interface FinalRank { entryId: string; rank: number; points?: number }
/** Final standings of the last round. Ties inside the rewarded places must be resolved so nobody is ranked arbitrarily. */
export function planFinish(st: PointsState, cfg: RoundsConfig, rewardSlots: number): FinalRank[] {
  const r = roundOf(st, cfg.count);
  if (r.status !== "ACTIVE") throw wrong("The final round isn't active");
  if (r.games.some(g => g.status !== "CONFIRMED")) throw wrong("Every game in the final round must be confirmed first");
  const standings = roundStandings(r);
  if (blockingTies(standings, Math.max(1, rewardSlots)).length) throw wrong("Players are tied inside the rewarded places. Resolve the tie first.");
  const out: FinalRank[] = standings.map(s => ({ entryId: s.entryId, rank: s.rank, points: s.points }));
  // Entries knocked out earlier rank below the finalists: later exits first, then by their standing in the round they left.
  // Entries still level on points/kills/best placement there share a rank (and the XP of that rank). Nobody is picked arbitrarily.
  for (let n = cfg.count - 1; n >= 1; n--) {
    const rd = roundOf(st, n), q = rd.qualifiers.length, base = out.length;
    for (const s of roundStandings(rd)) if (!rd.qualifiers.includes(s.entryId)) out.push({ entryId: s.entryId, rank: base + (s.rank - q), points: s.points });
  }
  return out;
}

// ===================== Knockout format =====================
export interface KMatch { id: string; round: number; index: number; a: string | null; b: string | null; deadA: boolean; deadB: boolean;
  status: "PENDING" | "READY" | "SUBMITTED" | "CONFIRMED" | "BYE" | "VOID"; winner: string | null; scoreA: number | null; scoreB: number | null; walkover: boolean; forfeitBoth: boolean; note: string;
  shotId: string | null; submittedBy: string | null; submittedAt: number | null; confirmedBy: string | null; confirmedAt: number | null; version: number;
  corrections: { by: string; at: number; reason: string; prevWinner: string | null }[] }
export interface Bracket { format: "knockout"; size: number; seeds: string[]; rounds: KMatch[][] }

export function seedOrder(size: number): number[] { let o = [1]; while (o.length < size) { const n = o.length * 2; o = o.flatMap(s => [s, n + 1 - s]); } return o; }
const nextPow2 = (n: number) => { let s = 2; while (s < n) s *= 2; return s; };
export const roundName = (round: number, total: number) => { const left = total - round; return left === 0 ? "Final" : left === 1 ? "Semifinals" : left === 2 ? "Quarterfinals" : `Round of ${2 ** (left + 1)}`; };

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Seed order: registration order (oldest first, id as tie-break), or a deterministic shuffle from a stored seed value so it can be re-verified. */
export function seedEntries(entries: { id: string; at: number }[], mode: "registration" | "random", seedValue = 0): string[] {
  const list = [...entries].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id)).map(e => e.id);
  if (mode === "random") { const rnd = mulberry32(seedValue); for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  return list;
}

const blankMatch = (round: number, index: number): KMatch => ({ id: `r${round}m${index + 1}`, round, index, a: null, b: null, deadA: false, deadB: false, status: "PENDING", winner: null, scoreA: null, scoreB: null, walkover: false, forfeitBoth: false, note: "",
  shotId: null, submittedBy: null, submittedAt: null, confirmedBy: null, confirmedAt: null, version: 0, corrections: [] });

/** Builds the full bracket. With a non-power-of-two field the top seeds get byes (their first-round opponent slot is empty). */
export function generateBracket(seeded: string[]): Bracket {
  const n = seeded.length; if (n < 2) throw wrong("At least two entries are needed to build a bracket");
  if (new Set(seeded).size !== n) throw bad("An entry appears twice");
  const size = nextPow2(n), order = seedOrder(size), total = Math.log2(size), rounds: KMatch[][] = [];
  const r1: KMatch[] = [];
  for (let i = 0; i < size / 2; i++) { const m = blankMatch(1, i), sa = order[2 * i], sb = order[2 * i + 1]; m.a = sa <= n ? seeded[sa - 1] : null; m.b = sb <= n ? seeded[sb - 1] : null; m.deadA = m.a === null; m.deadB = m.b === null; r1.push(m); }
  rounds.push(r1);
  for (let r = 2; r <= total; r++) rounds.push(Array.from({ length: size / 2 ** r }, (_, i) => blankMatch(r, i)));
  const b: Bracket = { format: "knockout", size, seeds: [...seeded], rounds };
  propagate(b);
  return b;
}

/** Recomputes every derived slot and structural status (bye/void/ready/pending) from the recorded results. Idempotent. */
export function propagate(b: Bracket): Bracket {
  for (const round of b.rounds) for (const m of round) {
    if (m.round > 1) for (const slot of ["a", "b"] as const) {
      const f = b.rounds[m.round - 2][2 * m.index + (slot === "a" ? 0 : 1)];
      const resolved = f.status === "CONFIRMED" || f.status === "BYE" || f.status === "VOID";
      const entry = resolved ? f.winner : null;
      if (slot === "a") { m.a = entry; m.deadA = resolved && entry === null; } else { m.b = entry; m.deadB = resolved && entry === null; }
    }
    if (m.status === "SUBMITTED" || m.status === "CONFIRMED") continue; // recorded results are kept as they are
    const A = m.a !== null, B = m.b !== null;
    if (m.deadA && m.deadB) { m.status = "VOID"; m.winner = null; }
    else if (m.deadA && B) { m.status = "BYE"; m.winner = m.b; }
    else if (m.deadB && A) { m.status = "BYE"; m.winner = m.a; }
    else if (A && B) { m.status = "READY"; m.winner = null; }
    else { m.status = "PENDING"; m.winner = null; }
  }
  return b;
}

const find = (b: Bracket, id: string) => { for (const r of b.rounds) for (const m of r) if (m.id === id) return m; throw new RuleError("notfound", "Match not found"); };
export const nextMatchOf = (b: Bracket, m: KMatch): KMatch | null => (m.round >= b.rounds.length ? null : b.rounds[m.round][Math.floor(m.index / 2)]);
const downstreamLocked = (b: Bracket, m: KMatch) => { const n = nextMatchOf(b, m); return !!n && (n.status === "SUBMITTED" || n.status === "CONFIRMED"); };

export interface MatchInput { winner?: string | null; scoreA?: any; scoreB?: any; walkover?: boolean; forfeitBoth?: boolean; note?: string; reason?: string; shotId?: string | null }
export function submitMatch(b0: Bracket, id: string, inp: MatchInput, actor: string, now: number, withdrawn: Set<string>): Bracket {
  const b = clone(b0), m = find(b, id);
  const correcting = m.status === "CONFIRMED";
  if (!(m.status === "READY" || m.status === "SUBMITTED" || correcting)) throw wrong(m.status === "PENDING" ? "This match isn't ready: it is waiting for earlier matches" : "This match has no contest to record");
  if (correcting) {
    if (downstreamLocked(b, m)) throw wrong("A later match already has a result. Reopen that match first, then correct this one");
    if (typeof inp.reason !== "string" || inp.reason.trim().length < 3) throw bad("A reason is required to correct a confirmed result");
  }
  const A = m.a as string, B = m.b as string;
  let winner: string | null = null;
  if (inp.forfeitBoth) {
    if (!withdrawn.has(A) || !withdrawn.has(B)) throw bad("Both entries must have withdrawn to void a match");
  } else {
    if (typeof inp.winner !== "string" || (inp.winner !== A && inp.winner !== B)) throw bad("The winner must be one of the two entries in this match");
    winner = inp.winner;
    if (withdrawn.has(winner)) throw bad("A withdrawn entry can't win a match");
    const other = winner === A ? B : A;
    if (withdrawn.has(other) && !inp.walkover) throw bad("The opponent withdrew. Record this as a walkover");
    if (inp.walkover && !withdrawn.has(other)) throw bad("A walkover needs the opponent to have withdrawn");
  }
  const sc = (v: any, nm: string) => (v === undefined || v === null || v === "" ? null : intIn(v, 0, 999, nm));
  const scoreA = sc(inp.scoreA, "Score A"), scoreB = sc(inp.scoreB, "Score B");
  if (winner && scoreA !== null && scoreB !== null) { const ws = winner === A ? scoreA : scoreB, ls = winner === A ? scoreB : scoreA; if (ws <= ls) throw bad("The winner must have the higher score"); }
  if (correcting) m.corrections.push({ by: actor, at: now, reason: (inp.reason as string).trim(), prevWinner: m.winner });
  Object.assign(m, { status: "SUBMITTED", winner, scoreA, scoreB, walkover: !!inp.walkover, forfeitBoth: !!inp.forfeitBoth, note: (inp.note || "").slice(0, 300), shotId: inp.shotId ?? m.shotId,
    submittedBy: actor, submittedAt: now, confirmedBy: null, confirmedAt: null, version: m.version + 1 });
  return propagate(b);
}
export function confirmMatch(b0: Bracket, id: string, actor: string, now: number): Bracket {
  const b = clone(b0), m = find(b, id);
  if (m.status !== "SUBMITTED") throw wrong(m.status === "CONFIRMED" ? "This match is already confirmed" : "There is no submitted result to confirm");
  m.status = "CONFIRMED"; m.confirmedBy = actor; m.confirmedAt = now;
  return propagate(b);
}
/** Takes a submitted/confirmed result back so it can be re-entered. Always rolls back from the latest match, so nothing downstream is left inconsistent. */
export function reopenMatch(b0: Bracket, id: string, actor: string, now: number, reason: string): Bracket {
  const b = clone(b0), m = find(b, id);
  if (m.status !== "SUBMITTED" && m.status !== "CONFIRMED") throw wrong("Only a submitted or confirmed result can be reopened");
  if (downstreamLocked(b, m)) throw wrong("A later match already has a result. Reopen that match first");
  if (reason.trim().length < 3) throw bad("A reason is required to reopen a result");
  m.corrections.push({ by: actor, at: now, reason: reason.trim(), prevWinner: m.winner });
  Object.assign(m, { status: "PENDING", winner: null, scoreA: null, scoreB: null, walkover: false, forfeitBoth: false, submittedBy: null, submittedAt: null, confirmedBy: null, confirmedAt: null, version: m.version + 1 });
  return propagate(b);
}

export const bracketChampion = (b: Bracket): string | null => { const f = b.rounds[b.rounds.length - 1][0]; return f.status === "CONFIRMED" ? f.winner : null; };
/** Final ranks: champion 1, finalist 2, semifinal losers joint 3, quarterfinal losers joint 5, and so on. */
export function knockoutRanks(b: Bracket): FinalRank[] {
  const champ = bracketChampion(b); if (!champ) throw wrong("The final hasn't been confirmed yet");
  const T = b.rounds.length, out = new Map<string, number>([[champ, 1]]);
  for (const round of b.rounds) for (const m of round) {
    if (m.status !== "CONFIRMED" || !m.winner) continue;
    const loser = m.winner === m.a ? m.b : m.a; if (loser) out.set(loser, 2 ** (T - m.round) + 1);
  }
  return [...out].map(([entryId, rank]) => ({ entryId, rank })).sort((x, y) => x.rank - y.rank || x.entryId.localeCompare(y.entryId));
}
/** Structural sanity checks used by the tests (and cheap to run before saving): nobody advances twice, every winner played in the match. */
export function bracketProblems(b: Bracket): string[] {
  const out: string[] = [];
  b.rounds.forEach((round, ri) => {
    const seen = new Set<string>();
    for (const m of round) for (const e of [m.a, m.b]) if (e) { if (seen.has(e)) out.push(`${e} appears twice in round ${ri + 1}`); seen.add(e); }
    for (const m of round) {
      if ((m.status === "CONFIRMED" || m.status === "BYE") && m.winner && m.winner !== m.a && m.winner !== m.b) out.push(`${m.id}: winner is not a participant`);
      const n = nextMatchOf(b, m);
      if (n && (m.status === "CONFIRMED" || m.status === "BYE") && m.winner) { const slot = m.index % 2 === 0 ? n.a : n.b; if (slot !== m.winner) out.push(`${m.id}: winner was not placed in ${n.id}`); }
      if (n && !(m.status === "CONFIRMED" || m.status === "BYE" || m.status === "VOID")) { const slot = m.index % 2 === 0 ? n.a : n.b; if (slot) out.push(`${m.id}: ${n.id} was filled before this match was confirmed`); }
    }
  });
  return out;
}

// ===================== Rewards =====================
export interface Reward { uid: string; entryId: string; rank: number; xp: number }
/** XP per player for every member of a ranked entry. Joint ranks share the XP of that rank. Zero rewards are dropped. */
export function rewardsFor(ranks: FinalRank[], members: Map<string, string[]>, placementXp: number[]): Reward[] {
  const out: Reward[] = [];
  for (const r of ranks) { const xp = placementXp[r.rank - 1] ?? 0; if (xp > 0) for (const uid of members.get(r.entryId) || []) out.push({ uid, entryId: r.entryId, rank: r.rank, xp }); }
  return out;
}
/** Deterministic id used for the XP ledger entry, so a retry can never pay the same player twice. */
export const rewardLedgerId = (tid: string, uid: string) => `tour2_${tid}_${uid}`;

// ===================== Account deletion helpers =====================
/** Stable, non-reversible stand-in written into retained historical records in place of a deleted player's uid. */
export const tombstone = (uid: string) => "deleted:" + crypto.createHash("sha256").update("ffarena-tomb:" + uid).digest("hex").slice(0, 12);
export const isTombstone = (v: any) => typeof v === "string" && v.startsWith("deleted:");
