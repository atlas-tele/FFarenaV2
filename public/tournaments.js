// FF Arena tournaments: player-facing pages. Loaded on demand. All rules are enforced by the server; this file only shows state and sends requests.
let S, api, html, raw, ico, avatar, sheet, confirmSheet, toast, paint, ACT, go, field, inp, empty, errorView, sec, skelRows, refreshMe;
let inited = false;
const A = {};
const $ = (s, r = document) => r.querySelector(s);
const RT = {}; // selected round tab per tournament

const when = ms => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const day = ms => (ms ? new Date(ms).toLocaleDateString([], { dateStyle: "medium" }) : "—");
const STATUS = { PUBLISHED: ["info", "Opening soon"], REGISTRATION_OPEN: ["ok", "Registration open"], REGISTRATION_CLOSED: ["warn", "Registration closed"], IN_PROGRESS: ["info", "In progress"], COMPLETED: ["", "Completed"], CANCELLED: ["bad", "Cancelled"], DRAFT: ["warn", "Draft"] };
const statusChip = t => { const [k, l] = STATUS[t.status] || ["", t.status]; return html`<span class="chip ${k}">${l}</span>`; };
const labelChips = t => html`<span class="chip">${t.modeLabel}</span><span class="chip">${t.formatLabel}</span>`;
const regLine = t => ({ open: `${t.spotsLeft} of ${t.capacity} spots left · closes ${when(t.regClosesAt)}`, not_open: `Registration opens ${when(t.regOpensAt)}`, closed: "Registration is closed", full: `Full · ${t.entryCount} of ${t.capacity}` }[t.registration] || "");
const unit = t => (t.teamSize === 1 ? "players" : "teams");

function init(K) {
  if (inited) return; inited = true;
  ({ S, api, html, raw, ico, avatar, sheet, confirmSheet, toast, paint, ACT, go, field, inp, empty, errorView, sec, skelRows, refreshMe } = K);
  Object.assign(ACT, A);
}

// ---------- List ----------
function card(t) {
  const mine = t.mine ? html`<span class="chip ok">${ico("check")}${t.mine.status === "FORMING" ? "Team forming" : t.mine.status === "PENDING_APPROVAL" ? "Awaiting approval" : "You're in"}</span>` : "";
  return html`<a class="card tcard" href="#/tournament/${t.id}"><div class="row sp" style="gap:8px;align-items:flex-start"><b class="wrap" style="font-size:16px">${t.name}</b>${statusChip(t)}</div>
    <div class="row gap8" style="flex-wrap:wrap;margin:8px 0">${labelChips(t)}${mine}</div>
    <div class="mut sm">Starts ${when(t.startsAt)}</div><div class="mut sm">${["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status) ? regLine(t) : t.status === "COMPLETED" && t.championName ? "Champion: " + t.championName : `${t.entryCount} ${unit(t)}`}</div></a>`;
}
export async function list(ctx, K) {
  init(K);
  let rows, inv = [];
  try { [rows, inv] = await Promise.all([api("/arena-tournaments", { fresh: true }), S.me?.role === "player" ? api("/arena-tournaments/invites", { fresh: true }).catch(() => []) : []]); }
  catch (e) { return paint(ctx, errorView(e), { title: "Tournaments" }); }
  const groups = [["Open for registration", t => t.status === "REGISTRATION_OPEN"], ["In progress", t => t.status === "IN_PROGRESS"], ["Coming up", t => ["PUBLISHED", "REGISTRATION_CLOSED"].includes(t.status)], ["Finished", t => ["COMPLETED", "CANCELLED"].includes(t.status)]];
  const body = rows.length ? groups.map(([title, f]) => { const g = rows.filter(f); return g.length ? html`${sec(title)}${g.map(card)}` : ""; })
    : html`<div class="card">${empty("flag", "No tournaments yet", "When an admin publishes one, it shows up here.")}</div>`;
  paint(ctx, html`<div style="margin-bottom:14px"><h1>Tournaments</h1><p class="mut sm">Solo, Duo and Squad events with brackets, points and XP rewards.</p></div>
    ${inv.length ? html`${sec("Team invitations")}${inv.map(i => html`<div class="card accent"><b class="wrap">${i.captain.displayName} invited you to “${i.teamName}”</b><div class="mut sm">${i.tournamentName}</div><div class="grid g2" style="margin-top:10px"><button class="btn primary" data-act="t_respond" data-t="${i.tournamentId}" data-e="${i.entryId}" data-y="1">Join team</button><button class="btn" data-act="t_respond" data-t="${i.tournamentId}" data-e="${i.entryId}" data-y="0">Decline</button></div></div>`)}` : ""}${body}`, { title: "Tournaments" });
}

