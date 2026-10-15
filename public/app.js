// FF Arena client: core + player screens. Admin screens load on demand from /admin.js (admins only).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- Safe templating: interpolations are HTML-escaped unless wrapped by raw()/html`` ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(String(s));
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const part = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : v === false || v == null ? "" : esc(v));
const html = (st, ...vals) => new Raw(st.reduce((o, s, i) => o + s + (i < vals.length ? part(vals[i]) : ""), ""));

const S = { user: null, me: null, meta: null, authReady: false, pending: 0, sprite: new Set() };
const fb = { auth: null, mod: null };
const ACT = {}, FORMS = {};
const DASH = "—";
const fmt = n => (Number.isFinite(+n) && n !== null && n !== "" ? Math.round(+n).toLocaleString() : DASH);
const signed = n => (n > 0 ? "+" + n : String(n));
const ago = ms => { if (!ms) return ""; const s = (Date.now() - ms) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : s < 604800 ? Math.floor(s / 86400) + "d ago" : new Date(ms).toLocaleDateString(); };
const kdCalc = (k, d) => Math.round((d === 0 ? k : k / d) * 100) / 100;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "r-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- Icons ----------
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/>', trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4c2.2.7 3.5 2.6 3.5 5.6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', x: '<path d="m6 6 12 12M18 6 6 18"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', unlock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  chevL: '<path d="m15 5-7 7 7 7"/>', chevR: '<path d="m9 5 7 7-7 7"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 8v4l3 2"/>', alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  star: '<path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.8 6.4 20l1.3-6.2L3 9.5l6.3-.7z"/>', flag: '<path d="M5 21V4M5 5h12l-2 4 2 4H5"/>', swords: '<path d="m4 4 9 9M20 4l-9 9M4 20l4-4M20 20l-4-4M13 13l-2 2"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>', download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21h4"/>',
};
const ico = (n, c = "ico") => raw(`<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`);

