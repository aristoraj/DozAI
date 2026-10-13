// DozAI operator app. Everything shown here comes from the API: there is no sample data.
const API_BASE = (window.DOZAI_API_BASE || "/api").replace(/[/]$/, "");
const CLOUD = API_BASE.startsWith("/server");
const TZ = "Asia/Kolkata"; // all times are shown in India Standard Time
const ROLE_HEADER = { admin: "admin", agentops: "agent_ops", operator: "operator", reviewer: "reviewer" };
const palette = ["#f4c7b7", "#b9e3df", "#ead6a8", "#d7cfeb", "#bcd7ea", "#f1c0cd"];
const ALLOWED = { intake: ["admin", "operator"], run: ["admin", "agent_ops", "operator"], review: ["admin", "reviewer"], admin: ["admin"], approve: ["admin", "reviewer", "agent_ops"], controls: ["admin", "agent_ops"], killswitch: ["admin", "agent_ops", "operator"] };

const state = {
  view: "overview", localRole: "admin",
  me: null, mission: null, cases: [], audits: [], summary: null, sessions: [],
  missions: [], defaultMission: null, missionShown: null, campaigns: [],
  employees: [], employeeCanEdit: false, employeeShown: null, employeeDef: null, ctxPreview: null,
  voiceForm: null, voiceFormFor: null, voicePublishing: false,
  approvals: [], approvalsWaiting: 0, controlsInfo: null, replay: null, voice: null, voiceCheck: null,
  loaded: false, error: null,
  caseFilter: "all", caseSearch: "", reviewSelected: null,
  agentTab: "agent", session: null, auditSearch: "", auditActor: "all",
};

const $ = id => document.getElementById(id);
const appView = $("appView"), caseDrawer = $("caseDrawer"), drawerBackdrop = $("drawerBackdrop"), modalBackdrop = $("modalBackdrop"), modal = $("modal"), toastRegion = $("toastRegion");

// ---- small helpers -----------------------------------------------------------------------------------------
const esc = v => String(v ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
const initials = n => String(n).split(/\s+/).map(x => x[0]).slice(0, 2).join("").toUpperCase() || "?";
const colorFor = id => palette[Number(String(id).replace(/\D/g, "")) % palette.length];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const can = cap => (ALLOWED[cap] || []).includes(state.me?.role);
const STATUS_LABEL = { review: "Needs review", confirmed: "Confirmed", progress: "In progress", "not-confirmed": "Not confirmed", inconclusive: "Inconclusive", "not-started": "Not started", "opted-out": "Opted out" };
const statusPill = s => `<span class="status ${s}">${esc(STATUS_LABEL[s] || s)}</span>`;
const istTime = ts => (ts ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: TZ }) : "");
const istDay = ts => {
  if (!ts) return "";
  const day = d => d.toLocaleDateString("en-CA", { timeZone: TZ });
  const when = day(new Date(ts));
  return when === day(new Date()) ? "Today" : when === day(new Date(Date.now() - 86_400_000)) ? "Yesterday" : new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ });
};
const withIst = e => ({ ...e, time: istTime(e.ts), date: istDay(e.ts) });

function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.innerHTML = `<span class="toast-icon">${tone === "warning" ? "!" : "✓"}</span><span>${esc(message)}</span>`;
  toastRegion.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
const toCsv = (head, rows) => [head, ...rows].map(r => r.map(csvCell).join(",")).join("\n");

// ---- API -------------------------------------------------------------------------------------------------------------------
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers: { "content-type": "application/json", ...(CLOUD ? {} : { "x-dozai-role": ROLE_HEADER[state.localRole] }) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Cannot reach the server. Check your connection and try again."); }
  if (res.status === 401 && CLOUD) { location.href = "/__catalyst/auth/login"; return new Promise(() => {}); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || (res.status === 504 ? "The server took too long. The work may still be finishing; refresh in a minute." : `Request failed (${res.status})`));
  return json;
}

async function loadAll() {
  try {
    // Configuration can change between deploys, so re-read it each time instead of trusting a stale tab.
    [state.me, state.mission] = await Promise.all([api("/me"), api("/mission")]);
    const [c, a, s, ss, ms, cp, em, ap, co, vo] = await Promise.all([api("/cases"), api("/audit?limit=300"), api("/summary"), api("/sessions"), api("/missions"), api("/campaigns"), api("/employees"), api("/approvals"), api("/controls"), api("/voice")]);
    Object.assign(state, { cases: c.cases, audits: a.events.map(withIst), summary: s, sessions: ss.sessions, missions: ms.missions, defaultMission: ms.default_version, campaigns: cp.campaigns, employees: em.employees, employeeCanEdit: em.can_edit, approvals: ap.approvals, approvalsWaiting: ap.waiting, controlsInfo: co, voice: vo, error: null, loaded: true });
    if (state.missionShown && !state.missions.some(m => m.version === state.missionShown.version)) state.missionShown = null;
  } catch (e) {
    state.error = e.message; state.loaded = true;
  }
  chrome();
}

async function act(fn, okMessage) {
  try { const out = await fn(); await loadAll(); if (okMessage) toast(okMessage, "success"); return out; }
  catch (e) { toast(e.message, "warning"); return null; }
}

// ---- page chrome ----------------------------------------------------------------------------------------------------------------
function chrome() {
  const { me, mission } = state;
  $("caseCount").textContent = state.cases.length;
  $("reviewCount").textContent = state.cases.filter(c => c.status === "review").length;
  $("approvalCount").textContent = state.approvalsWaiting;
  if (mission) { $("missionName").textContent = mission.name; $("missionVersion").textContent = `${mission.version} · ${mission.instrument_signed_off ? "instrument signed off" : "instrument not signed off"}`; $("workspaceName").textContent = mission.name; }
  if (me) {
    const nice = me.user.split("@")[0].replace(/[._-]+/g, " ");
    $("userName").textContent = nice.replace(/\b\w/g, c => c.toUpperCase());
    $("userRole").textContent = { admin: "Administrator", agent_ops: "Agent operations", operator: "Operator", reviewer: "Reviewer" }[me.role] || me.role;
    $("userAvatar").textContent = initials(nice);
  }
  if (mission) {
    const r = mission.runtime;
    $("runtimeNote").innerHTML = `<span class="simulation-icon">${r.whatsapp === "live" ? "●" : "◇"}</span><div><strong>WhatsApp ${r.whatsapp === "live" ? "live" : "off"}</strong><small>${r.whatsapp === "live" ? "Real messages are sent" : "Replies are simulated"}</small></div>`;
  }
  $("roleSwitcherWrap").hidden = CLOUD;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  render();
}

