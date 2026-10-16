// Pure business rules (no I/O) so they are easy to test.
export const RANKS = ["Aura −", "Bronze", "Silver", "Gold", "Platinum", "Aura +", "Diamond", "Heroic"];
export const THRESHOLDS = [0, 500, 1200, 2200, 3500, 5000, 7000, 10000];
export const CFG = { k: 32, winXp: 25, drawXp: 10, lossXp: 5, loginXp: 5, weeklyTarget: 5, startRating: 1000, teamMax: 5,
  weights: { kd: 60, hs: 3, kpm: 20, wr: 2 } };

/** Rank + stars (1–5 visible stars within each rank) derived from cumulative XP. */
export function rankFromXp(xp: number) {
  let i = 0;
  THRESHOLDS.forEach((v, k) => { if (xp >= v) i = k; });
  const next = THRESHOLDS[i + 1];
  const stars = next === undefined ? 5 : Math.min(5, Math.floor((xp - THRESHOLDS[i]) / ((next - THRESHOLDS[i]) / 5)) + 1);
  return { rank: RANKS[i], stars };
}

/** XP can never go below zero; deductions are capped at the balance. */
export function applyXp(balance: number, amount: number) {
  const newBalance = Math.max(0, balance + amount);
  return { newBalance, applied: newBalance - balance };
}

/** Elo: R' = R + K(S - E). sa = 1 win, 0.5 draw, 0 loss for player A. */
export function elo(ra: number, rb: number, sa: number, k = CFG.k) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return { a: Math.round(ra + k * (sa - ea)), b: Math.round(rb + k * ((1 - sa) - (1 - ea))) };
}

/** K/D = kills / deaths; zero deaths => K/D equals kills. */
export const kd = (kills: number, deaths: number) => Math.round((deaths === 0 ? kills : kills / deaths) * 100) / 100;

/** IST (UTC+5:30) calendar date, YYYY-MM-DD. */
export const istDate = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
/** Monday (IST) that starts the week containing d. */
export function istWeekStart(d = new Date()) {
  const s = new Date(d.getTime() + 330 * 60000);
  s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 6) % 7));
  return s.toISOString().slice(0, 10);
}
export const prevWeekStart = (d = new Date()) => istWeekStart(new Date(d.getTime() - 7 * 864e5));

/** Daily streak: same day keeps it, consecutive day adds one, a gap resets to 1. */
export function nextStreak(last: string | null, today: string, streak: number) {
  if (last === today) return streak;
  const y = new Date(Date.parse(today + "T00:00:00Z") - 864e5).toISOString().slice(0, 10);
  return last === y ? streak + 1 : 1;
}

export type Mode = { matches: number; wins: number; kills: number; deaths: number; hs: number };
/** Returns an error message for impossible stats, or null if valid. */
export function validStats(s: Mode): string | null {
  const n = [s.matches, s.wins, s.kills, s.deaths, s.hs];
  if (n.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0)) return "Stats must be non-negative numbers";
  if (![s.matches, s.wins, s.kills, s.deaths].every(Number.isInteger)) return "Counts must be whole numbers";
  if (s.hs > 100) return "Headshot rate must be 0-100";
  if (s.wins > s.matches) return "Wins cannot exceed matches";
  if (s.matches === 0 && s.kills > 0) return "Kills need at least one match";
  if (s.kills > s.matches * 60 || s.deaths > s.matches * 60) return "Kills/deaths are impossibly high";
  return null;
}

/** Self-reported initial XP: normalized weighted score per mode, capped (formula v1). */
export function initialXp(modes: Mode[], w = CFG.weights) {
  let total = 0;
  for (const m of modes) {
    if (!m.matches) continue;
    const score = kd(m.kills, m.deaths) * w.kd + m.hs * w.hs + (m.kills / m.matches) * w.kpm + (m.wins / m.matches) * 100 * w.wr;
    total += Math.min(1500, Math.round(score));
  }
  return Math.min(3000, total);
}

/** Achievement badges, derived from official stats. */
export const badges = (p: any): string[] => [p.wins >= 1 && "First Win", p.wins >= 10 && "10 Wins", (p.bestStreak || 0) >= 3 && "3-Win Streak", p.matches >= 25 && "25 Matches", p.xp >= 5000 && "Aura+ Club"].filter(Boolean) as string[];

/** Level progression (separate from rank): level = floor(sqrt(xp / base)) + 1. */
export const LEVEL = { base: 100 };
export const levelFromXp = (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL.base)) + 1;

/** Rank presentation metadata. Names come from RANKS (single source of truth); this only describes how a rank looks.
 *  The client builds its badge artwork from this, so there is exactly one place to restyle a rank. */