// ---------- Rank artwork: original SVG emblems generated from the server's rank metadata ----------
const hexOk = c => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : "#888");
const star5 = (cx, cy, R, r) => Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, d = i % 2 ? r : R; return `${(cx + d * Math.cos(a)).toFixed(1)},${(cy + d * Math.sin(a)).toFixed(1)}`; }).join(" ");
const SHIELD = "M32 3 54 11v25c0 15-10 26-22 31C20 62 10 51 10 36V11z", PLATE = "M32 10 48 16v20c0 11-7.5 19-16 23-8.5-4-16-12-16-23V16z";
function wing(i, c3, k, side) {
  const body = `<path d="M52 21C62 14 70 17 77 11c-1 13-6 24-17 30 4-8-2-11-8-8z" fill="url(#rg${i})" stroke="${c3}" stroke-width="1.4" stroke-linejoin="round"/><path d="M54 28c6-2 12-6 18-11M54 34c5-1 10-4 14-9" stroke="${c3}" stroke-opacity=".7" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  return side < 0 ? `<g transform="translate(64 0) scale(-1 1)">${body}</g>` : body;
}
function artFor(r, i) {
  const [c1, c2, c3] = r.colors.map(hexOk), t = r.tier, m = r.motif;
  let s = "";
  if (m === "wings" || m === "gem" || m === "crown") s += wing(i, c3, 1, -1) + wing(i, c3, 1, 1);
  s += `<path d="${SHIELD}" fill="url(#rg${i})" stroke="${c3}" stroke-width="2.2" stroke-linejoin="round"/><path d="${PLATE}" fill="#0b0d16" fill-opacity=".4" stroke="${c3}" stroke-opacity=".55"/>`;
  if (m === "shield") s += `<path d="M32 27 40 36 32 45 24 36z" fill="${c3}" fill-opacity=".85"/>`;
  else if (m.startsWith("chevron")) { const n = t, top = 38 - (n - 1) * 4.5; for (let k = 0; k < n; k++) { const y = top + k * 9; s += `<path d="M22 ${y + 5} 32 ${y - 3} 42 ${y + 5}" fill="none" stroke="${c3}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`; } }
  else if (m === "wings") s += `<polygon points="${star5(32, 36, 12, 5.2)}" fill="${c3}" stroke="${c1}" stroke-width=".8" stroke-linejoin="round"/>` + (t >= 5 ? `<circle cx="32" cy="36" r="16" fill="none" stroke="${c3}" stroke-opacity=".6" stroke-width="1.5"/>` : "");
  else if (m === "gem") s += `<path d="M22 30 27 24h10l5 6-10 21z" fill="${c3}" fill-opacity=".92" stroke="#fff" stroke-opacity=".8" stroke-width="1" stroke-linejoin="round"/><path d="M22 30h20M27 24l5 6 5-6M32 30v21" stroke="${c2}" stroke-opacity=".55" fill="none"/>`;
  else if (m === "crown") s += `<path d="M20 44 22 28l6 8 4-10 4 10 6-8 2 16z" fill="${c3}" stroke="#fff" stroke-opacity=".7" stroke-width="1" stroke-linejoin="round"/><rect x="20" y="45.5" width="24" height="4.5" rx="2" fill="${c3}"/><circle cx="32" cy="40" r="2" fill="${c2}"/><circle cx="26" cy="41" r="1.4" fill="${c2}"/><circle cx="38" cy="41" r="1.4" fill="${c2}"/>`;
  s += `<path d="M32 3 54 11v11C42 17 24 19 10 25V11z" fill="#fff" fill-opacity=".2"/>`;
  return s;
}
function buildSprite(ranks) {
  const defs = [], syms = [];
  ranks.forEach((r, i) => {
    const [c1, c2] = r.colors.map(hexOk);
    defs.push(`<linearGradient id="rg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
    syms.push(`<symbol id="rk-${i}" viewBox="${r.motif === "wings" || r.motif === "gem" || r.motif === "crown" ? "-14 0 92 72" : "4 0 56 72"}">${artFor(r, i)}</symbol>`);
    S.sprite.add(i);
  });
  defs.push(`<linearGradient id="rgx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa3b5"/><stop offset="1" stop-color="#5d6679"/></linearGradient>`);
  syms.push(`<symbol id="rk-x" viewBox="4 0 56 72"><path d="${SHIELD}" fill="url(#rgx)" stroke="#cdd3df" stroke-width="2.2"/><path d="${PLATE}" fill="#0b0d16" fill-opacity=".35"/></symbol>`);
  $("#sprite").innerHTML = `<defs>${defs.join("")}</defs>${syms.join("")}`;
}
const rankName = i => S.meta?.ranks?.[i]?.name || "Unranked";
// Falls back to a neutral emblem when the rank artwork (or metadata) isn't available.
const badge = (i, cls = "") => raw(`<svg class="rk ${cls}" viewBox="0 0 92 72" role="img" aria-label="${esc(rankName(i))} rank"><use href="#rk-${S.sprite.has(i) ? i : "x"}"/></svg>`);
const starsHtml = n => raw(`<span class="stars" aria-label="${n} of 5 stars">${"★".repeat(n)}<s>${"★".repeat(5 - n)}</s></span>`);

// ---------- Avatars (picture or initials) ----------
const initials = n => (String(n || "?").trim().match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();
const hue = n => [...String(n)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
function avatar(p, size = "", ring = false) {
  const name = p.displayName || p.gameName || "?", h = hue(name);
  const prot = p.avatar && !p.avatar.startsWith("/api/avatars/");
  const img = p.avatar ? raw(`<img alt="" decoding="async" loading="lazy" ${prot ? `data-psrc="${esc(p.avatar)}"` : `src="${esc(p.avatar)}"`}>`) : initials(name);
  return html`<span class="av ${size} ${ring ? "ring" : ""}" data-ini="${initials(name)}" style="${`background:linear-gradient(135deg,hsl(${h} 68% 50%),hsl(${(h + 55) % 360} 70% 40%))`}">${img}</span>`;
}
const blobs = new Map();
const blobUrl = u => { if (!blobs.has(u)) blobs.set(u, authedFetch(u).then(r => { if (!r.ok) throw new Error("no image"); return r.blob(); }).then(b => URL.createObjectURL(b))); return blobs.get(u); };
function hydrate() {
  $$("img[data-psrc]").forEach(img => { const u = img.dataset.psrc; img.removeAttribute("data-psrc"); blobUrl(u).then(b => { img.src = b; }, () => img.dispatchEvent(new Event("error"))); });
}
document.addEventListener("error", e => { const t = e.target; if (t.tagName === "IMG" && t.parentElement?.classList.contains("av")) t.parentElement.textContent = t.parentElement.dataset.ini || "?"; }, true);

// ---------- Network ----------
async function authedFetch(url, opts = {}) {
  const h = { ...(opts.headers || {}) }, u = fb.auth?.currentUser;
  if (u) h.Authorization = "Bearer " + (await u.getIdToken());
  try { return await fetch(url, { ...opts, headers: h }); } catch { throw new Error("You're offline or the server can't be reached."); }
}
const cache = new Map(), inflight = new Map();
async function api(path, { method = "GET", body, fresh = false, ttl = 8000 } = {}) {
  if (method === "GET") {
    const c = cache.get(path);
    if (!fresh && c && Date.now() - c.t < ttl) return c.v;
    if (inflight.has(path)) return inflight.get(path);
  } else cache.clear();
  const p = (async () => {
    const r = await authedFetch("/api" + path, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  })();
  if (method === "GET") { inflight.set(path, p); p.then(v => cache.set(path, { t: Date.now(), v }), () => {}).finally(() => inflight.delete(path)); }
  return p;
}
const refreshMe = async () => { S.me = await api("/me", { fresh: true }); return S.me; };

// ---------- Feedback: toasts, sheets, guarded actions ----------
function toast(msg, kind = "") {
  const t = document.createElement("div"); t.className = "toast " + kind; t.textContent = msg; $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 5500 : 3200);
}
function sheet({ title, sub = "", body = "", submit = "Confirm", danger = false, review = null, onOpen, onSubmit }) {
  return new Promise(resolve => {
    const opener = document.activeElement, back = document.createElement("div");
    back.className = "sheet-back";
    back.innerHTML = html`<form class="sheet" role="dialog" aria-modal="true" aria-label="${title}" novalidate><div class="grab"></div><h2>${title}</h2>${sub ? html`<p class="mut sm">${sub}</p>` : ""}
      <div style="margin-top:14px" data-form-body>${body}</div><div data-review hidden></div><p class="err" role="alert" data-err></p>
      <div class="acts"><button type="button" class="btn" data-cancel>Cancel</button>${submit ? html`<button class="btn ${danger ? "danger" : "primary"}" type="submit" data-ok>${review ? "Review" : submit}</button>` : ""}</div></form>`.s;
    $("#modal").appendChild(back); document.body.style.overflow = "hidden";
    const form = $("form", back), err = $("[data-err]", back), okBtn = $("[data-ok]", back), cancel = $("[data-cancel]", back), formBody = $("[data-form-body]", back), rev = $("[data-review]", back);
    let stage = 0, busy = false;
    const close = v => { document.removeEventListener("keydown", key); back.remove(); document.body.style.overflow = ""; opener?.focus?.(); resolve(v); };
    const key = e => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", key);
    back.addEventListener("mousedown", e => { if (e.target === back) close(false); });
    const toStage = n => { stage = n; formBody.hidden = n === 1; rev.hidden = n === 0; cancel.textContent = n === 1 ? "Back" : "Cancel"; if (okBtn) okBtn.textContent = n === 1 ? submit : review ? "Review" : submit; err.textContent = ""; };
    cancel.onclick = () => (stage === 1 ? toStage(0) : close(false));
    form.onsubmit = async e => {
      e.preventDefault(); if (busy) return; err.textContent = "";
      try {
        if (review && stage === 0) { rev.innerHTML = review(form).s; toStage(1); return; }
        busy = true; okBtn?.setAttribute("aria-busy", "true"); if (okBtn) okBtn.disabled = true;
        const r = onSubmit ? await onSubmit(form, close) : undefined;
        if (r !== false) close(true);
      } catch (ex) { err.textContent = ex.message || "Something went wrong"; }
      finally { busy = false; okBtn?.removeAttribute("aria-busy"); if (okBtn) okBtn.disabled = false; }
    };
    onOpen?.(form, close); (form.querySelector("input:not([type=hidden]):not([type=file]),select,textarea") || okBtn)?.focus?.();
  });
}
const confirmSheet = ({ title, body = "", confirm = "Confirm", danger = false }) => sheet({ title, body, submit: confirm, danger });
const run = async (btn, fn) => {
  if (btn.dataset.busy) return; btn.dataset.busy = "1"; btn.setAttribute("aria-busy", "true");
  try { await fn(btn.dataset, btn); } catch (e) { toast(e.message, "err"); } finally { delete btn.dataset.busy; btn.removeAttribute("aria-busy"); }
};
document.addEventListener("click", e => { const t = e.target.closest("[data-act]"); if (!t || t.disabled || !ACT[t.dataset.act]) return; e.preventDefault(); run(t, ACT[t.dataset.act]); });
document.addEventListener("submit", async e => {
  const f = e.target.closest("form[data-form]"); if (!f || !FORMS[f.dataset.form]) return; e.preventDefault();
  if (f.dataset.busy) return; f.dataset.busy = "1"; const b = f.querySelector("[type=submit]"), er = f.querySelector("[data-err]"); b?.setAttribute("aria-busy", "true"); if (er) er.textContent = "";
  try { await FORMS[f.dataset.form](Object.fromEntries(new FormData(f)), f); } catch (ex) { if (er) er.textContent = ex.message; toast(ex.message, "err"); } finally { delete f.dataset.busy; b?.removeAttribute("aria-busy"); }
});

// ---------- Layout building blocks ----------
const field = (label, input, hint) => html`<label class="field"><span>${label}</span>${input}${hint ? html`<small>${hint}</small>` : ""}</label>`;
const inp = (name, { type = "text", value = "", ph = "", mode = "", req = false, max = "", min = "", step = "", ac = "off", id = "" } = {}) =>
  raw(`<input class="input" name="${name}" ${id ? `id="${id}"` : ""} type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="${ac}" ${mode ? `inputmode="${mode}"` : ""} ${req ? "required" : ""} ${max ? `maxlength="${max}"` : ""} ${min !== "" ? `min="${min}"` : ""} ${step ? `step="${step}"` : ""}>`);
const empty = (icon, title, text = "", action = "") => html`<div class="empty">${ico(icon)}<b>${title}</b>${text ? html`<span>${text}</span>` : ""}${action}</div>`;
const skelRows = n => html`<div class="card flush">${Array.from({ length: n }, () => html`<div class="li"><div class="skel" style="width:44px;height:44px;border-radius:30%"></div><div class="grow"><div class="skel" style="height:14px;width:55%;margin-bottom:8px"></div><div class="skel" style="height:11px;width:35%"></div></div><div class="skel" style="width:46px;height:20px"></div></div>`)}</div>`;
const skelHero = () => html`<div class="card"><div class="row"><div class="skel" style="width:96px;height:96px;border-radius:32%"></div><div class="grow"><div class="skel" style="height:20px;width:65%;margin-bottom:10px"></div><div class="skel" style="height:13px;width:45%"></div></div></div></div><div class="grid g3">${[1, 2, 3, 4, 5, 6].map(() => html`<div class="skel" style="height:66px;border-radius:12px"></div>`)}</div>`;
const errorView = (e, retry = true) => html`<div class="card bad"><div class="row">${ico("alert")}<div class="grow"><b>Couldn't load this screen</b><p class="sm wrap">${e?.message || "Something went wrong."}</p></div></div>${retry ? html`<button class="btn block" style="margin-top:12px" data-act="reload">Try again</button>` : ""}</div>`;
ACT.reload = () => go();
const kdVal = c => (c.kd.mode === "admin-set" || (c.stats && c.stats.br.kills + c.stats.br.deaths + c.stats.cs.kills + c.stats.cs.deaths > 0) ? Number(c.kd.value).toFixed(2) : DASH);
const sourceLabel = s => (s === "admin-edited" ? "Reviewed by admin" : "Self-reported");
const tile = (v, l, extra = "") => html`<div class="tile"><b>${v}</b><span>${l}</span>${extra}</div>`;

// ---------- Routing and chrome ----------
const routes = []; let navToken = 0;
const route = (re, fn) => routes.push([re, fn]);
const appEl = () => $("#app");
const ADMIN_SECTIONS = [
  { g: "People", href: "#/admin/pending", icon: "clock", label: "Pending registrations", desc: "Approve, reject or request fixes", badge: true },
  { g: "People", href: "#/admin/players", icon: "users", label: "All players", desc: "Search, filter and open profiles" },
  { g: "People", href: "#/admin/locks", icon: "lock", label: "Profile locks", desc: "Lock or unlock player profiles" },
  { g: "Competition", href: "#/admin/ranks", icon: "shield", label: "Rank management", desc: "Preview and confirm rank changes" },
  { g: "Competition", href: "#/admin/xp", icon: "bolt", label: "XP adjustments", desc: "Add or remove XP with a reason" },
  { g: "Competition", href: "#/admin/matches", icon: "swords", label: "Match management", desc: "Results, challenges, tournaments, teams" },
  { g: "System", href: "#/admin/activity", icon: "history", label: "Recent changes", desc: "Audit history of admin actions" },
  { g: "System", href: "#/admin/settings", icon: "gear", label: "Settings & themes", desc: "Themes, rules config, admins" },
];
function navItems() {
  const r = S.me?.role;
  if (!S.user) return [["#/leaderboard", "trophy", "Ranks", /^\/(leaderboard|player)/], ["#/auth", "user", "Sign in", /^\/auth/]];
  if (r === "player") return [["#/", "home", "Home", /^\/$/], ["#/leaderboard", "trophy", "Ranks", /^\/(leaderboard|player)/], ["#/play", "bolt", "Play", /^\/play/], ["#/me", "user", "Profile", /^\/me/]];
  if (r === "owner" || r === "admin") return [["#/admin", "grid", "Overview", /^\/(admin)?$/], ["#/admin/players", "users", "Players", /^\/admin\/(players|player|pending)/, S.pending], ["#/leaderboard", "trophy", "Ranks", /^\/(leaderboard|player\/)/], ["#/admin/matches", "swords", "Matches", /^\/admin\/matches/], ["#/admin/menu", "menu", "More", /^\/admin\/(menu|xp|ranks|locks|activity|settings)|^\/me/]];
  return [["#/", "user", r === "none" ? "Register" : "Status", /^\/$/], ["#/leaderboard", "trophy", "Ranks", /^\/(leaderboard|player)/], ["#/me", "gear", "Settings", /^\/me/]];
}
function chrome(path, { title = "", back = "" } = {}) {
  const items = navItems(), cur = path || "/", admin = ["owner", "admin"].includes(S.me?.role);
  $("#nav").innerHTML = items.map(([h, i, l, re, n]) => `<a href="${h}" class="${re.test(cur) ? "on" : ""}" ${re.test(cur) ? 'aria-current="page"' : ""}>${ico(i).s}<span>${esc(l)}</span>${n ? `<b class="dot">${n}</b>` : ""}</a>`).join("");
  const side = items.map(([h, i, l, re, n]) => `<a href="${h}" class="${re.test(cur) ? "on" : ""}">${ico(i).s}<span>${esc(l)}</span>${n ? `<b class="dot">${n}</b>` : ""}</a>`).join("");
  const adminSide = admin ? `<h4>Admin</h4>` + ADMIN_SECTIONS.map(s => `<a href="${s.href}" class="${cur.startsWith(s.href.slice(1)) ? "on" : ""}">${ico(s.icon).s}<span>${esc(s.label)}</span>${s.badge && S.pending ? `<b class="dot">${S.pending}</b>` : ""}</a>`).join("") : "";
  $("#side").innerHTML = `<span class="logo"><i>FF</i>ARENA</span>${side}${adminSide}${S.user ? `<h4>Account</h4><a href="#/me">${ico("user").s}<span>Account & themes</span></a>` : ""}`;
  const who = S.me?.card || (S.user ? { displayName: S.user.email } : null);
  $("#top").innerHTML = (back ? `<a class="btn icon ghost" href="${esc(back)}" aria-label="Back">${ico("chevL").s}</a>` : `<span class="logo"><i>FF</i>${title ? "" : "ARENA"}</span>`) + `<span class="title trunc">${back || title ? esc(title) : ""}</span>` + (S.user && who ? `<a href="#/me" aria-label="Your profile">${avatar(who, "s").s}</a>` : `<a class="btn s primary" href="#/auth">Sign in</a>`);
}
function paint(ctx, node, opts = {}) {
  if (!ctx.ok()) return false;
  chrome(ctx.path, opts); const el = appEl(); el.innerHTML = node.s;
  if (!ctx.painted) { el.classList.remove("rise"); void el.offsetWidth; el.classList.add("rise"); scrollTo(0, 0); ctx.painted = true; }
  hydrate(); return true;
}
async function go() {
  const full = location.hash.slice(1) || "/", [path, qs] = full.split("?"), token = ++navToken;
  const ctx = { path, q: new URLSearchParams(qs || ""), ok: () => token === navToken, painted: false };
  for (const [re, fn] of routes) {
    const m = re.exec(path); if (!m) continue; ctx.m = m;
    try { await fn(ctx); } catch (e) { if (ctx.ok()) paint(ctx, errorView(e), { title: "Error" }); }
    return;
  }
  location.replace("#/");
}
addEventListener("hashchange", go);
const waiting = (ctx, title = "") => { if (!S.authReady) { paint(ctx, skelHero(), { title }); return true; } return false; };

// ---------- Theme ----------
const THEMES = [["esports", "Esports", "linear-gradient(135deg,#7c3aed,#06b6d4)"], ["classic", "Classic", "linear-gradient(135deg,#3d6a4d,#a9833a)"], ["pink", "Pink", "linear-gradient(135deg,#ec4899,#8b5cf6)"], ["modern", "Modern", "linear-gradient(135deg,#3b5bdb,#0ea5e9)"]];
function setTheme(t) {
  document.documentElement.dataset.theme = t; try { localStorage.setItem("theme", t); } catch { /* storage may be blocked */ }
  requestAnimationFrame(() => { $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#090a11"; });
}
const themePicker = () => html`<div class="themes">${THEMES.map(([k, n, g]) => html`<button type="button" data-act="theme" data-t="${k}" class="${document.documentElement.dataset.theme === k ? "on" : ""}" aria-pressed="${document.documentElement.dataset.theme === k}"><i style="${`background:${g}`}"></i>${n}</button>`)}</div>`;
ACT.theme = d => { setTheme(d.t); $$("[data-act=theme]").forEach(b => { const on = b.dataset.t === d.t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }); };

// ---------- Profile views ----------
const statusChips = (me) => html`<div class="row gap8" style="flex-wrap:wrap"><span class="chip ok">${ico("check")}Approved</span>${me.lock?.locked ? html`<span class="chip warn">${ico("lock")}Locked</span>` : html`<span class="chip">Active</span>`}</div>`;
function rankPanel(c) {
  const p = c.progress;
  return html`<div class="card accent"><div class="row">${badge(c.rankIndex, "l")}<div class="grow"><div class="mut xs b" style="text-transform:uppercase;letter-spacing:.08em">Current rank</div><h2 style="font-size:22px">${c.rank}</h2><div class="row gap8">${starsHtml(c.stars)}<span class="mut sm">Rating ${fmt(c.rating)}</span></div></div></div>
    ${p ? html`<div style="margin-top:14px"><div class="row sp sm"><span class="mut">${p.nextRank ? "Next: " + p.nextRank : "Top rank reached"}</span><b>${p.nextRank ? fmt(p.xpToNext) + " XP to go" : "MAX"}</b></div><div class="bar" style="margin-top:7px" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100"><i style="${`width:${p.pct}%`}"></i></div></div>` : html`<p class="mut sm" style="margin-top:12px">${ico("shield", "ico")} This rank was set by an admin.</p>`}</div>`;
}
function statGrid(c) {
  const wl = `${c.wins}–${c.losses}${c.draws ? "–" + c.draws : ""}`;
  return html`<div class="grid g3">${tile(fmt(c.xp), "XP")}${tile(fmt(c.rating), "Rating")}${tile(c.matches ? fmt(c.matches) : DASH, "Arena matches")}${tile(c.matches ? wl : DASH, "W–L" + (c.draws ? "–D" : ""))}${tile(c.matches ? c.winRate + "%" : DASH, "Win rate")}
    ${tile(kdVal(c), "K/D", html`<div class="xs mut" style="margin-top:3px">${c.kd.mode === "admin-set" ? "Set by admin" : sourceLabel(c.statsSource)}</div>`)}${tile(c.level, "Level")}${tile(c.winStreak, "Win streak")}${tile(c.bestStreak, "Best streak")}</div>`;
}
const modeStats = (c, key, name) => { const m = c.stats?.[key]; if (!m || !m.matches) return ""; return html`<div class="tile"><span class="b" style="color:var(--fg)">${name}</span><div class="row sp sm" style="margin-top:8px"><span class="mut">Matches</span><b>${fmt(m.matches)}</b></div><div class="row sp sm"><span class="mut">Wins</span><b>${fmt(m.wins)}</b></div><div class="row sp sm"><span class="mut">K/D</span><b>${kdCalc(m.kills, m.deaths).toFixed(2)}</b></div><div class="row sp sm"><span class="mut">Headshot</span><b>${m.hs}%</b></div></div>`; };
const recentList = list => (list?.length ? html`<div class="card flush">${list.map(m => html`<div class="li"><span class="chip ${m.outcome === "W" ? "ok" : m.outcome === "L" ? "bad" : ""}">${m.outcome === "W" ? "Win" : m.outcome === "L" ? "Loss" : "Draw"}</span><span class="grow"><b class="trunc" style="display:block">vs ${m.opponent}</b><span class="mut xs">${m.scoreFor}–${m.scoreAgainst} · ${ago(m.at)}</span></span><span class="right b ${m.ratingDelta > 0 ? "" : ""}" style="${`color:var(--${m.ratingDelta >= 0 ? "ok" : "bad"})`}">${signed(m.ratingDelta)}</span></div>`)}</div>` : html`<div class="card">${empty("swords", "No matches yet", "Approved match results will show up here.")}</div>`);
const uidRow = c => (c.ffUid ? html`<span class="chip mono">UID ${c.ffUid}</span><button class="chip" data-act="copy" data-v="${c.ffUid}" aria-label="Copy UID">${ico("copy")}Copy</button>` : "");
ACT.copy = async d => {
  try { if (navigator.clipboard && isSecureContext) await navigator.clipboard.writeText(d.v); else { const x = document.createElement("textarea"); x.value = d.v; document.body.appendChild(x); x.select(); const ok = document.execCommand("copy"); x.remove(); if (!ok) throw 0; } toast("Copied", "ok"); }
  catch { toast("Copy isn't supported in this browser", "err"); }
};
function heroCard(c, extra = "") {
  return html`<div class="card hero edge"><div class="row top">${avatar(c, "xl", true)}<div class="grow"><div class="name wrap">${c.displayName}</div>
    <div class="mut sm wrap">In-game: <b style="color:var(--fg)">${c.gameName}</b></div><div class="row gap8" style="flex-wrap:wrap;margin-top:8px"><span class="chip info mono">${c.arenaId}</span>${uidRow(c)}</div></div></div>${extra}</div>`;
}
const badgesRow = c => (c.badges?.length ? html`<div class="row gap8" style="flex-wrap:wrap;margin-top:12px">${c.badges.map(b => html`<span class="chip warn">${ico("star")}${b}</span>`)}</div>` : "");
const sec = (t, right = "") => html`<div class="sec"><h2>${t}</h2>${right}</div>`;

// ---------- Leaderboard ----------
const LB = { tab: "xp", q: "", rows: [], total: 0 };
const lbRow = (r, tab, mine) => html`<a class="lb ${mine ? "me" : ""}" href="#/player/${r.arenaId}"><span class="pos">${r.pos}</span>${avatar(r)}<span class="grow"><b class="trunc" style="display:block">${r.displayName}</b><span class="mut xs trunc" style="display:block">${r.gameName !== r.displayName ? r.gameName + " · " : ""}${r.rank}</span></span>${badge(r.rankIndex, "s")}<span class="val"><b>${fmt(r.value)}</b><span class="mut xs">${tab === "rating" ? "rating" : "XP"}</span></span></a>`;
function lbBody() {
  if (LB.tab === "teams") return LB.teams?.length ? html`<div class="card flush">${LB.teams.map((t, i) => html`<div class="lb"><span class="pos">${i + 1}</span><span class="grow"><b class="trunc" style="display:block">${t.name}</b><span class="mut xs wrap" style="display:block">Captain ${t.captain} · ${t.members.join(", ")}</span><span class="mut xs">${t.wins}W ${t.losses}L ${t.draws}D${t.matches ? " · " + t.winRate + "% win" : ""}</span></span><span class="val"><b>${fmt(t.rating)}</b><span class="mut xs">team rating</span></span></div>`)}</div>` : html`<div class="card">${empty("users", "No teams yet", "Teams created by admins will appear here.")}</div>`;
  if (!LB.rows.length) return html`<div class="card">${LB.q ? empty("search", "No players match “" + LB.q + "”", "Check the spelling or try an FF Arena ID.") : empty("trophy", "No players yet", "Approved players will appear here.")}</div>`;
  const mine = S.me?.card?.arenaId, top = !LB.q && LB.rows.length >= 3 ? LB.rows.slice(0, 3) : null, rest = top ? LB.rows.slice(3) : LB.rows;
  const pod = (r, n) => html`<a class="pod p${n}" href="#/player/${r.arenaId}"><span class="n">#${n}</span>${avatar(r, n === 1 ? "l" : "", n === 1)}${badge(r.rankIndex, n === 1 ? "" : "s")}<b class="nm trunc">${r.displayName}</b><span class="v">${fmt(r.value)}</span><span class="mut xs">${LB.tab === "rating" ? "rating" : "XP"}</span></a>`;
  return html`${top ? html`<div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>` : ""}${rest.length ? html`<div class="card flush">${rest.map(r => lbRow(r, LB.tab, r.arenaId === mine))}</div>` : ""}${LB.rows.length < LB.total ? html`<button class="btn block" data-act="lbmore">Show more (${LB.total - LB.rows.length} left)</button>` : ""}`;
}
async function lbLoad(reset) {
  const tk = navToken, box = $("#lbres"); if (!box) return;
  if (LB.tab === "teams") { LB.teams = await api("/teams"); } else {
    const d = await api(`/leaderboard?tab=${LB.tab}&q=${encodeURIComponent(LB.q)}&limit=30&offset=${reset ? 0 : LB.rows.length}`);
    LB.rows = reset ? d.rows : LB.rows.concat(d.rows); LB.total = d.total;
  }
  if (tk !== navToken || !$("#lbres")) return; $("#lbres").innerHTML = lbBody().s; hydrate();
}
const lbFail = e => { const b = $("#lbres"); if (b) b.innerHTML = errorView(e).s; };
route(/^\/leaderboard$/, async ctx => {
  LB.q = ""; LB.rows = [];
  paint(ctx, html`<div class="stack"><div class="seg" role="tablist">${[["xp", "Overall XP"], ["rating", "Rating"], ["teams", "Teams"]].map(([k, l]) => html`<button role="tab" data-act="lbtab" data-t="${k}" class="${LB.tab === k ? "on" : ""}" aria-selected="${LB.tab === k}">${l}</button>`)}</div>
    <div class="search" ${LB.tab === "teams" ? "hidden" : ""} id="lbsearch">${ico("search")}<input class="input" id="lbq" type="search" placeholder="Search players" aria-label="Search players" autocomplete="off" enterkeyhint="search"></div></div><div id="lbres" style="margin-top:12px">${skelRows(7)}</div>`, { title: "Leaderboard" });
  await lbLoad(true).catch(lbFail);
});
ACT.lbtab = async d => { LB.tab = d.t; LB.rows = []; $$("[data-act=lbtab]").forEach(b => { const on = b.dataset.t === d.t; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); }); $("#lbsearch").hidden = d.t === "teams"; $("#lbres").innerHTML = skelRows(7).s; await lbLoad(true).catch(lbFail); };
ACT.lbmore = async () => { await lbLoad(false); };
document.addEventListener("input", debounce(e => { if (e.target.id === "lbq") { LB.q = e.target.value.trim(); lbLoad(true).catch(lbFail); } }, 250));

// ---------- Public player profile ----------
route(/^\/player\/([\w-]+)$/, async ctx => {
  paint(ctx, skelHero(), { title: "Player", back: "#/leaderboard" });
  let d; try { d = await api("/players/" + encodeURIComponent(ctx.m[1])); } catch (e) { return paint(ctx, html`<div class="card">${empty("search", "Player not found", "This profile doesn't exist or isn't public.", html`<a class="btn" href="#/leaderboard">Back to leaderboard</a>`)}</div>`, { title: "Player", back: "#/leaderboard" }); }
  paint(ctx, html`${heroCard(d, badgesRow(d))}${rankPanel(d)}${statGrid(d)}${d.stats && (d.stats.br.matches || d.stats.cs.matches) ? html`${sec("Game stats", html`<span class="chip">${sourceLabel(d.statsSource)}</span>`)}<div class="grid g2">${modeStats(d, "br", "Battle Royale")}${modeStats(d, "cs", "Clash Squad")}</div>` : ""}${sec("Recent matches")}${recentList(d.recent)}`, { title: d.displayName, back: "#/leaderboard" });
});

// ---------- Auth, registration, pending ----------
const AUTH_ERR = { "auth/invalid-credential": "Email or password is incorrect.", "auth/wrong-password": "Email or password is incorrect.", "auth/user-not-found": "Email or password is incorrect.", "auth/email-already-in-use": "That email already has an account. Try signing in.", "auth/weak-password": "Use a password with at least 6 characters.", "auth/invalid-email": "That email address doesn't look right.", "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.", "auth/network-request-failed": "Network problem. Check your connection." };
let authMode = "in";
const authView = ctx => paint(ctx, html`<div class="auth"><div class="center stack"><span class="logo"><i>FF</i>ARENA</span><p class="mut">Free Fire competition for your crew.</p></div>
  <div class="card edge" style="margin-top:18px"><div class="seg" style="margin-bottom:14px"><button type="button" data-act="authmode" data-m="in" class="${authMode === "in" ? "on" : ""}">Sign in</button><button type="button" data-act="authmode" data-m="up" class="${authMode === "up" ? "on" : ""}">Create account</button></div>
  <form data-form="auth" novalidate>${field("Email", raw(`<input class="input" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="you@example.com">`))}
  ${field("Password", raw(`<input class="input" name="password" type="password" autocomplete="${authMode === "in" ? "current-password" : "new-password"}" required minlength="6" placeholder="6+ characters">`))}
  <p class="err" role="alert" data-err></p><button class="btn primary block" type="submit">${authMode === "in" ? "Sign in" : "Create account"}</button></form>
  ${authMode === "in" ? html`<button class="btn ghost block s" style="margin-top:8px" data-act="resetpw">Forgot password?</button>` : ""}</div>
  <p class="mut xs center">Use your gaming identity only. No real name or phone number is needed.</p></div>`, { title: "Sign in" });
route(/^\/auth$/, async ctx => { if (waiting(ctx)) return; if (S.user) return (location.hash = "#/"); authView(ctx); });
ACT.authmode = d => { authMode = d.m; go(); };
const needFb = () => { if (!fb.auth) throw new Error("Still connecting. Try again in a moment."); };
FORMS.auth = async d => {
  needFb(); const m = fb.mod;
  try { authMode === "in" ? await m.signInWithEmailAndPassword(fb.auth, d.email.trim(), d.password) : await m.createUserWithEmailAndPassword(fb.auth, d.email.trim(), d.password); }
  catch (e) { throw new Error(AUTH_ERR[e.code] || "Couldn't sign you in. Please try again."); }
  location.hash = "#/";
};
ACT.resetpw = async () => {
  needFb(); const email = $("input[name=email]")?.value.trim(); if (!email) throw new Error("Enter your email above first.");
  try { await fb.mod.sendPasswordResetEmail(fb.auth, email); toast("Password reset email sent", "ok"); } catch (e) { throw new Error(AUTH_ERR[e.code] || "Couldn't send the reset email."); }
};
ACT.signout = async () => { await fb.mod.signOut(fb.auth); };

const modeFields = (p, label, v = {}) => html`<h3 style="margin:14px 0 8px">${label}</h3><div class="grid g2">${field("Matches", inp(p + "m", { mode: "numeric", value: v.matches ?? "", ph: "0" }))}${field("Wins", inp(p + "w", { mode: "numeric", value: v.wins ?? "", ph: "0" }))}${field("Kills", inp(p + "k", { mode: "numeric", value: v.kills ?? "", ph: "0" }))}${field("Deaths", inp(p + "d", { mode: "numeric", value: v.deaths ?? "", ph: "0" }))}</div>${field("Headshot %", inp(p + "h", { mode: "decimal", value: v.hs ?? "", ph: "0" }))}`;
const readModes = d => { const m = p => ({ matches: d[p + "m"], wins: d[p + "w"], kills: d[p + "k"], deaths: d[p + "d"], hs: d[p + "h"] }); return { br: m("b"), cs: m("c") }; };
const identityFields = (v = {}) => html`${field("Display name", inp("displayName", { value: v.displayName || "", max: 20, ph: "Shown on leaderboards (optional)", ac: "nickname" }), "Your FF Arena name. Leave blank to use your in-game name.")}${field("Free Fire in-game name", inp("gameName", { value: v.gameName || "", max: 20, req: true, ph: "Exactly as in the game" }))}${field("Free Fire UID", inp("ffUid", { value: v.ffUid || "", mode: "numeric", req: true, ph: "Digits only" }))}`;
function registerView(ctx) {
  paint(ctx, html`<div class="stack"><div><h1>Join FF Arena</h1><p class="mut">Pick how you appear to everyone else. An admin will approve your account.</p></div>
    <form data-form="register" class="card edge" novalidate>${identityFields()}<details><summary class="b" style="min-height:44px;display:flex;align-items:center;cursor:pointer">Your game stats <span class="mut sm" style="margin-left:8px">(optional)</span></summary><p class="mut sm">Self-reported numbers set your starting XP. Admins can review and correct them.</p>${modeFields("b", "Battle Royale")}${modeFields("c", "Clash Squad")}</details>
    <p class="err" role="alert" data-err></p><button class="btn primary block" type="submit" style="margin-top:12px">Submit for approval</button></form>
    <details class="card"><summary class="b" style="min-height:44px;display:flex;align-items:center;cursor:pointer">Setting up FF Arena as the owner?</summary><p class="mut sm">Only the person deploying this app needs this. Use the bootstrap secret from your Railway variables. It works once.</p>
    <form data-form="owner" novalidate><div class="pw">${field("Bootstrap secret", raw(`<input class="input" name="secret" type="password" autocomplete="off" required>`))}</div><p class="err" role="alert" data-err></p><button class="btn block" type="submit">Claim owner access</button></form></details></div>`, { title: "Register" });
}
FORMS.register = async (d, f) => { const m = readModes(d); await api("/register", { method: "POST", body: { gameName: d.gameName, displayName: d.displayName || undefined, ffUid: d.ffUid, br: m.br, cs: m.cs } }); await refreshMe(); toast("Submitted. An admin will review it.", "ok"); go(); };
FORMS.owner = async d => { await api("/bootstrap-owner", { method: "POST", body: { secret: d.secret } }); await refreshMe(); toast("You are the owner now", "ok"); location.hash = "#/admin"; go(); };
function pendingView(ctx) {
  const r = S.me.registration, st = r?.status || "PENDING", step = (done, now, t) => html`<div class="row"><span class="chip ${done ? "ok" : now ? "info" : ""}" style="min-width:26px;justify-content:center">${done ? ico("check") : now ? ico("clock") : ""}</span><span class="${done || now ? "b" : "mut"}">${t}</span></div>`;
  const pic = html`<div class="card"><div class="row">${avatar({ avatar: r?.hasAvatar ? "/api/me/avatar?v=" + r.avatarV : null, displayName: r?.displayName || r?.gameName }, "l")}<div class="grow"><b>Profile picture</b><p class="mut sm">Admins see this when they review you.</p></div></div><div class="row" style="margin-top:12px"><button class="btn grow" data-act="pic">${ico("camera")}${r?.hasAvatar ? "Change" : "Add picture"}</button>${r?.hasAvatar ? html`<button class="btn danger icon" data-act="rmpic" aria-label="Remove picture">${ico("trash")}</button>` : ""}</div></div>`;
  if (S.me.role === "rejected") return paint(ctx, html`<div class="card bad"><h2>Registration not approved</h2><p style="margin-top:6px">${r?.reason || "An admin didn't approve this registration."}</p><p class="mut sm" style="margin-top:10px">Talk to an admin if you think this is a mistake.</p></div>`, { title: "Status" });
  paint(ctx, html`<div class="stack"><div class="card edge"><h2>${st === "NEEDS_CORRECTION" ? "Almost there" : "Waiting for approval"}</h2><p class="mut sm">${st === "NEEDS_CORRECTION" ? "An admin asked for a small fix before approving you." : "An admin will look at your registration soon. You can't join official matches until then."}</p>
    <div class="stack" style="margin-top:14px">${step(true, false, "Registered")}${step(false, true, st === "NEEDS_CORRECTION" ? "Needs your update" : "Admin review")}${step(false, false, "Approved and ready to play")}</div></div>
    ${st === "NEEDS_CORRECTION" ? html`<div class="card warnc"><b>Admin note</b><p class="wrap" style="margin-top:4px">${r.note}</p></div><form data-form="correct" class="card" novalidate>${identityFields(r)}<p class="err" role="alert" data-err></p><button class="btn primary block" type="submit">Send back for review</button></form>` : html`<div class="card"><div class="row sp"><span class="mut">In-game name</span><b>${r?.gameName}</b></div><div class="row sp"><span class="mut">Display name</span><b>${r?.displayName || r?.gameName}</b></div><div class="row sp"><span class="mut">UID</span><b class="mono">${r?.ffUid}</b></div></div>`}${pic}</div>`, { title: "Status" });
}
FORMS.correct = async d => { await api("/me/registration", { method: "PATCH", body: { gameName: d.gameName, displayName: d.displayName, ffUid: d.ffUid } }); await refreshMe(); toast("Sent back for review", "ok"); go(); };

// ---------- Picture upload with preview and crop ----------
const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));
function putAvatar(blob, onProgress) {
  return new Promise((resolve, reject) => {
    (async () => {
      const x = new XMLHttpRequest(); x.open("PUT", "/api/me/avatar"); x.setRequestHeader("Content-Type", blob.type);
      const u = fb.auth?.currentUser; if (u) x.setRequestHeader("Authorization", "Bearer " + (await u.getIdToken()));
      x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* not json */ } x.status < 300 ? resolve(d) : reject(new Error(d.error || "Upload failed")); };
      x.onerror = () => reject(new Error("Upload failed. Check your connection and try again.")); x.send(blob);
    })().catch(reject);
  });
}
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch { /* fall through */ } }
  return await new Promise((res, rej) => { const i = new Image(), u = URL.createObjectURL(file); i.onload = () => res(i); i.onerror = () => rej(new Error("That picture format isn't supported. Try a JPEG or PNG.")); i.src = u; });
}
ACT.pic = async () => {
  const SIZE = 384, max = S.meta?.avatarMaxBytes || 150 * 1024; let img = null, z = 1, ox = 0, oy = 0, cv, g, base = 1;
  const clamp = () => { const w = img.width * base * z, h = img.height * base * z; ox = Math.min(0, Math.max(SIZE - w, ox)); oy = Math.min(0, Math.max(SIZE - h, oy)); };
  const draw = () => { g.fillStyle = "#000"; g.fillRect(0, 0, SIZE, SIZE); clamp(); g.drawImage(img, ox, oy, img.width * base * z, img.height * base * z); };
  const ok = await sheet({ title: "Profile picture", sub: "Pick a photo from your gallery, then drag to position it.", submit: "Save picture",
    body: html`<div class="crop" data-crop hidden><canvas width="${SIZE}" height="${SIZE}"></canvas></div><button type="button" class="btn block" data-pick>${ico("camera")}Choose photo</button><input type="file" accept="image/*" hidden data-file>
      <label class="field" data-zoomw hidden style="margin-top:14px"><span>Zoom</span><input type="range" min="1" max="3" step="0.01" value="1" data-zoom style="width:100%;accent-color:var(--ac)"></label><div class="bar" data-prog hidden style="margin-top:12px"><i style="width:0%"></i></div>`,
    onOpen(form) {
      const file = $("[data-file]", form), crop = $("[data-crop]", form); cv = $("canvas", form); g = cv.getContext("2d");
      $("[data-pick]", form).onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0]; if (!f) return;
        if (!/^image\//.test(f.type) && f.type) return toast("Please choose an image file", "err");
        try { img = await loadBitmap(f); } catch (e) { return toast(e.message || "Couldn't read that picture", "err"); }
        base = Math.max(SIZE / img.width, SIZE / img.height); z = 1; ox = (SIZE - img.width * base) / 2; oy = (SIZE - img.height * base) / 2; crop.hidden = false; $("[data-zoomw]", form).hidden = false; $("[data-pick]", form).textContent = "Choose a different photo"; draw();
      };
      $("[data-zoom]", form).oninput = e => { const cx = SIZE / 2, k = +e.target.value / z; ox = cx - (cx - ox) * k; oy = cx - (cx - oy) * k; z = +e.target.value; draw(); };
      let last = null; crop.onpointerdown = e => { if (!img) return; last = [e.clientX, e.clientY]; crop.setPointerCapture(e.pointerId); };
      crop.onpointermove = e => { if (!last) return; const k = SIZE / crop.getBoundingClientRect().width; ox += (e.clientX - last[0]) * k; oy += (e.clientY - last[1]) * k; last = [e.clientX, e.clientY]; draw(); };
      crop.onpointerup = crop.onpointercancel = () => { last = null; };
    },
    async onSubmit(form) {
      if (!img) throw new Error("Choose a photo first.");
      let out = cv, size = SIZE, blob = null;
      for (const [sz, qs] of [[SIZE, [0.82, 0.7, 0.55]], [256, [0.7, 0.55]]]) {
        if (sz !== size) { out = document.createElement("canvas"); out.width = out.height = sz; out.getContext("2d").drawImage(cv, 0, 0, sz, sz); size = sz; }
        for (const q of qs) { let b = await toBlob(out, "image/webp", q); if (!b || b.type !== "image/webp") b = await toBlob(out, "image/jpeg", q); if (b && b.size <= max) { blob = b; break; } }
        if (blob) break;
      }
      if (!blob) throw new Error("That picture is too detailed to shrink enough. Try another one.");
      const prog = $("[data-prog]", form); prog.hidden = false;
      await putAvatar(blob, p => { $("i", prog).style.width = Math.round(p * 100) + "%"; });
    } });
  if (ok) { blobs.clear(); await refreshMe(); toast("Profile picture updated", "ok"); go(); }
};
ACT.rmpic = async () => { if (!(await confirmSheet({ title: "Remove your picture?", body: html`<p class="mut">You'll go back to the default avatar with your initial.</p>`, confirm: "Remove", danger: true }))) return; await api("/me/avatar", { method: "DELETE" }); blobs.clear(); await refreshMe(); toast("Picture removed", "ok"); go(); };