function pageHead(eyebrow, title, text, actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div><div class="page-actions">${actions}</div></div>`;
}
const empty = (title, text, action = "") => `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;

function render() {
  if (!state.loaded) { appView.innerHTML = `<div class="view-enter">${empty("Loading…", "Reading the latest data.")}</div>`; return; }
  if (state.error) { appView.innerHTML = `<div class="view-enter">${empty("Could not load data", state.error, `<button class="button primary" data-action="refresh">Try again</button>`)}</div>`; bind(); return; }
  const views = { overview: renderOverview, cases: renderCases, campaigns: renderCampaigns, reviews: renderReviews, agent: renderAgent, approvals: renderApprovals, calls: renderCalls, missions: renderMission, audit: renderAudit };
  const off = state.controlsInfo?.controls.paused ? `<div class="agent-callout" style="border-color:#b64b48;margin-bottom:14px"><small>Switched off</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>Open Claude engine, then Controls, to switch it back on.</p></div>` : "";
  appView.innerHTML = `<div class="view-enter">${off}${views[state.view]()}</div>`;
  bind();
  if (state.view === "reviews" && state.reviewSelected && $("reviewConv")) fillConversation("reviewConv", state.reviewSelected);
}

// ---- command centre -----------------------------------------------------------------------------------------------------------
function renderOverview() {
  const s = state.summary, m = state.mission, cases = state.cases;
  const name = (state.me?.user || "").split("@")[0].split(/[._-]/)[0];
  const greeting = `Hello${name ? ", " + name.charAt(0).toUpperCase() + name.slice(1) : ""}.`;
  const head = pageHead("Command centre", greeting, "What is moving, what needs a person, and what happens next.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "");
  if (!s.total) {
    return `${head}${empty("No participants yet", can("intake") ? "Load your first cohort to start. Participant contact numbers are encrypted when stored." : "Ask an administrator or operator to load participants.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")}`;
  }
  const pct = n => Math.round((n / s.total) * 100);
  const mix = s.mix, mixTotal = mix.same_job + mix.changed_job + mix.not_employed + mix.other;
  const colors = [["#2c7771", "Same job", mix.same_job], ["#e8967a", "Changed job", mix.changed_job], ["#e5aa57", "Not employed", mix.not_employed], ["#b8aaa2", "Other or unresolved", mix.other]];
  let acc = 0;
  const donut = mixTotal ? `conic-gradient(${colors.map(([c, , n]) => { const from = (acc / mixTotal) * 360; acc += n; return `${c} ${from}deg ${(acc / mixTotal) * 360}deg`; }).join(",")})` : "var(--line)";
  const waiting = cases.filter(c => c.status === "progress").length;
  const items = [];
  if (s.review) items.push(["!", `${plural(s.review, "case")} need${s.review === 1 ? "s" : ""} a person's decision`, "Evidence conflict or low confidence", "reviews"]);
  const paused = state.campaigns.filter(c => c.status === "paused");
  if (paused.length) items.push(["!", `${plural(paused.length, "campaign")} paused`, paused[0].pause_reason || "Resume it from the Campaigns page", "campaigns"]);
  if (waiting) items.push(["↗", `${plural(waiting, "case")} ${waiting === 1 ? "is" : "are"} waiting for a reply`, "Check for replies on the Cases page", "cases"]);
  if (m.runtime.whatsapp !== "live") items.push(["◇", "WhatsApp sending is off", "The agent runs with simulated replies. Nothing is sent to anyone.", "missions"]);
  if (!m.instrument_signed_off) items.push(["?", "The questionnaire wording is not signed off", "The questions are placeholders until the programme team approves them", "missions"]);
  return `${head}
    <div class="grid kpis">
      ${kpi("Participants", s.total, "loaded", "#e4f5f3")}
      ${kpi("Contacted", `${pct(s.reached)}%`, `${s.reached} of ${s.total}`, "#fae8dc")}
      ${kpi("Outcomes confirmed", s.confirmed, `${s.complete} completed`, "#e4f5f3")}
      ${kpi("Needs a person", s.review, s.review ? "waiting for review" : "all clear", "#fff1d9", s.review ? "amber" : "")}
    </div>
    <div class="grid two">
      <section class="card card-pad"><div class="card-head"><div><h2>Progress</h2><p>How far participants have moved</p></div><button class="text-button" data-go="cases">Open cases →</button></div>
        <div class="stage-list">${[["Loaded", s.total], ["Contacted", s.reached], ["Responded", s.responded], ["Completed", s.complete], ["Confirmed", s.confirmed]].map(([l, n]) => `<div class="stage-row"><strong>${l}</strong><div class="progress-track"><div class="progress-fill" style="width:${pct(n)}%"></div></div><span>${n}</span></div>`).join("")}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Outcomes</h2><p>Where participants are now</p></div></div>
        <div class="donut-wrap"><div class="donut-holder"><div class="donut" style="background:${donut}"></div><div class="donut-centre"><strong>${mixTotal}</strong><small>classified</small></div></div>
        <div class="legend">${colors.map(([c, l, n]) => `<div class="legend-item"><span class="legend-dot" style="background:${c}"></span><span>${l}</span><strong>${n}</strong></div>`).join("")}</div></div></section>
    </div>
    <div class="grid two-even" style="margin-top:16px">
      <section class="card card-pad"><div class="card-head"><div><h2>Needs attention</h2><p>Only what needs a decision or a setting</p></div></div>
        <div class="attention-list">${items.length ? items.map(([i, t, sub, go]) => `<button class="attention-item" style="border:0;width:100%;text-align:left;cursor:pointer" data-go="${go}"><span class="attention-icon">${i}</span><span><strong>${esc(t)}</strong><small>${esc(sub)}</small></span><span>›</span></button>`).join("") : `<p style="color:var(--muted);font-size:12px">Nothing needs attention.</p>`}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Recent activity</h2><p>Every action is recorded</p></div><button class="text-button" data-go="audit">Audit trail →</button></div>
        <div class="timeline">${state.audits.slice(0, 5).map(timelineEvent).join("") || `<p style="color:var(--muted);font-size:12px">No activity yet.</p>`}</div></section>
    </div>`;
}
const kpi = (label, value, foot, soft, tone = "") => `<section class="card kpi-card" style="--accent-soft:${soft}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-foot"><span class="delta ${tone}">${esc(foot)}</span></div></section>`;
const timelineEvent = a => `<div class="timeline-event"><span class="event-dot ${a.tone === "coral" ? "coral" : ""}">${esc(a.icon)}</span><span class="event-copy"><strong>${esc(a.action)}</strong><small>${esc(a.detail)}</small></span><span class="event-time">${esc(a.time)}</span></div>`;

// ---- cases ---------------------------------------------------------------------------------------------------------------------------------
function filteredCases() {
  const q = state.caseSearch.toLowerCase();
  return state.cases.filter(c => (state.caseFilter === "all" || c.status === state.caseFilter) && `${c.name} ${c.id} ${c.location} ${c.cohort}`.toLowerCase().includes(q));
}

function renderCases() {
  const list = filteredCases();
  const actions = `${state.me?.can_purge && can("admin") ? `<button class="button ghost" data-action="purge" style="color:#b64b48;border-color:#b64b48">Delete ALL data…</button>` : ""}${can("admin") ? `<button class="button ghost" data-action="check-replies">Check for replies</button>` : ""}<button class="button ghost" data-action="export-cases">Export CSV</button>${can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : ""}`;
  const options = [["all", "All statuses"], ["review", "Needs review"], ["progress", "In progress"], ["not-started", "Not started"], ["confirmed", "Confirmed"], ["not-confirmed", "Not confirmed"], ["inconclusive", "Inconclusive"], ["opted-out", "Opted out"]];
  return `${pageHead("Cases", "Every participant has one accountable case.", "The current state, the evidence behind it, and the next permitted action.", actions)}
    <section class="card table-card">
      <div class="table-toolbar"><div class="filters"><label class="search-box"><input id="caseSearch" value="${esc(state.caseSearch)}" placeholder="Search name, case or place" aria-label="Search cases" /></label>
      <select class="filter-select" id="caseFilter">${options.map(([v, l]) => `<option value="${v}" ${state.caseFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <span style="font-size:11px;color:var(--muted)">${list.length} of ${state.cases.length}</span></div>
      ${state.cases.length === 0 ? empty("No cases yet", can("intake") ? "Add participants to create their cases." : "No participants have been loaded.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")
        : list.length === 0 ? empty("No cases match", "Change the search or the status filter.")
        : `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Participant</th><th>Status</th><th>Outcome</th><th>Confidence</th><th>Last activity</th><th></th></tr></thead><tbody>${list.map(caseRow).join("")}</tbody></table></div>`}
    </section>`;
}
const caseRow = c => `<tr data-case="${esc(c.id)}" style="cursor:pointer"><td><div class="participant-cell"><span class="mini-avatar" style="background:${colorFor(c.id)}">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.id)} · ${esc(c.location)}</small></span></div></td><td>${statusPill(c.status)}</td><td><strong style="font-size:12px">${esc(c.outcome)}</strong><div style="color:var(--muted);font-size:10px;margin-top:3px">${esc(c.stage)}</div></td><td><div class="confidence"><div class="confidence-bar"><span style="width:${c.confidence}%"></span></div><span>${c.confidence}%</span></div></td><td style="color:var(--muted)">${esc(c.lastTouch)}</td><td><button class="row-action" data-case="${esc(c.id)}" aria-label="Open ${esc(c.name)}">›</button></td></tr>`;

// ---- campaigns -------------------------------------------------------------------------------------------------------------------------------
const CAMP_STATUS = { draft: ["not-started", "Draft"], running: ["progress", "Running"], paused: ["review", "Paused"], completed: ["confirmed", "Finished"], stopped: ["not-confirmed", "Stopped"] };
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const missionName = v => { const m = state.missions.find(x => x.version === v); return m ? `${m.name} (${m.version})` : v; };

function renderCampaigns() {
  const list = state.campaigns;
  const running = list.some(c => c.status === "running");
  const actions = can("intake") ? `${running ? `<button class="button ghost" data-action="run-batch">Send next batch now</button>` : ""}<button class="button primary" data-action="new-campaign">New campaign</button>` : "";
  return `${pageHead("Campaigns", "Send the first message to many people, at a safe pace.", "A campaign sends each person their mission's first message in small batches, inside the contact hours and under a daily limit. Replies are handled automatically.", actions)}
    ${list.length ? list.map(campaignCard).join("") : empty("No campaigns yet", can("intake") ? "Add participants, then create a campaign to message them. Nothing is sent until you start it." : "No campaign has been created.", can("intake") ? `<button class="button primary" data-action="new-campaign">New campaign</button>` : "")}`;
}

function campaignCard(c) {
  const p = c.progress || { queued: 0, contacted: 0, waiting: 0, needs_review: 0, complete: 0, send_failed: 0 };
  const total = p.queued + p.contacted;
  const pct = total ? Math.round((p.contacted / total) * 100) : 0;
  const [cls, label] = CAMP_STATUS[c.status] || ["not-started", c.status];
  const today = c.sent_day === todayIst() ? c.sent_today : 0;
  const stale = c.status === "running" && c.last_run_at && Date.now() - new Date(c.last_run_at).getTime() > 3 * 60_000;
  const btn = (act, text) => `<button class="button ${act === "start" || act === "resume" ? "primary" : "ghost"} small" data-camp="${esc(c.campaign_id)}" data-act="${act}">${text}</button>`;
  const controls = !can("intake") ? "" : c.status === "draft" ? btn("start", "Start sending") + btn("stop", "Discard")
    : c.status === "running" ? btn("pause", "Pause") + btn("stop", "Stop") : c.status === "paused" ? btn("resume", "Resume") + btn("stop", "Stop") : "";
  const tile = (l, v, tone = "") => `<div class="summary-box"><small>${l}</small><strong ${tone ? `style="color:${tone}"` : ""}>${v}</strong></div>`;
  return `<section class="card card-pad" style="margin-bottom:14px" data-campaign-card="${esc(c.campaign_id)}">
    <div class="card-head"><div><h2>${esc(c.name)}</h2><p>${esc(missionName(c.mission_version))} · ${c.cohort ? `cohort ${esc(c.cohort)}` : "everyone loaded before it started"} · up to ${c.daily_cap} a day, ${c.per_tick} a minute</p></div><span class="status ${cls}">${label}</span></div>
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px"><div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div><strong style="font-size:12px">${p.contacted} of ${total} messaged</strong></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">${tile("Waiting to send", p.queued)}${tile("Messaged", p.contacted)}${tile("Waiting for reply", p.waiting)}${tile("Needs review", p.needs_review, p.needs_review ? "#b64b48" : "")}${tile("Finished", p.complete)}${tile("Could not send", p.send_failed, p.send_failed ? "#b64b48" : "")}${tile("Sent today", `${today} / ${c.daily_cap}`)}</div>
    ${c.pause_reason && c.status === "paused" ? `<p style="color:#b64b48;font-size:12px;margin:10px 0 0">${esc(c.pause_reason)}</p>` : c.last_note ? `<p style="color:var(--muted);font-size:12px;margin:10px 0 0">${esc(c.last_note)}${c.last_run_at ? ` (${esc(istTime(c.last_run_at))})` : ""}</p>` : ""}
    ${stale ? `<p style="color:#b64b48;font-size:12px;margin:6px 0 0">The scheduler has not run for a few minutes, so no new batches are going out. Check that the Cron job is set up, or press "Send next batch now".</p>` : ""}
    ${p.send_failed ? `<p style="color:var(--muted);font-size:11px;margin:6px 0 0">People marked "Could not send" stay in the waiting state. Open their case to see why.</p>` : ""}
    ${controls ? `<div style="display:flex;gap:8px;margin-top:12px">${controls}</div>` : ""}</section>`;
}

function campaignAct(id, act) {
  const c = state.campaigns.find(x => x.campaign_id === id);
  if (!c) return;
  const run = async (okMessage) => {
    const out = await act_(id, act);
    if (out && okMessage) toast(okMessage(out), "success");
  };
  if (act === "start") {
    const live = state.me?.channel === "interakt";
    return confirmModal({
      title: `Start "${c.name}"?`,
      text: `${plural(c.progress?.queued ?? 0, "person", "people")} will be messaged, at most ${c.daily_cap} a day and ${c.per_tick} a minute, inside the contact hours (${state.mission?.policy.contact_window}). ${live ? "These are real WhatsApp messages." : "WhatsApp is off, so messages are simulated."} People loaded after this moment are not included.`,
      button: "Start sending",
      onConfirm: () => run(out => `Started. ${plural(out.pass?.sent ?? 0, "first message")} sent now.`),
    });
  }
  if (act === "stop") {
    return confirmModal({ title: `${c.status === "draft" ? "Discard" : "Stop"} "${c.name}"?`, text: c.status === "draft" ? "Nothing has been sent. The campaign is closed and cannot be started." : "No more first messages will be sent. People already messaged keep their conversations. A stopped campaign cannot be restarted.", button: c.status === "draft" ? "Discard" : "Stop campaign", danger: true, onConfirm: () => run(() => "Campaign stopped.") });
  }
  run(out => act === "pause" ? "Paused. Nothing more will be sent until you resume." : `Resumed. ${plural(out.pass?.sent ?? 0, "first message")} sent now.`);
}
const act_ = (id, a) => act(() => api(`/campaigns/${id}/${a}`, { method: "POST" }), null);

function confirmModal({ title, text, button, danger, onConfirm }) {
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${esc(title)}</h2><p>${esc(text)}</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-foot"><button class="button ghost" id="cancelConfirm">Cancel</button><button class="button primary" id="okConfirm" ${danger ? 'style="background:#b64b48;border-color:#b64b48"' : ""}>${esc(button)}</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelConfirm").addEventListener("click", closeModal);
  $("okConfirm").addEventListener("click", async () => { $("okConfirm").disabled = true; closeModal(); await onConfirm(); });
}

function openCampaignModal() {
  const s = { name: "", mission: state.defaultMission, cohort: "", daily_cap: 200, per_tick: 15, error: null, running: false };
  const cohortsFor = v => {
    const first = state.missions[0]?.version;
    const counts = {};
    for (const c of state.cases) if (c.status === "not-started" && (c.mission_version ?? first) === v) counts[c.cohort] = (counts[c.cohort] || 0) + 1;
    return counts;
  };
  const draw = () => {
    const counts = cohortsFor(s.mission), everyone = Object.values(counts).reduce((a, b) => a + b, 0);
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">New campaign</h2><p>Choose who to message and how fast. Nothing is sent until you start it.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="field full"><label for="cmpName">Name</label><input id="cmpName" value="${esc(s.name)}" placeholder="e.g. Batch 7, first message" autocomplete="off" /></div>
        <div class="field full"><label for="cmpMission">Mission</label><select id="cmpMission">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === s.mission ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><small>Decides the first message, the questions and the contact hours.</small></div>
        <div class="field full"><label for="cmpCohort">Who</label><select id="cmpCohort"><option value="">Everyone not yet messaged (${everyone})</option>${Object.entries(counts).map(([k, n]) => `<option value="${esc(k)}" ${k === s.cohort ? "selected" : ""}>Cohort ${esc(k)} (${n})</option>`).join("")}</select></div>
        <div class="field"><label for="cmpCap">Most messages a day</label><input id="cmpCap" type="number" min="1" max="10000" value="${s.daily_cap}" /><small>WhatsApp limits how many new people a number may message each day. A new number often starts at 250.</small></div>
        <div class="field"><label for="cmpTick">Most messages a minute</label><input id="cmpTick" type="number" min="1" max="50" value="${s.per_tick}" /></div>
        ${s.error ? `<p style="color:#b64b48;font-size:12px;grid-column:1/-1;margin:0">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelCmp">Cancel</button><button class="button primary" id="saveCmp" ${s.running || s.name.trim().length < 2 ? "disabled" : ""}>Create campaign</button></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelCmp").addEventListener("click", closeModal);
    $("cmpName").addEventListener("input", e => { s.name = e.target.value; $("saveCmp").disabled = s.name.trim().length < 2; });
    $("cmpMission").addEventListener("change", e => { s.mission = e.target.value; s.cohort = ""; draw(); });
    $("cmpCohort").addEventListener("change", e => { s.cohort = e.target.value; });
    $("cmpCap").addEventListener("input", e => { s.daily_cap = Number(e.target.value); });
    $("cmpTick").addEventListener("input", e => { s.per_tick = Number(e.target.value); });
    $("saveCmp").addEventListener("click", async () => {
      s.running = true; s.error = null; $("saveCmp").disabled = true;
      try {
        await api("/campaigns", { method: "POST", body: { name: s.name.trim(), mission_version: s.mission, cohort: s.cohort || null, daily_cap: s.daily_cap, per_tick: s.per_tick } });
        closeModal(); await loadAll(); toast("Campaign created. Check the numbers, then start it.", "success");
      } catch (e) { s.running = false; s.error = e.message; draw(); }
    });
  };
  draw(); modalBackdrop.hidden = false;
}