// ---------- Details ----------
const Q = { emap: new Map() };
const nm = id => (id && Q.emap.get(id)?.name) || "TBD";
const members = e => (e && e.members.length > 1 ? html`<span class="mut xs wrap">${e.members.map(m => m.displayName).join(", ")}</span>` : "");

function myPanel(d) {
  const role = S.me?.role, m = d.mine?.entry, invs = d.mine?.invitations || [];
  if (!S.user) return html`<div class="card"><b>Want to play?</b><p class="mut sm">Sign in with your FF Arena account to register.</p><a class="btn primary block" href="#/auth">Sign in</a></div>`;
  if (role !== "player") return role === "owner" || role === "admin" ? html`<div class="card"><p class="mut sm">You're signed in as an admin. Manage this tournament from the admin area.</p><a class="btn block" href="#/admin/tournaments/${d.id}">Open in admin</a></div>` : html`<div class="card"><p class="mut sm">Only approved players can register for tournaments.</p></div>`;
  const inv = invs.length ? html`${invs.map(i => html`<div class="card accent"><b class="wrap">${i.captain.displayName} invited you to “${i.teamName}”</b><div class="grid g2" style="margin-top:10px"><button class="btn primary" data-act="t_respond" data-t="${d.id}" data-e="${i.entryId}" data-y="1">Join team</button><button class="btn" data-act="t_respond" data-t="${d.id}" data-e="${i.entryId}" data-y="0">Decline</button></div></div>`)}` : "";
  if (m) {
    const need = m.needs, forming = m.status === "FORMING", canLeave = ["REGISTRATION_OPEN", "PUBLISHED"].includes(d.status);
    const chip = m.status === "REGISTERED" ? html`<span class="chip ok">${ico("check")}Registered</span>` : m.status === "PENDING_APPROVAL" ? html`<span class="chip warn">Waiting for admin approval</span>` : m.status === "FORMING" ? html`<span class="chip info">Team forming</span>` : html`<span class="chip">${m.status}</span>`;
    return html`${inv}<div class="card accent"><div class="row sp"><b>${d.teamSize === 1 ? "Your registration" : m.name}</b>${chip}</div>
      ${d.teamSize > 1 ? html`<div class="stack" style="margin-top:10px">${m.members.map(p => html`<div class="row gap8">${avatar(p, "s")}<span class="grow trunc">${p.displayName}</span>${p.arenaId === m.captain ? html`<span class="chip">Captain</span>` : ""}</div>`)}${(m.invited || []).map(p => html`<div class="row gap8 mut">${avatar(p, "s")}<span class="grow trunc">${p.displayName}</span><span class="chip">Invited</span></div>`)}</div>` : ""}
      ${forming ? html`<p class="mut sm" style="margin-top:10px">A ${d.modeLabel} team needs exactly ${d.teamSize} players. ${need ? `Waiting for ${need} more.` : "Your team is full. Submit it to take a spot."}</p>` : ""}
      <div class="grid g2" style="margin-top:12px">${forming && m.isCaptain && need > (m.invited || []).length ? html`<button class="btn primary" data-act="t_invite" data-t="${d.id}" data-e="${m.id}">${ico("plus")}Invite a player</button>` : ""}${forming && m.isCaptain && !need ? html`<button class="btn primary" data-act="t_confirm" data-t="${d.id}" data-e="${m.id}">${ico("check")}Submit team</button>` : ""}${canLeave ? html`<button class="btn danger" data-act="t_leave" data-t="${d.id}" data-e="${m.id}" data-cap="${m.isCaptain ? 1 : 0}" data-solo="${d.teamSize === 1 ? 1 : 0}">${d.teamSize === 1 ? "Withdraw" : m.isCaptain ? "Disband team" : "Leave team"}</button>` : ""}</div></div>`;
  }
  if (d.registration === "open") return html`${inv}<div class="card"><b>${d.teamSize === 1 ? "Join this tournament" : `Create a ${d.modeLabel} team`}</b><p class="mut sm">${d.teamSize === 1 ? "One tap and you're in." : `You become the captain, invite ${d.teamSize - 1} teammate${d.teamSize > 2 ? "s" : ""} by FF Arena ID, then submit the team.`}</p><button class="btn primary block" data-act="t_register" data-t="${d.id}" data-size="${d.teamSize}">${ico("plus")}${d.teamSize === 1 ? "Register" : "Create team"}</button></div>`;
  return html`${inv}<div class="card"><p class="mut sm">${{ not_open: `Registration opens ${when(d.regOpensAt)}.`, closed: "Registration is closed.", full: "This tournament is full." }[d.registration] || ""}</p></div>`;
}