// ---------- Player home ----------
const notesCard = n => (n?.length ? html`${sec("Notifications")}<div class="card flush">${n.slice(0, 5).map(x => html`<div class="li"><span class="grow wrap">${x.text}</span><span class="mut xs nowrap">${ago(x.at)}</span></div>`)}</div>` : "");
const lockBanner = me => (me.lock?.locked ? html`<div class="card warnc"><div class="row top">${ico("lock")}<div class="grow"><b>Your profile is locked</b><p class="sm wrap">An admin locked your profile${me.lock.reason ? ": " + me.lock.reason : "."} You can't edit your profile or join new matches until it's unlocked. You can still sign out and use your account.</p></div></div></div>` : "");
function homePlayer(ctx) {
  const draw = () => { const me = S.me, c = me.card; paint(ctx, html`${lockBanner(me)}${heroCard(c, html`<div style="margin-top:14px" class="row sp">${statusChips(me)}<a class="btn s" href="#/me">${ico("edit")}Edit profile</a></div>`)}${rankPanel(c)}${sec("Your stats")}${statGrid(c)}
    ${sec("This week")}<div class="card"><div class="row sp sm"><span class="mut">Approved challenges</span><b>${me.weekly.done}/${me.weekly.target}</b></div><div class="bar" style="margin:8px 0 14px"><i style="${`width:${Math.min(100, (me.weekly.done / me.weekly.target) * 100)}%`}"></i></div><div class="row sp"><span class="sm"><b>Daily login</b><br><span class="mut">Streak ${me.loginStreak} day${me.loginStreak === 1 ? "" : "s"}</span></span><button class="btn s primary" data-act="daily">${ico("bolt")}Claim +XP</button></div></div>
    ${sec("Recent matches", html`<a class="sm b" href="#/play">All challenges</a>`)}${recentList(me.recent)}${notesCard(me.notifications)}`, { title: "Home" }); };
  draw(); api("/me", { fresh: true }).then(d => { if (ctx.ok() && JSON.stringify(d) !== JSON.stringify(S.me)) { S.me = d; draw(); } }).catch(() => {});
}
ACT.daily = async () => { const d = await api("/daily-login", { method: "POST" }); await refreshMe(); toast(d.already ? "Already claimed today" : `Daily login claimed. Streak ${d.streak}`, d.already ? "" : "ok"); go(); };