// ---- add a mission (administrators) -----------------------------------------------------------------------------------------------------
function openMissionModal() {
  const s = { text: "", from: state.missionShown?.version ?? state.defaultMission, error: null, running: false };
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add a mission</h2><p>A mission is one client's first message, questions, contact rules and agent notes. Saved missions never change: to change one, add a new version.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="field full"><label for="mFrom">Start from</label><div style="display:flex;gap:8px"><select id="mFrom" style="flex:1">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === s.from ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><button type="button" class="button ghost small" id="mLoad">Copy it here</button></div></div>
        <div class="field full"><label for="mText">Definition (JSON)</label><textarea id="mText" rows="14" spellcheck="false" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px" placeholder="Copy an existing mission, then change the version name, wording and questions.">${esc(s.text)}</textarea><small>Change mission_id, version and name. A mission that is not approved (instrument.draft: true) cannot be used for live campaigns.</small></div>
        ${s.error ? `<p style="color:#b64b48;font-size:12px;grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelM">Cancel</button><button class="button primary" id="saveM" ${s.running || !s.text.trim() ? "disabled" : ""}>Save mission</button></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelM").addEventListener("click", closeModal);
    $("mFrom").addEventListener("change", e => { s.from = e.target.value; });
    $("mLoad").addEventListener("click", async () => {
      try { const d = await api(`/missions/${encodeURIComponent(s.from)}/definition`); s.text = JSON.stringify(d.definition, null, 2); s.error = null; draw(); } catch (e) { s.error = e.message; draw(); }
    });
    $("mText").addEventListener("input", e => { s.text = e.target.value; $("saveM").disabled = !s.text.trim(); });
    $("saveM").addEventListener("click", async () => {
      let body;
      try { body = JSON.parse(s.text); } catch { s.error = "That is not valid JSON. Check for a missing comma or quote."; draw(); return; }
      s.running = true; s.error = null; $("saveM").disabled = true;
      try { await api("/missions", { method: "POST", body }); closeModal(); state.missionShown = null; await loadAll(); toast("Mission saved. New participants join it by default.", "success"); }
      catch (e) { s.running = false; s.error = e.message; draw(); }
    });
  };
  draw(); modalBackdrop.hidden = false;
}

// ---- case drawer ---------------------------------------------------------------------------------------------------------------------------
async function openCase(id) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const simulated = state.me?.channel !== "interakt";
  const waiting = ["Contacting", "Follow-up"].includes(c.stage);
  const canRun = can("run") && c.stage !== "Complete" && c.stage !== "Review";
  caseDrawer.innerHTML = `<div class="drawer-head"><div><div class="eyebrow">Participant case</div><h2>${esc(c.name)}</h2><p>${esc(c.id)} · ${esc(c.cohort)} · ${esc(c.location)}</p></div><button class="close-button" id="closeDrawer" aria-label="Close case">×</button></div><div class="drawer-body">
    <div class="case-summary"><div class="summary-box"><small>Status</small><strong>${esc(STATUS_LABEL[c.status])}</strong></div><div class="summary-box"><small>Outcome</small><strong>${esc(c.outcome)}</strong></div><div class="summary-box"><small>Confidence</small><strong>${c.confidence}%</strong></div></div>
    <div class="next-action"><small>Next permitted action</small><h3>${esc(c.stage === "Complete" ? "Case is complete" : c.stage === "Review" ? "A person must decide" : c.stage === "Not started" ? "Ready to start" : "Waiting")}</h3><p>${esc(c.next)}</p>
      ${canRun && simulated ? `<label style="display:block;font-size:11px;color:var(--muted);margin:10px 0 4px" for="scenarioSelect">Simulated participant reply (WhatsApp is off)</label><select id="scenarioSelect" class="filter-select" style="width:100%;margin-bottom:8px"><option value="same_job">Same job</option><option value="changed_job">Changed job</option><option value="employer_conflict">Employer name conflict</option><option value="not_employed">Not employed</option><option value="opt_out">Opts out</option><option value="no_response">No response</option></select>` : ""}
      ${canRun && !simulated ? `<p style="font-size:11px;color:var(--muted);margin:10px 0 8px">WhatsApp is live. The agent sends the approved message to this participant and waits for a real reply.</p>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${c.stage === "Review" && can("review") ? `<button class="button primary small" id="goReview">Open review</button>` : ""}
        ${canRun ? `<button class="button primary small" id="runAgent">Run agent session</button>` : ""}
        ${canRun && state.me?.voice && state.me.voice !== "off" ? `<button class="button ghost small" id="requestCall">Request a phone call</button>` : ""}
        ${canRun && waiting && !simulated ? `<button class="button ghost small" id="resumeAgent">Resume after reply</button>` : ""}
        ${c.stage !== "Not started" ? `<button class="button ghost small" id="viewSession">View agent session</button>` : ""}
      </div></div>
    <div class="drawer-section"><h3>What we need to know</h3><div id="reqBox"><p style="color:var(--muted);font-size:12px">Loading…</p></div></div>
    <div class="drawer-section"><h3>Participant</h3><div class="evidence-grid">
      <div class="evidence-card"><small>Phone</small><strong>${esc(c.phone)}</strong></div>
      <div class="evidence-card"><small>Programme record employer</small><strong>${esc(c.recorded_employer)}</strong></div>
      <div class="evidence-card"><small>Reported employer</small><strong>${esc(c.employer)}</strong></div>
      <div class="evidence-card"><small>Case owner</small><strong>${esc(c.owner)}</strong></div>
      <div class="evidence-card"><small>Mission</small><strong>${esc(missionName(c.mission_version ?? state.missions[0]?.version))}</strong></div></div></div>
    <div class="drawer-section"><h3>Conversation</h3><div id="convBox"><p style="color:var(--muted);font-size:12px">Loading…</p></div>${simulated && can("run") && c.stage !== "Complete" ? `<div style="display:flex;gap:8px;margin-top:10px"><input id="simText" placeholder="Type a participant reply (simulated)" style="flex:1;padding:9px 11px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:12px" /><button class="button primary small" id="simSend">Send</button></div><small style="color:var(--muted);font-size:10px">WhatsApp is off. This goes through the same conversation logic as a real reply.</small>` : ""}</div>
    <div class="drawer-section"><h3>Phone calls</h3><div id="callBox"><p style="color:var(--muted);font-size:12px">Loading…</p></div></div>
    <div class="drawer-section"><h3>Agent notes</h3><div id="agentBox"><p style="color:var(--muted);font-size:12px">Loading…</p></div></div>
    <div class="drawer-section"><h3>Case history</h3><div class="timeline" id="caseHistory"><p style="color:var(--muted);font-size:12px">Loading…</p></div></div>
    ${can("admin") ? `<div class="drawer-section"><h3>Danger zone</h3><p style="font-size:12px;color:var(--muted);margin:0 0 10px">Deleting erases this participant's name, number, replies and evidence. The case stays only as an anonymous entry in the audit trail. This cannot be undone.</p><button class="button ghost small" id="deleteCase" style="color:#b64b48;border-color:#b64b48">Delete case…</button></div>` : ""}
  </div>`;
  caseDrawer.classList.add("open"); caseDrawer.setAttribute("aria-hidden", "false"); drawerBackdrop.hidden = false;
  $("closeDrawer").addEventListener("click", closeDrawer);
  $("goReview")?.addEventListener("click", () => { closeDrawer(); state.reviewSelected = id; go("reviews"); });
  $("runAgent")?.addEventListener("click", () => runAgent(id, $("scenarioSelect")?.value || "same_job"));
  $("resumeAgent")?.addEventListener("click", async () => {
    await api("/admin/process-inbox", { method: "POST" }).catch(() => null);
    const out = await act(() => api(`/cases/${id}/resume-agent`, { method: "POST" }), "Agent resumed and read the reply");
    if (out) { state.session = out.session; openCase(id); }
  });
  $("requestCall")?.addEventListener("click", () => confirmModal({
    title: "Request a phone call?", text: `This asks for a call to ${c.name}. It goes through the same checks as the agent's calls (consent, contact hours, attempts) and then waits for approval on the Approvals page. Nothing rings until someone approves it.`, button: "Request the call",
    onConfirm: async () => { const out = await act(() => api(`/cases/${id}/request-call`, { method: "POST", body: { reason: "Phone call requested by staff" } }), null); if (out) { toast(out.message, "success"); openCase(id); } },
  }));
  $("viewSession")?.addEventListener("click", () => openLastSession(id).catch(e => toast(e.message, "warning")));
  $("deleteCase")?.addEventListener("click", () => openDeleteModal(c));
  fillConversation("convBox", id);
  const sendSim = async () => {
    const box = $("simText"); const text = box?.value ?? "";
    box.value = "";
    const out = await act(() => api(`/cases/${id}/simulate-reply`, { method: "POST", body: { text } }), null);
    if (out) { toast(`Reply handled: ${out.result.action}${out.result.detail ? " (" + out.result.detail + ")" : ""}`, "success"); openCase(id); }
  };
  $("simSend")?.addEventListener("click", sendSim);
  $("simText")?.addEventListener("keydown", e => { if (e.key === "Enter") sendSim(); });
  try {
    const d = await api(`/cases/${id}`);
    const box = $("caseHistory");
    if (box) box.innerHTML = d.events.map(withIst).reverse().map(timelineEvent).join("") || `<p style="color:var(--muted);font-size:12px">No history.</p>`;
    const rb = $("reqBox"); if (rb) rb.innerHTML = requirementsHtml(d.requirements);
    const ab = $("agentBox"); if (ab) { ab.innerHTML = agentNotesHtml(d); ab.querySelectorAll("[data-approve]").forEach(b => b.addEventListener("click", async () => { await decideApproval(b.dataset.approve, "approve"); openCase(id); })); ab.querySelectorAll("[data-reject]").forEach(b => b.addEventListener("click", async () => { await decideApproval(b.dataset.reject, "reject"); openCase(id); })); }
    const cb = $("callBox"); if (cb) { cb.innerHTML = callsHtml(d.calls); cb.querySelectorAll("[data-simcall]").forEach(b => b.addEventListener("click", () => simulateCall(id, b.dataset.simcall))); }
  } catch (e) { const box = $("caseHistory"); if (box) box.innerHTML = `<p style="color:var(--muted);font-size:12px">${esc(e.message)}</p>`; }
}
// What the agent remembers about this person, when it will next look at the case, and anything waiting for a person.
function agentNotesHtml(d) {
  const held = (d.approvals || []).filter(a => a.state === "held");
  const parts = [];
  if (held.length) parts.push(held.map(a => `<div class="agent-callout" style="margin:0 0 8px"><small>Waiting for approval</small><h3>${esc(a.label)}</h3><p>${esc(a.summary)}</p>${can("approve") ? `<div style="display:flex;gap:6px"><button class="button primary small" data-approve="${esc(a.outbox_id)}">Approve</button><button class="button ghost small" data-reject="${esc(a.outbox_id)}">Decline</button></div>` : ""}</div>`).join(""));
  parts.push(d.memory?.length ? `<div class="check-list">${d.memory.map(m => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(m.label)}</strong><small>${esc(m.value)}</small></span></div>`).join("")}</div>` : `<p style="color:var(--muted);font-size:12px">Nothing remembered about this person yet.</p>`);
  if (d.wakes?.length) parts.push(`<p style="font-size:12px;margin:8px 0 0">The agent will look at this case again: ${d.wakes.map(w => `${esc(istDay(w.at))} ${esc(istTime(w.at))} (${esc(w.reason.replace(/_/g, " "))})`).join("; ")}.</p>`);
  return parts.join("");
}
// What the mission needs to know about this person, and how much of it is settled.
const REQ_STATE = { verified: ["✓", "Checked against the programme record", "var(--sys)"], stated: ["●", "Said by the participant", "var(--amber, #ba772b)"], missing: ["○", "Still needed", "#b64b48"], conflict: ["!", "Does not match the programme record", "#b64b48"] };
function requirementsHtml(r) {
  if (!r || !r.items.length) return `<p style="color:var(--muted);font-size:12px">This mission does not list what it needs to know yet.</p>`;
  const shown = r.items.filter(i => i.applicable), later = r.items.length - shown.length;
  const head = `${r.collected} of ${r.needed} needed answers collected${r.verified ? `, ${r.verified} checked` : ""}${r.conflicts ? `, ${r.conflicts} not matching` : ""}`;
  return `<p style="font-size:12px;margin:0 0 8px"><strong>${esc(head)}</strong>${r.complete ? " · nothing more is needed" : r.gaps.length ? ` · still missing: ${esc(r.gaps.map(g => shown.find(i => i.key === g)?.label || g).join(", "))}` : ""}</p>` +
    shown.map(i => { const [mark, text, color] = REQ_STATE[i.state] || ["·", i.state, "var(--muted)"]; return `<div style="display:flex;gap:8px;font-size:12px;padding:3px 0"><span style="color:${color};width:14px;text-align:center;font-weight:700">${mark}</span><span style="flex:1"><strong>${esc(i.label)}</strong>${i.required ? "" : ` <small style="color:var(--muted)">(optional)</small>`}<small style="display:block;color:var(--muted)">${esc(text)}${i.confidence != null ? ` · ${Math.round(i.confidence * 100)}% sure` : ""}${i.note ? ` · ${esc(i.note)}` : ""}</small></span></div>`; }).join("") +
    (later ? `<small style="color:var(--muted)">${plural(later, "more question")} depend on earlier answers.</small>` : "");
}
// Phone calls on a case: how each went, the audio and the transcript (shown only to people allowed to see them).
const CALL_LABEL = { requested: "Requested", scheduled: "Scheduled", in_progress: "In progress", completed: "Completed", no_answer: "No answer", busy: "Busy", declined: "Declined", failed: "Failed", cancelled: "Cancelled" };
function callsHtml(calls) {
  const live = (calls || []).some(k => k.status === "in_progress" || k.status === "scheduled");
  const sim = state.me?.voice === "simulated" && live && can("run");
  const list = (calls || []).map(k => `<div style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:6px 0;font-size:12px"><strong>${esc(CALL_LABEL[k.status] || k.status)}</strong> <small style="color:var(--muted)">· requested ${esc(istDay(k.requested_at))} ${esc(istTime(k.requested_at))}${k.scheduled_for ? " for " + esc(istDay(k.scheduled_for)) + " " + esc(istTime(k.scheduled_for)) : ""}${k.duration_seconds ? " · " + Math.max(1, Math.round(k.duration_seconds / 60)) + " min" : ""}</small>
      ${k.reason ? `<div style="color:var(--muted)">Why: ${esc(k.reason)}</div>` : ""}${k.asked?.length ? `<div style="color:var(--muted)">Asked for: ${esc(k.asked.join(", "))}</div>` : ""}
      ${k.audio_url ? `<div><audio controls preload="none" src="${esc(recordingSrc(k.audio_url))}" style="max-width:100%"></audio></div>` : ""}
      ${k.transcript ? `<details><summary style="cursor:pointer">Transcript</summary><pre style="white-space:pre-wrap;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:6px 0 0">${esc(k.transcript)}</pre></details>` : ""}</div>`).join("");
  const buttons = sim ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><small style="width:100%;color:var(--muted)">Simulator: finish the call yourself</small><button class="button primary small" data-simcall="answered">Answered</button><button class="button ghost small" data-simcall="no_answer">No answer</button><button class="button ghost small" data-simcall="refused">Refused</button><button class="button ghost small" data-simcall="wrong_person">Wrong person</button></div>` : "";
  return (list || `<p style="color:var(--muted);font-size:12px">No phone calls on this case. The agent can ask for one when WhatsApp is not enough.</p>`) + buttons;
}
async function simulateCall(id, outcome) {
  const body = { outcome, ...(outcome === "answered" ? { answers: { work_status: "I work at the same place as before", employer_name: "Employer (simulated)", role_title: "Role (simulated)" }, transcript: "Simulated call. The person agreed to continue and answered the questions." } : {}) };
  const out = await act(() => api(`/cases/${id}/simulate-call`, { method: "POST", body }), null);
  if (out) { toast("The call was finished as \"" + outcome.replace("_", " ") + "\" and applied like a real result.", "success"); openCase(id); }
}
const CONV_LABEL = { not_started: "Not started", awaiting_consent: "Waiting for consent", asking: "Asking questions", done: "Interview finished", escalated: "Handed to a person", stopped: "Stopped by participant" };
async function fillConversation(boxId, caseId) {
  try {
    const d = await api(`/cases/${caseId}/conversation`);
    const box = $(boxId); if (!box) return;
    const bubbles = d.messages.map(x => `<div style="display:flex;justify-content:${x.from === "participant" ? "flex-end" : "flex-start"};margin:6px 0"><div style="max-width:85%;padding:8px 11px;border-radius:12px;font-size:12px;white-space:pre-wrap;background:${x.from === "participant" ? "var(--teal-soft)" : "var(--surface)"};border:1px solid var(--line)">${esc(x.text)}</div></div>`).join("");
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px"><span class="status ${d.status === "escalated" ? "review" : d.status === "done" ? "confirmed" : "progress"}">${esc(CONV_LABEL[d.status] || d.status)}</span><small style="color:var(--muted)">${d.answered} answered${d.reasks ? ` · ${d.reasks} re-asked` : ""}</small></div>${d.escalation_reason ? `<p style="font-size:12px;color:#b64b48;margin:4px 0">Needs a person: ${esc(d.escalation_reason.replace(/_/g, " "))}</p>` : ""}${bubbles || `<p style="color:var(--muted);font-size:12px">No questions have been asked yet. The interview starts when the participant agrees to continue.</p>`}`;
  } catch (e) { const box = $(boxId); if (box) box.innerHTML = `<p style="color:var(--muted);font-size:12px">${esc(e.message)}</p>`; }
}

