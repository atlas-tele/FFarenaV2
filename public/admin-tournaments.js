// FF Arena admin: tournament console. Loaded on demand for owners/admins. Every action is re-validated by the backend.
let S, api, html, raw, esc, ico, avatar, sheet, confirmSheet, toast, paint, ACT, FORMS, go, field, inp, empty, errorView, sec, skelRows, authedFetch, fmt;
let inited = false;
const A = {};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const when = ms => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const local = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const iso = v => { const d = new Date(v); if (!v || !Number.isFinite(d.getTime())) throw new Error("Pick a valid date and time."); return d.toISOString(); };
const nums = (s, name) => { const l = String(s || "").split(/[,\s]+/).filter(Boolean).map(Number); if (l.some(n => !Number.isFinite(n) || !Number.isInteger(n))) throw new Error(`${name} must be whole numbers separated by commas.`); return l; };
const reason = (v, name = "Reason") => { if (!v || v.trim().length < 3) throw new Error(name + " must be at least 3 characters."); return v.trim(); };
const reasonField = (req = true, ph = "Why is this needed?") => field("Reason" + (req ? "" : " (optional)"), raw(`<textarea class="input" name="reason" maxlength="200" placeholder="${esc(ph)}"></textarea>`));
const STATUS = { DRAFT: ["warn", "Draft"], PUBLISHED: ["info", "Published"], REGISTRATION_OPEN: ["ok", "Registration open"], REGISTRATION_CLOSED: ["warn", "Registration closed"], IN_PROGRESS: ["info", "In progress"], COMPLETED: ["", "Completed"], CANCELLED: ["bad", "Cancelled"] };
const chip = s => { const [k, l] = STATUS[s] || ["", s]; return html`<span class="chip ${k}">${l}</span>`; };
const ENTRY = { FORMING: ["info", "Forming"], PENDING_APPROVAL: ["warn", "Needs approval"], REGISTERED: ["ok", "Registered"], WITHDRAWN: ["", "Withdrawn"], REJECTED: ["bad", "Rejected"], DISQUALIFIED: ["bad", "Disqualified"] };
const NEXT = { PUBLISHED: ["Publish", "eye"], REGISTRATION_OPEN: ["Open registration", "check"], REGISTRATION_CLOSED: ["Close registration", "lock"] };
const Q = { d: null, names: new Map(), round: 0 };
const nm = id => (id && Q.names.get(id)) || "TBD";
const T = () => "/admin/arena-tournaments/" + Q.d.id;
const done = (msg, tab) => { toast(msg, "ok"); go(); };

function init(K) {
  if (inited) return; inited = true;
  ({ S, api, html, raw, esc, ico, avatar, sheet, confirmSheet, toast, paint, ACT, FORMS, go, field, inp, empty, errorView, sec, skelRows, authedFetch, fmt } = K);
  Object.assign(ACT, A);
}