// ---------- Profile & account settings ----------
route(/^\/me$/, async ctx => {
  if (waiting(ctx, "Profile")) return; if (!S.user) return (location.hash = "#/auth");
  const me = S.me, c = me.card, locked = !!me.lock?.locked;
  const account = html`${sec("Appearance")}<div class="card">${themePicker()}</div>${sec("Account")}<div class="card"><div class="row sp"><span class="mut">Signed in as</span><b class="trunc">${S.user.email}</b></div><div class="grid g2" style="margin-top:14px"><button class="btn" data-act="resetme">${ico("mail")}Reset password</button><button class="btn danger" data-act="signout">${ico("logout")}Sign out</button></div></div>`;
  if (me.role !== "player" || !c) return paint(ctx, html`<div class="stack"><div><h1>Account</h1><p class="mut sm">${me.role === "owner" ? "Owner" : me.role === "admin" ? "Admin" : "Your account"}</p></div>${account}</div>`, { title: "Account" });
  paint(ctx, html`${lockBanner(me)}${heroCard(c, html`<div class="row gap8" style="margin-top:14px"><button class="btn grow" data-act="pic" ${locked ? "disabled" : ""}>${ico("camera")}${c.avatar ? "Change picture" : "Add picture"}</button>${c.avatar ? html`<button class="btn danger icon" data-act="rmpic" ${locked ? "disabled" : ""} aria-label="Remove picture">${ico("trash")}</button>` : ""}</div>`)}
    ${sec("Edit profile")}<form data-form="profile" class="card" novalidate><fieldset style="border:0;padding:0;margin:0" ${locked ? "disabled" : ""}>${field("Display name", inp("displayName", { value: c.displayName === c.gameName ? "" : c.displayName, max: 20, ph: c.gameName }), "Shown on leaderboards and match lists.")}
    ${field("Free Fire in-game name", inp("gameName", { value: c.gameName, max: 20, req: true }))}<label class="switch"><span>Show my Free Fire UID on my public profile</span><input type="checkbox" name="showUid" ${me.settings.showUid ? "checked" : ""}></label></fieldset>
    <p class="err" role="alert" data-err></p><button class="btn primary block" type="submit" ${locked ? "disabled" : ""}>Save changes</button></form>
    <div class="card"><h3>Managed by admins</h3><p class="mut sm" style="margin-top:4px">XP, rank, rating, K/D, approval and profile locks can only be changed by an admin. Your rank comes from your match results.</p><div class="row gap8" style="flex-wrap:wrap;margin-top:10px"><span class="chip">${c.rank}</span><span class="chip">${fmt(c.xp)} XP</span><span class="chip">${sourceLabel(c.statsSource)} stats</span></div></div>${account}`, { title: "Profile" });
});
FORMS.profile = async d => { await api("/me/profile", { method: "PATCH", body: { displayName: d.displayName.trim(), gameName: d.gameName, showUid: d.showUid === "on" } }); await refreshMe(); toast("Profile saved", "ok"); go(); };
ACT.resetme = async () => { needFb(); await fb.mod.sendPasswordResetEmail(fb.auth, S.user.email); toast("Password reset email sent", "ok"); };