function closeDrawer() { caseDrawer.classList.remove("open"); caseDrawer.setAttribute("aria-hidden", "true"); drawerBackdrop.hidden = true; caseDrawer.innerHTML = ""; /* do not leave personal data in the page */ }

async function runAgent(id, scenario) {
  toast("Agent session started. This can take up to a minute.");
  const out = await act(() => api(`/cases/${id}/run-agent`, { method: "POST", body: { scenario } }), null);
  if (!out) return;
  state.session = out.session;
  explainSession(out.session);
  openCase(id);
}

// Say plainly why a session stopped, so nobody has to dig through logs.
function explainSession(s) {
  const refused = s.trace.find(t => t.result && t.result.code);
  if (s.trace.find(t => t.type === "refusal")) toast("The model declined this request. A person needs to handle the case.", "warning");
  else if (refused && refused.result.code === "ALREADY_WAITING") toast("This participant was already messaged and has not replied yet. Nothing more to send.", "success");
  else if (refused) toast(`The agent was stopped: ${refused.tool} returned ${refused.result.code}. ${refused.result.message || ""}`.trim(), "warning");
  else if (s.trace.find(t => t.type === "channel")) toast("Message handed to WhatsApp. The agent is waiting for a reply.", "success");
  else if (s.status === "budget_reached") toast("The session budget was reached before the agent finished.", "warning");
  else toast("Agent session finished.", "success");
}

async function openLastSession(caseId) {
  const d = await api(`/cases/${caseId}`);
  const last = (d.sessions || []).slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).pop();
  if (!last) { toast("No agent session has run on this case yet.", "warning"); return; }
  state.session = (await api(`/sessions/${last.session_id}`)).session;
  closeDrawer(); state.agentTab = "sessions"; go("agent");
}

// ---- review ------------------------------------------------------------------------------------------------------------------------------------
function renderReviews() {
  const reviews = state.cases.filter(c => c.status === "review");
  if (!reviews.find(c => c.id === state.reviewSelected) && reviews[0]) state.reviewSelected = reviews[0].id;
  const active = reviews.find(c => c.id === state.reviewSelected);
  return `${pageHead("Human review", "Judgment where it matters.", "The agent gathers evidence and proposes an outcome. A person decides whenever policy or confidence requires it.")}
    <section class="card review-layout">
      <div class="review-list"><div class="review-list-head"><strong>Queue</strong><small>${plural(reviews.length, "case")} to decide</small></div>${reviews.map(c => `<button class="review-item ${c.id === state.reviewSelected ? "active" : ""}" data-review="${esc(c.id)}"><div class="review-item-top"><strong>${esc(c.name)}</strong><span style="font-size:10px;color:var(--muted)">${esc(c.id)}</span></div><p>${esc(c.reason)}</p></button>`).join("") || empty("Queue is clear", "Nothing is waiting for a decision.")}</div>
      <div class="review-content">${active ? reviewDetail(active) : empty("Nothing waiting for review", "Cases that need a person appear here automatically.")}</div>
    </section>`;
}
function reviewDetail(c) {
  return `<div class="review-title"><div><div class="eyebrow">Decision required</div><h2>${esc(c.name)}</h2><p>${esc(c.id)} · ${esc(c.cohort)} · ${esc(c.location)}</p></div>${statusPill(c.status)}</div>
    <div class="evidence-grid">
      <div class="evidence-card"><small>Current reading</small><strong>${esc(c.outcome)}</strong><p>Proposed by the agent.</p></div>
      <div class="evidence-card flagged"><small>Programme record</small><strong>${esc(c.recorded_employer)}</strong><p>What the programme has on file.</p></div>
      <div class="evidence-card"><small>Reported employer</small><strong>${esc(c.employer)}</strong><p>From the participant's reply.</p></div>
      <div class="evidence-card"><small>Confidence</small><strong>${c.confidence}%</strong><p>Auto-confirm needs ${Math.round(state.mission.policy.auto_confirm_at * 100)}% and no conflict.</p></div></div>
    <div style="margin:14px 0"><h3 style="font-size:13px;margin:0 0 6px">Conversation</h3><div id="reviewConv"></div></div>
    <div class="agent-callout"><small>Why this needs a person</small><h3>${esc(c.reason)}</h3><p>The agent's recommendation is not a final decision.</p></div>
    ${can("review") ? `<div class="review-notes"><label for="reviewNotes">Note (kept with the decision, removed if the case is deleted)</label><textarea id="reviewNotes" placeholder="Why did you decide this?"></textarea></div>
    <div class="decision-bar"><button class="button ghost" data-decision="inconclusive" data-id="${esc(c.id)}">Mark inconclusive</button><button class="button coral" data-decision="followup" data-id="${esc(c.id)}">Request follow-up</button><button class="button ghost" data-decision="not_confirm" data-id="${esc(c.id)}">Not confirmed</button><button class="button primary" data-decision="confirm" data-id="${esc(c.id)}">Confirm outcome</button></div>`
      : `<p style="color:var(--muted);font-size:12px">Only reviewers and administrators can decide.</p>`}`;
}
async function decide(id, decision) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const note = $("reviewNotes")?.value.trim() ?? "";
  await act(() => api(`/cases/${id}/review`, { method: "POST", body: { decision, note, expected_version: c.version } }), "Decision recorded in the audit trail");
}