function standingsTable(r) {
  const rows = r.standings;
  if (!rows.length || !r.games.some(g => g.status === "CONFIRMED")) return html`<p class="mut sm">No confirmed results yet.</p>`;
  return html`<div class="card flush">${rows.map(s => html`<div class="li stand"><b class="pos">${s.rank}</b><span class="grow"><b class="trunc" style="display:block">${nm(s.entryId)}</b>${members(Q.emap.get(s.entryId))}${s.tied ? html`<span class="chip warn" style="margin-top:4px">Tied: admin ruling pending</span>` : ""}</span><span class="num"><b>${s.points}</b><span class="mut xs"> pts</span><br><span class="mut xs">${s.kills} kills</span></span></div>`)}</div>`;
}
function pointsView(d) {
  const rounds = d.state.rounds.filter(r => r.status !== "PENDING");
  if (!rounds.length) return "";
  const cur = RT[d.id] && rounds.find(r => r.number === RT[d.id]) ? RT[d.id] : rounds[rounds.length - 1].number, r = rounds.find(x => x.number === cur);
  const cfg = d.roundsConfig;
  return html`${sec("Progress")}<div class="seg" style="margin-bottom:12px">${d.state.rounds.map(x => html`<button type="button" class="${x.number === cur ? "on" : ""}" ${x.status === "PENDING" ? "disabled" : ""} data-act="t_round" data-t="${d.id}" data-r="${x.number}">${x.number === cfg.count ? "Final" : "Round " + x.number}</button>`)}</div>
    <p class="mut sm" style="margin-bottom:8px">${r.status === "ADVANCED" ? `${r.qualifiers.length} advanced to the next round.` : r.status === "ACTIVE" ? `${r.entryIds.length} ${unit(d)} playing${r.number < cfg.count ? `. The top ${cfg.qualifiers[r.number - 1]} advance` : ""}.` : ""} ${r.games.filter(g => g.status === "CONFIRMED").length} of ${r.games.length} game${r.games.length === 1 ? "" : "s"} confirmed.</p>${standingsTable(r)}
    ${r.games.filter(g => g.status === "CONFIRMED").map(g => html`<details class="card gdet"><summary><b>Game ${g.n}</b> <span class="mut sm">confirmed ${when(g.confirmedAt)}</span></summary><div class="stack" style="margin-top:8px">${[...g.rows].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99)).map(x => html`<div class="row sp sm"><span class="trunc">${x.noShow ? "—" : "#" + (x.placement ?? "·")} ${nm(x.entryId)}</span><span>${x.noShow ? "no show" : `${x.kills} kills · ${x.points} pts`}</span></div>`)}</div></details>`)}`;
}
function bracketView(d) {
  const b = d.state.bracket;
  return html`${sec("Bracket")}<div class="bracket" role="region" aria-label="Knockout bracket" tabindex="0">${b.rounds.map(rd => html`<div class="bcol"><h3 class="bhead">${rd.name}</h3>${rd.matches.map(m => {
    const side = (id, score, w) => html`<div class="bside ${m.winner && m.winner === id ? "win" : m.winner && id ? "lose" : ""}"><span class="trunc">${id ? nm(id) : m.status === "VOID" ? "—" : "TBD"}</span>${score !== null && score !== undefined ? html`<b>${score}</b>` : m.winner && m.winner === id ? html`${ico("check")}` : ""}</div>`;
    return html`<div class="bm ${m.status.toLowerCase()}">${side(m.a, m.scoreA)}${side(m.b, m.scoreB)}<div class="bmeta">${m.status === "BYE" ? "Bye" : m.status === "VOID" ? "No match" : m.walkover ? "Walkover" : m.status === "CONFIRMED" ? "Final" : m.status === "READY" ? "Ready to play" : "Waiting"}</div></div>`; })}</div>`)}</div>`;
}
function finalView(d) {
  if (d.status !== "COMPLETED" || !d.finalRanks) return "";
  const c = d.champion;
  return html`<div class="card accent champ">${ico("trophy")}<div class="grow"><span class="mut sm">Champion</span><b class="wrap" style="display:block;font-size:20px">${c ? c.name : "—"}</b>${c && c.members.length > 1 ? html`<span class="mut sm wrap">${c.members.map(p => p.displayName).join(", ")}</span>` : ""}</div></div>
    ${sec("Final standings")}<div class="card flush">${d.finalRanks.map(r => html`<div class="li"><b class="pos">${r.rank}</b><span class="grow"><b class="trunc" style="display:block">${r.entry ? r.entry.name : "Entry"}</b>${r.entry ? members(r.entry) : ""}</span>${(d.placementXp[r.rank - 1] || 0) > 0 ? html`<span class="chip ok">+${d.placementXp[r.rank - 1]} XP</span>` : ""}</div>`)}</div>`;
}