export const RANK_META: Record<string, { tier: number; colors: [string, string, string]; motif: string }> = {
  "Aura −": { tier: 0, colors: ["#8b93a5", "#5b6478", "#c3c9d6"], motif: "shield" },
  Bronze: { tier: 1, colors: ["#e0a470", "#9a5b2c", "#f4cfa5"], motif: "chevron" },
  Silver: { tier: 2, colors: ["#e6ecf5", "#8f9bb0", "#ffffff"], motif: "chevron2" },
  Gold: { tier: 3, colors: ["#ffe27a", "#c98a0b", "#fff4b8"], motif: "chevron3" },
  Platinum: { tier: 4, colors: ["#8ff0ff", "#1b9fc0", "#d9fbff"], motif: "wings" },
  "Aura +": { tier: 5, colors: ["#c4a8ff", "#6a3fe0", "#efe6ff"], motif: "wings" },
  Diamond: { tier: 6, colors: ["#7fd4ff", "#2a62e8", "#e1f4ff"], motif: "gem" },
  Heroic: { tier: 7, colors: ["#ff7a6b", "#c4161c", "#ffd36b"], motif: "crown" },
};

/** Progress toward the next rank, derived only from XP and the live thresholds. */
export function rankProgress(xp: number) {
  let i = 0;
  THRESHOLDS.forEach((v, k) => { if (xp >= v) i = k; });
  const floor = THRESHOLDS[i], next = THRESHOLDS[i + 1];
  return { index: i, rank: RANKS[i], stars: rankFromXp(xp).stars, floor, nextAt: next ?? null, nextRank: next === undefined ? null : RANKS[i + 1],
    pct: next === undefined ? 100 : Math.max(0, Math.min(100, Math.floor(((xp - floor) / (next - floor)) * 100))), xpToNext: next === undefined ? 0 : Math.max(0, next - xp) };
}

/** Detects an allowed avatar image by its magic bytes (never trusts the declared content type). */
export function detectImage(b: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) return "image/png";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
export const AVATAR_MAX_BYTES = 150 * 1024;

/** Case-insensitive match against any of the given text fields. */
export const matches = (q: string, ...fields: any[]) => {
  const s = q.trim().toLowerCase();
  return !s || fields.some(f => f != null && String(f).toLowerCase().includes(s));
};

/** Player-created open matches (collection `openMatches`). Pure rules live here so they can be unit-tested. */
export const OPEN_MATCH = {
  titleMin: 3, titleMax: 60,
  capacity: { br: [2, 50], cs: [2, 8] } as Record<string, [number, number]>, // players INCLUDING the creator
  minLeadMs: 60_000, maxLeadMs: 30 * 86_400_000, // must start between 1 minute and 30 days from now
  graceMs: 2 * 3_600_000,                         // a started match stays visible (not joinable) for 2 hours
  maxActivePerCreator: 3,
};
export const MODE_LABEL: Record<string, string> = { br: "Battle Royale", cs: "Clash Squad" };

export function parseOpenMatch(b: any, now = Date.now()): { ok: true; value: { title: string; mode: "br" | "cs"; scheduledAt: Date; capacity: number } } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!b || typeof b !== "object") return bad("Send the match details as JSON");
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (title.length < OPEN_MATCH.titleMin || title.length > OPEN_MATCH.titleMax) return bad(`Title must be ${OPEN_MATCH.titleMin}-${OPEN_MATCH.titleMax} characters`);
  const m = typeof b.mode === "string" ? b.mode.trim().toLowerCase().replace(/[\s_-]+/g, " ") : "";
  const mode = m === "br" || m === "battle royale" ? "br" : m === "cs" || m === "clash squad" ? "cs" : null;
  if (!mode) return bad("Game mode must be Battle Royale (br) or Clash Squad (cs)");
  const cap = typeof b.capacity === "number" ? b.capacity : typeof b.capacity === "string" && b.capacity.trim() !== "" ? Number(b.capacity) : NaN;
  const [lo, hi] = OPEN_MATCH.capacity[mode];
  if (!Number.isInteger(cap) || cap < lo || cap > hi) return bad(`Capacity for ${MODE_LABEL[mode]} must be a whole number from ${lo} to ${hi}, including you`);
  const raw = b.scheduledAt;
  const when = (typeof raw === "string" && raw.trim() !== "") || typeof raw === "number" ? new Date(raw) : null;
  if (!when || !Number.isFinite(when.getTime())) return bad("Pick a valid date and time");
  const lead = when.getTime() - now;
  if (lead < OPEN_MATCH.minLeadMs) return bad("The match must start at least a minute from now");
  if (lead > OPEN_MATCH.maxLeadMs) return bad("The match can't be more than 30 days away");
  return { ok: true, value: { title, mode, scheduledAt: when, capacity: cap } };
}