// ---------- Screenshots: shrink in the browser, send as an image, never treated as verified data ----------
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP screenshot.");
  const bmp = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55, 0.4]) { const b = await new Promise(r => c.toBlob(r, "image/jpeg", q)); if (b && b.size <= 480 * 1024) return b; }
  throw new Error("That screenshot is too large even after shrinking. Crop it and try again.");
}
async function upload(file, label) {
  const blob = await shrink(file), r = await authedFetch(`/api${T()}/shots?label=${encodeURIComponent(label || "")}`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Upload failed"); return j.shotId;
}
const shotField = () => field("Screenshot (optional)", raw(`<input class="input" type="file" name="shot" accept="image/jpeg,image/png,image/webp">`), "A reference only. The numbers you type are what count, and you confirm them yourself.");
A.tn_shot = async d => { const r = await authedFetch(`/api${T()}/shots/${d.s}`); if (!r.ok) throw new Error("Couldn't open the screenshot"); window.open(URL.createObjectURL(await r.blob()), "_blank", "noopener"); };

// ---------- List ----------
export async function tournaments(ctx, K, id) {
  init(K);
  try { return id ? await detail(ctx, id) : await listPage(ctx); } catch (e) { paint(ctx, errorView(e), { title: "Tournaments", back: id ? "#/admin/tournaments" : "" }); }
}
async function listPage(ctx) {
  const rows = await api("/admin/arena-tournaments", { fresh: true });
  paint(ctx, html`<div style="margin-bottom:14px"><h1>Tournaments</h1><p class="mut sm">Create tournaments, run rounds and brackets, confirm results and pay XP once.</p></div><button class="btn primary block" data-act="tn_new" style="margin-bottom:12px">${ico("plus")}New tournament</button>
    ${rows.length ? html`<div class="card flush">${rows.map(t => html`<a class="li" href="#/admin/tournaments/${t.id}"><span class="grow"><b class="trunc" style="display:block">${t.name}</b><span class="mut xs">${t.modeLabel} · ${t.formatLabel} · ${t.entryCount}/${t.capacity} · ${when(t.startsAt)}</span></span>${chip(t.status)}</a>`)}</div>` : html`<div class="card">${empty("trophy", "No tournaments yet", "Create the first one. It starts as a private draft.")}</div>`}`, { title: "Tournaments" });
}

// ---------- Create / edit ----------
function formBody(v = {}) {
  const sc = v.scoring || { placementPoints: [12, 9, 8, 7, 6, 5, 4, 3, 2, 1], killPoints: 1, winBonus: 0 }, rc = v.roundsConfig || { count: 1, gamesPerRound: 3, qualifiers: [] };
  const sel = (n, opts, cur) => raw(`<select class="input" name="${n}">${opts.map(([k, l]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${l}</option>`).join("")}</select>`);
  return html`${field("Name", inp("name", { value: v.name || "", max: 80, ph: "Friday Squad Cup" }))}${field("Description", raw(`<textarea class="input" name="description" maxlength="1000" placeholder="What is this event?">${esc(v.description || "")}</textarea>`))}
    <div class="grid g2">${field("Mode", sel("mode", [["solo", "Solo (1 player)"], ["duo", "Duo (2 players)"], ["squad", "Squad (4 players)"]], v.mode || "squad"))}${field("Format", sel("format", [["points", "Battle Royale Points"], ["knockout", "Knockout bracket"]], v.format || "points"))}</div>
    <div class="grid g2">${field("Max players / teams", inp("capacity", { mode: "numeric", value: v.capacity ?? 12 }))}${field("Entries need approval?", sel("approval", [["auto", "No, instant"], ["manual", "Yes, admin approves"]], v.approval || "auto"))}</div>
    ${field("Registration opens", raw(`<input class="input" type="datetime-local" name="regOpensAt" value="${v.regOpensAt ? local(v.regOpensAt) : ""}">`))}${field("Registration closes", raw(`<input class="input" type="datetime-local" name="regClosesAt" value="${v.regClosesAt ? local(v.regClosesAt) : ""}">`))}${field("Tournament starts", raw(`<input class="input" type="datetime-local" name="startsAt" value="${v.startsAt ? local(v.startsAt) : ""}">`))}
    <div data-points>${sec("Scoring")}${field("Placement points (1st, 2nd, 3rd…)", inp("pp", { value: sc.placementPoints.join(", ") }), "Whole numbers separated by commas. Places beyond the list score 0.")}<div class="grid g2">${field("Points per kill", inp("kp", { mode: "numeric", value: sc.killPoints }))}${field("Bonus for a win", inp("wb", { mode: "numeric", value: sc.winBonus }))}</div>
      <div class="grid g2">${field("Rounds", inp("rounds", { mode: "numeric", value: rc.count }))}${field("Games per round", inp("games", { mode: "numeric", value: rc.gamesPerRound }))}</div>${field("Qualifiers after each round", inp("qual", { value: rc.qualifiers.join(", ") }), "One number per round except the last, e.g. 24, 12. Leave empty for a single round.")}</div>
    <div data-ko hidden>${field("Seeding", sel("seeding", [["registration", "Registration order (earliest = top seed)"], ["random", "Random (seed saved so it can be re-checked)"]], v.seeding || "registration"))}</div>
    ${sec("XP rewards")}${field("XP per player by final place", inp("xp", { value: (v.placementXp || v.rewards?.placementXp || [100, 60, 40]).join(", ") }), "1st, 2nd, 3rd… Paid once after the final is confirmed. Blank = no reward.")}${field("Rules", raw(`<textarea class="input" name="rules" maxlength="2000" placeholder="Map, weapon limits, check-in time…">${esc(v.rules || "")}</textarea>`))}`;
}
const toggleFmt = f => { const p = f.format.value === "points"; $("[data-points]", f).hidden = !p; $("[data-ko]", f).hidden = p; };
function readForm(f) {
  const format = f.format.value, body = { name: f.elements.name.value, description: f.description.value, rules: f.rules.value, mode: f.mode.value, format, approval: f.approval.value, capacity: Number(f.capacity.value),
    regOpensAt: iso(f.regOpensAt.value), regClosesAt: iso(f.regClosesAt.value), startsAt: iso(f.startsAt.value), seeding: f.seeding.value, rewards: { placementXp: nums(f.xp.value, "XP rewards") } };
  if (format === "points") { body.scoring = { placementPoints: nums(f.pp.value, "Placement points"), killPoints: Number(f.kp.value), winBonus: Number(f.wb.value || 0) }; body.roundsConfig = { count: Number(f.rounds.value), gamesPerRound: Number(f.games.value), qualifiers: nums(f.qual.value, "Qualifiers") }; }
  return body;
}
A.tn_new = async () => { const ok = await sheet({ title: "New tournament", sub: "Saved as a private draft. Publish it when you're ready.", body: formBody(), submit: "Create draft", onOpen: f => { toggleFmt(f); f.format.onchange = () => toggleFmt(f); }, onSubmit: f => api("/admin/arena-tournaments", { method: "POST", body: readForm(f) }) }); if (ok) { toast("Draft created", "ok"); go(); } };
A.tn_edit = async () => {
  const d = Q.d, locked = d.entries.some(e => !["REJECTED", "WITHDRAWN"].includes(e.status));
  const ok = await sheet({ title: "Edit tournament", sub: locked ? "Players have registered, so mode and format are locked." : "", body: formBody(d), submit: "Save changes", onOpen: f => { toggleFmt(f); f.format.onchange = () => toggleFmt(f); if (locked) { f.mode.disabled = true; f.format.disabled = true; } },
    onSubmit: f => { f.mode.disabled = false; f.format.disabled = false; return api(`${T()}`, { method: "PATCH", body: readForm(f) }); } });
  if (ok) { toast("Saved", "ok"); go(); }
};

// ---------- Detail ----------
async function detail(ctx, id) {
  const d = await api("/admin/arena-tournaments/" + encodeURIComponent(id), { fresh: true });
  Q.d = d; Q.names = new Map(d.entries.map(e => [e.id, e.name]));
  const tab = ctx.q.get("t") || "overview", started = ["IN_PROGRESS", "COMPLETED"].includes(d.status), openReports = d.disputes.filter(x => x.status === "OPEN").length;
  const tabs = [["overview", "Overview"], ["entries", `Entries (${d.entries.filter(e => !["REJECTED", "WITHDRAWN"].includes(e.status)).length})`], ["results", `Results${openReports ? " •" + openReports : ""}`]];
  const head = html`<div class="row sp" style="align-items:flex-start;gap:8px;margin-bottom:6px"><h1 class="wrap" style="margin:0">${d.name}</h1>${chip(d.status)}</div><p class="mut sm" style="margin-bottom:12px">${d.modeLabel} · ${d.formatLabel} · ${d.entryCount}/${d.capacity} ${d.teamSize === 1 ? "players" : "teams"}</p>
    <div class="seg" style="margin-bottom:14px">${tabs.map(([k, l]) => html`<button type="button" class="${tab === k ? "on" : ""}" onclick="location.hash='#/admin/tournaments/${id}?t=${k}'">${l}</button>`)}</div>`;
  const body = tab === "entries" ? entriesTab(d) : tab === "results" ? resultsTab(d, ctx) : overviewTab(d);
  paint(ctx, html`${head}${body}`, { title: d.name, back: "#/admin/tournaments" });
}

function overviewTab(d) {
  const next = d.nextStatuses.filter(s => s !== "CANCELLED"), canEdit = !["COMPLETED", "CANCELLED"].includes(d.status);
  return html`<div class="card"><div class="grid g2"><div class="tile"><b style="font-size:14px">${when(d.regOpensAt)}</b><span>Registration opens</span></div><div class="tile"><b style="font-size:14px">${when(d.regClosesAt)}</b><span>Registration closes</span></div><div class="tile"><b style="font-size:14px">${when(d.startsAt)}</b><span>Starts</span></div><div class="tile"><b style="font-size:14px">${d.approval === "manual" ? "Approval needed" : "Instant"}</b><span>Entry approval</span></div></div>
    ${d.seedValue !== null ? html`<p class="mut xs" style="margin-top:8px">Random seed used: ${d.seedValue}</p>` : ""}
    <div class="grid g2" style="margin-top:12px">${next.map(s => html`<button class="btn primary" data-act="tn_status" data-to="${s}">${ico(NEXT[s]?.[1] || "check")}${NEXT[s]?.[0] || s}</button>`)}${d.status === "REGISTRATION_CLOSED" ? html`<button class="btn primary" data-act="tn_start">${ico("bolt")}Start tournament</button>` : ""}${canEdit ? html`<button class="btn" data-act="tn_edit">${ico("edit")}Edit</button>` : ""}${d.nextStatuses.includes("CANCELLED") ? html`<button class="btn danger" data-act="tn_cancel">${ico("x")}Cancel tournament</button>` : ""}</div></div>
    ${d.status === "IN_PROGRESS" ? html`<div class="card warnc"><b>In progress</b><p class="sm">Enter and confirm results in the Results tab. Nothing advances until you confirm.</p></div>` : ""}
    ${sec("Rewards")}<div class="card">${d.placementXp.some(x => x > 0) ? d.placementXp.map((x, i) => (x > 0 ? html`<span class="chip warn">#${i + 1}: +${x} XP</span> ` : "")) : html`<span class="mut sm">No XP rewards.</span>`}</div>
    ${d.shots.length ? html`${sec("Screenshots (admin only)")}<div class="card flush">${d.shots.map(s => html`<button class="li" data-act="tn_shot" data-s="${s.id}"><span class="grow">${s.label || "Screenshot"} <span class="mut xs">${when(s.at)} · ${Math.round(s.size / 1024)} KB</span></span>${ico("eye")}</button>`)}</div>` : ""}`;
}
A.tn_status = async d => {
  const to = d.to, label = NEXT[to]?.[0] || to;
  if (!(await confirmSheet({ title: label + "?", confirm: label, body: html`<p class="mut">${to === "PUBLISHED" ? "Everyone can see it. Registration stays closed until you open it." : to === "REGISTRATION_OPEN" ? "Players can register until the closing time." : "Players can no longer register or change teams."}</p>` }))) return;
  await api(`${T()}/status`, { method: "POST", body: { to } }); done("Updated");
};
A.tn_cancel = async () => { const ok = await sheet({ title: "Cancel this tournament?", sub: "Registered players are notified. No XP is paid. This can't be undone.", body: reasonField(true, "Players see this"), submit: "Cancel tournament", danger: true, onSubmit: f => api(`${T()}/status`, { method: "POST", body: { to: "CANCELLED", reason: reason(f.reason.value) } }) }); if (ok) done("Tournament cancelled"); };
A.tn_start = async () => {
  const pv = await api(`${T()}/start`, { method: "POST", body: { preview: true } }), ko = pv.state.format === "knockout";
  const show = ko ? html`<p class="sm">${pv.entries} entries → a bracket of ${pv.state.bracket.size}. ${pv.state.bracket.rounds[0].matches.filter(m => m.status === "BYE").length} bye(s) go to the top seeds.</p><div class="preview stack">${pv.state.bracket.rounds[0].matches.map(m => html`<div class="sm">${nm(m.a)} <span class="mut">vs</span> ${m.status === "BYE" ? html`<span class="chip">bye</span>` : nm(m.b)}</div>`)}</div>${pv.seedValue !== null ? html`<p class="mut xs">Random seed ${pv.seedValue}</p>` : ""}`
    : html`<p class="sm">${pv.entries} ${Q.d.teamSize === 1 ? "players" : "teams"} start round 1.</p>`;
  if (!(await confirmSheet({ title: "Start the tournament?", confirm: "Start now", body: html`${show}<p class="mut xs">Registration is closed for good. Entries and the seeding can't change after this.</p>` }))) return;
  await api(`${T()}/start`, { method: "POST", body: { seedValue: pv.seedValue ?? undefined } }); done("Tournament started");
};