// ---------- Play: missions and challenges ----------
const outChip = s => ({ PROPOSED: ["info", "Proposed"], SCHEDULED: ["info", "Scheduled"], PENDING_REVIEW: ["warn", "In review"], APPROVED: ["ok", "Approved"], REJECTED: ["bad", "Rejected"], DISPUTED: ["warn", "Disputed"], CANCELLED: ["", "Cancelled"] }[s] || ["", s]);
route(/^\/play$/, async ctx => {
  if (waiting(ctx, "Play")) return; if (S.me?.role !== "player") return (location.hash = "#/");
  paint(ctx, html`${skelRows(3)}${skelRows(3)}`, { title: "Play" });
  const [ms, ch, ts, pl] = await Promise.all([api("/missions"), api("/challenges/mine"), api("/tournaments"), api("/players")]);
  const locked = !!S.me.lock?.locked; ctx.players = pl;
  paint(ctx, html`${lockBanner(S.me)}${sec("Weekly missions")}<div class="card flush">${ms.map(m => html`<div class="li"><span class="grow"><b>${m.title}</b><div class="bar" style="margin:7px 0 4px"><i style="${`width:${(m.progress / m.target) * 100}%`}"></i></div><span class="mut xs">${m.progress}/${m.target} · +${m.xp} XP</span></span>${m.claimed ? html`<span class="chip ok">${ico("check")}Claimed</span>` : html`<button class="btn s ${m.progress >= m.target ? "primary" : ""}" data-act="claim" data-k="${m.key}" ${m.progress < m.target ? "disabled" : ""}>Claim</button>`}</div>`)}</div>
    ${sec("Challenges", html`<button class="btn s primary" data-act="newch" ${locked ? "disabled" : ""}>${ico("plus")}Challenge</button>`)}${ch.length ? html`<div class="card flush">${ch.map(c => { const [k, l] = outChip(c.status); return html`<div class="li" style="flex-wrap:wrap"><span class="grow"><b class="trunc" style="display:block">${c.title}</b><span class="mut xs">${c.a} vs ${c.b}</span></span><span class="chip ${k}">${l}</span><span class="row gap8" style="width:100%;justify-content:flex-end;empty-cells:hide">${c.status === "PROPOSED" && c.meIsB ? html`<button class="btn s primary" data-act="accept" data-id="${c.id}" data-y="1" ${locked ? "disabled" : ""}>Accept</button><button class="btn s" data-act="accept" data-id="${c.id}" data-y="0" ${locked ? "disabled" : ""}>Decline</button>` : ""}${["SCHEDULED", "REJECTED"].includes(c.status) ? html`<button class="btn s primary" data-act="submitres" data-id="${c.id}" data-a="${c.a}" data-b="${c.b}" ${locked ? "disabled" : ""}>Submit result</button>` : ""}${["PENDING_REVIEW", "APPROVED"].includes(c.status) ? html`<button class="btn s" data-act="dispute" data-id="${c.id}">Dispute</button>` : ""}</span></div>`; })}</div>` : html`<div class="card">${empty("swords", "No challenges yet", "Challenge another player to start climbing.")}</div>`}
    ${sec("Tournaments")}${ts.length ? html`<div class="card flush">${ts.map(t => html`<div class="li"><span class="grow b">${t.name}</span><span class="chip ${t.status === "PUBLISHED" ? "ok" : ""}">${t.status === "PUBLISHED" ? "Results in" : "Upcoming"}</span></div>`)}</div>` : html`<div class="card">${empty("trophy", "No tournaments yet")}</div>`}`, { title: "Play" });
  S.players = pl;
});
ACT.claim = async d => { await api(`/missions/${d.k}/claim`, { method: "POST" }); toast("Reward claimed", "ok"); await refreshMe(); go(); };
ACT.accept = async d => { await api(`/challenges/${d.id}/respond`, { method: "POST", body: { accept: d.y === "1" } }); toast(d.y === "1" ? "Challenge accepted" : "Challenge declined", "ok"); go(); };
ACT.newch = async () => {
  const opts = (S.players || []).filter(p => p.uid !== S.user.uid && !p.locked);
  if (!opts.length) return toast("No other players are available to challenge yet.");
  const ok = await sheet({ title: "Challenge a player", submit: "Send challenge", body: html`${field("Opponent", raw(`<select class="input" name="opponent">${opts.map(p => `<option value="${esc(p.uid)}">${esc(p.displayName)} · ${esc(p.arenaId)}</option>`).join("")}</select>`))}${field("Title", inp("title", { max: 80, ph: "Friday 1v1", req: true }))}${field("Rules", inp("rules", { max: 500, ph: "Optional" }))}`,
    onSubmit: f => api("/challenges", { method: "POST", body: { opponent: f.opponent.value, title: f.title.value, rules: f.rules.value } }) });
  if (ok) { toast("Challenge sent", "ok"); go(); }
};
const winnerFields = (a, b, v = {}) => html`<div class="seg" role="radiogroup" aria-label="Winner" style="margin-bottom:12px">${[["A", a + " won"], ["B", b + " won"], ["draw", "Draw"]].map(([k, l], i) => html`<button type="button" role="radio" data-win="${k}" class="${(v.winner || "A") === k ? "on" : ""}" aria-checked="${(v.winner || "A") === k}">${l}</button>`)}</div><input type="hidden" name="winner" value="${v.winner || "A"}"><div class="grid g2">${field(a + " score", inp("scoreA", { mode: "numeric", value: v.scoreA ?? "0" }))}${field(b + " score", inp("scoreB", { mode: "numeric", value: v.scoreB ?? "0" }))}</div>`;
const wireWinner = form => $$("[data-win]", form).forEach(b => (b.onclick = () => { form.elements.winner.value = b.dataset.win; $$("[data-win]", form).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); }); }));
const resBody = f => ({ winner: f.winner.value, scoreA: f.scoreA.value, scoreB: f.scoreB.value });
ACT.submitres = async d => { const ok = await sheet({ title: "Submit result", sub: "An admin reviews it before XP and rating change.", submit: "Submit for review", body: winnerFields(d.a, d.b), onOpen: wireWinner, onSubmit: f => api(`/challenges/${d.id}/submit`, { method: "POST", body: resBody(f) }) }); if (ok) { toast("Submitted for review", "ok"); go(); } };
ACT.dispute = async d => { const ok = await sheet({ title: "Dispute this result", submit: "Send dispute", body: field("What's wrong?", raw(`<textarea class="input" name="reason" minlength="10" maxlength="500" placeholder="At least 10 characters"></textarea>`)), onSubmit: f => api(`/challenges/${d.id}/dispute`, { method: "POST", body: { reason: f.reason.value } }) }); if (ok) { toast("Dispute sent to the admins", "ok"); go(); } };