// ---- phone calls (ZoLabs): connection, forms and the calls made ---------------------------------------------------------------------------
const CALL_STATUS = { scheduled: ["progress", "Scheduled"], in_progress: ["progress", "In progress"], completed: ["confirmed", "Completed"], no_answer: ["review", "No answer"], busy: ["review", "Busy"], declined: ["not-confirmed", "Declined"], failed: ["not-confirmed", "Failed"] };
const FORM_STATE = { current: ["confirmed", "Published and current"], out_of_date: ["review", "Out of date"], not_published: ["not-started", "Not published"] };
const callPill = s => { const [cls, label] = CALL_STATUS[s] || ["progress", String(s).replace(/_/g, " ")]; return `<span class="status ${cls}">${esc(label)}</span>`; };
// A recording we stream ourselves comes as a path on this server; one from another provider is a full link.
const recordingSrc = u => (u.startsWith("/") ? `${API_BASE}${u}` : u);
const mmss = s => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function renderCalls() {
  const v = state.voice;
  if (!v) return empty("Loading phone calls…", "Reading the connection and the calls.");
  const kind = { zolabs: "ZoLabs, live", simulated: "Simulator: nobody is rung", off: "Not connected" }[v.kind] || v.kind;
  const chk = state.voiceCheck;
  const checkNote = chk ? (chk.ok ? `<p style="font-size:12px;margin:8px 0;color:var(--sys)">Connected. Signed in as ${esc(typeof chk.account === "string" ? chk.account : chk.account?.email || chk.account?.name || chk.account?.account || JSON.stringify(chk.account).slice(0, 120))}.</p>` : `<p style="font-size:12px;margin:8px 0;color:#b64b48">Could not connect: ${esc(chk.error)}</p>`) : "";
  const forms = v.forms.map(f => `<tr><td><strong>${esc(f.name)}</strong><small style="display:block;color:var(--muted)">${esc(f.mission_version)}</small></td><td>${f.form_id ? esc(f.form_id) : "—"}</td><td><span class="status ${FORM_STATE[f.state][0]}">${esc(FORM_STATE[f.state][1])}</span></td><td style="font-size:12px">${f.published_at ? `${esc(istDay(f.published_at))} ${esc(istTime(f.published_at))}<small style="display:block;color:var(--muted)">${esc(f.published_by || "")}</small>` : "—"}</td></tr>`).join("");
  const calls = v.calls.map(k => `<tr><td>${esc(istDay(k.requested_at))} ${esc(istTime(k.requested_at))}${k.scheduled_for ? `<small style="display:block;color:var(--muted)">for ${esc(istDay(k.scheduled_for))} ${esc(istTime(k.scheduled_for))}</small>` : ""}</td>
    <td><button style="background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit;text-align:left" data-case="${esc(k.case_id)}"><strong>${esc(k.person)}</strong></button><small style="display:block;color:var(--muted)">${esc(k.case_id)}</small></td>
    <td>${callPill(k.status)}</td><td>${esc(mmss(k.duration_seconds))}</td>
    <td style="font-size:12px">${k.asked?.length ? esc(k.asked.join(", ").replace(/_/g, " ")) : "everything"}${k.reason ? `<small style="display:block;color:var(--muted)">${esc(k.reason)}</small>` : ""}</td>
    <td style="font-size:12px">${k.audio_url ? `<audio controls preload="none" src="${esc(recordingSrc(k.audio_url))}" style="max-width:200px"></audio>` : k.has_audio ? `<small style="color:var(--muted)">Recording kept. Reviewers can play it.</small>` : `<small style="color:var(--muted)">No recording</small>`}${k.transcript ? `<details><summary style="cursor:pointer">Transcript</summary><pre style="white-space:pre-wrap;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:6px 0 0">${esc(k.transcript)}</pre></details>` : k.has_transcript ? `<small style="display:block;color:var(--muted)">Transcript kept. Reviewers can read it.</small>` : ""}</td></tr>`).join("");
  return `${pageHead("Phone calls", "How the voice agent reaches people.", "The platform asks for a call, a person approves it, and ZoLabs places it. Here is the connection, the form each mission uses, and every call made.")}
    <div class="agent-layout">
      <section class="card config-section"><div class="card-head"><div><h2>Connection</h2><p>What is switched on</p></div><span class="status ${v.kind === "zolabs" ? "confirmed" : v.kind === "simulated" ? "progress" : "not-started"}">${esc(kind)}</span></div>
        <div class="config-list">
          ${configRow("Calls", v.calls_enabled ? "Switched on" : "Switched off", v.calls_enabled ? "Approved calls are placed by the scheduler." : "Nothing will ring, even when a call is approved.")}
          ${configRow("Who can be called", v.who_can_be_called, "Only people who have not opted out, inside the contact hours.")}
          ${configRow("Finished calls", v.callback_ready ? "ZoLabs rings us back" : "Found by the scheduler", v.callback_ready ? "ZoLabs tells us the moment a call finishes, and we fetch the details ourselves." : "No callback address is set, so results are picked up when the scheduler runs.")}
        </div>
        ${checkNote}
        ${v.can_check && v.kind !== "off" ? `<button class="button ghost small" data-action="voice-check">Check connection</button><small style="display:block;color:var(--muted);font-size:10px;margin-top:6px">Asks ZoLabs who we are signed in as. Places no call and costs nothing.</small>` : ""}</section>
      <aside class="card config-section"><div class="card-head"><div><h2>Phone forms</h2><p>One per mission</p></div></div>
        <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Mission</th><th>Form</th><th>State</th><th>Published</th></tr></thead><tbody>${forms}</tbody></table></div>
        <div style="margin-top:10px"><button class="button ghost small" data-go="missions">Open a mission to preview or publish</button></div></aside></div>
    <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Calls</h2><p>Most recent first. Recordings and transcripts are shown to reviewers and platform staff only.</p></div><span class="status active">${v.calls.length}</span></div>
      ${v.calls.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Requested</th><th>Person</th><th>Result</th><th>Length</th><th>What it asked</th><th>Recording</th></tr></thead><tbody>${calls}</tbody></table></div>` : empty("No calls yet", "When the agent asks for a call and a person approves it, it appears here.")}</section>`;
}
// While a call is in progress, ask the server every few seconds whether it has finished, and show the result when it has.
let callSyncBusy = false, lastSyncError = "";
async function syncCallsNow() {
  if (callSyncBusy || !state.loaded || !state.me || state.me.voice === "off" || !can("run")) return;
  if (!state.voice?.calls?.some(k => k.status === "in_progress" || k.status === "scheduled")) return;
  callSyncBusy = true;
  try {
    const r = await api("/voice/sync", { method: "POST" });
    if (r.errors?.length && r.errors[0] !== lastSyncError) { lastSyncError = r.errors[0]; toast("Could not check the call at ZoLabs: " + r.errors[0], "warning"); }
    if (r.applied > 0) { await loadAll(); toast(r.applied === 1 ? "A call finished. The answers are on the case." : r.applied + " calls finished. The answers are on the cases.", "success"); }
  } catch { /* try again on the next beat */ } finally { callSyncBusy = false; }
}
setInterval(syncCallsNow, 8000);

async function checkVoice() {
  try { state.voiceCheck = await api("/voice/check", { method: "POST" }); render(); toast(state.voiceCheck.ok ? "Connected to ZoLabs." : "Could not connect to ZoLabs.", state.voiceCheck.ok ? "success" : "warning"); }
  catch (e) { toast(e.message, "warning"); }
}

// ---- approvals and controls: a person's say over what the agent does -------------------------------------------------------------------
const ACTION_NOTE = { message_template: "Approved wording, chosen by the agent", message_scripted: "The interview's own questions, in approved wording", message_free: "Text the agent writes itself (not used yet)", voice_call: "The agent asks for a call; the voice agent then speaks" };
const approvalState = s => ({ held: ["review", "Waiting for a person"], approved: ["confirmed", "Approved"], rejected: ["not-confirmed", "Declined"] }[s] || ["progress", s]);

function renderApprovals() {
  const list = state.approvals, waiting = list.filter(a => a.state === "held"), done = list.filter(a => a.state !== "held");
  const canDecide = can("approve");
  const row = a => `<tr><td><strong>${esc(a.participant)}</strong><small style="display:block;color:var(--muted)">${esc(a.case_id)}</small></td><td>${esc(a.label)}</td><td style="font-size:12px;max-width:420px">${esc(a.summary)}</td><td>${esc(istDay(a.held_at))} ${esc(istTime(a.held_at))}</td>
    <td>${a.state === "held" ? (canDecide ? `<div style="display:flex;gap:6px"><button class="button primary small" data-approve="${esc(a.outbox_id)}">Approve</button><button class="button ghost small" data-reject="${esc(a.outbox_id)}">Decline</button></div>` : `<small style="color:var(--muted)">Only reviewers, administrators and agent operations can decide.</small>`) : `<span class="status ${approvalState(a.state)[0]}">${esc(approvalState(a.state)[1])}</span><small style="display:block;color:var(--muted)">${esc(a.decided_by || "")} ${a.decided_at ? esc(istTime(a.decided_at)) : ""}${a.note ? " · " + esc(a.note) : ""}</small>`}</td></tr>`;
  const table = rows => `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Person</th><th>What</th><th>Details</th><th>Proposed</th><th></th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;
  return `${pageHead("Approvals", "A person says yes first.", "Some things the agent proposes are held until someone approves them. Nothing here is sent or placed until you do. You choose which kinds of action need this on the Controls tab of the Claude engine page.")}
    <section class="card card-pad"><div class="card-head"><div><h2>Waiting for you</h2><p>Approve to release it, or decline to stop it and send the case to a person</p></div><span class="status ${waiting.length ? "review" : "confirmed"}">${waiting.length}</span></div>
      ${waiting.length ? table(waiting) : empty("Nothing is waiting", "When the agent proposes something that needs a person's approval, it appears here.")}</section>
    ${done.length ? `<section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Decided</h2><p>The most recent decisions</p></div></div>${table(done.slice(0, 30))}</section>` : ""}`;
}
async function decideApproval(id, decision) {
  await act(() => api(`/approvals/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: {} }), null).then(out => { if (!out) return; toast(decision === "reject" ? "Declined. The case was sent to a person." : out.call ? (out.call.placed ? "Approved. Calling now." : `Approved, but the call could not be placed: ${out.call.error ?? "unknown reason"}.`) : "Approved. It goes out on the next scheduler pass.", out.call && !out.call.placed ? "warning" : "success"); });
}

function renderControls() {
  const k = state.controlsInfo;
  if (!k) return empty("Loading the controls…", "Reading the current settings.");
  const c = k.controls, canChange = k.can_change, stat = Object.fromEntries(k.stats.map(s => [s.kind, s]));
  const dial = k.actions.map(a => { const s = stat[a.kind]; return `<tr><td><strong>${esc(a.label)}</strong><small style="display:block;color:var(--muted)">${esc(ACTION_NOTE[a.kind])}</small></td>
    <td><select class="filter-select" data-dial="${esc(a.kind)}" ${canChange ? "" : "disabled"} aria-label="${esc(a.label)}"><option value="approve_first" ${c.autonomy[a.kind] === "approve_first" ? "selected" : ""}>A person approves first</option><option value="automatic" ${c.autonomy[a.kind] === "automatic" ? "selected" : ""}>Automatic</option></select></td>
    <td style="font-size:12px">${s.approved} approved, ${s.rejected} declined${s.held ? `, ${s.held} waiting` : ""}${s.suggest_automatic ? `<small style="display:block;color:var(--sys)">Ten approvals and no refusals: this could safely go automatic.</small>` : ""}</td></tr>`; }).join("");
  const sw = c.paused
    ? `<div class="agent-callout" style="border-color:#b64b48"><small>Switched off${c.paused_by ? " by " + esc(c.paused_by) : ""}${c.paused_at ? " at " + esc(istTime(c.paused_at)) : ""}</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>${c.paused_reason ? esc(c.paused_reason) + ". " : ""}Replies are still recorded. ${plural(k.queued_unsent, "message")} and calls are queued and will go out when you switch it back on.</p>${k.can_pause ? `<button class="button primary small" data-action="resume-platform">Switch back on</button>` : ""}</div>`
    : `<div class="agent-callout"><small>Running normally</small><h3>The kill switch stops everything at once.</h3><p>No message is sent, no call is placed, no campaign queues and the agent is not woken. Replies are still recorded. Use it if something wrong is going out.</p>${k.can_pause ? `<button class="button coral small" data-action="pause-platform">Switch everything off</button>` : ""}</div>`;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Autonomy dial</h2><p>What the agent may do on its own, and what waits for a person</p></div><span class="status ${k.held ? "review" : "active"}">${k.held} waiting</span></div>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Rule</th><th>So far</th></tr></thead><tbody>${dial}</tbody></table></div>
      ${canChange ? "" : `<p style="color:var(--muted);font-size:11px">Only administrators and agent operations can change the dial and the limits.</p>`}</section>
    <aside class="card config-section"><div class="card-head"><div><h2>Kill switch</h2><p>Stop everything now</p></div></div>${sw}</aside></div>
    <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Limits</h2><p>The agent stops, and a person is asked, when a limit is reached. 0 means no limit.</p></div><span class="status active">$${k.spend_24h.toFixed(2)} in the last 24 hours</span></div>
      <div class="form-grid">
        <div class="field"><label for="limDaily">Most the agent may spend in 24 hours (USD)</label><input id="limDaily" type="number" min="0" step="0.5" value="${esc(c.daily_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limCase">Most on one case, in total (USD)</label><input id="limCase" type="number" min="0" step="0.1" value="${esc(c.case_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limWakes">Most wake-ups on one case</label><input id="limWakes" type="number" min="1" step="1" value="${esc(c.max_wakes_per_case)}" ${canChange ? "" : "disabled"} /></div>
      </div>
      ${canChange ? `<div style="margin-top:10px"><button class="button primary small" data-action="save-limits">Save limits</button></div>` : ""}
      <small style="color:var(--muted);font-size:10px;display:block;margin-top:8px">Amounts use indicative prices. ${plural(k.pending_wakes, "wake-up")} are set for later.${c.updated_by ? ` Last changed by ${esc(c.updated_by)}.` : ""}</small></section>`;
}
async function saveControls(patch, okMessage) { await act(() => api("/controls", { method: "POST", body: patch }), okMessage); }

// What the platform would do now with what an agent session did.
async function replaySession(id) {
  try { state.replay = await api(`/sessions/${encodeURIComponent(id)}/replay`); render(); }
  catch (e) { toast(e.message, "warning"); }
}
function replayHtml(r) {
  if (!r) return "";
  const lab = { allowed: "Still allowed", would_be_held: "Would wait for a person", refused: "Would be refused" };
  const body = r.rows.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Then</th><th>Now</th><th></th></tr></thead><tbody>${r.rows.map(x => `<tr><td><code>${esc(x.tool)}</code></td><td>${esc(x.recorded === "unknown" ? "not recorded" : { executed: "ran", held: "held", refused: "refused" }[x.recorded])}</td><td>${esc(lab[x.now])}${x.message ? `<small style="display:block;color:var(--muted)">${esc(x.message)}</small>` : ""}</td><td>${x.changed ? `<span class="status review">Changed</span>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);font-size:12px">This session took no action that can be checked.</p>`;
  return `<section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Replay under today's rules</h2><p>${esc(r.note)}</p></div></div>${body}</section>`;
}

// ---- Claude engine -------------------------------------------------------------------------------------------------------------------------
const TOOL_HELP = {
  case_get_context: ["Read", "Authorised facts and evidence for one case. No names or phone numbers."],
  mission_get_bundle: ["Read", "The mission's modules, approved messages, contact policy and rubric."],
  case_get_timeline: ["Read", "Recent ledger events for the case."],
  whatsapp_send_template: ["Action", "Queue an approved message. Checks consent, window, attempt cap and opt-out."],
  callback_schedule: ["Action", "Set its own wake-up: the agent is woken at that time to look at the case again."],
  voice_call_request: ["Action", "Request a phone call for what is still missing. Checks consent, hours and attempts."],
  memory_note: ["Action", "Remember one fixed fact about the person (best time to call, preferred channel, language). Nothing else can be stored."],
  decision_propose: ["Gated", "Propose an outcome with evidence. The system decides whether it is final."],
  review_request: ["Gated", "Send the case to a person with a reason."],
};

function renderAgent() {
  const tab = state.agentTab;
  const tabs = [["agent", "Agent"], ["employee", "Employee"], ["controls", "Controls"], ["sessions", "Sessions"]];
  return `${pageHead("Claude engine", "The agent, its limits and what it has done.", "It can only use the tools below. It cannot read the database, see phone numbers, or complete a case on its own.")}
    <div class="agent-tabs" role="tablist">${tabs.map(([id, l]) => `<button class="agent-tab ${tab === id ? "active" : ""}" data-agent-tab="${id}" role="tab">${l}</button>`).join("")}</div>
    ${tab === "agent" ? renderAgentInfo() : tab === "employee" ? renderEmployee() : tab === "controls" ? renderControls() : renderSessions()}`;
}
function renderAgentInfo() {
  const r = state.mission.runtime;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Configuration</h2><p>What is running right now</p></div><span class="status ${r.agent === "claude" ? "confirmed" : "progress"}">${r.agent === "claude" ? "Claude" : "Scripted stand-in"}</span></div>
      <div class="config-list">
        ${configRow("Agent", r.agent === "claude" ? "Claude, through the tool gateway" : "Scripted stand-in (no model)", r.agent === "claude" ? "A real model decides which tool to use." : "No Anthropic key is set, so the agent follows a fixed script.")}
        ${configRow("Reading replies", r.classifier === "claude" ? "Rules, then a model for unclear replies" : "Rules only", r.classifier === "claude" ? "Participant text is sent to the model only when the rules cannot place it." : "No participant text goes to a model to be understood.")}
        ${configRow("Model", r.model || "None", "Pinned per release; changed in configuration.")}
        ${configRow("WhatsApp", r.whatsapp === "live" ? "Live" : "Off", r.whatsapp === "live" ? "Approved messages go to participants on the send allowlist." : "Replies are simulated; nothing is sent.")}
        ${configRow("Contact window", r.contact_window, `At most ${state.mission.policy.max_attempts} approved attempts per participant.`)}
        ${configRow("Auto-confirm", `${Math.round(state.mission.policy.auto_confirm_at * 100)}% and no conflict`, "Anything lower or conflicting goes to a person.")}
      </div></section>
    <aside class="card config-section"><div class="card-head"><div><h2>What it cannot do</h2><p>Enforced by the system, not by instruction</p></div></div>
      <div class="prohibited-strip" style="flex-direction:column;align-items:flex-start;gap:6px"><span>× Query the database</span><span>× See names or phone numbers</span><span>× Complete or delete a case</span><span>× Record an opt-out on its own</span><span>× Send anything not on the approved list</span><span>× Contact someone who opted out</span></div></aside>
  </div>
  <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Tools</h2><p>The only things the agent can do</p></div><span class="status active">${state.mission.tools.length}</span></div>
    <div class="tool-registry">${state.mission.tools.map(t => `<div class="tool-card"><div class="tool-card-head"><code>${esc(t)}</code><span class="permission-pill ${TOOL_HELP[t]?.[0] === "Read" ? "allow" : "review"}">${esc(TOOL_HELP[t]?.[0] || "")}</span></div><p>${esc(TOOL_HELP[t]?.[1] || "")}</p></div>`).join("")}</div></section>`;
}
const configRow = (label, value, desc) => `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><strong>${esc(value)}</strong><p>${esc(desc)}</p></span></div>`;

// ---- the employee: the reusable AI worker above every mission ------------------------------------------------------------------
async function showEmployee(version) {
  try {
    state.employeeShown = version;
    state.employeeDef = (await api("/employees/" + encodeURIComponent(version))).employee;
    state.ctxPreview = null;
    render();
  } catch (e) { toast(e.message, "warning"); }
}
async function showContext(missionVersion) {
  try { state.ctxPreview = await api("/employees/" + encodeURIComponent(state.employeeShown) + "/context?mission_version=" + encodeURIComponent(missionVersion)); render(); }
  catch (e) { toast(e.message, "warning"); }
}
const longText = (label, text) => `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><p style="white-space:pre-wrap;margin:0">${esc(text)}</p></span></div>`;
const listText = (label, items) => (items && items.length ? `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><ul style="margin:0;padding-left:18px">${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></span></div>` : "");

function renderEmployee() {
  const e = state.employeeDef;
  if (!e) return empty("Loading the employee…", "Reading the current version.");
  const info = state.employees.find(x => x.version === e.version);
  const versions = state.employees.map(x => `<button class="review-item ${x.version === e.version ? "active" : ""}" data-employee="${esc(x.version)}"><div class="review-item-top"><strong>${esc(x.name)} · ${esc(x.version)}</strong><span style="font-size:10px;color:var(--muted)">${x.current ? "current" : "older"}</span></div><p>${x.builtin ? "Built in" : "Added " + esc(istDay(x.created_at))}. ${plural(x.missions_using, "mission")} use it.</p></button>`).join("");
  const mission = state.ctxPreview?.mission_version || state.defaultMission;
  const layers = state.ctxPreview ? state.ctxPreview.layers.map(l => `<details style="margin:8px 0"><summary style="cursor:pointer;font-size:12px"><strong>${esc(l.title)}</strong> <small style="color:var(--muted)">(${esc(l.layer)} layer)</small></summary><pre style="white-space:pre-wrap;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0 0">${esc(l.text)}</pre></details>`).join("") + `<small style="color:var(--muted)">About ${state.ctxPreview.estimated_tokens.toLocaleString()} tokens. Cached: ${esc(state.ctxPreview.cached_as.join("; "))}. Nothing about a person is ever in here: the case is read through a tool.</small>` : `<p style="color:var(--muted);font-size:12px">Choose a mission to see the exact text the agent is given.</p>`;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>${esc(e.name)} <small style="color:var(--muted);font-weight:500">${esc(e.version)}</small></h2><p>One employee does every mission. A mission can pin an exact version or follow the current one.</p></div><span class="status ${info?.current ? "confirmed" : "progress"}">${info?.current ? "Current" : "Older version"}</span></div>
      <div class="config-list">${longText("Purpose", e.purpose)}${longText("Persona and tone", e.persona)}${longText("Standing instructions", e.instructions)}${listText("Never does", e.guardrails)}${listText("Hands to a person when", e.escalation_rules)}${e.knowledge?.length ? longText("Knows", e.knowledge.map(k => k.title + ": " + k.text).join("\n\n")) : ""}${e.memory_policy ? longText("Memory", e.memory_policy) : ""}${configRow("Limits per run", `${e.model?.max_turns ?? 12} turns, up to ${(e.model?.budget_usd ?? 0.5).toFixed(2)}`, `Effort ${e.model?.effort ?? "medium"}${e.model?.name ? ", model " + e.model.name : ", the platform's pinned model"}.`)}</div></section>
    <aside class="card config-section"><div class="card-head"><div><h2>Versions</h2><p>Saved versions never change</p></div>${state.employeeCanEdit ? `<button class="button primary small" data-action="add-employee">Add a version</button>` : ""}</div><div class="review-list" style="border:0">${versions}</div>
      ${state.employeeCanEdit ? "" : `<p style="color:var(--muted);font-size:11px">Only platform staff (administrators and agent operations) can add a version. Clients never create employees.</p>`}</aside>
  </div>
  <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Tools this employee may use</h2><p>The gateway refuses any other tool, whatever the model asks for</p></div><span class="status active">${e.allowed_tools.length}</span></div>
    <div class="tool-registry">${e.allowed_tools.map(t => `<div class="tool-card"><div class="tool-card-head"><code>${esc(t)}</code><span class="permission-pill ${TOOL_HELP[t]?.[0] === "Read" ? "allow" : "review"}">${esc(TOOL_HELP[t]?.[0] || "")}</span></div><p>${esc(TOOL_HELP[t]?.[1] || "")}</p></div>`).join("")}</div></section>
  <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>What the agent is told</h2><p>Platform rules, then this employee, then the mission. The case itself is read through a tool.</p></div>
    <select class="filter-select" id="ctxMission" aria-label="Mission">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === mission ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select></div>${layers}</section>`;
}

function openEmployeeModal() {
  const s = { text: "", error: null, running: false };
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add an employee version</h2><p>Saved versions never change. A mission that does not pin a version starts using the newest one straight away, so test the change first.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="field full"><label>Start from</label><div><button type="button" class="button ghost small" id="eLoad">Copy ${esc(state.employeeDef?.version || "the current version")} here</button></div></div>
        <div class="field full"><label for="eText">Definition (JSON)</label><textarea id="eText" rows="16" spellcheck="false" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px" placeholder="Copy the current version, then change the version name and what you want to improve.">${esc(s.text)}</textarea><small>Change version at least. The platform's safety rules apply whatever is written here, and allowed_tools limits what the agent may do.</small></div>
        ${s.error ? `<p style="color:#b64b48;font-size:12px;grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelE">Cancel</button><button class="button primary" id="saveE" ${s.running || !s.text.trim() ? "disabled" : ""}>Save version</button></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelE").addEventListener("click", closeModal);
    $("eLoad").addEventListener("click", () => { const { created_at, created_by, ...def } = state.employeeDef || {}; s.text = JSON.stringify(def, null, 2); s.error = null; draw(); });
    $("eText").addEventListener("input", e => { s.text = e.target.value; $("saveE").disabled = !s.text.trim(); });
    $("saveE").addEventListener("click", async () => {
      let body;
      try { body = JSON.parse(s.text); } catch { s.error = "That is not valid JSON. Check for a missing comma or quote."; draw(); return; }
      s.running = true; s.error = null; $("saveE").disabled = true;
      try { const out = await api("/employees", { method: "POST", body }); closeModal(); state.employeeDef = null; await loadAll(); await showEmployee(out.employee.version); toast("Version saved. Missions that follow the current version use it from now on.", "success"); }
      catch (e) { s.running = false; s.error = e.message; draw(); }
    });
  };
  draw(); modalBackdrop.hidden = false;
}

function renderSessions() {
  if (state.session) return renderSessionViewer(state.session);
  const ss = state.sessions;
  if (!ss.length) return empty("No agent sessions yet", "Open a case and run an agent session. Each run is recorded here with its steps and cost.");
  const total = ss.reduce((n, s) => n + s.cost_usd, 0);
  return `<div class="monitor-kpis">
      <div class="card monitor-kpi"><small>Sessions</small><strong>${ss.length}</strong><span>all time</span></div>
      <div class="card monitor-kpi"><small>Total cost</small><strong>$${total.toFixed(2)}</strong><span>${ss.some(s => s.simulated) ? "includes simulated runs" : "from token usage"}</span></div>
      <div class="card monitor-kpi"><small>Average cost</small><strong>$${(total / ss.length).toFixed(3)}</strong><span>per session</span></div>
      <div class="card monitor-kpi"><small>Hit the budget</small><strong>${ss.filter(s => s.status === "budget_reached").length}</strong><span>stopped early</span></div></div>
    <section class="card session-monitor-table" style="margin-top:15px"><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Session</th><th>Case</th><th>Started</th><th>Status</th><th>Tokens</th><th>Cost</th><th></th></tr></thead><tbody>${ss.map(s => `<tr><td><code style="font-size:11px">${esc(s.session_id)}</code></td><td><strong>${esc(s.case_id)}</strong></td><td>${esc(istDay(s.started_at))} ${esc(istTime(s.started_at))}</td><td>${esc(s.status)}${s.simulated ? " (simulated)" : ""}</td><td>${(s.tokens_in + s.tokens_out).toLocaleString()}</td><td>$${s.cost_usd.toFixed(3)}</td><td><button class="row-action" data-open-session="${esc(s.session_id)}">›</button></td></tr>`).join("")}</tbody></table></div></section>`;
}

function renderSessionViewer(s) {
  const turns = s.trace.length ? s.trace.map(t => {
    const actor = t.tool ? "Claude · tool request" : t.type.startsWith("session") ? "Session state" : t.type === "system.message" ? "System event" : "Runtime";
    const body = t.tool
      ? `<p>Calling an approved capability.</p><div class="tool-call"><div class="tool-call-head"><strong>${esc(t.tool)}</strong><span>${t.outcome === "held" ? "held for approval" : t.result?.code ? "refused" : "completed"}</span></div><pre>INPUT  ${esc(JSON.stringify(t.input))}\nRESULT ${esc(JSON.stringify(t.result).slice(0, 360))}</pre></div>`
      : `<p>${esc(t.detail)}</p>`;
    return `<div class="model-turn"><div class="turn-meta"><span class="turn-actor"><span>${t.tool ? "AI" : "S"}</span>${actor}</span><span>${esc(istTime(t.ts))}</span></div>${body}</div>`;
  }).join("") : `<p style="color:var(--muted);font-size:12px">The step-by-step record was removed (the case was deleted).</p>`;
  const steps = s.trace.map(t => `<div class="trace-event complete"><span class="trace-index">✓</span><span class="trace-copy"><strong>${esc(t.label)}</strong><small>${esc(t.type)}${t.tool ? "" : ` · ${esc(t.detail)}`}</small></span></div>`).join("");
  return `<div style="margin-bottom:12px"><button class="button ghost small" data-action="close-session">← All sessions</button></div>
    <section class="card session-header"><div class="session-identity"><span class="session-pulse">Ⅱ</span><div><h2>Session ${esc(s.session_id)}</h2><p>Case ${esc(s.case_id)} · Agent v${esc(s.employee_version)} · ${esc(s.mission_version)}</p></div>${statusPill(s.status === "budget_reached" ? "review" : "confirmed")}</div><div class="session-actions"><span class="beta-chip">${s.simulated ? "Simulated agent" : "Claude"} · same tool gateway</span><button class="button ghost small" data-replay="${esc(s.session_id)}">Replay under today's rules</button></div></section>
    <section class="card session-grid"><aside class="trace-sidebar"><h3>Steps</h3>${steps}</aside>
      <div class="transcript"><div class="transcript-head"><h3>Transcript</h3><span style="font-size:10px;color:var(--muted)">Recorded from the tool gateway</span></div>${turns}</div>
      <aside class="inspector"><div class="inspector-tabs"><button class="inspector-tab active">Session</button></div><div class="inspector-body">
        ${field("Status", s.status)}${field("Woken by", (s.trigger || "first run").replace("wake:", "timer: ").replace(/_/g, " "))}${field("Tool calls", `${s.trace.filter(t => t.tool).length} · ${s.trace.filter(t => t.result?.code).length} refused`)}${field("Tokens in / out", `${s.tokens_in.toLocaleString()} / ${s.tokens_out.toLocaleString()}`)}
        <div class="inspector-field"><small>Budget</small><strong>$${s.cost_usd.toFixed(3)} of $${s.budget_usd.toFixed(2)}</strong><div class="budget-track"><span style="width:${Math.min(100, (s.cost_usd / s.budget_usd) * 100)}%"></span></div></div></div></aside></section>${replayHtml(state.replay && state.replay.session_id === s.session_id ? state.replay : null)}`;
}
const field = (l, v) => `<div class="inspector-field"><small>${esc(l)}</small><strong>${esc(v)}</strong></div>`;

// ---- mission (read only) ---------------------------------------------------------------------------------------------------------------
// The evidence a mission needs: the checklist the employee works through for every person.
function needsCard(m) {
  const rs = m.requirements || [];
  const label = k => rs.find(r => r.key === k)?.label || k;
  const body = rs.length ? rs.map(r => `<div class="check-item"><span class="check-mark">${r.required ? "●" : "○"}</span><span><strong>${esc(r.label)}</strong><small>${r.required ? "Required" : "Optional"}, counts at ${Math.round(r.min_confidence * 100)}% sure or more${r.when ? `, only if ${esc(label(r.when.key).toLowerCase())} is ${esc(r.when.in.map(v => v.replace(/_/g, " ")).join(" or "))}` : ""}${r.checked_against ? ", checked against the programme record" : ""}.${r.hint ? " " + esc(r.hint) : ""}</small></span></div>`).join("") : `<p style="color:var(--muted);font-size:12px">This mission does not list what it needs to know. Add evidence_requirements so the employee can tell what is still missing for each person.</p>`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>What the employee must find out</h2><p>For each person, the employee works until these are known, choosing the easiest way to ask</p></div><span class="status ${rs.length ? "active" : "progress"}">${rs.length}</span></div><div class="check-list">${body}</div></section>`;
}
// The phone form: what the voice provider is told for this mission, and whether what is published is still current.
function voiceCard(m) {
  const off = state.me?.voice === "off";
  const v = state.voiceFormFor === m.version ? state.voiceForm : null;
  const status = !v ? "" : v.link ? (v.in_sync ? `<span class="status confirmed">Published and current</span>` : `<span class="status review">Out of date</span>`) : `<span class="status progress">Not published</span>`;
  const note = !v ? "" : v.link ? `<p style="font-size:12px;margin:8px 0">Published as form ${esc(v.link.form_id)} on ${esc(istDay(v.link.published_at))} ${esc(istTime(v.link.published_at))} by ${esc(v.link.published_by)}.${v.in_sync ? "" : " The mission or the employee has changed since, so the voice agent is working from older instructions. Publish again to update it."}</p>` : `<p style="font-size:12px;margin:8px 0">Nothing is published yet, so the agent cannot ask for a phone call on this mission.</p>`;
  const fields = !v ? "" : `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px"><strong>What the voice agent is told</strong> (instructions and ${v.definition.form_fields.length} fields)</summary><pre style="white-space:pre-wrap;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0">${esc(v.definition.start_message + "\n\n" + v.definition.form_context)}</pre>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Field</th><th>Type</th><th>What it asks</th></tr></thead><tbody>${v.definition.form_fields.map(f => `<tr><td><code>${esc(f.field_id)}</code><small style="display:block;color:var(--muted)">${esc(f.field_name)}</small></td><td>${esc(f.datatype)}</td><td style="font-size:11px">${esc(f.additional_info)}</td></tr>`).join("")}</tbody></table></div></details>`;
  const buttons = off ? "" : `<button class="button ghost small" data-action="voice-preview">${v ? "Refresh the preview" : "Preview the phone form"}</button>${v && state.employeeCanEdit ? (state.voicePublishing ? `<button class="button primary small" disabled>Publishing… this can take a minute</button>` : v.link && v.in_sync ? "" : `<button class="button primary small" data-action="voice-publish">${v.link ? "Update at ZoLabs" : "Create at ZoLabs"}</button>`) : ""}`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Phone calls (ZoLabs)</h2><p>The form the voice agent follows for this mission. A person publishes it; the agent only asks for calls.</p></div>${status}</div>
    ${off ? `<p style="color:var(--muted);font-size:12px">Phone calls are not switched on for this platform yet.</p>` : `${note}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${buttons}</div>${fields}`}
    ${state.me?.voice === "simulated" ? `<small style="color:var(--muted);font-size:10px;display:block;margin-top:8px">Simulator: nobody is rung. Use the case page to finish a call yourself.</small>` : ""}</section>`;
}
async function loadVoiceForm(version) {
  try { state.voiceForm = await api("/missions/" + encodeURIComponent(version) + "/voice-form"); state.voiceFormFor = version; render(); }
  catch (e) { toast(e.message, "warning"); }
}
function renderMission() {
  const m = state.missionShown ?? state.mission, r = m.runtime;
  const picker = `<select class="filter-select" id="missionPick" aria-label="Choose a mission">${state.missions.map(x => `<option value="${esc(x.version)}" ${x.version === m.version ? "selected" : ""}>${esc(x.name)} · ${esc(x.version)} (${plural(x.participants, "participant")})</option>`).join("")}</select>`;
  const actions = `${picker}${can("admin") ? `<button class="button primary" data-action="add-mission">Add a mission</button>` : ""}`;
  const detail = `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Set up for this client</h2><p>What changes from one mission to the next</p></div>${m.builtin ? `<span class="status not-started">Built in</span>` : `<span class="status confirmed">Saved version</span>`}</div>
      <div class="check-list">
        ${m.employee ? `<div class="check-item"><span class="check-mark">☺</span><span><strong>Done by</strong><small>${esc(m.employee.name)}, ${esc(m.employee.version)} (${m.employee.pinned ? "this exact version" : "follows the current version"}). Open the Employee tab on the Claude engine page to see what it is told.</small></span></div>` : ""}
        ${m.objective ? `<div class="check-item"><span class="check-mark">◎</span><span><strong>Goal</strong><small>${esc(m.objective)}</small></span></div>` : ""}
        ${m.strategy ? `<div class="check-item"><span class="check-mark">↗</span><span><strong>Suggested approach</strong><small>Channels in order: ${m.strategy.channels.map(c => c === "voice" ? "phone call" : "WhatsApp").join(", then ")}. Follow up after about ${m.strategy.follow_up_after_hours} hours of silence.${m.strategy.notes ? " " + esc(m.strategy.notes) : ""} These are hints: the employee may deviate inside the safety rules.</small></span></div>` : ""}
        <div class="check-item"><span class="check-mark">·</span><span><strong>First message</strong><small>${esc(m.intro_template)}${m.programme_name ? ` · programme name "${esc(m.programme_name)}"` : ""}</small></span></div>
        ${m.templates.map(t => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(t.key)}</strong><small>${esc(t.purpose)} · ${esc(t.language)} · WhatsApp template: ${t.provider_name ? esc(t.provider_name) : "<b>not set</b>"}</small></span></div>`).join("")}
        <div class="check-item"><span class="check-mark">·</span><span><strong>Agent working notes</strong><small>${m.agent_guidance ? esc(m.agent_guidance) : "None. The agent follows the standard rules only."}</small></span></div>
        ${m.created_at ? `<div class="check-item"><span class="check-mark">·</span><span><strong>Added</strong><small>${esc(istDay(m.created_at))} ${esc(istTime(m.created_at))} by ${esc(m.created_by)}. Saved missions never change: a change is a new version.</small></span></div>` : ""}
      </div></section>`;
  const checks = [
    [m.instrument_signed_off, "Questionnaire wording signed off", m.instrument_signed_off ? "Approved" : `${m.questions_total} question slots exist but the wording is not approved yet`],
    [r.whatsapp === "live", "WhatsApp sending", r.whatsapp === "live" ? "On, to allowlisted numbers" : "Off. Replies are simulated"],
    [!m.instrument.draft, "Interview questions approved", m.instrument.draft ? `${m.instrument.questions} draft questions. ${r.draft_instrument_allowed ? "Allowed for testing only" : "Blocked for real conversations until approved"}` : "Approved"],
    [m.templates.length > 0, "Approved message template", m.templates.map(t => t.key).join(", ") || "None configured"],
    [state.cases.length > 0, "Participants loaded", state.cases.length ? plural(state.cases.length, "participant") : "None yet"],
    [r.agent === "claude", "Claude agent", r.agent === "claude" ? `Running ${r.model}` : "Scripted stand-in is running (no model key)"],
  ];
  return `${pageHead("Mission", m.name, "Each client or programme has its own mission: first message, questions, contact rules and agent notes. New participants join the most recently added one unless you choose.", actions)}
    <section class="card mission-hero"><div class="mission-meta"><span class="mission-icon">↗</span><div><h2>${esc(m.name)}</h2><p>${esc(m.mission_id)} · ${esc(m.version)}</p></div></div>
      <div class="mission-stats"><div class="mission-stat"><strong>${m.questions_total}</strong><small>Question slots</small></div><div class="mission-stat"><strong>${m.templates.length}</strong><small>Approved messages</small></div><div class="mission-stat"><strong>${m.policy.max_attempts}</strong><small>Contact attempts</small></div><div class="mission-stat"><strong>${esc(m.policy.contact_window)}</strong><small>Contact window</small></div></div></section>
    ${detail}
    ${needsCard(m)}
    ${voiceCard(m)}
    <div class="grid two" style="margin-top:16px">
      <section class="card card-pad"><div class="card-head"><div><h2>Questionnaire</h2><p>Modules and how many questions each holds</p></div></div>
        <div class="check-list">${m.modules.map(x => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(x.title)}</strong><small>${esc(x.branch === "all" ? "Asked of everyone" : "Asked only on the " + x.branch.replace("_", " ") + " branch")}</small></span><span class="status active">${x.questions}</span></div>`).join("")}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Readiness</h2><p>What is in place before a real run</p></div></div>
        <div class="check-list">${checks.map(([ok, t, sub]) => `<div class="check-item ${ok ? "" : "pending"}"><span class="check-mark">${ok ? "✓" : "!"}</span><span><strong>${esc(t)}</strong><small>${esc(sub)}</small></span><span class="status ${ok ? "confirmed" : "progress"}">${ok ? "Ready" : "Pending"}</span></div>`).join("")}</div></section>
    </div>
    <section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Decision policy</h2><p>Outcome and workflow status stay separate</p></div></div>
      <div class="check-list"><div class="check-item"><span class="check-mark">✓</span><span><strong>Auto-confirm</strong><small>At ${Math.round(m.policy.auto_confirm_at * 100)}% confidence or higher with no evidence conflict</small></span></div>
      <div class="check-item"><span class="check-mark">!</span><span><strong>Goes to a person</strong><small>Any conflict, an identity doubt, or lower confidence</small></span></div>
      <div class="check-item"><span class="check-mark">×</span><span><strong>Final outcomes</strong><small>Confirmed, not confirmed, inconclusive, opted out, cancelled</small></span></div></div></section>`;
}

// ---- audit -------------------------------------------------------------------------------------------------------------------------------------
function renderAudit() {
  const q = state.auditSearch.toLowerCase();
  const actorOf = a => (a.actor === "Claude agent" ? "agent" : /^(admin|operator|reviewer|agent_ops)/.test(a.actor) ? "human" : ["interakt", "whatsapp", "voice"].includes(a.actor) ? "channel" : "system");
  const list = state.audits.filter(a => (state.auditActor === "all" || actorOf(a) === state.auditActor) && `${a.action} ${a.detail} ${a.actor}`.toLowerCase().includes(q));
  return `${pageHead("Audit trail", "Every change has an actor and a reason.", "A tamper-evident record of what the system, the agent and people did. Deleted cases remain only as anonymous entries.", `<button class="button ghost" data-action="verify-ledger">Verify integrity</button><button class="button primary" data-action="export-audit">Export CSV</button>`)}
    <div class="audit-toolbar"><label class="search-box"><input id="auditSearch" value="${esc(state.auditSearch)}" placeholder="Search events" aria-label="Search audit events" /></label>
      <select class="filter-select" id="auditActor">${[["all", "All actors"], ["human", "People"], ["agent", "Agent"], ["system", "System"], ["channel", "WhatsApp"]].map(([v, l]) => `<option value="${v}" ${state.auditActor === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <section class="card audit-list">${list.map(a => `<div class="audit-row"><span class="audit-time"><strong>${esc(a.time)}</strong><small>${esc(a.date)}</small></span><span class="event-dot ${a.tone === "coral" ? "coral" : ""}">${esc(a.icon)}</span><span class="audit-action"><strong>${esc(a.action)}</strong><small>${esc(a.detail)}</small></span><span class="actor-pill"><span>${esc(a.actorCode)}</span>${esc(a.actor)}</span><span class="hash">${esc(a.hash)}</span></div>`).join("") || empty("No events", state.audits.length ? "Nothing matches the search." : "Events appear here as the system works.")}</section>`;
}

// ---- add participants ---------------------------------------------------------------------------------------------------------------------
const HEADERS = { name: ["name", "fullname", "participant", "participantname"], phone: ["phone", "mobile", "phonenumber", "mobilenumber", "whatsapp", "contact"], employer: ["employer", "company", "organisation", "organization", "employername"], location: ["location", "city", "district", "place"], cohort: ["cohort", "batch"], language: ["language", "lang"] };

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === "," || ch === "\t") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
function rowsFromText(text) {
  const grid = parseCsv(text.trim());
  if (!grid.length) return { rows: [], problem: "Paste or choose a CSV file first." };
  const head = grid[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  const idx = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, head.findIndex(h => names.includes(h))]));
  if (idx.name < 0 || idx.phone < 0) {
    const found = grid[0].map(h => h.trim()).filter(Boolean).slice(0, 6).join(", ");
    return { rows: [], problem: `This does not look like a participant list. The first row must have 'name' and 'phone' columns, but it has: ${found || "nothing readable"}${grid[0].length > 6 ? ", …" : ""}. Check that you pasted the right file.` };
  }
  const lang = v => (/^h/i.test(v || "") ? "hi" : "en");
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] || "").trim() : "");
  const rows = grid.slice(1).map(r => ({ name: get(r, "name"), phone: get(r, "phone"), employer: get(r, "employer"), location: get(r, "location"), cohort: get(r, "cohort"), language: idx.language >= 0 ? lang(r[idx.language]) : "en" }));
  return { rows, problem: rows.length ? null : "The file has a header but no participants." };
}