export async function detail(ctx, K, id) {
  init(K);
  let d;
  try { d = await api("/arena-tournaments/" + encodeURIComponent(id), { fresh: true }); }
  catch (e) { return paint(ctx, html`<div class="card">${empty("flag", "Tournament not found", e.message || "It may not be published yet.", html`<a class="btn" href="#/tournaments">All tournaments</a>`)}</div>`, { title: "Tournament", back: "#/tournaments" }); }
  Q.emap = new Map(d.entries.map(e => [e.id, e])); Q.d = d;
  const infoTile = (v, l) => html`<div class="tile"><b style="font-size:15px">${v}</b><span>${l}</span></div>`;
  const rewards = d.placementXp.filter(x => x > 0).length ? html`<div class="row gap8" style="flex-wrap:wrap">${d.placementXp.map((x, i) => (x > 0 ? html`<span class="chip warn">#${i + 1}: +${x} XP</span>` : ""))}</div><p class="mut xs" style="margin-top:6px">${d.teamSize > 1 ? "XP is paid to every player on the team." : ""} Paid once, after the admin confirms the final results.</p>` : html`<p class="mut sm">No XP rewards for this tournament.</p>`;
  const sc = d.scoring;
  const rules = html`${sec("Rules and scoring")}<div class="card">${d.format === "points" && sc ? html`<p class="sm"><b>Points:</b> placement ${sc.placementPoints.slice(0, 12).map((p, i) => `#${i + 1}: ${p}`).join(" · ")}${sc.placementPoints.length > 12 ? " …" : ""}; ${sc.killPoints} per kill${sc.winBonus ? `; +${sc.winBonus} for a win` : ""}.</p><p class="sm" style="margin-top:6px">${d.roundsConfig.count} round${d.roundsConfig.count > 1 ? "s" : ""} of ${d.roundsConfig.gamesPerRound} game${d.roundsConfig.gamesPerRound > 1 ? "s" : ""}.${d.roundsConfig.qualifiers.length ? " Qualifiers: " + d.roundsConfig.qualifiers.map((q, i) => `top ${q} after round ${i + 1}`).join(", ") + "." : ""} Ties are decided by kills, then best placement; anything still level is settled by an admin.</p>` : html`<p class="sm"><b>Single elimination.</b> Win to advance. If the field isn't a power of two, the top seeds get a bye. Results count only after an admin confirms them.</p>`}
    ${d.rules ? html`<p class="sm wrap" style="margin-top:10px;white-space:pre-wrap">${d.rules}</p>` : ""}</div>`;
  const people = d.entries.filter(e => e.status !== "WITHDRAWN");
  const state = d.state ? (d.state.format === "points" ? pointsView(d) : bracketView(d)) : "";
  const canReport = S.me?.role === "player" && d.status === "IN_PROGRESS" && d.mine?.entry;
  paint(ctx, html`<div class="card hero edge"><div class="row sp" style="align-items:flex-start;gap:8px"><h1 class="wrap" style="margin:0">${d.name}</h1>${statusChip(d)}</div><div class="row gap8" style="flex-wrap:wrap;margin:10px 0">${labelChips(d)}</div>${d.description ? html`<p class="wrap">${d.description}</p>` : ""}
      <div class="grid g2" style="margin-top:12px">${infoTile(when(d.startsAt), "Starts")}${infoTile(`${d.entryCount} / ${d.capacity}`, d.teamSize === 1 ? "Players" : "Teams")}${infoTile(when(d.regOpensAt), "Registration opens")}${infoTile(when(d.regClosesAt), "Registration closes")}</div>${["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(d.status) ? html`<p class="mut sm" style="margin-top:10px">${regLine(d)}</p>` : ""}</div>
    ${d.status === "CANCELLED" ? html`<div class="card bad"><b>This tournament was cancelled.</b></div>` : ""}${finalView(d)}${["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(d.status) || d.mine?.entry ? myPanel(d) : ""}
    ${state}${canReport ? html`<button class="btn block ghost" style="margin-top:10px" data-act="t_report" data-t="${d.id}">${ico("alert")}Report a problem with a result</button>` : ""}
    ${sec("Rewards")}<div class="card">${rewards}</div>${rules}
    ${sec(d.teamSize === 1 ? "Players" : "Teams", html`<span class="chip">${people.length}</span>`)}${people.length ? html`<div class="card flush">${people.map(e => html`<div class="li">${avatar(e.members[0] || {}, "s")}<span class="grow"><b class="trunc" style="display:block">${e.name}</b>${members(e)}</span>${e.status === "WITHDRAWN" ? html`<span class="chip">Withdrawn</span>` : ""}</div>`)}</div>` : html`<div class="card">${empty("users", "Nobody yet", "Be the first to register.")}</div>`}`, { title: d.name, back: "#/tournaments" });
}

// ---------- Actions ----------
const T = id => "/arena-tournaments/" + encodeURIComponent(id);
A.t_round = d => { RT[d.t] = Number(d.r); go(); };
A.t_register = async d => {
  if (d.size === "1") { await api(`${T(d.t)}/register`, { method: "POST", body: {} }); toast("You're registered", "ok"); return go(); }
  const ok = await sheet({ title: "Create your team", sub: "Pick a team name. You'll invite your teammates next.", body: field("Team name", inp("team", { max: 30, ph: "e.g. Night Owls" })), submit: "Create team", onSubmit: f => { if (f.team.value.trim().length < 2) throw new Error("Team name must be at least 2 characters."); return api(`${T(d.t)}/register`, { method: "POST", body: { teamName: f.team.value.trim() } }); } });
  if (ok) { toast("Team created. Now invite your teammates", "ok"); go(); }
};
A.t_invite = async d => {
  const ok = await sheet({ title: "Invite a player", sub: "They get a notification and must accept before they join.", body: field("FF Arena ID", inp("aid", { ph: "FFA-0007", max: 20 }), "Find it on their profile or on the leaderboard."), submit: "Send invite",
    onSubmit: f => { const v = f.aid.value.trim().toUpperCase(); if (!/^FFA-\d{4,}$/.test(v)) throw new Error("Enter an FF Arena ID like FFA-0007."); return api(`${T(d.t)}/entries/${d.e}/invite`, { method: "POST", body: { arenaId: v } }); } });
  if (ok) { toast("Invitation sent", "ok"); go(); }
};
A.t_respond = async d => { await api(`${T(d.t)}/entries/${d.e}/respond`, { method: "POST", body: { accept: d.y === "1" } }); toast(d.y === "1" ? "You joined the team" : "Invitation declined", "ok"); if (location.hash.startsWith("#/tournament/")) go(); else location.hash = d.y === "1" ? "#/tournament/" + d.t : "#/tournaments"; go(); };
A.t_confirm = async d => { if (!(await confirmSheet({ title: "Submit your team?", confirm: "Submit team", body: html`<p class="mut">This takes a spot in the tournament. If someone leaves later, the team reopens.</p>` }))) return; const r = await api(`${T(d.t)}/entries/${d.e}/confirm`, { method: "POST", body: {} }); toast(r.status === "PENDING_APPROVAL" ? "Submitted. An admin will approve it" : "Team registered", "ok"); go(); };
A.t_leave = async d => {
  const solo = d.solo === "1", cap = d.cap === "1";
  if (!(await confirmSheet({ title: solo ? "Withdraw from this tournament?" : cap ? "Disband your team?" : "Leave this team?", confirm: solo ? "Withdraw" : cap ? "Disband" : "Leave", danger: true, body: html`<p class="mut">${solo ? "You can register again while registration is open." : cap ? "Everyone is removed from the team and the spot is freed." : "The team goes back to forming until a replacement joins."}</p>` }))) return;
  await api(`${T(d.t)}/entries/${d.e}/leave`, { method: "POST", body: {} }); toast("Done", "ok"); go();
};
A.t_report = async d => {
  const t = Q.d, opts = t.state?.format === "points" ? t.state.rounds.filter(r => r.status !== "PENDING").flatMap(r => r.games.map(g => [`r:${r.number}:${g.n}`, `Round ${r.number}, game ${g.n}`])) : t.state.bracket.rounds.flatMap(r => r.matches.filter(m => m.a && m.b).map(m => [`m:${m.id}`, `${r.name}: ${nm(m.a)} vs ${nm(m.b)}`]));
  if (!opts.length) return toast("There's nothing to report yet.");
  const ok = await sheet({ title: "Report a problem", sub: "An admin reviews it. The result can't be confirmed until they do.", submit: "Send report",
    body: html`${field("Which result?", raw(`<select class="input" name="which">${opts.map(([v, l]) => `<option value="${v.replace(/"/g, "")}">${l.replace(/[<>&"]/g, "")}</option>`).join("")}</select>`))}${field("What's wrong?", raw(`<textarea class="input" name="reason" minlength="10" maxlength="500" placeholder="Explain what happened (10+ characters)"></textarea>`))}`,
    onSubmit: f => { const v = f.which.value, why = f.reason.value.trim(); if (why.length < 10) throw new Error("Please explain in at least 10 characters."); const body = v.startsWith("m:") ? { matchId: v.slice(2), reason: why } : { round: Number(v.split(":")[1]), game: Number(v.split(":")[2]), reason: why }; return api(`${T(d.t)}/disputes`, { method: "POST", body }); } });
  if (ok) toast("Report sent to the admins", "ok");
};