// ---------- Home dispatcher ----------
route(/^\/$/, async ctx => {
  if (waiting(ctx)) return;
  if (!S.user) return (location.hash = "#/leaderboard");
  const r = S.me?.role;
  if (r === "owner" || r === "admin") return (location.replace("#/admin"));
  if (r === "player" && S.me.card) return homePlayer(ctx);
  if (r === "pending" || r === "rejected") return pendingView(ctx);
  registerView(ctx);
});

async function exportData() {
  const r = await authedFetch("/api/admin/export"); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export failed");
  const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `ff-arena-export-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
}
// ---------- Admin (lazy) ----------
const K = { exportData, S, api, html, raw, esc, ico, avatar, badge, starsHtml, sheet, confirmSheet, toast, paint, chrome, ACT, FORMS, fmt, ago, signed, go, field, inp, empty, skelRows, skelHero, errorView, sec, tile, heroCard, statGrid, modeStats, recentList, themePicker, kdVal, kdCalc, sourceLabel, uuid, debounce, hydrate, refreshMe, ADMIN_SECTIONS, DASH, uidRow, rankName, setTheme, blobs };
let adminMod = null;
route(/^\/admin(\/.*)?$/, async ctx => {
  if (waiting(ctx, "Admin")) return;
  if (!["owner", "admin"].includes(S.me?.role)) return (location.replace("#/"));
  paint(ctx, skelRows(4), { title: "Admin" });
  adminMod = adminMod || (await import("/admin.js"));
  await adminMod.admin(ctx, K);
});

// ---------- Boot ----------
async function boot() {
  go(); // the public leaderboard needs no sign-in, so it renders while Firebase loads
  api("/meta").then(m => { S.meta = m; buildSprite(m.ranks); if (S.authReady) go(); }).catch(() => {});
  try {
    const [cfg, appMod, authMod] = await Promise.all([fetch("/api/config").then(r => r.json()), import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"), import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js")]);
    fb.mod = authMod; fb.auth = authMod.getAuth(appMod.initializeApp(cfg));
    authMod.onAuthStateChanged(fb.auth, async u => {
      cache.clear(); blobs.clear(); S.user = u; S.me = null; S.pending = 0;
      if (u) { try { await refreshMe(); } catch (e) { toast(e.message, "err"); } }
      S.authReady = true; go();
    });
  } catch { S.authReady = true; toast("Couldn't reach the sign-in service. Showing public pages only.", "err"); go(); }
}
setTheme(document.documentElement.dataset.theme);
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
boot();