// ---------- Entries ----------
function entriesTab(d) {
  const can = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(d.status), live = e => ["FORMING", "PENDING_APPROVAL", "REGISTERED"].includes(e.status);
  return html`${can ? html`<button class="btn primary block" style="margin-bottom:12px" data-act="tn_addentry">${ico("plus")}Register ${d.teamSize === 1 ? "a player" : "a " + d.modeLabel.toLowerCase() + " team"}</button>` : ""}
    ${d.entries.length ? html`<div class="card flush">${d.entries.map(e => { const [k, l] = ENTRY[e.status] || ["", e.status]; return html`<div class="li" style="flex-wrap:wrap"><span class="grow" style="min-width:0"><b class="trunc" style="display:block">${e.name}</b><span class="mut xs wrap">${e.members.map(m => m.displayName + (m.arenaId ? " (" + m.arenaId + ")" : "")).join(", ")}${e.invited.length ? " · invited: " + e.invited.map(m => m.displayName).join(", ") : ""}</span>${e.memberDeleted ? html`<span class="chip warn" style="margin-top:4px">A member's account was deleted</span>` : ""}</span><span class="chip ${k}">${l}</span>
      <span class="row gap8" style="width:100%;justify-content:flex-end">${e.status === "PENDING_APPROVAL" ? html`<button class="btn s primary" data-act="tn_entry" data-k="approve" data-e="${e.id}">Approve</button>` : ""}${live(e) && d.status !== "IN_PROGRESS" && d.status !== "COMPLETED" ? html`<button class="btn s danger" data-act="tn_entry" data-k="reject" data-e="${e.id}">Reject</button>` : ""}${live(e) && d.status === "IN_PROGRESS" ? html`<button class="btn s danger" data-act="tn_entry" data-k="remove" data-e="${e.id}">Withdraw</button>` : ""}</span></div>`; })}</div>` : html`<div class="card">${empty("users", "No entries yet", "Players can register once registration is open, or you can add them here.")}</div>`}`;
}
A.tn_entry = async d => {
  const k = d.k; if (k === "approve") { await api(`${T()}/entries/${d.e}/approve`, { method: "POST", body: {} }); return done("Approved"); }
  const inProg = Q.d.status === "IN_PROGRESS";
  const ok = await sheet({ title: inProg ? "Withdraw this entry?" : "Reject this entry?", sub: inProg ? "It stays in the rosters so results stay consistent. Record walkovers or no-shows for its matches." : "The spot is freed and the players are told why.", body: reasonField(true, "Players see this"), submit: inProg ? "Withdraw" : "Reject", danger: true, onSubmit: f => api(`${T()}/entries/${d.e}/${inProg ? "remove" : k}`, { method: "POST", body: { reason: reason(f.reason.value) } }) });
  if (ok) done(inProg ? "Withdrawn" : "Rejected");
};
A.tn_addentry = async () => {
  const d = Q.d, pl = await api("/admin/players?status=active"), opts = pl.map(p => `<option value="${esc(p.arenaId)}">${esc(p.displayName)} · ${esc(p.arenaId)}</option>`).join("");
  const ok = await sheet({ title: d.teamSize === 1 ? "Register a player" : `Register a ${d.modeLabel} team`, submit: "Register", body: html`${d.teamSize > 1 ? field("Team name", inp("team", { max: 30 })) : ""}${Array.from({ length: d.teamSize }, (_, i) => field(d.teamSize === 1 ? "Player" : i === 0 ? "Captain" : "Player " + (i + 1), raw(`<select class="input" name="p${i}">${opts}</select>`)))}`,
    onOpen: f => { for (let i = 1; i < d.teamSize; i++) if (f.elements["p" + i].options.length > i) f.elements["p" + i].selectedIndex = i; },
    onSubmit: f => { const ids = Array.from({ length: d.teamSize }, (_, i) => f.elements["p" + i].value); if (new Set(ids).size !== ids.length) throw new Error("Pick different players."); return api(`${T()}/entries`, { method: "POST", body: { arenaIds: ids, name: d.teamSize > 1 ? f.team.value.trim() : undefined } }); } });
  if (ok) done("Registered");
};

// ---------- Results ----------
const clean = (t, k) => t.entries.filter(e => k.includes(e.id));
function resultsTab(d, ctx) {
  if (!d.state) return html`<div class="card">${empty("clock", "Not started yet", "Results open once you start the tournament.")}</div>${reportsBlock(d)}`;
  const body = d.state.format === "points" ? pointsAdmin(d, ctx) : bracketAdmin(d);
  const finish = d.status === "IN_PROGRESS" ? html`${sec("Finish")}<div class="card"><p class="sm">When the last results are confirmed, complete the tournament to lock results and pay XP once.</p><button class="btn primary block" data-act="tn_complete">${ico("trophy")}Review and complete</button></div>` : d.status === "COMPLETED" ? html`<div class="card accent"><b>Completed.</b> Results are locked. Use an XP adjustment (with a reason) for any later correction.</div>` : "";
  return html`${body}${finish}${reportsBlock(d)}`;
}
function reportsBlock(d) {
  const open = d.disputes.filter(x => x.status === "OPEN");
  if (!d.disputes.length) return "";
  return html`${sec("Player reports", html`<span class="chip ${open.length ? "warn" : ""}">${open.length} open</span>`)}<div class="card flush">${d.disputes.slice(0, 20).map(x => html`<div class="li" style="flex-wrap:wrap"><span class="grow wrap"><b>${x.ref.matchId ? "Match " + x.ref.matchId : `Round ${x.ref.round}, game ${x.ref.game}`}</b> <span class="mut xs">by ${x.by}</span><div class="sm wrap">${x.reason}</div>${x.note ? html`<div class="mut xs">Resolved: ${x.note}</div>` : ""}</span>${x.status === "OPEN" ? html`<button class="btn s" data-act="tn_resolve" data-id="${x.id}">Resolve</button>` : html`<span class="chip">Resolved</span>`}</div>`)}</div>`;
}
A.tn_resolve = async d => { const ok = await sheet({ title: "Resolve report", body: field("What did you find?", raw(`<textarea class="input" name="note" maxlength="200"></textarea>`)), submit: "Resolve", onSubmit: f => api(`${T()}/disputes/${d.id}/resolve`, { method: "POST", body: { note: reason(f.note.value, "Note") } }) }); if (ok) done("Resolved"); };

// ----- points -----
const stRow = s => html`<div class="li stand"><b class="pos">${s.rank}</b><span class="grow"><b class="trunc" style="display:block">${nm(s.entryId)}</b>${s.tied ? html`<span class="chip warn">Tied</span>` : ""}</span><span class="num"><b>${s.points}</b> <span class="mut xs">pts</span><br><span class="mut xs">${s.kills} kills</span></span></div>`;
function pointsAdmin(d, ctx) {
  const rounds = d.state.rounds, active = rounds.find(r => r.status === "ACTIVE"), cur = Number(ctx.q.get("r")) || Q.round || (active || rounds[0]).number; Q.round = cur;
  const r = rounds.find(x => x.number === cur) || rounds[0], last = r.number === d.roundsConfig.count, editable = d.status === "IN_PROGRESS" && r.status === "ACTIVE";
  const ties = r.standings.filter(s => s.tied && !s.resolved), allConf = r.games.every(g => g.status === "CONFIRMED");
  return html`<div class="seg" style="margin-bottom:12px">${rounds.map(x => html`<button type="button" class="${x.number === cur ? "on" : ""}" onclick="location.hash='#/admin/tournaments/${d.id}?t=results&r=${x.number}'">${x.number === d.roundsConfig.count ? "Final" : "Round " + x.number}</button>`)}</div>
    <div class="row sp" style="margin-bottom:8px"><span class="mut sm">${r.status === "PENDING" ? "Waits for the previous round" : `${r.entryIds.length} ${d.teamSize === 1 ? "players" : "teams"}`}</span><span class="chip ${r.status === "ACTIVE" ? "info" : r.status === "ADVANCED" ? "ok" : ""}">${r.status === "ADVANCED" ? "Advanced" : r.status === "ACTIVE" ? "Active" : "Pending"}</span></div>
    ${r.games.map(g => html`<div class="card"><div class="row sp"><b>Game ${g.n}</b><span class="chip ${g.status === "CONFIRMED" ? "ok" : g.status === "SUBMITTED" ? "warn" : ""}">${g.status === "EMPTY" ? "No result" : g.status === "SUBMITTED" ? "Awaiting confirmation" : "Confirmed"}</span></div>
      ${g.status !== "EMPTY" ? html`<p class="mut xs" style="margin-top:6px">Entered ${when(g.submittedAt)}${g.confirmedAt ? " · confirmed " + when(g.confirmedAt) : ""}${g.corrections.length ? ` · ${g.corrections.length} correction${g.corrections.length > 1 ? "s" : ""}` : ""}</p>${g.shotId ? html`<button class="chip" data-act="tn_shot" data-s="${g.shotId}">${ico("eye")}Screenshot</button>` : ""}` : ""}
      ${editable ? html`<div class="grid g2" style="margin-top:10px"><button class="btn" data-act="tn_game" data-r="${r.number}" data-g="${g.n}">${ico("edit")}${g.status === "EMPTY" ? "Enter results" : "Correct"}</button>${g.status === "SUBMITTED" ? html`<button class="btn primary" data-act="tn_gconfirm" data-r="${r.number}" data-g="${g.n}">${ico("check")}Confirm</button>` : ""}</div>` : ""}</div>`)}
    ${r.status !== "PENDING" ? html`${sec("Standings", html`<span class="mut xs">${allConf ? "confirmed" : "includes unconfirmed games"}</span>`)}<div class="card flush">${(allConf ? r.standings : r.draftStandings || r.standings).map(stRow)}</div>` : ""}
    ${editable && ties.length ? html`<div class="card warnc"><b>${ties.length} tied ${ties.length === 1 ? "entry" : "entries"}</b><p class="sm">Entries level on points, kills and best placement need an admin ruling before they can be placed. Nobody is picked automatically.</p><button class="btn block" data-act="tn_tie" data-r="${r.number}">Resolve tie</button></div>` : ""}
    ${editable && !last ? html`<button class="btn primary block" ${allConf ? "" : "disabled"} data-act="tn_advance" data-r="${r.number}">${ico("chevR")}Review advancement</button>${allConf ? "" : html`<p class="mut xs center" style="margin-top:6px">Confirm every game to enable advancement.</p>`}` : ""}
    ${d.status === "IN_PROGRESS" && r.status === "ADVANCED" ? html`<button class="btn block" data-act="tn_reopen" data-r="${r.number}">${ico("history")}Reopen this round to correct results</button>` : ""}`;
}
function gameSheetBody(r, g) {
  const prev = new Map((g.rows || []).map(x => [x.entryId, x]));
  return html`<div class="stack">${r.entryIds.map((id, i) => { const p = prev.get(id) || {}; return html`<div class="tile"><b class="trunc" style="display:block;margin-bottom:6px">${nm(id)}</b><div class="grid g2"><input class="input" name="pl_${i}" inputmode="numeric" placeholder="Placement" value="${p.placement ?? ""}"><input class="input" name="k_${i}" inputmode="numeric" placeholder="Kills" value="${p.kills ?? 0}"></div>
    <div class="grid g2" style="margin-top:6px"><input class="input" name="pt_${i}" inputmode="numeric" placeholder="Total pts (optional)" value="${p.pointsOverride ?? ""}"><label class="row gap8 sm"><input type="checkbox" name="ns_${i}" ${p.noShow ? "checked" : ""}> No show</label></div></div>`; })}</div>${shotField()}`;
}
A.tn_game = async d => {
  const r = Q.d.state.rounds[Number(d.r) - 1], g = r.games[Number(d.g) - 1], correcting = g.status === "CONFIRMED";
  const readRows = f => r.entryIds.map((id, i) => ({ entryId: id, noShow: f.elements["ns_" + i].checked, placement: f.elements["pl_" + i].value.trim() === "" ? undefined : Number(f.elements["pl_" + i].value), kills: Number(f.elements["k_" + i].value || 0), pointsOverride: f.elements["pt_" + i].value.trim() === "" ? undefined : Number(f.elements["pt_" + i].value) }));
  let prev = null, file = null, why = "";
  const ok = await sheet({ title: `Round ${r.number}, game ${g.n}`, sub: correcting ? "This game was confirmed. A correction needs a reason and must be confirmed again." : "Enter what happened. You'll see the calculated points before saving.", submit: "Preview", body: html`${gameSheetBody(r, g)}${correcting ? reasonField(true, "What was wrong?") : ""}`,
    onSubmit: async f => { const rows = readRows(f); if (correcting) why = reason(f.reason.value); file = f.shot.files[0] || null; prev = { rows, pv: await api(`${T()}/rounds/${r.number}/games/${g.n}/submit`, { method: "POST", body: { rows, preview: true, reason: why || undefined } }) }; } });
  if (!ok || !prev) return;
  const pts = new Map(prev.pv.rows.map(x => [x.entryId, x]));
  if (!(await confirmSheet({ title: "Save these results?", confirm: "Save (not yet confirmed)", body: html`<div class="preview stack">${[...prev.pv.rows].sort((a, b) => b.points - a.points).map(x => html`<div class="row sp sm"><span class="trunc">${x.noShow ? "no show" : "#" + (x.placement ?? "·")} ${nm(x.entryId)}</span><b>${x.points} pts</b></div>`)}</div>${sec("Standings with this game")}<div class="preview stack">${prev.pv.standings.map(s => html`<div class="row sp sm"><span class="trunc">${s.rank}. ${nm(s.entryId)}${s.tied ? " (tied)" : ""}</span><b>${s.points}</b></div>`)}</div><p class="mut xs">Saving does not advance anyone. You confirm separately.</p>` }))) return;
  const shotId = file ? await upload(file, `R${r.number} G${g.n}`) : undefined;
  await api(`${T()}/rounds/${r.number}/games/${g.n}/submit`, { method: "POST", body: { rows: prev.rows, shotId, reason: why || undefined } }); done("Saved. Confirm it when you're happy");
};
A.tn_gconfirm = async d => {
  const g = Q.d.state.rounds[Number(d.r) - 1].games[Number(d.g) - 1];
  if (!(await confirmSheet({ title: "Confirm this game?", confirm: "Confirm results", body: html`<div class="preview stack">${[...g.rows].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99)).map(x => html`<div class="row sp sm"><span class="trunc">${x.noShow ? "no show" : "#" + x.placement} ${nm(x.entryId)}</span><b>${x.points}</b></div>`)}</div><p class="mut xs">Confirmed results count for standings and advancement. Later changes are logged as corrections.</p>` }))) return;
  await api(`${T()}/rounds/${d.r}/games/${d.g}/confirm`, { method: "POST", body: {} }); done("Confirmed");
};
A.tn_tie = async d => {
  const r = Q.d.state.rounds[Number(d.r) - 1], tied = r.standings.filter(s => s.tied && !s.resolved), first = tied[0].rank, group = tied.filter(s => s.rank === first);
  const ok = await sheet({ title: "Resolve a tie", sub: `${group.length} entries are level for place ${first}. Give each a finishing order.`, submit: "Save ruling", body: html`${group.map((s, i) => field(nm(s.entryId), inp("o_" + i, { mode: "numeric", value: i + 1 }), "1 = finishes highest"))}${reasonField(true, "Why this order? (e.g. replay review)")}`,
    onSubmit: f => { const pos = group.map((_, i) => Number(f.elements["o_" + i].value)); if (new Set(pos).size !== pos.length || pos.some(p => !Number.isInteger(p) || p < 1 || p > group.length)) throw new Error(`Use each of 1 to ${group.length} exactly once.`); const ids = group.map((s, i) => [pos[i], s.entryId]).sort((a, b) => a[0] - b[0]).map(x => x[1]); return api(`${T()}/rounds/${d.r}/tie`, { method: "POST", body: { ids, reason: reason(f.reason.value) } }); } });
  if (ok) done("Tie resolved");
};
A.tn_advance = async d => {
  const pv = await api(`${T()}/rounds/${d.r}/advance`, { method: "POST", body: { preview: true } });
  if (!(await confirmSheet({ title: `Advance from round ${d.r}?`, confirm: "Advance", body: html`<p class="sm"><b>${pv.qualifiers.length} advance</b>, ${pv.eliminated.length} are eliminated.</p><div class="preview stack">${pv.standings.map(s => html`<div class="row sp sm"><span class="trunc">${s.rank}. ${nm(s.entryId)}</span><span>${pv.qualifiers.includes(s.entryId) ? html`<span class="chip ok">advances</span>` : html`<span class="chip">out</span>`} <b>${s.points}</b></span></div>`)}</div><p class="mut xs">Earlier results stay on record. If you find a mistake later, you can reopen the round.</p>` }))) return;
  await api(`${T()}/rounds/${d.r}/advance`, { method: "POST", body: {} }); Q.round = Number(d.r) + 1; done("Advanced");
};
A.tn_reopen = async d => { const ok = await sheet({ title: `Reopen round ${d.r}?`, sub: "The next round's roster is cleared (only possible while it has no results). Re-advancing recalculates it from the corrected results.", body: reasonField(true, "What needs correcting?"), submit: "Reopen", danger: true, onSubmit: f => api(`${T()}/rounds/${d.r}/reopen`, { method: "POST", body: { reason: reason(f.reason.value) } }) }); if (ok) { Q.round = Number(d.r); done("Round reopened"); } };

// ----- knockout -----
function bracketAdmin(d) {
  const b = d.state.bracket, edit = d.status === "IN_PROGRESS", wd = new Set(d.entries.filter(e => ["WITHDRAWN", "DISQUALIFIED"].includes(e.status)).map(e => e.id));
  return html`${sec("Bracket")}<div class="bracket" role="region" aria-label="Knockout bracket" tabindex="0">${b.rounds.map(rd => html`<div class="bcol"><h3 class="bhead">${rd.name}</h3>${rd.matches.map(m => {
    const side = (id, sc) => html`<div class="bside ${m.winner && m.winner === id ? "win" : m.winner && id ? "lose" : ""}"><span class="trunc">${id ? nm(id) + (wd.has(id) ? " (withdrawn)" : "") : "TBD"}</span>${sc !== null && sc !== undefined ? html`<b>${sc}</b>` : ""}</div>`;
    return html`<div class="bm ${m.status.toLowerCase()}">${side(m.a, m.scoreA)}${side(m.b, m.scoreB)}<div class="bmeta">${m.status === "SUBMITTED" ? `Awaiting confirmation: ${nm(m.pendingWinner) === "TBD" ? "double forfeit" : nm(m.pendingWinner)}` : m.status === "CONFIRMED" ? (m.forfeitBoth ? "Double forfeit" : m.walkover ? "Walkover" : "Confirmed") : m.status === "READY" ? "Ready" : m.status === "BYE" ? "Bye" : m.status === "VOID" ? "No match" : "Waiting"}${m.corrections.length ? ` · ${m.corrections.length} correction${m.corrections.length > 1 ? "s" : ""}` : ""}</div>
      ${edit && m.status === "READY" ? html`<button class="btn s block" data-act="tn_match" data-m="${m.id}">Enter result</button>` : ""}${edit && m.status === "SUBMITTED" ? html`<div class="grid g2"><button class="btn s primary" data-act="tn_mconfirm" data-m="${m.id}">Confirm</button><button class="btn s" data-act="tn_match" data-m="${m.id}">Edit</button></div>` : ""}${edit && m.status === "CONFIRMED" ? html`<div class="grid g2"><button class="btn s" data-act="tn_match" data-m="${m.id}">Correct</button><button class="btn s" data-act="tn_mreopen" data-m="${m.id}">Reopen</button></div>` : ""}${m.shotId ? html`<button class="chip" data-act="tn_shot" data-s="${m.shotId}">Screenshot</button>` : ""}</div>`; })}</div>`)}</div>`;
}
const findMatch = id => Q.d.state.bracket.rounds.flatMap(r => r.matches).find(m => m.id === id);
A.tn_match = async d => {
  const m = findMatch(d.m), wd = new Set(Q.d.entries.filter(e => ["WITHDRAWN", "DISQUALIFIED"].includes(e.status)).map(e => e.id)), correcting = m.status === "CONFIRMED", anyWd = wd.has(m.a) || wd.has(m.b);
  let file = null;
  const ok = await sheet({ title: `${nm(m.a)} vs ${nm(m.b)}`, sub: correcting ? "Confirmed already. A correction needs a reason and a new confirmation." : "Saving doesn't advance anyone. You confirm it next.", submit: "Save result",
    body: html`<div class="seg" role="radiogroup" aria-label="Winner" style="margin-bottom:12px">${[[m.a, nm(m.a)], [m.b, nm(m.b)]].map(([id, l], i) => html`<button type="button" role="radio" data-w="${id}" class="${(m.pendingWinner || m.winner) === id ? "on" : ""}">${l} won</button>`)}</div><input type="hidden" name="winner" value="${m.pendingWinner || m.winner || ""}">
      <div class="grid g2">${field("Score " + nm(m.a), inp("sa", { mode: "numeric", value: m.scoreA ?? "" }))}${field("Score " + nm(m.b), inp("sb", { mode: "numeric", value: m.scoreB ?? "" }))}</div>
      ${anyWd ? html`<label class="row gap8 sm" style="margin-bottom:8px"><input type="checkbox" name="walkover" ${m.walkover ? "checked" : ""}> Walkover (opponent withdrew)</label>` : ""}${wd.has(m.a) && wd.has(m.b) ? html`<label class="row gap8 sm" style="margin-bottom:8px"><input type="checkbox" name="both"> Both withdrew: void this match</label>` : ""}
      ${field("Notes (optional)", inp("note", { max: 300, value: m.note || "" }))}${correcting ? reasonField(true, "What was wrong?") : ""}${shotField()}`,
    onOpen: f => $$("[data-w]", f).forEach(b => (b.onclick = () => { f.winner.value = b.dataset.w; $$("[data-w]", f).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); }); })),
    onSubmit: async f => { const both = f.elements.both?.checked; if (!both && !f.winner.value) throw new Error("Pick the winner."); file = f.shot.files[0] || null;
      const shotId = file ? await upload(file, m.id) : undefined;
      return api(`${T()}/matches/${m.id}/submit`, { method: "POST", body: { winner: both ? undefined : f.winner.value, scoreA: f.sa.value.trim(), scoreB: f.sb.value.trim(), walkover: !!f.elements.walkover?.checked, forfeitBoth: !!both, note: f.note.value.trim(), reason: correcting ? reason(f.reason.value) : undefined, shotId } }); } });
  if (ok) done("Saved. Confirm it to advance the winner");
};
A.tn_mconfirm = async d => {
  const m = findMatch(d.m);
  if (!(await confirmSheet({ title: "Confirm this result?", confirm: "Confirm and advance", body: html`<p class="sm">${m.pendingWinner ? html`<b>${nm(m.pendingWinner)}</b> advances` : "Neither entry advances (double forfeit)"}.</p><p class="mut xs">The winner is placed in the next round only now.</p>` }))) return;
  await api(`${T()}/matches/${d.m}/confirm`, { method: "POST", body: {} }); done("Confirmed");
};
A.tn_mreopen = async d => { const ok = await sheet({ title: "Reopen this result?", sub: "The winner is taken out of the next round. Only possible while the next match has no result.", body: reasonField(true, "What needs correcting?"), submit: "Reopen", danger: true, onSubmit: f => api(`${T()}/matches/${d.m}/reopen`, { method: "POST", body: { reason: reason(f.reason.value) } }) }); if (ok) done("Reopened"); };

// ----- complete -----
A.tn_complete = async () => {
  const pv = await api(`${T()}/complete`, { method: "POST", body: { preview: true } });
  if (!(await confirmSheet({ title: "Complete the tournament?", confirm: "Complete and pay XP", danger: true, body: html`<p class="sm"><b>Champion: ${pv.champion || "—"}</b></p><div class="preview stack">${pv.standings.slice(0, 12).map(s => html`<div class="row sp sm"><span class="trunc">${s.rank}. ${s.name}</span>${s.points !== undefined && s.points !== null ? html`<span>${s.points} pts</span>` : ""}</div>`)}</div>
    ${sec("XP to be paid")}${pv.rewards.length ? html`<div class="preview stack">${pv.rewards.map(r => html`<div class="row sp sm"><span class="trunc">#${r.rank} ${r.name}</span><b>+${r.xp} XP</b></div>`)}</div>` : html`<p class="mut sm">No XP rewards.</p>`}${pv.skipped ? html`<p class="mut xs">${pv.skipped} reward(s) skipped because the player no longer exists.</p>` : ""}<p class="mut xs">Rewards are paid exactly once. Results are locked afterwards.</p>` }))) return;
  await api(`${T()}/complete`, { method: "POST", body: {} }); done("Tournament completed. XP paid");
};