function openImportModal() {
  const s = { text: "", rows: [], problem: null, attested: false, running: false, result: null, mission: state.defaultMission };
  const importResult = r => `<p style="font-size:13px"><strong>${plural(r.created.length, "participant")} added.</strong> ${r.skipped.length ? `${plural(r.skipped.length, "row")} skipped.` : ""}</p>
    ${r.error ? `<p style="color:#b64b48;font-size:12px">Stopped early: ${esc(r.error)}</p>` : ""}
    ${r.skipped.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Row</th><th>Why it was skipped</th></tr></thead><tbody>${r.skipped.map(x => `<tr><td>${x.row}</td><td>${esc(x.reason)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add participants</h2><p>One row per participant. Numbers are encrypted when stored.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body">${s.result ? importResult(s.result) : `
        ${state.missions.length > 1 ? `<div class="field full" style="margin-bottom:10px"><label for="impMission">Mission</label><select id="impMission">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === s.mission ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><small>Decides the first message, questions and contact hours for these participants. It cannot be changed afterwards.</small></div>` : ""}
        <div class="field full"><label for="csvFile">CSV file</label><input type="file" id="csvFile" accept=".csv,.txt,text/csv" /></div>
        <div class="field full" style="margin-top:10px"><label for="csvText">Or paste rows (first row is the header) <button type="button" class="text-button" id="csvExample" style="margin-left:8px">Insert an example</button></label><textarea id="csvText" rows="6" placeholder="name,phone,employer,location,cohort,language&#10;Asha Kumari,9876543210,Acme Retail,Jaipur,Batch 7,en">${esc(s.text)}</textarea><small>name and phone are required. employer, location, cohort and language (en or hi) are optional. Larger files are sent in batches of 20.</small></div>
        ${s.problem ? `<p style="color:#b64b48;font-size:12px;margin:10px 0 0">${esc(s.problem)}</p>` : ""}
        ${s.rows.length ? `<div style="margin-top:12px"><strong style="font-size:12px">${plural(s.rows.length, "participant")} ready</strong><div style="overflow-x:auto"><table class="data-table" style="margin-top:6px"><thead><tr><th>Name</th><th>Phone</th><th>Employer</th><th>Location</th><th>Cohort</th></tr></thead><tbody>${s.rows.slice(0, 5).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.phone.replace(/\d(?=\d{4})/g, "•"))}</td><td>${esc(r.employer || "—")}</td><td>${esc(r.location || "—")}</td><td>${esc(r.cohort || "—")}</td></tr>`).join("")}</tbody></table></div>${s.rows.length > 5 ? `<small style="color:var(--muted)">…and ${s.rows.length - 5} more</small>` : ""}</div>` : ""}
        <label style="display:flex;gap:10px;align-items:flex-start;margin-top:14px;font-size:12px"><input type="checkbox" id="attest" ${s.attested ? "checked" : ""} style="margin-top:3px" /><span>I confirm these participants agreed to be contacted for programme follow-up under the agreed data policy. This confirmation is recorded.</span></label>`}
      </div>
      <div class="modal-foot">${s.result ? `<button class="button primary" id="doneImport">Done</button>` : `<button class="button ghost" id="cancelImport">Cancel</button><button class="button primary" id="runImport" ${s.rows.length && s.attested && !s.running ? "" : "disabled"}>${s.running ? "Importing…" : `Import ${s.rows.length || ""} participants`}</button>`}</div>`;
    $("closeModal").addEventListener("click", closeModal);
    $("cancelImport")?.addEventListener("click", closeModal);
    $("doneImport")?.addEventListener("click", closeModal);
    $("csvFile")?.addEventListener("change", async e => { const f = e.target.files[0]; if (!f) return; s.text = await f.text(); Object.assign(s, rowsFromText(s.text)); draw(); });
    $("csvText")?.addEventListener("input", e => { s.text = e.target.value; Object.assign(s, s.text.trim() ? rowsFromText(s.text) : { rows: [], problem: null }); const keep = e.target.selectionStart; draw(); const t = $("csvText"); t.focus(); t.setSelectionRange(keep, keep); });
    $("csvExample")?.addEventListener("click", () => { s.text = "name,phone,employer,location,cohort,language\nYour Name,9876543210,Test Employer,Jaipur,Test batch,en"; Object.assign(s, rowsFromText(s.text)); draw(); });
    $("attest")?.addEventListener("change", e => { s.attested = e.target.checked; draw(); });
    $("impMission")?.addEventListener("change", e => { s.mission = e.target.value; });
    $("runImport")?.addEventListener("click", async () => {
      s.running = true; draw();
      const result = { created: [], skipped: [] };
      try {
        for (let i = 0; i < s.rows.length; i += 20) {
          const r = await api("/participants/import", { method: "POST", body: { rows: s.rows.slice(i, i + 20), consent_attested: true, mission_version: s.mission } });
          result.created.push(...r.created.map(x => ({ ...x, row: x.row + i })));
          result.skipped.push(...r.skipped.map(x => ({ ...x, row: x.row + i })));
        }
      } catch (e) { result.error = e.message; }
      s.running = false; s.result = result; draw(); await loadAll();
    });
  };
  draw(); modalBackdrop.hidden = false;
}

// ---- delete case -----------------------------------------------------------------------------------------------------------------------------------
function openDeleteModal(c) {
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Delete ${esc(c.id)}?</h2><p>This erases the participant's personal data and cannot be undone.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="field full"><p style="font-size:12px;margin:0">Erased: name, phone number, employer, replies, evidence values, agent notes and step records. Kept: an anonymous entry in the audit trail saying who deleted the case and when. Any message still queued is cancelled.</p></div>
      <div class="field full"><label for="delReason">Reason</label><select id="delReason"><option value="participant_request">Participant asked for their data to be deleted</option><option value="data_entry_error">Added by mistake</option><option value="test_data">Test data</option><option value="other">Other</option></select></div>
      <div class="field full"><label for="delConfirm">Type <b>${esc(c.id)}</b> to confirm</label><input id="delConfirm" autocomplete="off" /></div></div></div>
    <div class="modal-foot"><button class="button ghost" id="cancelDelete">Cancel</button><button class="button primary" id="confirmDelete" disabled style="background:#b64b48;border-color:#b64b48">Delete case</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelDelete").addEventListener("click", closeModal);
  $("delConfirm").addEventListener("input", e => { $("confirmDelete").disabled = e.target.value.trim() !== c.id; });
  $("confirmDelete").addEventListener("click", async () => {
    $("confirmDelete").disabled = true;
    const out = await act(() => api(`/cases/${c.id}/delete`, { method: "POST", body: { confirm: c.id, reason_code: $("delReason").value } }), `${c.id} deleted. Personal data erased.`);
    if (out) { closeModal(); closeDrawer(); }
  });
}
// Wipes every record. Only offered in a development project where DOZAI_ALLOW_PURGE is set.
function openPurgeModal() {
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Delete ALL data?</h2><p>Every case, participant, event, session and message record is removed. This cannot be undone.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-body"><div class="form-grid"><div class="field full"><label for="purgeConfirm">Type <b>DELETE ALL DATA</b> to confirm</label><input id="purgeConfirm" autocomplete="off" /></div></div></div>
    <div class="modal-foot"><button class="button ghost" id="cancelPurge">Cancel</button><button class="button primary" id="confirmPurge" disabled style="background:#b64b48;border-color:#b64b48">Delete everything</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelPurge").addEventListener("click", closeModal);
  $("purgeConfirm").addEventListener("input", e => { $("confirmPurge").disabled = e.target.value !== "DELETE ALL DATA"; });
  $("confirmPurge").addEventListener("click", async () => {
    $("confirmPurge").disabled = true;
    const out = await act(() => api("/admin/purge-all", { method: "POST", body: { confirm: "DELETE ALL DATA" } }), "All data deleted.");
    if (out) closeModal();
  });
}

function closeModal() { modalBackdrop.hidden = true; modal.innerHTML = ""; /* pasted rows and names must not linger in the page */ }

// ---- events -------------------------------------------------------------------------------------------------------------------------------------------
function go(view) { state.view = view; chrome(); window.scrollTo({ top: 0 }); }

function bind() {
  appView.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", () => go(el.dataset.go)));
  appView.querySelectorAll("[data-case]").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); openCase(el.dataset.case); }));
  appView.querySelectorAll("[data-review]").forEach(el => el.addEventListener("click", () => { state.reviewSelected = el.dataset.review; render(); }));
  appView.querySelectorAll("[data-decision]").forEach(el => el.addEventListener("click", () => decide(el.dataset.id, el.dataset.decision)));
  appView.querySelectorAll("[data-agent-tab]").forEach(el => el.addEventListener("click", () => { state.agentTab = el.dataset.agentTab; if (state.agentTab === "agent") state.session = null; if (state.agentTab === "employee" && !state.employeeDef) { const cur = state.employees.filter(e => e.current)[0] || state.employees[0]; if (cur) { showEmployee(cur.version); return; } } render(); }));
  appView.querySelectorAll("[data-approve]").forEach(el => el.addEventListener("click", () => decideApproval(el.dataset.approve, "approve")));
  appView.querySelectorAll("[data-reject]").forEach(el => el.addEventListener("click", () => decideApproval(el.dataset.reject, "reject")));
  appView.querySelectorAll("[data-replay]").forEach(el => el.addEventListener("click", () => replaySession(el.dataset.replay)));
  appView.querySelectorAll("[data-dial]").forEach(el => el.addEventListener("change", () => saveControls({ autonomy: { [el.dataset.dial]: el.value } }, "Saved. It applies to the next action the agent proposes.")));
  appView.querySelectorAll("[data-open-session]").forEach(el => el.addEventListener("click", async () => { try { state.replay = null; state.session = (await api(`/sessions/${el.dataset.openSession}`)).session; render(); } catch (e) { toast(e.message, "warning"); } }));
  appView.querySelectorAll("[data-action]").forEach(el => el.addEventListener("click", () => action(el.dataset.action)));
  appView.querySelectorAll("[data-employee]").forEach(el => el.addEventListener("click", () => showEmployee(el.dataset.employee)));
  $("ctxMission")?.addEventListener("change", e => showContext(e.target.value));
  appView.querySelectorAll("[data-camp]").forEach(el => el.addEventListener("click", () => campaignAct(el.dataset.camp, el.dataset.act)));
  $("missionPick")?.addEventListener("change", async e => {
    try { state.missionShown = await api(`/mission?version=${encodeURIComponent(e.target.value)}`); render(); } catch (err) { toast(err.message, "warning"); }
  });
  const search = $("caseSearch");
  if (search) search.addEventListener("input", e => { state.caseSearch = e.target.value; render(); const n = $("caseSearch"); n?.focus(); n?.setSelectionRange(state.caseSearch.length, state.caseSearch.length); });
  $("caseFilter")?.addEventListener("change", e => { state.caseFilter = e.target.value; render(); });
  const audit = $("auditSearch");
  if (audit) audit.addEventListener("input", e => { state.auditSearch = e.target.value; render(); const n = $("auditSearch"); n?.focus(); n?.setSelectionRange(state.auditSearch.length, state.auditSearch.length); });
  $("auditActor")?.addEventListener("change", e => { state.auditActor = e.target.value; render(); });
}

function action(name) {
  if (name === "refresh") { state.loaded = false; render(); loadAll(); }
  if (name === "import") openImportModal();
  if (name === "purge") openPurgeModal();
  if (name === "new-campaign") openCampaignModal();
  if (name === "add-employee") openEmployeeModal();
  if (name === "voice-preview") loadVoiceForm((state.missionShown ?? state.mission).version);
  if (name === "voice-publish") {
    const m = state.missionShown ?? state.mission, update = !!state.voiceForm?.link;
    confirmModal({
      title: update ? "Update the phone form at ZoLabs?" : "Create the phone form at ZoLabs?",
      text: `${update ? "This brings the existing form up to date with the mission and the employee." : "This creates the form and uses ZoLabs quota."} Review the preview first: it is exactly what will be sent. No call is placed by this.`,
      button: update ? "Update the form" : "Create the form",
      onConfirm: async () => {
        if (state.voicePublishing) return;
        state.voicePublishing = true; render(); // the button locks at once: ZoLabs is slow, and a second click would create a second form
        try {
          state.voiceForm = await api("/missions/" + encodeURIComponent(m.version) + "/voice-form/publish", { method: "POST", body: { confirm: true } }); state.voiceFormFor = m.version;
          toast("Phone form " + (update ? "updated" : "created") + ".", "success");
        } catch (e) { toast(e.message + " Check the form state on this card before trying again.", "warning"); }
        finally { state.voicePublishing = false; await loadVoiceForm(m.version); } // always show what the server really has, even if the answer was lost
      },
    });
  }
  if (name === "add-mission") openMissionModal();
  if (name === "run-batch") {
    act(() => api("/campaigns/run-now", { method: "POST" }), null).then(r => {
      if (!r) return;
      const queued = r.campaigns.reduce((n, c) => n + c.sent, 0);
      toast(`${plural(queued, "first message")} queued, ${r.sent} sent.${r.paused.length ? ` ${plural(r.paused.length, "campaign")} paused: ${r.paused[0].reason}` : ""}`, r.paused.length ? "warning" : "success");
    });
  }
  if (name === "voice-check") checkVoice();
  if (name === "close-session") { state.session = null; state.replay = null; render(); }
  if (name === "pause-platform") confirmModal({ title: "Switch everything off?", text: "No message will be sent, no call placed, no campaign queued and the agent will not be woken until you switch it back on. Replies are still recorded.", button: "Switch everything off", onConfirm: () => saveControls({ paused: true, reason: "Switched off from the console" }, "Everything is switched off.") });
  if (name === "resume-platform") confirmModal({ title: "Switch back on?", text: "Queued messages and calls go out on the next scheduler pass, and timers that came due are acted on. Check the queue first if something wrong was going out.", button: "Switch back on", onConfirm: () => saveControls({ paused: false }, "Back on.") });
  if (name === "save-limits") saveControls({ daily_budget_usd: Number($("limDaily").value), case_budget_usd: Number($("limCase").value), max_wakes_per_case: Number($("limWakes").value) }, "Limits saved.");
  if (name === "export-cases") {
    const rows = filteredCases().map(c => [c.id, c.cohort, c.location, STATUS_LABEL[c.status], c.outcome, c.confidence, c.attempts, c.lastTouch]);
    download(`dozai-cases-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(["case", "cohort", "location", "status", "outcome", "confidence", "attempts", "last activity"], rows));
    toast("Exported without names or phone numbers.", "success");
  }
  if (name === "export-audit") {
    download(`dozai-audit-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(["time (UTC)", "case", "action", "detail", "actor", "hash"], state.audits.map(a => [a.ts, a.case_id, a.action, a.detail, a.actor, a.hash])));
    toast("Audit trail exported.", "success");
  }
  if (name === "verify-ledger") api("/audit/verify").then(v => v.ok ? toast(`Ledger verified: ${plural(v.events, "event")} across ${plural(v.cases, "case")}.`, "success") : toast(`Ledger check FAILED on ${v.failures[0].case_id} at event ${v.failures[0].at_seq}: ${v.failures[0].reason}`, "warning")).catch(e => toast(e.message, "warning"));
  if (name === "check-replies") {
    act(() => api("/admin/tick", { method: "POST" }), null).then(r => {
      if (!r) return;
      const w = r.webhook;
      const lastBad = w?.last_bad_signature_at ? new Date(w.last_bad_signature_at).getTime() : 0, lastGood = w?.last_event_at ? new Date(w.last_event_at).getTime() : 0;
      const recentBad = lastBad > lastGood && Date.now() - lastBad < 30 * 60_000;
      const bits = [plural(r.inbox.processed, "new event"), `${plural(r.conversation?.length ?? 0, "reply", "replies")} handled`, `${plural(r.sent, "message")} sent`, `${plural(r.resumed.length, "case")} resumed`];
      if (w && recentBad) bits.push(`WEBHOOK PROBLEM at ${istTime(w.last_bad_signature_at)}: Interakt called but the secret did not match`);
      else if (w) bits.push(w.events ? `webhook: ${plural(w.events, "event")}, last at ${istTime(w.last_event_at)}` : "webhook: nothing received from Interakt yet");
      toast(bits.join(" · "), r.resume_errors.length || recentBad ? "warning" : "success");
    });
  }
}

$("primaryNav").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (!b) return; state.session = null; go(b.dataset.view); document.querySelector(".sidebar").classList.remove("open"); });
$("roleSwitcher").addEventListener("change", e => { state.localRole = e.target.value; state.me = null; state.loaded = false; render(); loadAll(); });
$("refresh").addEventListener("click", () => action("refresh"));
$("mobileMenu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
drawerBackdrop.addEventListener("click", closeDrawer);
modalBackdrop.addEventListener("click", e => { if (e.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeModal(); document.querySelector(".sidebar").classList.remove("open"); } });

render();
loadAll();
