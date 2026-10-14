// DozAI operator app. Everything shown here comes from the API: there is no sample data.
import { initSelects } from "./select.js";
import { initNumbers } from "./number.js";
import { initFiles } from "./file.js";
import { createQuestionEditor } from "./questions.js";
import { createBusy, loadingLine, loadingState } from "./busy.js";
import { ALL, OUTCOMES, casesFor, dashboardFor, donutGradient, legendHtml, paintDashboard } from "./dashboard.js";
const API_BASE = (window.DOZAI_API_BASE || "/api").replace(/[/]$/, "");
const CLOUD = API_BASE.startsWith("/server");
const TZ = "Asia/Kolkata"; // all times are shown in India Standard Time
const ROLE_HEADER = { admin: "admin", agentops: "agent_ops", operator: "operator", reviewer: "reviewer" };
const palette = ["#f4c7b7", "#b9e3df", "#ead6a8", "#d7cfeb", "#bcd7ea", "#f1c0cd"];
const ALLOWED = { intake: ["admin", "operator"], run: ["admin", "agent_ops", "operator"], review: ["admin", "reviewer"], admin: ["admin"], approve: ["admin", "reviewer", "agent_ops"], controls: ["admin", "agent_ops"], killswitch: ["admin", "agent_ops", "operator"] };

const state = {
  view: "overview", localRole: "admin", dashMission: ALL, caseTab: "overview", caseTabFor: null,
  me: null, mission: null, cases: [], audits: [], summary: null, sessions: [],
  missions: [], defaultMission: null, missionShown: null, campaigns: [],
  employees: [], employeeCanEdit: false, employeeShown: null, employeeDef: null, ctxPreview: null,
  voiceForm: null, voiceFormFor: null, voicePublishing: false, voiceLoading: false, wording: null, wordingFor: null, qeditor: null, wordingLoading: false, wordingFailedFor: null,
  approvals: [], approvalsWaiting: 0, controlsInfo: null, replay: null, voice: null, voiceCheck: null,
  loaded: false, error: null,
  caseFilter: "all", caseSearch: "", reviewSelected: null,
  agentTab: "agent", session: null, auditSearch: "", auditActor: "all",
};

const $ = id => document.getElementById(id);
const appView = $("appView"), caseDrawer = $("caseDrawer"), drawerBackdrop = $("drawerBackdrop"), modalBackdrop = $("modalBackdrop"), modal = $("modal"), toastRegion = $("toastRegion");
initSelects();
initNumbers();
initFiles();

// ---- small helpers -----------------------------------------------------------------------------------------
const esc = v => String(v ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
const initials = n => String(n).split(/\s+/).map(x => x[0]).slice(0, 2).join("").toUpperCase() || "?";
const colorFor = id => palette[Number(String(id).replace(/\D/g, "")) % palette.length];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const can = cap => (ALLOWED[cap] || []).includes(state.me?.role);
const STATUS_LABEL = { review: "Needs review", confirmed: "Confirmed", progress: "In progress", "not-confirmed": "Not confirmed", inconclusive: "Inconclusive", "not-started": "Not started", "opted-out": "Opted out" };
const statusPill = s => `<span class="status ${s}">${esc(STATUS_LABEL[s] || s)}</span>`;
// A case's status in plain words (where it is in the process), coloured by how it stands. The result, what was found out, is a separate column.
const casePill = c => `<span class="status ${c.status}">${esc(c.status_label || STATUS_LABEL[c.status] || c.status)}</span>`;
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
const busy = createBusy(); // holds the button that was just pressed, runs the top bar, and guards against double clicks (busy.js)
async function api(path, { method = "GET", body, silent = false } = {}) {
  const end = busy.begin({ silent }); // silent: refreshes that run by themselves, which must not look like work
  try { return await request(path, method, body); } finally { end(); }
}
async function request(path, method, body) {
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
  if (!state.loaded) { appView.innerHTML = `<div class="view-enter">${loadingState("Loading…", "Reading the latest data.")}</div>`; return; }
  if (state.error) { appView.innerHTML = `<div class="view-enter">${empty("Could not load data", state.error, `<button class="button primary" data-action="refresh">Try again</button>`)}</div>`; bind(); return; }
  const views = { overview: renderOverview, cases: renderCases, campaigns: renderCampaigns, reviews: renderReviews, agent: renderAgent, approvals: renderApprovals, calls: renderCalls, missions: renderMission, audit: renderAudit };
  const off = state.controlsInfo?.controls.paused ? `<div class="agent-callout" style="border-color:#b64b48;margin-bottom:14px"><small>Switched off</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>Open Claude engine, then Controls, to switch it back on.</p></div>` : "";
  appView.innerHTML = `<div class="view-enter">${off}${views[state.view]()}</div>`;
  bind();
  if (state.view === "reviews" && state.reviewSelected && $("reviewConv")) fillConversation("reviewConv", state.reviewSelected);
  // The questions of an unsigned mission open by themselves: reading them is what a sign-off is based on.
  if (state.view === "missions") {
    const m = state.missionShown ?? state.mission;
    if (m && !m.instrument_signed_off && can("admin") && state.wordingFor !== m.version && state.wordingFailedFor !== m.version && !state.wordingLoading) loadWording(m.version);
    if ($("qEditorMount") && state.qeditor && state.wordingFor === m?.version) { state.qeditor.mount($("qEditorMount")); syncSignOff(); }
  }
  // The phone card shows whether the form is published and current as soon as the Mission page opens, without a click on Preview.
  if (state.view === "missions" && state.me?.voice && state.me.voice !== "off" && !state.voiceLoading) {
    const v = (state.missionShown ?? state.mission)?.version;
    if (v && state.voiceFormFor !== v) { state.voiceLoading = true; loadVoiceForm(v).finally(() => { state.voiceLoading = false; }); }
  }
}

// ---- command centre -----------------------------------------------------------------------------------------------------------
// ---- command centre ------------------------------------------------------------------------------------------------------------
// One mission filter. Everything below it is counted over that mission's cases, with the same rules as the server's summary.
const dashKey = () => (state.missions.some(m => m.version === state.dashMission) ? state.dashMission : ALL);

/** Everything the page shows for the chosen mission. The first draw and the in-place updates both use it. */
function overviewModel() {
  const key = dashKey();
  const d = dashboardFor({ cases: state.cases, missions: state.missions, campaigns: state.campaigns, audits: state.audits, key });
  const s = d.summary, picked = state.missions.find(x => x.version === key);
  const signedOff = (picked ?? state.mission).instrument_signed_off;
  const pct = n => (s.total ? Math.round((n / s.total) * 100) : 0);
  const items = [];
  if (s.review) items.push(["!", `${plural(s.review, "case")} need${s.review === 1 ? "s" : ""} a person's decision`, "Evidence conflict or low confidence", "reviews"]);
  if (d.paused.length) items.push(["!", `${plural(d.paused.length, "campaign")} paused`, d.paused[0].pause_reason || "Resume it from the Campaigns page", "campaigns"]);
  if (d.waiting) items.push(["↗", `${plural(d.waiting, "case")} ${d.waiting === 1 ? "is" : "are"} waiting for a reply`, "Check for replies on the Cases page", "cases"]);
  if (state.mission.runtime.whatsapp !== "live") items.push(["◇", "WhatsApp sending is off", "The agent runs with simulated replies. Nothing is sent to anyone.", "missions"]);
  if (!signedOff) items.push(["?", "The questionnaire wording is not signed off", "The questions are placeholders until the programme team approves them", "missions"]);
  return {
    key, empty: !s.total, s,
    kpis: { total: s.total, reached: pct(s.reached), confirmed: s.confirmed, review: s.review },
    foots: { total: "loaded", reached: `${s.reached} of ${s.total}`, confirmed: `${s.complete} completed`, review: s.review ? "waiting for review" : "all clear", reviewTone: !!s.review },
    stages: { total: s.total, reached: s.reached, responded: s.responded, complete: s.complete, confirmed: s.confirmed },
    stagePct: { total: pct(s.total), reached: pct(s.reached), responded: pct(s.responded), complete: pct(s.complete), confirmed: pct(s.confirmed) },
    mix: s.mix, mixTotal: Object.values(s.mix).reduce((a, b) => a + b, 0), slots: d.slots,
    // What "confirmed" means for this mission, as the mission words it ("Feedback collected"), or the plain word.
    confirmedLabel: picked?.verdict_labels?.confirmed ?? "Confirmed",
    attentionHtml: items.length ? items.map(([i, t, sub, go]) => `<button class="attention-item" style="border:0;width:100%;text-align:left;cursor:pointer" data-go="${go}"><span class="attention-icon">${i}</span><span><strong>${esc(t)}</strong><small>${esc(sub)}</small></span><span>›</span></button>`).join("") : `<p class="muted t-sm">Nothing needs attention.</p>`,
    activityHtml: d.activity.slice(0, 5).map(timelineEvent).join("") || `<p class="muted t-sm">${key === ALL ? "No activity yet." : "No recent activity for this mission."}</p>`,
    caption: `Showing ${plural(s.total, "participant")} for ${picked ? picked.name : "all missions"}.`,
    countLine: picked ? `Showing ${s.total} of ${plural(state.cases.length, "participant")}` : `Showing all ${plural(s.total, "participant")}`,
  };
}

/** The filter bar under the greeting: the mission, a way back to everyone, and what is being shown. */
function missionBarHtml(md) {
  const count = v => casesFor(state.cases, state.missions, v).length;
  const option = m => `<option value="${esc(m.version)}" data-short="${esc(m.name)}" data-sub="${esc(`${m.version} · ${plural(count(m.version), "participant")}`)}" ${m.version === md.key ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)} (${plural(count(m.version), "participant")})</option>`;
  return `<div class="dash-bar"><label class="dash-filter ${md.key === ALL ? "" : "is-active"}"><span>Mission</span><select id="dashMission" class="filter-select" aria-label="Filter the Command centre by mission"><option value="${ALL}" data-short="All missions" data-sub="${esc(plural(state.cases.length, "participant"))}" ${md.key === ALL ? "selected" : ""}>All missions (${plural(state.cases.length, "participant")})</option>${state.missions.map(option).join("")}</select></label><button type="button" class="text-button dash-clear" data-dash-clear ${md.key === ALL ? "hidden" : ""}>Clear</button><span class="dash-count" id="dashCount">${esc(md.countLine)}</span></div>`;
}

/** Keeps the bar in step with the choice without redrawing it (so the open dropdown and its motion are not disturbed). */
function updateMissionBar(md) {
  const filter = appView.querySelector(".dash-filter");
  if (!filter) return;
  filter.classList.toggle("is-active", md.key !== ALL);
  appView.querySelector("[data-dash-clear]").hidden = md.key === ALL;
  $("dashCount").textContent = md.countLine;
}

function renderOverview() {
  const md = overviewModel();
  const name = (state.me?.user || "").split("@")[0].split(/[._-]/)[0];
  const greeting = `Hello${name ? ", " + name.charAt(0).toUpperCase() + name.slice(1) : ""}.`;
  const head = pageHead("Command centre", greeting, "What is moving, what needs a person, and what happens next.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "");
  const bar = missionBarHtml(md);
  const live = `<p class="sr-only" id="dashLive" aria-live="polite">${esc(md.caption)}</p>`;
  if (md.empty) {
    return `${head}${bar}${live}${empty(md.key === ALL ? "No participants yet" : "No participants in this mission yet", can("intake") ? "Load your first cohort to start. Participant contact numbers are encrypted when stored." : "Ask an administrator or operator to load participants.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")}`;
  }
  const { kpis, foots, stages, stagePct, mix, mixTotal, slots, confirmedLabel } = md;
  const stage = (key, label) => `<div class="stage-row" data-stage="${key}"><strong>${label}</strong><div class="progress-track"><div class="progress-fill" style="width:${stagePct[key]}%"></div></div><span data-stage-count data-shown="${stages[key]}">${stages[key]}</span></div>`;
  const values = slots.map(([k]) => mix[k]);
  return `${head}${bar}${live}<div data-overview>
    <div class="grid kpis">
      ${kpi("Participants", "total", kpis.total, kpis.total, foots.total, "#e4f5f3")}
      ${kpi("Contacted", "reached", `${kpis.reached}%`, kpis.reached, foots.reached, "#fae8dc")}
      ${kpi(confirmedLabel === "Confirmed" ? "Outcomes confirmed" : confirmedLabel, "confirmed", kpis.confirmed, kpis.confirmed, foots.confirmed, "#e4f5f3")}
      ${kpi("Needs a person", "review", kpis.review, kpis.review, foots.review, "#fff1d9", foots.reviewTone ? "amber" : "")}
    </div>
    <div class="grid two">
      <section class="card card-pad"><div class="card-head"><div><h2>Progress</h2><p>How far participants have moved</p></div><button class="text-button" data-go="cases">Open cases →</button></div>
        <div class="stage-list">${stage("total", "Loaded")}${stage("reached", "Contacted")}${stage("responded", "Responded")}${stage("complete", "Completed")}${stage("confirmed", esc(confirmedLabel))}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Outcomes</h2><p>Where participants are now</p></div></div>
        <div class="donut-wrap"><div class="donut-holder"><div class="donut" data-donut data-values="${JSON.stringify(values)}" style="background:${donutGradient(values, slots)}"></div><div class="donut-centre"><strong data-donut-centre>${mixTotal}</strong><small>classified</small></div></div>
        <div class="legend">${legendHtml(slots, mix)}</div></div></section>
    </div>
    <div class="grid two-even" style="margin-top:16px">
      <section class="card card-pad"><div class="card-head"><div><h2>Needs attention</h2><p>Only what needs a decision or a setting</p></div></div>
        <div class="attention-list dash-swap" data-dash="attention">${md.attentionHtml}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Recent activity</h2><p>Every action is recorded</p></div><button class="text-button" data-go="audit">Audit trail →</button></div>
        <div class="timeline dash-swap" data-dash="activity">${md.activityHtml}</div></section>
    </div></div>`;
}
const kpi = (label, hook, value, shown, foot, soft, tone = "") => `<section class="card kpi-card" style="--accent-soft:${soft}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value" data-kpi="${hook}" data-shown="${shown}">${esc(value)}</div><div class="kpi-foot"><span class="delta ${tone}" data-kpi-foot="${hook}">${esc(foot)}</span></div></section>`;

/** The filter changed. Update the page in place so the numbers, bars and donut can move. Draw it again only when its shape changes (empty or not). */
function refreshOverview() {
  const md = overviewModel();
  const root = appView.querySelector("[data-overview]");
  if (md.empty || !root) { render(); return; }
  paintDashboard(root, md, { after: bindGo });
  updateMissionBar(md);
  const live = $("dashLive"); if (live) live.textContent = md.caption;
}
const timelineEvent = a => `<div class="timeline-event"><span class="event-dot ${a.tone === "coral" ? "coral" : ""}">${esc(a.icon)}</span><span class="event-copy"><strong>${esc(a.action)}</strong><small>${esc(a.detail)}</small></span><span class="event-time">${esc(a.time)}</span></div>`;

// ---- cases ---------------------------------------------------------------------------------------------------------------------------------
function filteredCases() {
  const q = state.caseSearch.toLowerCase();
  return state.cases.filter(c => (state.caseFilter === "all" || c.status === state.caseFilter) && `${c.name} ${c.id} ${c.location} ${c.cohort}`.toLowerCase().includes(q));
}

function renderCases() {
  const list = filteredCases();
  const actions = `${state.me?.can_purge && can("admin") ? `<button class="button ghost" data-action="purge" style="color:#b64b48;border-color:#b64b48">Delete ALL data…</button>` : ""}${can("admin") ? `<button class="button ghost" data-action="check-replies" data-busy-label="Checking…">Check for replies</button>` : ""}<button class="button ghost" data-action="export-cases">Export CSV</button>${can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : ""}`;
  const options = [["all", "All statuses"], ["review", "Needs review"], ["progress", "In progress"], ["not-started", "Not started"], ["confirmed", "Confirmed"], ["not-confirmed", "Not confirmed"], ["inconclusive", "Inconclusive"], ["opted-out", "Opted out"]];
  return `${pageHead("Cases", "Every participant has one accountable case.", "The current state, the evidence behind it, and the next permitted action.", actions)}
    <section class="card table-card">
      <div class="table-toolbar"><div class="filters"><label class="search-box"><input id="caseSearch" value="${esc(state.caseSearch)}" placeholder="Search name, case or place" aria-label="Search cases" /></label>
      <select class="filter-select" id="caseFilter">${options.map(([v, l]) => `<option value="${v}" ${state.caseFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <span class="t-xs muted">${list.length} of ${state.cases.length}</span></div>
      ${state.cases.length === 0 ? empty("No cases yet", can("intake") ? "Add participants to create their cases." : "No participants have been loaded.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")
        : list.length === 0 ? empty("No cases match", "Change the search or the status filter.")
        : `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Participant</th><th>Status</th><th>Result</th><th>Confidence</th><th>Last activity</th><th></th></tr></thead><tbody>${list.map(caseRow).join("")}</tbody></table></div>`}
    </section>`;
}
const caseRow = c => `<tr data-case="${esc(c.id)}" style="cursor:pointer"><td><div class="participant-cell"><span class="mini-avatar" style="background:${colorFor(c.id)}">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.id)} · ${esc(c.location)}</small></span></div></td><td>${casePill(c)}</td><td><strong class="t-sm">${esc(c.outcome)}</strong>${c.outcome_note ? `<div class="muted t-xs" style="margin-top:3px">${esc(c.outcome_note)}</div>` : ""}</td><td><div class="confidence"><div class="confidence-bar"><span style="width:${c.confidence}%"></span></div><span>${c.confidence}%</span></div></td><td style="color:var(--muted)">${esc(c.lastTouch)}</td><td><button class="row-action" data-case="${esc(c.id)}" aria-label="Open ${esc(c.name)}">›</button></td></tr>`;

// ---- campaigns -------------------------------------------------------------------------------------------------------------------------------
const CAMP_STATUS = { draft: ["not-started", "Draft"], running: ["progress", "Running"], paused: ["review", "Paused"], completed: ["confirmed", "Finished"], stopped: ["not-confirmed", "Stopped"] };
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const missionName = v => { const m = state.missions.find(x => x.version === v); return m ? `${m.name} (${m.version})` : v; };

function renderCampaigns() {
  const list = state.campaigns;
  const running = list.some(c => c.status === "running");
  const actions = can("intake") ? `${running ? `<button class="button ghost" data-action="run-batch" data-busy-label="Sending…">Send next batch now</button>` : ""}<button class="button primary" data-action="new-campaign">New campaign</button>` : "";
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
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px"><div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div><strong class="t-sm">${p.contacted} of ${total} messaged</strong></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">${tile("Waiting to send", p.queued)}${tile("Messaged", p.contacted)}${tile("Waiting for reply", p.waiting)}${tile("Needs review", p.needs_review, p.needs_review ? "#b64b48" : "")}${tile("Finished", p.complete)}${tile("Could not send", p.send_failed, p.send_failed ? "#b64b48" : "")}${tile("Sent today", `${today} / ${c.daily_cap}`)}</div>
    ${c.pause_reason && c.status === "paused" ? `<p class="danger-text t-sm" style="margin:10px 0 0">${esc(c.pause_reason)}</p>` : c.last_note ? `<p class="muted t-sm" style="margin:10px 0 0">${esc(c.last_note)}${c.last_run_at ? ` (${esc(istTime(c.last_run_at))})` : ""}</p>` : ""}
    ${stale ? `<p class="danger-text t-sm" style="margin:6px 0 0">The scheduler has not run for a few minutes, so no new batches are going out. Check that the Cron job is set up, or press "Send next batch now".</p>` : ""}
    ${p.send_failed ? `<p class="muted t-xs" style="margin:6px 0 0">People marked "Could not send" stay in the waiting state. Open their case to see why.</p>` : ""}
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
      button: "Start sending", busy: "Starting…",
      onConfirm: () => run(out => `Started. ${plural(out.pass?.sent ?? 0, "first message")} sent now.`),
    });
  }
  if (act === "stop") {
    return confirmModal({ title: `${c.status === "draft" ? "Discard" : "Stop"} "${c.name}"?`, text: c.status === "draft" ? "Nothing has been sent. The campaign is closed and cannot be started." : "No more first messages will be sent. People already messaged keep their conversations. A stopped campaign cannot be restarted.", button: c.status === "draft" ? "Discard" : "Stop campaign", busy: c.status === "draft" ? "Discarding…" : "Stopping…", danger: true, onConfirm: () => run(() => "Campaign stopped.") });
  }
  run(out => act === "pause" ? "Paused. Nothing more will be sent until you resume." : `Resumed. ${plural(out.pass?.sent ?? 0, "first message")} sent now.`);
}
const act_ = (id, a) => act(() => api(`/campaigns/${id}/${a}`, { method: "POST" }), null);

// The dialog stays open while the work runs, with the button saying so ("Signing off…"), and closes when it is done, worked or not.
function confirmModal({ title, text, button, danger, busy: busyLabel = "Working…", onConfirm }) {
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${esc(title)}</h2><p>${esc(text)}</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-foot"><button class="button ghost" id="cancelConfirm">Cancel</button><button class="button primary" id="okConfirm" data-busy-label="${esc(busyLabel)}" ${danger ? 'style="background:#b64b48;border-color:#b64b48"' : ""}>${esc(button)}</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelConfirm").addEventListener("click", closeModal);
  const ok = $("okConfirm");
  ok.addEventListener("click", async () => {
    if (ok.dataset.started) return; ok.dataset.started = "1"; // one press only
    $("cancelConfirm").disabled = true;
    try { await onConfirm(); } finally { if ($("okConfirm") === ok) closeModal(); }
  });
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
        ${s.error ? `<p class="danger-text t-sm" style="grid-column:1/-1;margin:0">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelCmp">Cancel</button><button class="button primary" id="saveCmp" data-busy-label="Creating…" ${s.running || s.name.trim().length < 2 ? "disabled" : ""}>Create campaign</button></div>`;
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
function openMissionModal(prefill) {
  const s = { text: prefill ?? "", from: state.missionShown?.version ?? state.defaultMission, error: null, running: false };
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add a mission</h2><p>A mission is one client's first message, questions, contact rules and agent notes. Saved missions never change: to change one, add a new version.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="field full"><label for="mFrom">Start from</label><div style="display:flex;gap:8px"><select id="mFrom" style="flex:1">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === s.from ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><button type="button" class="button ghost small" id="mLoad" data-busy-label="Copying…">Copy it here</button></div></div>
        <div class="field full"><label for="mText">Definition (JSON)</label><textarea id="mText" rows="14" spellcheck="false" class="mono t-xs" placeholder="Copy an existing mission, then change the version name, wording and questions.">${esc(s.text)}</textarea><small>Change mission_id, version and name. A mission that is not approved (instrument.draft: true) cannot be used for live campaigns.</small></div>
        ${s.error ? `<p class="danger-text t-sm" style="grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelM">Cancel</button><button class="button primary" id="saveM" data-busy-label="Saving…" ${s.running || !s.text.trim() ? "disabled" : ""}>Save mission</button></div>`;
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
/** Shows one tab of the case panel and hides the others. The hidden ones stay on the page, so they keep loading. */
function showCaseTab(key, focus = false) {
  state.caseTab = key;
  caseDrawer.querySelectorAll("[data-tab]").forEach(b => { const on = b.dataset.tab === key; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); if (on) b.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }); // on a phone the tab bar scrolls sideways: keep the chosen tab in view
  caseDrawer.querySelectorAll("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== key; });
  const bar = caseDrawer.querySelector(".drawer-tabs");
  if (bar && caseDrawer.scrollTop > bar.offsetTop) caseDrawer.scrollTop = bar.offsetTop; // the top of the new tab is in view
}
/** A small number on a tab, shown only when there is something in it. */
function setTabCount(key, n) {
  const el = caseDrawer.querySelector(`[data-tab-count="${key}"]`);
  if (el) { el.textContent = !n ? "" : n > 99 ? "99+" : String(n); el.hidden = !n; }
}
async function openCase(id) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const simulated = state.me?.channel !== "interakt";
  const waiting = ["Contacting", "Follow-up"].includes(c.stage);
  const canRun = can("run") && c.stage !== "Complete" && c.stage !== "Review";
  state.caseTab = state.caseTabFor === id ? state.caseTab : "overview"; // an action that refreshes the panel keeps you on your tab
  state.caseTabFor = id;
  const tab = state.caseTab;
  const TABS = [["overview", "Overview"], ["conversation", "Conversation"], ["calls", "Phone calls"], ["activity", "Activity"]];
  const panel = (key, html) => `<div class="drawer-panel" role="tabpanel" id="panel-${key}" data-panel="${key}" aria-labelledby="tab-${key}" ${key === tab ? "" : "hidden"}>${html}</div>`;
  const kv = (label, value) => `<div class="kv-row"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  caseDrawer.innerHTML = `<div class="drawer-head"><span class="mini-avatar drawer-avatar" style="background:${colorFor(c.id)}">${esc(initials(c.name))}</span><div class="drawer-title"><div class="eyebrow">Participant case</div><h2>${esc(c.name)}</h2><p>${esc(c.id)} · ${esc(c.cohort)} · ${esc(c.location)}</p><div class="drawer-status">${statusPill(c.status)}</div></div><button class="close-button" id="closeDrawer" aria-label="Close case">×</button></div><div class="drawer-body">
    <div class="case-summary"><div class="summary-box"><small>Status</small><strong>${esc(c.status_label || STATUS_LABEL[c.status])}</strong></div><div class="summary-box"><small>Result</small><strong>${esc(c.outcome)}</strong>${c.outcome_note ? `<span class="muted t-xs">${esc(c.outcome_note)}</span>` : ""}</div><div class="summary-box"><small>Confidence</small><strong>${c.confidence}%</strong><span class="summary-bar"><span style="width:${Math.max(0, Math.min(100, c.confidence))}%"></span></span></div></div>
    <div class="next-action"><small>Next permitted action</small><h3>${esc(c.stage === "Complete" ? "Case is complete" : c.stage === "Review" ? "A person must decide" : c.stage === "Not started" ? "Ready to start" : "Waiting")}</h3><p>${esc(c.next)}</p>
      ${canRun && simulated ? `<div class="sim-row"><label for="scenarioSelect">Simulated participant reply (WhatsApp is off)</label><select id="scenarioSelect" class="filter-select"><option value="same_job">Same job</option><option value="changed_job">Changed job</option><option value="employer_conflict">Employer name conflict</option><option value="not_employed">Not employed</option><option value="opt_out">Opts out</option><option value="no_response">No response</option></select></div>` : ""}
      ${canRun && !simulated ? `<p class="t-xs muted" style="margin:10px 0 8px">WhatsApp is live. The agent sends the approved message to this participant and waits for a real reply.</p>` : ""}
      <div class="next-buttons">
        ${c.stage === "Review" && can("review") ? `<button class="button primary small" id="goReview">Open review</button>` : ""}
        ${canRun ? `<button class="button primary small" id="runAgent" data-busy-label="Running…">Run agent session</button>` : ""}
        ${canRun && state.me?.voice && state.me.voice !== "off" ? `<button class="button ghost small" id="requestCall">Request a phone call</button>` : ""}
        ${canRun && waiting && !simulated ? `<button class="button ghost small" id="resumeAgent" data-busy-label="Reading…">Resume after reply</button>` : ""}
        ${c.stage !== "Not started" ? `<button class="button ghost small" id="viewSession">View agent session</button>` : ""}
      </div></div>
    <div class="drawer-tabs" role="tablist" aria-label="Case sections">${TABS.map(([k, label]) => `<button type="button" class="drawer-tab" role="tab" id="tab-${k}" data-tab="${k}" aria-controls="panel-${k}" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}">${label}<span class="tab-count" data-tab-count="${k}" hidden></span></button>`).join("")}</div>
    ${panel("overview", `<div class="drawer-section"><h3>What we need to know</h3><div id="reqBox">${loadingLine()}</div></div>
      <div class="drawer-section"><h3>Participant</h3><dl class="kv">${kv("Phone", c.phone)}${kv("Programme record employer", c.recorded_employer)}${kv("Reported employer", c.employer)}${kv("Case owner", c.owner)}${kv("Mission", missionName(c.mission_version ?? state.missions[0]?.version))}</dl></div>
      ${can("admin") ? `<div class="drawer-section danger-zone"><h3>Danger zone</h3><p class="t-sm muted" style="margin:0 0 10px">Deleting erases this participant's name, number, replies and evidence. The case stays only as an anonymous entry in the audit trail. This cannot be undone.</p><button class="button ghost small" id="deleteCase" style="color:#b64b48;border-color:#b64b48">Delete case…</button></div>` : ""}`)}
    ${panel("conversation", `<div id="convBox">${loadingLine()}</div>${simulated && can("run") && c.stage !== "Complete" ? `<div style="display:flex;gap:8px;margin-top:10px"><input id="simText" placeholder="Type a participant reply (simulated)" class="t-sm" style="flex:1" /><button class="button primary small" id="simSend" data-busy-label="Sending…">Send</button></div><small class="muted t-xs">WhatsApp is off. This goes through the same conversation logic as a real reply.</small>` : ""}`)}
    ${panel("calls", `<div id="callBox">${loadingLine()}</div>`)}
    ${panel("activity", `<div class="drawer-section"><h3>Agent notes</h3><div id="agentBox">${loadingLine()}</div></div>
      <div class="drawer-section"><h3>Case history</h3><div class="timeline" id="caseHistory">${loadingLine()}</div></div>`)}
  </div>`;
  caseDrawer.classList.add("open"); caseDrawer.setAttribute("aria-hidden", "false"); drawerBackdrop.hidden = false;
  $("closeDrawer").addEventListener("click", closeDrawer);
  caseDrawer.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => showCaseTab(b.dataset.tab)));
  caseDrawer.querySelector(".drawer-tabs").addEventListener("keydown", e => {
    const keys = ["overview", "conversation", "calls", "activity"], at = keys.indexOf(state.caseTab);
    const next = { ArrowRight: keys[(at + 1) % keys.length], ArrowLeft: keys[(at + keys.length - 1) % keys.length], Home: keys[0], End: keys.at(-1) }[e.key];
    if (next) { e.preventDefault(); showCaseTab(next, true); }
  });
  $("goReview")?.addEventListener("click", () => { closeDrawer(); state.reviewSelected = id; go("reviews"); });
  $("runAgent")?.addEventListener("click", () => runAgent(id, $("scenarioSelect")?.value || "same_job"));
  $("resumeAgent")?.addEventListener("click", async () => {
    await api("/admin/process-inbox", { method: "POST" }).catch(() => null);
    const out = await act(() => api(`/cases/${id}/resume-agent`, { method: "POST" }), "Agent resumed and read the reply");
    if (out) { state.session = out.session; openCase(id); }
  });
  $("requestCall")?.addEventListener("click", () => confirmModal({
    title: "Request a phone call?", text: `This asks for a call to ${c.name}. It goes through the same checks as the agent's calls (consent, contact hours, attempts) and then waits for approval on the Approvals page. Nothing rings until someone approves it.`, button: "Request the call", busy: "Requesting…",
    onConfirm: async () => { const out = await act(() => api(`/cases/${id}/request-call`, { method: "POST", body: { reason: "Phone call requested by staff" } }), null); if (out) { toast(out.message, "success"); openCase(id); } },
  }));
  $("viewSession")?.addEventListener("click", () => openLastSession(id).catch(e => toast(e.message, "warning")));
  $("deleteCase")?.addEventListener("click", () => openDeleteModal(c));
  fillConversation("convBox", id);
  let simSending = false;
  const sendSim = async () => {
    const box = $("simText"); const text = box?.value ?? "";
    if (simSending || !text.trim()) return; // one at a time, and nothing to send is nothing to do
    simSending = true; box.value = "";
    try {
    const out = await act(() => api(`/cases/${id}/simulate-reply`, { method: "POST", body: { text } }), null);
    if (out) { toast(`Reply handled: ${out.result.action}${out.result.detail ? " (" + out.result.detail + ")" : ""}`, "success"); openCase(id); }
    } finally { simSending = false; }
  };
  $("simSend")?.addEventListener("click", sendSim);
  $("simText")?.addEventListener("keydown", e => { if (e.key === "Enter") sendSim(); });
  try {
    const d = await api(`/cases/${id}`);
    const box = $("caseHistory");
    if (box) box.innerHTML = d.events.map(withIst).reverse().map(timelineEvent).join("") || `<p class="muted t-sm">No history.</p>`;
    setTabCount("activity", d.events.length); setTabCount("calls", d.calls?.length ?? 0);
    const rb = $("reqBox"); if (rb) rb.innerHTML = requirementsHtml(d.requirements);
    const ab = $("agentBox"); if (ab) { ab.innerHTML = agentNotesHtml(d); ab.querySelectorAll("[data-approve]").forEach(b => b.addEventListener("click", async () => { await decideApproval(b.dataset.approve, "approve"); openCase(id); })); ab.querySelectorAll("[data-reject]").forEach(b => b.addEventListener("click", async () => { await decideApproval(b.dataset.reject, "reject"); openCase(id); })); }
    const cb = $("callBox"); if (cb) { cb.innerHTML = callsHtml(d.calls); cb.querySelectorAll("[data-simcall]").forEach(b => b.addEventListener("click", () => simulateCall(id, b.dataset.simcall))); }
  } catch (e) { const box = $("caseHistory"); if (box) box.innerHTML = `<p class="muted t-sm">${esc(e.message)}</p>`; }
}
// What the agent remembers about this person, when it will next look at the case, and anything waiting for a person.
function agentNotesHtml(d) {
  const held = (d.approvals || []).filter(a => a.state === "held");
  const parts = [];
  if (held.length) parts.push(held.map(a => `<div class="agent-callout" style="margin:0 0 8px"><small>Waiting for approval</small><h3>${esc(a.label)}</h3><p>${esc(a.summary)}</p>${can("approve") ? `<div style="display:flex;gap:6px"><button class="button primary small" data-approve="${esc(a.outbox_id)}" data-busy-label="Approving…">Approve</button><button class="button ghost small" data-reject="${esc(a.outbox_id)}" data-busy-label="Declining…">Decline</button></div>` : ""}</div>`).join(""));
  parts.push(d.memory?.length ? `<div class="check-list">${d.memory.map(m => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(m.label)}</strong><small>${esc(m.value)}</small></span></div>`).join("")}</div>` : `<p class="muted t-sm">Nothing remembered about this person yet.</p>`);
  if (d.wakes?.length) parts.push(`<p class="t-sm" style="margin:8px 0 0">The agent will look at this case again: ${d.wakes.map(w => `${esc(istDay(w.at))} ${esc(istTime(w.at))} (${esc(w.reason.replace(/_/g, " "))})`).join("; ")}.</p>`);
  return parts.join("");
}
// What the mission needs to know about this person, and how much of it is settled.
const REQ_STATE = { verified: ["✓", "Checked against the programme record", "var(--sys)"], stated: ["●", "Said by the participant", "var(--amber, #ba772b)"], missing: ["○", "Still needed", "#b64b48"], conflict: ["!", "Does not match the programme record", "#b64b48"] };
function requirementsHtml(r) {
  if (!r || !r.items.length) return `<p class="muted t-sm">This mission does not list what it needs to know yet.</p>`;
  const shown = r.items.filter(i => i.applicable), later = r.items.length - shown.length;
  const head = `${r.collected} of ${r.needed} needed answers collected${r.verified ? `, ${r.verified} checked` : ""}${r.conflicts ? `, ${r.conflicts} not matching` : ""}`;
  return `<p class="t-sm" style="margin:0 0 8px"><strong>${esc(head)}</strong>${r.complete ? " · nothing more is needed" : r.gaps.length ? ` · still missing: ${esc(r.gaps.map(g => shown.find(i => i.key === g)?.label || g).join(", "))}` : ""}</p>` +
    shown.map(i => { const [mark, text, color] = REQ_STATE[i.state] || ["·", i.state, "var(--muted)"]; return `<div class="t-sm" style="display:flex;gap:8px;padding:3px 0"><span style="color:${color};width:14px;text-align:center;font-weight:700">${mark}</span><span style="flex:1"><strong>${esc(i.label)}</strong>${i.required ? "" : ` <small style="color:var(--muted)">(optional)</small>`}<small style="display:block;color:var(--muted)">${esc(text)}${i.confidence != null ? ` · ${Math.round(i.confidence * 100)}% sure` : ""}${i.note ? ` · ${esc(i.note)}` : ""}</small></span></div>`; }).join("") +
    (later ? `<small style="color:var(--muted)">${plural(later, "more question")} depend on earlier answers.</small>` : "");
}
// Phone calls on a case: how each went, the audio and the transcript (shown only to people allowed to see them).
const CALL_LABEL = { requested: "Requested", scheduled: "Scheduled", in_progress: "In progress", completed: "Completed", no_answer: "No answer", busy: "Busy", declined: "Declined", failed: "Failed", cancelled: "Cancelled" };
function callsHtml(calls) {
  const live = (calls || []).some(k => k.status === "in_progress" || k.status === "scheduled");
  const sim = state.me?.voice === "simulated" && live && can("run");
  const list = (calls || []).map(k => `<div class="t-sm" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:6px 0"><strong>${esc(CALL_LABEL[k.status] || k.status)}</strong> <small style="color:var(--muted)">· requested ${esc(istDay(k.requested_at))} ${esc(istTime(k.requested_at))}${k.scheduled_for ? " for " + esc(istDay(k.scheduled_for)) + " " + esc(istTime(k.scheduled_for)) : ""}${k.duration_seconds ? " · " + Math.max(1, Math.round(k.duration_seconds / 60)) + " min" : ""}</small>
      ${k.reason ? `<div style="color:var(--muted)">Why: ${esc(k.reason)}</div>` : ""}${k.asked?.length ? `<div style="color:var(--muted)">Asked for: ${esc(k.asked.join(", "))}</div>` : ""}
      ${k.audio_url ? `<div><audio controls preload="none" src="${esc(recordingSrc(k.audio_url))}" style="max-width:100%"></audio></div>` : ""}
      ${k.transcript ? `<details><summary style="cursor:pointer">Transcript</summary><pre class="mono t-xs" style="white-space:pre-wrap;margin:6px 0 0">${esc(k.transcript)}</pre></details>` : ""}</div>`).join("");
  const buttons = sim ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><small style="width:100%;color:var(--muted)">Simulator: finish the call yourself</small><button class="button primary small" data-simcall="answered">Answered</button><button class="button ghost small" data-simcall="no_answer">No answer</button><button class="button ghost small" data-simcall="refused">Refused</button><button class="button ghost small" data-simcall="wrong_person">Wrong person</button></div>` : "";
  return (list || `<p class="muted t-sm">No phone calls on this case. The agent can ask for one when WhatsApp is not enough.</p>`) + buttons;
}
async function simulateCall(id, outcome) {
  const body = { outcome, ...(outcome === "answered" ? { answers: { work_status: "I work at the same place as before", employer_name: "Employer (simulated)", role_title: "Role (simulated)" }, transcript: "Simulated call. The person agreed to continue and answered the questions." } : {}) };
  const out = await act(() => api(`/cases/${id}/simulate-call`, { method: "POST", body }), null);
  if (out) { toast("The call was finished as \"" + outcome.replace("_", " ") + "\" and applied like a real result.", "success"); openCase(id); }
}
const CONV_LABEL = { not_started: "Not started", awaiting_consent: "Waiting for consent", asking: "Asking questions", done: "Interview finished", escalated: "Handed to a person", stopped: "Stopped by participant" };
async function fillConversation(boxId, caseId) {
  try {
    const d = await api(`/cases/${caseId}/conversation`, { silent: true });
    const box = $(boxId); if (!box) return;
    const sig = JSON.stringify(d); // a refresh that brings nothing new leaves the panel (and its scroll position) alone
    if (box.dataset.case === caseId && box.dataset.sig === sig) return;
    box.dataset.case = caseId; box.dataset.sig = sig;
    const bubbles = d.messages.map(x => `<div style="display:flex;justify-content:${x.from === "participant" ? "flex-end" : "flex-start"};margin:6px 0"><div class="t-sm" style="max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;background:${x.from === "participant" ? "var(--teal-soft)" : "var(--surface)"};border:1px solid var(--line)">${esc(x.text)}</div></div>`).join("");
    setTabCount("conversation", d.messages.length);
    box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px"><span class="status ${d.status === "escalated" ? "review" : d.status === "done" ? "confirmed" : "progress"}">${esc(CONV_LABEL[d.status] || d.status)}</span><small style="color:var(--muted)">${d.answered} answered${d.reasks ? ` · ${d.reasks} re-asked` : ""}</small></div>${d.escalation_reason ? `<p class="t-sm danger-text" style="margin:4px 0">Needs a person: ${esc(d.escalation_reason.replace(/_/g, " "))}</p>` : ""}${bubbles || `<p class="muted t-sm">No questions have been asked yet. The interview starts when the participant agrees to continue.</p>`}`;
  } catch (e) { const box = $(boxId); if (box) box.innerHTML = `<p class="muted t-sm">${esc(e.message)}</p>`; }
}

// New replies and questions arrive while someone is looking at a conversation: refresh the one on screen every few seconds.
let convPollBusy = false;
async function pollConversation() {
  if (convPollBusy || document.hidden || !state.loaded) return;
  convPollBusy = true;
  try {
    if (caseDrawer.classList.contains("open") && state.caseTab === "conversation" && state.caseTabFor && $("convBox")) await fillConversation("convBox", state.caseTabFor);
    else if (state.view === "reviews" && state.reviewSelected && $("reviewConv")) await fillConversation("reviewConv", state.reviewSelected);
  } finally { convPollBusy = false; }
}
setInterval(pollConversation, 5000);

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
      <div class="review-list"><div class="review-list-head"><strong>Queue</strong><small>${plural(reviews.length, "case")} to decide</small></div>${reviews.map(c => `<button class="review-item ${c.id === state.reviewSelected ? "active" : ""}" data-review="${esc(c.id)}"><div class="review-item-top"><strong>${esc(c.name)}</strong><span class="t-xs muted">${esc(c.id)}</span></div><p>${esc(c.reason)}</p></button>`).join("") || empty("Queue is clear", "Nothing is waiting for a decision.")}</div>
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
    <div style="margin:14px 0"><h3 class="t-md" style="margin:0 0 6px">Conversation</h3><div id="reviewConv"></div></div>
    <div class="agent-callout"><small>Why this needs a person</small><h3>${esc(c.reason)}</h3><p>The agent's recommendation is not a final decision.</p></div>
    ${can("review") ? `<div class="review-notes"><label for="reviewNotes">Note (kept with the decision, removed if the case is deleted)</label><textarea id="reviewNotes" placeholder="Why did you decide this?"></textarea></div>
    <div class="decision-bar"><button class="button ghost" data-decision="inconclusive" data-id="${esc(c.id)}">Mark inconclusive</button><button class="button coral" data-decision="followup" data-id="${esc(c.id)}">Request follow-up</button><button class="button ghost" data-decision="not_confirm" data-id="${esc(c.id)}">Not confirmed</button><button class="button primary" data-decision="confirm" data-id="${esc(c.id)}">Confirm outcome</button></div>`
      : `<p class="muted t-sm">Only reviewers and administrators can decide.</p>`}`;
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
  if (!v) return loadingState("Loading phone calls…", "Reading the connection and the calls.");
  const [kindTone, kindLabel] = { zolabs: ["ok", "ZoLabs, live"], simulated: ["warn", "Simulator: nobody is rung"], off: ["off", "Not connected"] }[v.kind] || ["off", v.kind];
  const chk = state.voiceCheck;
  const account = chk?.ok ? (typeof chk.account === "string" ? chk.account : chk.account?.email || chk.account?.name || chk.account?.account || JSON.stringify(chk.account).slice(0, 120)) : "";
  const checkNote = chk ? (chk.ok ? `<p class="pc-note ok">Connected. Signed in as ${esc(account)}.</p>` : `<p class="pc-note bad">Could not connect: ${esc(chk.error)}</p>`) : "";
  const canCheck = v.can_check && v.kind !== "off";

  // 1. Status strip: is it working, and who can it reach?
  const tile = (label, value, note, tone, extra = "") => `<div class="pc-tile"><span class="pc-label">${label}</span><strong class="pc-value">${tone ? `<i class="pc-dot ${tone}"></i>` : ""}${esc(value)}</strong><small>${esc(note)}</small>${extra}</div>`;
  const strip = `<section class="pc-strip" aria-label="Phone connection">
    ${tile("Connection", kindLabel, canCheck ? "Asks ZoLabs who we are signed in as. Places no call and costs nothing." : "", kindTone, canCheck ? `<button type="button" class="button ghost small" data-action="voice-check" data-busy-label="Checking…">Check connection</button>` : "")}
    ${tile("Calls", v.calls_enabled ? "Switched on" : "Switched off", v.calls_enabled ? "Approved calls are placed by the scheduler." : "Nothing will ring, even when a call is approved.", v.calls_enabled ? "ok" : "off")}
    ${tile("Who can be called", v.who_can_be_called, "Only people who have not opted out, inside the contact hours.", "")}
    ${tile("Finished calls", v.callback_ready ? "ZoLabs rings us back" : "Found by the scheduler", v.callback_ready ? "ZoLabs tells us the moment a call finishes, and we fetch the details ourselves." : "No callback address is set, so results are picked up when the scheduler runs.", "")}
  </section>`;

  // 2. The calls, most recent first. One row each; the recording and transcript sit underneath.
  const count = (statuses, cls, label) => { const n = v.calls.filter(k => statuses.includes(k.status)).length; return n ? `<span class="status ${cls}">${n} ${label}</span>` : ""; };
  const counts = [count(["scheduled"], "progress", "scheduled"), count(["in_progress"], "progress", "in progress"), count(["completed"], "confirmed", "completed"), count(["no_answer", "busy", "declined"], "review", "not answered"), count(["failed"], "not-confirmed", "failed")].join("");
  const callRow = k => {
    const asked = k.asked?.length ? k.asked.join(", ").replace(/_/g, " ") : "everything";
    const recording = k.audio_url ? `<audio class="pc-audio" controls preload="none" src="${esc(recordingSrc(k.audio_url))}"></audio>` : k.has_audio ? `<small>Recording kept. Reviewers can play it.</small>` : k.status === "completed" ? `<small>No recording</small>` : "";
    const transcript = k.transcript ? `<details class="pc-transcript"><summary>Transcript</summary><pre class="mono t-xs">${esc(k.transcript)}</pre></details>` : k.has_transcript ? `<small>Transcript kept. Reviewers can read it.</small>` : "";
    return `<article class="pc-call">
      <div class="pc-who">${callPill(k.status)}<button type="button" class="pc-person" data-case="${esc(k.case_id)}">${esc(k.person)}</button><small>${esc(k.case_id)}</small></div>
      <div class="pc-what"><span class="pc-k">Asked for</span><span>${esc(asked)}</span>${k.reason ? `<small>${esc(k.reason)}</small>` : ""}</div>
      <div class="pc-when"><span class="pc-k">Requested</span><span>${esc(istDay(k.requested_at))} ${esc(istTime(k.requested_at))}</span>${k.scheduled_for ? `<small>for ${esc(istDay(k.scheduled_for))} ${esc(istTime(k.scheduled_for))}</small>` : ""}${k.duration_seconds != null ? `<small>Length ${esc(mmss(k.duration_seconds))}</small>` : ""}</div>
      <div class="pc-media">${recording}${transcript}</div>
    </article>`;
  };

  // 3. The phone form of each mission: published once per mission, and again when the mission changes.
  const formRow = f => `<div class="pc-form">
      <div class="pc-form-name"><strong>${esc(f.name)}</strong><small>${esc(f.mission_version)}</small></div>
      <span class="status ${FORM_STATE[f.state][0]}">${esc(FORM_STATE[f.state][1])}</span>
      <div class="pc-form-meta">${f.published_at ? `Published ${esc(istDay(f.published_at))} ${esc(istTime(f.published_at))}${f.published_by ? ` by ${esc(f.published_by)}` : ""}` : "Not published yet"}${f.form_id ? `<small>Form ${esc(f.form_id)}</small>` : ""}</div>
      <button type="button" class="button ghost small" data-open-mission="${esc(f.mission_version)}">Preview or publish</button>
    </div>`;

  return `${pageHead("Phone calls", "How the voice agent reaches people.", "The platform asks for a call, a person approves it, and ZoLabs places it. Here is the connection, every call made, and the form each mission uses.")}
    ${strip}${checkNote}
    <section class="card card-pad pc-section"><div class="card-head"><div><h2>Calls</h2><p>Most recent first. Recordings and transcripts are shown to reviewers and platform staff only.</p></div><span class="status active">${v.calls.length}</span></div>
      ${counts ? `<div class="pc-counts">${counts}</div>` : ""}
      ${v.calls.length ? `<div class="pc-list">${v.calls.map(callRow).join("")}</div>` : empty("No calls yet", "When the agent asks for a call and a person approves it, it appears here.")}</section>
    <section class="card card-pad pc-section"><div class="card-head"><div><h2>Phone forms</h2><p>One per mission. The form the voice agent follows on a call.</p></div></div>
      ${v.forms.length ? `<div class="pc-forms">${v.forms.map(formRow).join("")}</div>` : empty("No missions yet", "Each mission gets its own phone form.")}</section>`;
}
// While a call is in progress, ask the server every few seconds whether it has finished, and show the result when it has.
let callSyncBusy = false, lastSyncError = "";
async function syncCallsNow() {
  if (callSyncBusy || !state.loaded || !state.me || state.me.voice === "off" || !can("run")) return;
  if (!state.voice?.calls?.some(k => k.status === "in_progress" || k.status === "scheduled")) return;
  callSyncBusy = true;
  try {
    const r = await api("/voice/sync", { method: "POST", silent: true });
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
  const row = a => `<tr><td><strong>${esc(a.participant)}</strong><small style="display:block;color:var(--muted)">${esc(a.case_id)}</small></td><td>${esc(a.label)}</td><td class="t-sm" style="max-width:420px">${esc(a.summary)}</td><td>${esc(istDay(a.held_at))} ${esc(istTime(a.held_at))}</td>
    <td>${a.state === "held" ? (canDecide ? `<div style="display:flex;gap:6px"><button class="button primary small" data-approve="${esc(a.outbox_id)}" data-busy-label="Approving…">Approve</button><button class="button ghost small" data-reject="${esc(a.outbox_id)}" data-busy-label="Declining…">Decline</button></div>` : `<small style="color:var(--muted)">Only reviewers, administrators and agent operations can decide.</small>`) : `<span class="status ${approvalState(a.state)[0]}">${esc(approvalState(a.state)[1])}</span><small style="display:block;color:var(--muted)">${esc(a.decided_by || "")} ${a.decided_at ? esc(istTime(a.decided_at)) : ""}${a.note ? " · " + esc(a.note) : ""}</small>`}</td></tr>`;
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
  if (!k) return loadingState("Loading the controls…", "Reading the current settings.");
  const c = k.controls, canChange = k.can_change, stat = Object.fromEntries(k.stats.map(s => [s.kind, s]));
  const dial = k.actions.map(a => { const s = stat[a.kind]; return `<tr><td><strong>${esc(a.label)}</strong><small style="display:block;color:var(--muted)">${esc(ACTION_NOTE[a.kind])}</small></td>
    <td><select class="filter-select" data-dial="${esc(a.kind)}" ${canChange ? "" : "disabled"} aria-label="${esc(a.label)}"><option value="approve_first" ${c.autonomy[a.kind] === "approve_first" ? "selected" : ""}>A person approves first</option><option value="automatic" ${c.autonomy[a.kind] === "automatic" ? "selected" : ""}>Automatic</option></select></td>
    <td class="t-sm">${s.approved} approved, ${s.rejected} declined${s.held ? `, ${s.held} waiting` : ""}${s.suggest_automatic ? `<small style="display:block;color:var(--sys)">Ten approvals and no refusals: this could safely go automatic.</small>` : ""}</td></tr>`; }).join("");
  const sw = c.paused
    ? `<div class="agent-callout" style="border-color:#b64b48"><small>Switched off${c.paused_by ? " by " + esc(c.paused_by) : ""}${c.paused_at ? " at " + esc(istTime(c.paused_at)) : ""}</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>${c.paused_reason ? esc(c.paused_reason) + ". " : ""}Replies are still recorded. ${plural(k.queued_unsent, "message")} and calls are queued and will go out when you switch it back on.</p>${k.can_pause ? `<button class="button primary small" data-action="resume-platform">Switch back on</button>` : ""}</div>`
    : `<div class="agent-callout"><small>Running normally</small><h3>The kill switch stops everything at once.</h3><p>No message is sent, no call is placed, no campaign queues and the agent is not woken. Replies are still recorded. Use it if something wrong is going out.</p>${k.can_pause ? `<button class="button coral small" data-action="pause-platform">Switch everything off</button>` : ""}</div>`;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Autonomy dial</h2><p>What the agent may do on its own, and what waits for a person</p></div><span class="status ${k.held ? "review" : "active"}">${k.held} waiting</span></div>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Rule</th><th>So far</th></tr></thead><tbody>${dial}</tbody></table></div>
      ${canChange ? "" : `<p class="muted t-xs">Only administrators and agent operations can change the dial and the limits.</p>`}</section>
    <aside class="card config-section"><div class="card-head"><div><h2>Kill switch</h2><p>Stop everything now</p></div></div>${sw}</aside></div>
    <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Limits</h2><p>The agent stops, and a person is asked, when a limit is reached. 0 means no limit.</p></div><span class="status active">$${k.spend_24h.toFixed(2)} in the last 24 hours</span></div>
      <div class="form-grid">
        <div class="field"><label for="limDaily">Most the agent may spend in 24 hours (USD)</label><input id="limDaily" type="number" min="0" step="0.5" value="${esc(c.daily_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limCase">Most on one case, in total (USD)</label><input id="limCase" type="number" min="0" step="0.1" value="${esc(c.case_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limWakes">Most wake-ups on one case</label><input id="limWakes" type="number" min="1" step="1" value="${esc(c.max_wakes_per_case)}" ${canChange ? "" : "disabled"} /></div>
      </div>
      ${canChange ? `<div style="margin-top:10px"><button class="button primary small" data-action="save-limits" data-busy-label="Saving…">Save limits</button></div>` : ""}
      <small class="muted t-xs" style="display:block;margin-top:8px">Amounts use indicative prices. ${plural(k.pending_wakes, "wake-up")} are set for later.${c.updated_by ? ` Last changed by ${esc(c.updated_by)}.` : ""}</small></section>`;
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
  const body = r.rows.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Then</th><th>Now</th><th></th></tr></thead><tbody>${r.rows.map(x => `<tr><td><code>${esc(x.tool)}</code></td><td>${esc(x.recorded === "unknown" ? "not recorded" : { executed: "ran", held: "held", refused: "refused" }[x.recorded])}</td><td>${esc(lab[x.now])}${x.message ? `<small style="display:block;color:var(--muted)">${esc(x.message)}</small>` : ""}</td><td>${x.changed ? `<span class="status review">Changed</span>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted t-sm">This session took no action that can be checked.</p>`;
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
        ${configRow("WhatsApp", r.whatsapp === "live" ? "Live" : "Off", r.whatsapp === "live" ? "Approved messages go to participants who have consented." : "Replies are simulated; nothing is sent.")}
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
  if (!e) return loadingState("Loading the employee…", "Reading the current version.");
  const info = state.employees.find(x => x.version === e.version);
  const versions = state.employees.map(x => `<button class="review-item ${x.version === e.version ? "active" : ""}" data-employee="${esc(x.version)}"><div class="review-item-top"><strong>${esc(x.name)} · ${esc(x.version)}</strong><span class="t-xs muted">${x.current ? "current" : "older"}</span></div><p>${x.builtin ? "Built in" : "Added " + esc(istDay(x.created_at))}. ${plural(x.missions_using, "mission")} use it.</p></button>`).join("");
  const mission = state.ctxPreview?.mission_version || state.defaultMission;
  const layers = state.ctxPreview ? state.ctxPreview.layers.map(l => `<details style="margin:8px 0"><summary class="t-sm" style="cursor:pointer"><strong>${esc(l.title)}</strong> <small style="color:var(--muted)">(${esc(l.layer)} layer)</small></summary><pre class="mono t-xs" style="white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0 0">${esc(l.text)}</pre></details>`).join("") + `<small style="color:var(--muted)">About ${state.ctxPreview.estimated_tokens.toLocaleString()} tokens. Cached: ${esc(state.ctxPreview.cached_as.join("; "))}. Nothing about a person is ever in here: the case is read through a tool.</small>` : `<p class="muted t-sm">Choose a mission to see the exact text the agent is given.</p>`;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>${esc(e.name)} <small class="muted t-lg t-regular">${esc(e.version)}</small></h2><p>One employee does every mission. A mission can pin an exact version or follow the current one.</p></div><span class="status ${info?.current ? "confirmed" : "progress"}">${info?.current ? "Current" : "Older version"}</span></div>
      <div class="config-list">${longText("Purpose", e.purpose)}${longText("Persona and tone", e.persona)}${longText("Standing instructions", e.instructions)}${listText("Never does", e.guardrails)}${listText("Hands to a person when", e.escalation_rules)}${e.knowledge?.length ? longText("Knows", e.knowledge.map(k => k.title + ": " + k.text).join("\n\n")) : ""}${e.memory_policy ? longText("Memory", e.memory_policy) : ""}${configRow("Limits per run", `${e.model?.max_turns ?? 12} turns, up to ${(e.model?.budget_usd ?? 0.5).toFixed(2)}`, `Effort ${e.model?.effort ?? "medium"}${e.model?.name ? ", model " + e.model.name : ", the platform's pinned model"}.`)}</div></section>
    <aside class="card config-section"><div class="card-head"><div><h2>Versions</h2><p>Saved versions never change</p></div>${state.employeeCanEdit ? `<button class="button primary small" data-action="add-employee">Add a version</button>` : ""}</div><div class="review-list" style="border:0">${versions}</div>
      ${state.employeeCanEdit ? "" : `<p class="muted t-xs">Only platform staff (administrators and agent operations) can add a version. Clients never create employees.</p>`}</aside>
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
        <div class="field full"><label for="eText">Definition (JSON)</label><textarea id="eText" rows="16" spellcheck="false" class="mono t-xs" placeholder="Copy the current version, then change the version name and what you want to improve.">${esc(s.text)}</textarea><small>Change version at least. The platform's safety rules apply whatever is written here, and allowed_tools limits what the agent may do.</small></div>
        ${s.error ? `<p class="danger-text t-sm" style="grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelE">Cancel</button><button class="button primary" id="saveE" data-busy-label="Saving…" ${s.running || !s.text.trim() ? "disabled" : ""}>Save version</button></div>`;
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
    <section class="card session-monitor-table" style="margin-top:15px"><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Session</th><th>Case</th><th>Started</th><th>Status</th><th>Tokens</th><th>Cost</th><th></th></tr></thead><tbody>${ss.map(s => `<tr><td><code class="t-xs">${esc(s.session_id)}</code></td><td><strong>${esc(s.case_id)}</strong></td><td>${esc(istDay(s.started_at))} ${esc(istTime(s.started_at))}</td><td>${esc(s.status)}${s.simulated ? " (simulated)" : ""}</td><td>${(s.tokens_in + s.tokens_out).toLocaleString()}</td><td>$${s.cost_usd.toFixed(3)}</td><td><button class="row-action" data-open-session="${esc(s.session_id)}">›</button></td></tr>`).join("")}</tbody></table></div></section>`;
}

function renderSessionViewer(s) {
  const turns = s.trace.length ? s.trace.map(t => {
    const actor = t.tool ? "Claude · tool request" : t.type.startsWith("session") ? "Session state" : t.type === "system.message" ? "System event" : "Runtime";
    const body = t.tool
      ? `<p>Calling an approved capability.</p><div class="tool-call"><div class="tool-call-head"><strong>${esc(t.tool)}</strong><span>${t.outcome === "held" ? "held for approval" : t.result?.code ? "refused" : "completed"}</span></div><pre>INPUT  ${esc(JSON.stringify(t.input))}\nRESULT ${esc(JSON.stringify(t.result).slice(0, 360))}</pre></div>`
      : `<p>${esc(t.detail)}</p>`;
    return `<div class="model-turn"><div class="turn-meta"><span class="turn-actor"><span>${t.tool ? "AI" : "S"}</span>${actor}</span><span>${esc(istTime(t.ts))}</span></div>${body}</div>`;
  }).join("") : `<p class="muted t-sm">The step-by-step record was removed (the case was deleted).</p>`;
  const steps = s.trace.map(t => `<div class="trace-event complete"><span class="trace-index">✓</span><span class="trace-copy"><strong>${esc(t.label)}</strong><small>${esc(t.type)}${t.tool ? "" : ` · ${esc(t.detail)}`}</small></span></div>`).join("");
  return `<div style="margin-bottom:12px"><button class="button ghost small" data-action="close-session">← All sessions</button></div>
    <section class="card session-header"><div class="session-identity"><span class="session-pulse">Ⅱ</span><div><h2>Session ${esc(s.session_id)}</h2><p>Case ${esc(s.case_id)} · Agent v${esc(s.employee_version)} · ${esc(s.mission_version)}</p></div>${statusPill(s.status === "budget_reached" ? "review" : "confirmed")}</div><div class="session-actions"><span class="beta-chip">${s.simulated ? "Simulated agent" : "Claude"} · same tool gateway</span><button class="button ghost small" data-replay="${esc(s.session_id)}">Replay under today's rules</button></div></section>
    <section class="card session-grid"><aside class="trace-sidebar"><h3>Steps</h3>${steps}</aside>
      <div class="transcript"><div class="transcript-head"><h3>Transcript</h3><span class="t-xs muted">Recorded from the tool gateway</span></div>${turns}</div>
      <aside class="inspector"><div class="inspector-tabs"><button class="inspector-tab active">Session</button></div><div class="inspector-body">
        ${field("Status", s.status)}${field("Woken by", (s.trigger || "first run").replace("wake:", "timer: ").replace(/_/g, " "))}${field("Tool calls", `${s.trace.filter(t => t.tool).length} · ${s.trace.filter(t => t.result?.code).length} refused`)}${field("Tokens in / out", `${s.tokens_in.toLocaleString()} / ${s.tokens_out.toLocaleString()}`)}
        <div class="inspector-field"><small>Budget</small><strong>$${s.cost_usd.toFixed(3)} of $${s.budget_usd.toFixed(2)}</strong><div class="budget-track"><span style="width:${Math.min(100, (s.cost_usd / s.budget_usd) * 100)}%"></span></div></div></div></aside></section>${replayHtml(state.replay && state.replay.session_id === s.session_id ? state.replay : null)}`;
}
const field = (l, v) => `<div class="inspector-field"><small>${esc(l)}</small><strong>${esc(v)}</strong></div>`;

// ---- mission (read only) ---------------------------------------------------------------------------------------------------------------
// ---- the questionnaire wording: read it, and sign it off --------------------------------------------------------------------------------
// Everything a participant will be sent, in the order they will see it. Reading it here is what a sign-off is based on.
// The messages that are not questions: the fixed replies and the answers to common questions. Read only, folded away.
function wordingHtml(ins) {
  const fixed = [["Opening after they agree", ins.start_message], ["Closing", ins.closing_message], ["When we could not understand", ins.reask_prefix], ["When they hand over to a person", ins.handover_message], ["Wrong person", ins.wrong_person_message], ["Someone in distress", ins.distress_message], ["Asking for data to be deleted", ins.deletion_message], ["Not a text message", ins.unsupported_prefix]];
  return `<details class="q-more" style="margin-top:14px"><summary class="t-sm" style="cursor:pointer"><strong>Fixed messages and answers to common questions</strong> (${fixed.length} messages, ${ins.faq.length} answers)</summary>
    <h3 class="t-md" style="margin:14px 0 4px">Fixed messages</h3><div class="check-list">${fixed.map(([t, v]) => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(t)}</strong><small>${esc(v)}</small></span></div>`).join("")}</div>
    <h3 class="t-md" style="margin:14px 0 4px">Answers to common questions (${ins.faq.length})</h3><div class="check-list">${ins.faq.map(f => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(f.keywords.join(", "))}</strong><small>${esc(f.answer)}</small></span></div>`).join("")}</div></details>`;
}
function wordingCard(m) {
  const w = state.wordingFor === m.version ? state.wording : null;
  const so = m.signed_off;
  const editable = !m.instrument_signed_off && can("admin");
  const status = m.instrument_signed_off
    ? `<span class="status confirmed">Signed off${so ? ` by ${esc(so.by)} on ${esc(istDay(so.at))}` : ""}</span>`
    : `<span class="status review">Draft: not signed off</span>`;
  const signBtn = editable && w ? `<button class="button primary small" data-action="sign-off">Sign off this wording</button>` : "";
  const explain = m.instrument_signed_off
    ? `<p class="t-sm" style="margin:8px 0">This wording was approved for real participants. It cannot be edited: a change is a new version, which has to be signed off again.</p>`
    : `<p class="t-sm" style="margin:8px 0">Read every question as it will be asked on WhatsApp and on a phone call${editable ? ". Edit, remove or add questions here, then sign off. What you sign off is exactly what the agent will use" : ""}. Until someone signs this wording off, the interview will not continue on its own with real participants: every reply is handed to a person.${can("admin") ? "" : " Only an administrator can sign off."}</p>`;
  const load = w || state.wordingLoading ? "" : `<button class="button ghost small" data-action="read-wording" data-busy-label="Opening…">${editable ? "Review and edit the questions" : "Read the questionnaire"} (${esc(m.questions_total)} questions)</button>`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Questionnaire wording</h2><p>Every question and message a participant will receive, on WhatsApp and on a call</p></div>${status}</div>
    ${explain}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${load}${signBtn}</div>${w ? `<div id="qEditorMount" style="margin-top:12px"></div>${wordingHtml(w.definition.instrument)}` : state.wordingLoading ? `<div style="margin-top:12px">${loadingLine("Opening the questions…")}</div>` : ""}</section>`;
}
async function loadWording(version) {
  if (state.wordingLoading) return;
  state.wordingLoading = true; state.wordingFailedFor = null;
  render(); // draws the "opening the questions" line
  try {
    const d = await api("/missions/" + encodeURIComponent(version) + "/definition");
    const m = state.missionShown ?? state.mission;
    state.wording = d; state.wordingFor = version;
    state.qeditor = createQuestionEditor({ def: d.definition, canEdit: !m.instrument_signed_off && can("admin"), check: def => api("/missions/check", { method: "POST", body: def, silent: true }), onChange: syncSignOff });
    render(); state.qeditor.runCheck();
  } catch (e) { state.wordingFailedFor = version; toast(e.message, "warning"); } // do not try again by itself: the button is back for a person to press
  finally { state.wordingLoading = false; if (state.wordingFor !== version) render(); }
}
/** The Sign off button follows the editor: not while a question is open for editing, not while there are problems, and it says when there are changes. */
function syncSignOff() {
  const b = document.querySelector('[data-action="sign-off"]'), ed = state.qeditor;
  if (!b || !ed) return;
  const why = ed.isBusy() ? "Save or cancel the question you are editing first." : !ed.isChecked() ? "Checking the questions…" : ed.problems().length ? "Fix the problems listed above first." : "";
  b.disabled = !!why; b.title = why;
  b.textContent = ed.isChanged() ? "Sign off with my changes" : "Sign off this wording";
}

// ---- Mission Studio: write a mission as a plain brief, let the drafter structure it, read it, save it as a draft ---------------------------------------------
function openStudioModal() {
  const s = { step: "brief", running: false, error: null, result: null, brief: { name: "", programme_name: "", goal: "", people: "", find_out: "", approach: "", start_from: state.defaultMission, max_attempts: "", window_start_hour: "", window_end_hour: "" } };
  const read = () => {
    const b = s.brief, out = { name: b.name.trim(), programme_name: b.programme_name.trim(), goal: b.goal.trim(), people: b.people.trim(), find_out: b.find_out.trim() };
    if (b.approach.trim()) out.approach = b.approach.trim();
    if (b.start_from) out.start_from = b.start_from;
    for (const k of ["max_attempts", "window_start_hour", "window_end_hour"]) if (String(b[k]).trim() !== "") out[k] = Number(b[k]);
    return out;
  };
  // ---- the form screen -------------------------------------------------------------------------------------------------------------
  const STUDIO_STEPS = ["Describe", "Draft", "Review", "Save"];
  const LIMITS = { name: [3, 100], programme_name: [1, 80], goal: [20, 1500], people: [10, 1000], find_out: [10, 3000], approach: [0, 1500] }; // the same limits the server checks
  const hourLabel = h => (h === 24 ? "12:00 am (end of day)" : `${Math.floor(h) % 12 || 12}:${h % 1 ? "30" : "00"} ${h < 12 ? "am" : "pm"}`);
  const hourSelect = (id, value, label) => `<select id="${id}" aria-label="${label}"><option value="">Usual</option>${Array.from({ length: 49 }, (_, i) => i / 2).map(h => `<option value="${h}" ${String(h) === String(value) ? "selected" : ""}>${hourLabel(h)}</option>`).join("")}</select>`;
  const autosize = el => { if (!el.offsetParent) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`; }; // not while the dialog is hidden: it would measure as zero // grows as you type, so there are no big empty boxes

  /** Plain-words problems with the brief, found before anything is sent. The server checks the same limits again. */
  const briefProblems = b => {
    const out = [], len = k => String(b[k] ?? "").trim().length;
    if (len("name") < 3 || len("name") > 100) out.push("Give the mission a name (3 to 100 characters).");
    if (len("programme_name") < 1 || len("programme_name") > 80) out.push("Say what the programme is called (up to 80 characters).");
    if (len("goal") < 20) out.push("Say what the mission is trying to achieve, in at least 20 characters.");
    if (len("people") < 10) out.push("Say who the people are, in at least 10 characters.");
    if (len("find_out") < 10) out.push("Say what you need to find out about each person, in at least 10 characters.");
    for (const k of ["goal", "people", "find_out", "approach"]) if (len(k) > LIMITS[k][1]) out.push(`That text is too long: keep it under ${LIMITS[k][1]} characters.`);
    const att = String(b.max_attempts).trim();
    if (att !== "" && !(Number.isInteger(Number(att)) && Number(att) >= 1 && Number(att) <= 10)) out.push("Most contact attempts has to be a whole number from 1 to 10.");
    const ws = String(b.window_start_hour), we = String(b.window_end_hour);
    if (ws !== "" && we !== "" && Number(ws) >= Number(we)) out.push("Contact hours must end after they start.");
    return [...new Set(out)];
  };

  /** One line that says what the optional settings are, so they can stay folded away. */
  const settingsSummary = () => {
    const b = s.brief, picked = state.missions.find(m => m.version === b.start_from);
    const ws = String(b.window_start_hour), we = String(b.window_end_hour), att = String(b.max_attempts).trim();
    const hours = ws === "" && we === "" ? "usual contact hours" : `contact ${ws === "" ? "from the usual start" : "from " + hourLabel(Number(ws))} ${we === "" ? "to the usual end" : "to " + hourLabel(Number(we))}`;
    return `${picked ? "Using " + picked.name : "Using the standard setup"} · ${att ? att + " attempts at most" : "usual attempts"} · ${hours}`;
  };

  const field = (id, label, hint, rows, value, key) => {
    const [min, max] = LIMITS[key];
    return `<div class="field full"><div class="field-label"><label for="${id}">${label}</label><span class="field-count" id="${id}Count" data-min="${min}" data-max="${max}"></span></div><small class="field-hint">${hint}</small><textarea id="${id}" rows="${rows}" class="t-md">${esc(value)}</textarea></div>`;
  };

  const countLine = (id, value) => {
    const el = $(id + "Count"); if (!el) return;
    const n = value.trim().length, min = Number(el.dataset.min), max = Number(el.dataset.max);
    el.textContent = `${n} / ${max}`;
    el.classList.toggle("is-short", n > 0 && n < min);       // typed something, but not enough yet
    el.classList.toggle("is-long", n > max);
  };

  const drawBrief = () => {
    const b = s.brief, open = !!s.settingsOpen;
    modal.classList.add("modal-sticky");                      // only the middle scrolls, so Cancel and Draft are always in view
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Create a mission</h2><p>Describe the mission in your own words. The drafter turns it into the questions and checklist the employee works from.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      ${s.running ? '<div class="studio-progress" role="progressbar" aria-label="Drafting the mission"></div>' : ""}
      <div class="stepper" aria-label="Steps">${STUDIO_STEPS.map((n, i) => `<div class="stepper-item ${i === 0 ? "active" : ""}" ${i === 0 ? 'aria-current="step"' : ""}><span class="stepper-number">${i + 1}</span><span>${n}</span></div>`).join("")}</div>
      <div class="modal-body">
        <div class="studio-note"><span class="studio-note-icon" aria-hidden="true">i</span><p><strong>Describe the programme, not people.</strong> Do not write any person's name or phone number here. You read and approve the draft before anyone is contacted.</p></div>
        ${s.problems?.length ? `<div class="studio-problems" role="alert"><strong>${s.problems.length === 1 ? "One thing to fix" : "A few things to fix"}</strong><ul>${s.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
        ${s.error ? `<div class="studio-problems" role="alert"><strong>The draft could not be started</strong><p>${esc(s.error)}</p></div>` : ""}
        <fieldset class="studio-fields" ${s.running ? "disabled" : ""}>
          <section class="form-section"><h3>About the mission</h3><div class="form-grid">
            <div class="field"><label for="sName">Mission name</label><input id="sName" value="${esc(b.name)}" placeholder="Six-month placement check" /></div>
            <div class="field"><label for="sProg">Programme name <span class="opt">(as participants see it)</span></label><input id="sProg" value="${esc(b.programme_name)}" placeholder="Project Udaan" /></div>
          </div></section>
          <section class="form-section"><h3>What it is for</h3><div class="form-grid">
            ${field("sGoal", "What is this mission trying to achieve?", "For example: find out whether people we placed in jobs are still working there six months on, and whether they want support.", 3, b.goal, "goal")}
            ${field("sPeople", "Who are the people?", "For example: young people who finished a three-month retail training with us last year, mostly on basic phones.", 2, b.people, "people")}
            ${field("sFind", "What must we find out about each person?", "One thing per line is clearest. Say when something only applies to some people, for example: &quot;the name of their employer, if they are working&quot;.", 5, b.find_out, "find_out")}
          </div></section>
          <section class="form-section"><h3>Tone and style <span class="opt">(optional)</span></h3><div class="form-grid">
            ${field("sApproach", "Tone, things to avoid, languages", "For example: be warm and brief; never promise jobs; do not ask about family.", 2, b.approach, "approach")}
          </div></section>
          <section class="form-section"><button type="button" class="settings-toggle" id="sToggle" aria-expanded="${open}"><span><strong>Settings</strong> <span class="opt">(optional)</span><small id="sSummary">${esc(settingsSummary())}</small></span><svg class="settings-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            ${open ? `<div class="form-grid settings-panel">
              <div class="field full"><label for="sFrom">Use the approved first message, contact rules and employee from</label><select id="sFrom">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === b.start_from ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><small>The first WhatsApp message must be a template approved by WhatsApp, so it is copied rather than drafted.</small></div>
              <div class="field"><label for="sAtt">Most contact attempts per person</label><input id="sAtt" type="number" min="1" max="10" placeholder="Usual" value="${esc(b.max_attempts)}" /></div>
              <div class="field"><label for="sWs">Contact hours</label><div class="hours-row">${hourSelect("sWs", b.window_start_hour, "Contact hours, from")}<span>to</span>${hourSelect("sWe", b.window_end_hour, "Contact hours, until")}</div></div>
            </div>` : ""}</section>
        </fieldset>
      </div>
      <div class="modal-foot"><button class="button ghost" id="cancelS">Cancel</button><span class="foot-actions"><small class="foot-note">${s.running ? "Drafting can take a minute. Keep this window open." : "Takes about a minute. Nothing is saved until you approve it."}</small><button class="button primary" id="draftS" ${s.running ? "disabled" : ""}>${s.running ? "Drafting…" : "Draft the mission"}</button></span></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelS").addEventListener("click", closeModal);
    const counted = { sGoal: "goal", sPeople: "people", sFind: "find_out", sApproach: "approach" };
    modal.querySelectorAll("textarea").forEach(autosize);
    for (const [id, k] of Object.entries(counted)) countLine(id, b[k]);
    const bind = (id, key) => $(id)?.addEventListener("input", e => { s.brief[key] = e.target.value; if (e.target.tagName === "TEXTAREA") autosize(e.target); if (counted[id]) countLine(id, e.target.value); if (id === "sAtt") $("sSummary").textContent = settingsSummary(); });
    [["sName", "name"], ["sProg", "programme_name"], ["sGoal", "goal"], ["sPeople", "people"], ["sFind", "find_out"], ["sApproach", "approach"], ["sAtt", "max_attempts"]].forEach(([id, k]) => bind(id, k));
    $("sFrom")?.addEventListener("change", e => { s.brief.start_from = e.target.value; $("sSummary").textContent = settingsSummary(); });
    [["sWs", "window_start_hour"], ["sWe", "window_end_hour"]].forEach(([id, k]) => $(id)?.addEventListener("change", e => { s.brief[k] = e.target.value; $("sSummary").textContent = settingsSummary(); }));
    $("sToggle").addEventListener("click", () => { s.settingsOpen = !s.settingsOpen; drawBrief(); });
    $("draftS").addEventListener("click", async () => {
      if (s.running) return;
      s.problems = briefProblems(s.brief); s.error = null;
      if (s.problems.length) { drawBrief(); modal.querySelector(".modal-body").scrollTop = 0; return; } // say what is missing before sending anything
      s.running = true; drawBrief(); // lock the button at once: drafting takes a while and a second click would start a second draft
      try { s.result = await api("/missions/draft", { method: "POST", body: read() }); s.editor = null; s.step = "review"; s.running = false; drawReview(); }
      catch (e) { s.running = false; s.error = e.message; drawBrief(); }
    });
  };
  const drawReview = () => {
    modal.classList.remove("modal-sticky");
    const r = s.result, d = r.definition;
    const need = d ? d.evidence_requirements.map(x => `<div class="check-item"><span class="check-mark">${x.required === false ? "○" : "●"}</span><span><strong>${esc(x.label)}</strong><small>${x.required === false ? "Optional" : "Required"}${x.when ? `, only if <code>${esc(x.when.key)}</code> is ${esc(x.when.in.join(" or "))}` : ""}${x.verify_against ? ", checked against the programme record" : ""}.${x.hint ? " " + esc(x.hint) : ""}</small></span></div>`).join("") : "";
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${d ? "Review the questions" : "The draft could not be made"}</h2><p>${d ? `Drafted ${r.source === "claude" ? "by Claude" : "as a plain starting point (no model key is set)"}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}. Nothing is saved yet. It will be saved as draft wording: nobody is contacted until a person signs it off.` : "Fix the brief or add detail, then try again."}</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body" style="max-height:60vh;overflow:auto">
        ${r.problems.length && !d ? `<div class="agent-callout" style="border-color:#b64b48"><small>Problems</small><h3>${esc(r.problems[0])}</h3>${r.problems.length > 1 ? `<p>${r.problems.slice(1, 6).map(esc).join("<br>")}</p>` : ""}</div>` : ""}
        ${r.notes.length ? `<div class="agent-callout"><small>Assumptions to check</small><p>${r.notes.map(esc).join("<br>")}</p></div>` : ""}
        ${d ? `<h3 class="t-md" style="margin:14px 0 4px">Goal</h3><p class="t-md" style="margin:0">${esc(d.objective)}</p>
          <h3 class="t-md" style="margin:14px 0 4px">Results it can end with</h3>${resultsHtml(d.outcomes, d.verdict_labels)}
          ${d.strategy ? `<h3 class="t-md" style="margin:14px 0 4px">Approach</h3><p class="t-sm" style="margin:0">Channels in order: ${d.strategy.channels.map(c => (c === "voice" ? "phone call" : "WhatsApp")).join(", then ")}. Follow up after about ${esc(d.strategy.follow_up_after_hours)} hours of silence.${d.agent_guidance ? " " + esc(d.agent_guidance) : ""}</p>` : ""}
          <h3 class="t-md" style="margin:18px 0 4px">Questions</h3>
          <p class="t-sm" style="margin:0 0 10px">Read each question as it will be asked on WhatsApp and on a phone call. Edit, remove or add anything you need. Nothing is saved until you save the mission.</p>
          <div id="qEditor"></div>
          <details class="q-more" style="margin-top:14px"><summary class="t-sm" style="cursor:pointer"><strong>What the employee will find out</strong> (${d.evidence_requirements.length})</summary><div class="check-list" style="margin-top:8px">${need}</div></details>
          ${wordingHtml(d.instrument)}` : ""}
      </div>
      <div class="modal-foot"><button class="button ghost" id="backS">← Edit the brief</button>${d ? `<button class="button primary" id="saveS" ${s.running ? "disabled" : ""}>${s.running ? "Saving…" : "Save as a draft mission"}</button>` : ""}</div>`;
    $("closeModal").addEventListener("click", closeModal);
    $("backS").addEventListener("click", () => { s.step = "brief"; drawBrief(); });
    // The save button follows the editor: not while a question is open for editing, and not while there are problems.
    const syncSave = () => {
      const b = $("saveS"), ed = s.editor; if (!b || !ed) return;
      const why = ed.isBusy() ? "Save or cancel the question you are editing first." : !ed.isChecked() ? "Checking the questions…" : ed.problems().length ? "Fix the problems listed above first." : "";
      b.disabled = s.running || !!why; b.title = why;
    };
    if (d) {
      s.editor ??= createQuestionEditor({ def: d, check: def => api("/missions/check", { method: "POST", body: def, silent: true }), onChange: syncSave });
      s.editor.mount($("qEditor"));
      if (!s.editor.isChecked()) s.editor.runCheck();
      syncSave();
    }
    $("saveS")?.addEventListener("click", async () => {
      if (s.running || !s.editor) return;
      const edited = s.editor.getDef();
      s.running = true; drawReview();
      try {
        const out = await api("/missions", { method: "POST", body: edited });
        closeModal(); state.missionShown = null; state.wording = null; state.wordingFor = null; state.qeditor = null; state.voiceFormFor = null; await loadAll();
        state.missionShown = await api("/mission?version=" + encodeURIComponent(out.mission.version)); render();
        toast("Saved as a draft mission. Review the questions on this page and sign off before contacting anyone.", "success");
      } catch (e) { s.running = false; s.error = e.message; toast(e.message, "warning"); drawReview(); }
    });
  };
  drawBrief(); modalBackdrop.hidden = false;
  modal.querySelectorAll("textarea").forEach(autosize); // now that it is visible, give the boxes their height
}

// The evidence a mission needs: the checklist the employee works through for every person.
// What a mission can conclude about a person, in its own words: the findings, and what the three general results mean here.
function resultsHtml(outcomes, verdictLabels) {
  const found = (outcomes || []).map(o => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(o.label)}</strong><small>${esc(o.description || "")}</small></span></div>`).join("");
  const v = verdictLabels || {};
  const means = `Confirmed: ${esc(v.confirmed || "confirmed")}. Not confirmed: ${esc(v.not_confirmed || "not confirmed")}. Inconclusive: ${esc(v.inconclusive || "inconclusive")}.`;
  return `<div class="check-list">${found || '<p class="muted t-sm">This mission does not list its own findings, so the original job findings apply.</p>'}</div><p class="muted t-sm" style="margin:8px 0 0">${means}</p>`;
}
function resultsCard(m) {
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Results this mission can end with</h2><p>What the employee can conclude about each person. The cases list shows these, in these words</p></div><span class="status active">${(m.outcomes || []).length}</span></div>${resultsHtml(m.outcomes, m.verdict_labels)}</section>`;
}
function needsCard(m) {
  const rs = m.requirements || [];
  const label = k => rs.find(r => r.key === k)?.label || k;
  const body = rs.length ? rs.map(r => `<div class="check-item"><span class="check-mark">${r.required ? "●" : "○"}</span><span><strong>${esc(r.label)}</strong><small>${r.required ? "Required" : "Optional"}, counts at ${Math.round(r.min_confidence * 100)}% sure or more${r.when ? `, only if ${esc(label(r.when.key).toLowerCase())} is ${esc(r.when.in.map(v => v.replace(/_/g, " ")).join(" or "))}` : ""}${r.checked_against ? ", checked against the programme record" : ""}.${r.hint ? " " + esc(r.hint) : ""}</small></span></div>`).join("") : `<p class="muted t-sm">This mission does not list what it needs to know. Add evidence_requirements so the employee can tell what is still missing for each person.</p>`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>What the employee must find out</h2><p>For each person, the employee works until these are known, choosing the easiest way to ask</p></div><span class="status ${rs.length ? "active" : "progress"}">${rs.length}</span></div><div class="check-list">${body}</div></section>`;
}
// The phone form: what the voice provider is told for this mission, and whether what is published is still current.
function voiceCard(m) {
  const off = state.me?.voice === "off";
  const v = state.voiceFormFor === m.version ? state.voiceForm : null;
  const status = !v ? "" : v.link ? (v.in_sync ? `<span class="status confirmed">Published and current</span>` : `<span class="status review">Out of date</span>`) : `<span class="status progress">Not published</span>`;
  const note = !v ? "" : v.link ? `<p class="t-sm" style="margin:8px 0">Published as form ${esc(v.link.form_id)} on ${esc(istDay(v.link.published_at))} ${esc(istTime(v.link.published_at))} by ${esc(v.link.published_by)}.${v.in_sync ? "" : " The mission or the employee has changed since, so the voice agent is working from older instructions. Publish again to update it."}</p>` : `<p class="t-sm" style="margin:8px 0">Nothing is published yet, so the agent cannot ask for a phone call on this mission.</p>`;
  const fields = !v ? "" : `<details style="margin-top:8px"><summary class="t-sm" style="cursor:pointer"><strong>What the voice agent is told</strong> (instructions and ${v.definition.form_fields.length} fields)</summary><pre class="mono t-xs" style="white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0">${esc(v.definition.start_message + "\n\n" + v.definition.form_context)}</pre>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Field</th><th>Type</th><th>What it asks</th></tr></thead><tbody>${v.definition.form_fields.map(f => `<tr><td><code>${esc(f.field_id)}</code><small style="display:block;color:var(--muted)">${esc(f.field_name)}</small></td><td>${esc(f.datatype)}</td><td class="t-xs">${esc(f.additional_info)}</td></tr>`).join("")}</tbody></table></div></details>`;
  const buttons = off ? "" : `<button class="button ghost small" data-action="voice-preview" data-busy-label="Loading…">${v ? "Refresh the preview" : "Preview the phone form"}</button>${v && state.employeeCanEdit ? (state.voicePublishing ? `<button class="button primary small" disabled>Publishing… this can take a minute</button>` : v.link && v.in_sync ? "" : `<button class="button primary small" data-action="voice-publish">${v.link ? "Update at ZoLabs" : "Create at ZoLabs"}</button>`) : ""}`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Phone calls (ZoLabs)</h2><p>The form the voice agent follows for this mission. A person publishes it; the agent only asks for calls.</p></div>${status}</div>
    ${off ? `<p class="muted t-sm">Phone calls are not switched on for this platform yet.</p>` : `${note}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${buttons}</div>${fields}`}
    ${state.me?.voice === "simulated" ? `<small class="muted t-xs" style="display:block;margin-top:8px">Simulator: nobody is rung. Use the case page to finish a call yourself.</small>` : ""}</section>`;
}
async function loadVoiceForm(version) {
  try { state.voiceForm = await api("/missions/" + encodeURIComponent(version) + "/voice-form"); state.voiceFormFor = version; render(); }
  catch (e) { toast(e.message, "warning"); }
}
function renderMission() {
  const m = state.missionShown ?? state.mission, r = m.runtime;
  const picker = `<select class="filter-select" id="missionPick" aria-label="Choose a mission">${state.missions.map(x => `<option value="${esc(x.version)}" ${x.version === m.version ? "selected" : ""}>${esc(x.name)} · ${esc(x.version)} (${plural(x.participants, "participant")})</option>`).join("")}</select>`;
  const actions = `${picker}${can("admin") ? `<button class="button primary" data-action="new-mission">Create a mission</button><button class="button ghost" data-action="add-mission">Add from JSON</button>${m.builtin ? "" : `<button class="button ghost" data-action="delete-mission" style="color:#b64b48;border-color:#b64b48">Delete this mission</button>`}` : ""}`;
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
    [r.whatsapp === "live", "WhatsApp sending", r.whatsapp === "live" ? "On, to participants who have consented" : "Off. Replies are simulated"],
    [!m.instrument.draft, "Interview questions approved", m.instrument.draft ? `${m.instrument.questions} draft questions. ${r.draft_instrument_allowed ? "Allowed for testing only" : "Blocked for real conversations until approved"}` : "Approved"],
    [m.templates.length > 0, "Approved message template", m.templates.map(t => t.key).join(", ") || "None configured"],
    [state.cases.length > 0, "Participants loaded", state.cases.length ? plural(state.cases.length, "participant") : "None yet"],
    [r.agent === "claude", "Claude agent", r.agent === "claude" ? `Running ${r.model}` : "Scripted stand-in is running (no model key)"],
  ];
  return `${pageHead("Mission", m.name, "Each client or programme has its own mission: first message, questions, contact rules and agent notes. New participants join the most recently added one unless you choose.", actions)}
    <section class="card mission-hero"><div class="mission-meta"><span class="mission-icon">↗</span><div><h2>${esc(m.name)}</h2><p>${esc(m.mission_id)} · ${esc(m.version)}</p></div></div>
      <div class="mission-stats"><div class="mission-stat"><strong>${m.questions_total}</strong><small>Question slots</small></div><div class="mission-stat"><strong>${m.templates.length}</strong><small>Approved messages</small></div><div class="mission-stat"><strong>${m.policy.max_attempts}</strong><small>Contact attempts</small></div><div class="mission-stat"><strong>${esc(m.policy.contact_window)}</strong><small>Contact window</small></div></div></section>
    ${detail}
    ${wordingCard(m)}
    ${needsCard(m)}
    ${resultsCard(m)}
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
  return `${pageHead("Audit trail", "Every change has an actor and a reason.", "A tamper-evident record of what the system, the agent and people did. Deleted cases remain only as anonymous entries.", `<button class="button ghost" data-action="verify-ledger" data-busy-label="Verifying…">Verify integrity</button><button class="button primary" data-action="export-audit">Export CSV</button>`)}
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
  const importResult = r => `<p class="t-md"><strong>${plural(r.created.length, "participant")} added.</strong> ${r.skipped.length ? `${plural(r.skipped.length, "row")} skipped.` : ""}</p>
    ${r.error ? `<p class="danger-text t-sm">Stopped early: ${esc(r.error)}</p>` : ""}
    ${r.skipped.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Row</th><th>Why it was skipped</th></tr></thead><tbody>${r.skipped.map(x => `<tr><td>${x.row}</td><td>${esc(x.reason)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add participants</h2><p>One row per participant. Numbers are encrypted when stored.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body">${s.result ? importResult(s.result) : `
        <div class="field full" style="margin-bottom:10px"><label for="impMission">Mission</label><select id="impMission">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === s.mission ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><small>Decides the first message, questions and contact hours for these participants. It cannot be changed afterwards.${state.missions.length > 1 ? "" : " Only one mission exists at the moment."}</small></div>
        <div class="field full"><label for="csvFile">CSV file</label><input type="file" id="csvFile" accept=".csv,.txt,text/csv" /></div>
        <div class="field full" style="margin-top:10px"><label for="csvText">Or paste rows (first row is the header) <button type="button" class="text-button" id="csvExample" style="margin-left:8px">Insert an example</button></label><textarea id="csvText" rows="6" placeholder="name,phone,employer,location,cohort,language&#10;Asha Kumari,9876543210,Acme Retail,Jaipur,Batch 7,en">${esc(s.text)}</textarea><small>name and phone are required. employer, location, cohort and language (en or hi) are optional. Larger files are sent in batches of 20.</small></div>
        ${s.problem ? `<p class="danger-text t-sm" style="margin:10px 0 0">${esc(s.problem)}</p>` : ""}
        ${s.rows.length ? `<div style="margin-top:12px"><strong class="t-sm">${plural(s.rows.length, "participant")} ready</strong><div style="overflow-x:auto"><table class="data-table" style="margin-top:6px"><thead><tr><th>Name</th><th>Phone</th><th>Employer</th><th>Location</th><th>Cohort</th></tr></thead><tbody>${s.rows.slice(0, 5).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.phone.replace(/\d(?=\d{4})/g, "•"))}</td><td>${esc(r.employer || "—")}</td><td>${esc(r.location || "—")}</td><td>${esc(r.cohort || "—")}</td></tr>`).join("")}</tbody></table></div>${s.rows.length > 5 ? `<small style="color:var(--muted)">…and ${s.rows.length - 5} more</small>` : ""}</div>` : ""}
        <label class="t-sm" style="display:flex;gap:10px;align-items:flex-start;margin-top:14px"><input type="checkbox" id="attest" ${s.attested ? "checked" : ""} style="margin-top:3px" /><span>I confirm these participants agreed to be contacted for programme follow-up under the agreed data policy. This confirmation is recorded.</span></label>`}
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
function openDeleteMissionModal(m) {
  const used = state.missions.find(x => x.version === m.version)?.participants ?? 0;
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Delete ${esc(m.name)}?</h2><p>This removes the mission and its questionnaire. It cannot be undone.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="field full"><p class="t-sm" style="margin:0">${used ? `<b>${plural(used, "participant")}</b> use this mission, so it cannot be deleted until they are deleted. ` : ""}A mission that has participants or campaigns is kept, because their history points at it. The phone form made for it stays in ZoLabs (ZoLabs has no way to delete it): switch it off there if you do not want it.</p></div>
      <div class="field full"><label for="delMConfirm">Type <b>${esc(m.version)}</b> to confirm</label><input id="delMConfirm" autocomplete="off" /></div>
      <p id="delMError" style="color:#b64b48;font-size:12px;grid-column:1/-1;margin:0;white-space:pre-wrap"></p></div></div>
    <div class="modal-foot"><button class="button ghost" id="cancelDelM">Cancel</button><button class="button primary" id="confirmDelM" data-busy-label="Deleting…" disabled style="background:#b64b48;border-color:#b64b48">Delete mission</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelDelM").addEventListener("click", closeModal);
  $("delMConfirm").addEventListener("input", e => { $("confirmDelM").disabled = e.target.value.trim() !== m.version; });
  $("confirmDelM").addEventListener("click", async () => {
    $("confirmDelM").disabled = true;
    try {
      await api(`/missions/${encodeURIComponent(m.version)}/delete`, { method: "POST", body: { confirm: m.version } });
      closeModal(); state.missionShown = null; state.wording = null; state.wordingFor = null; state.qeditor = null; state.voiceFormFor = null; await loadAll();
      toast(`${m.version} deleted.`, "success");
    } catch (e) { $("delMError").textContent = e.message; $("confirmDelM").disabled = false; }
  });
}
function openDeleteModal(c) {
  modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Delete ${esc(c.id)}?</h2><p>This erases the participant's personal data and cannot be undone.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="field full"><p class="t-sm" style="margin:0">Erased: name, phone number, employer, replies, evidence values, agent notes and step records. Kept: an anonymous entry in the audit trail saying who deleted the case and when. Any message still queued is cancelled.</p></div>
      <div class="field full"><label for="delReason">Reason</label><select id="delReason"><option value="participant_request">Participant asked for their data to be deleted</option><option value="data_entry_error">Added by mistake</option><option value="test_data">Test data</option><option value="other">Other</option></select></div>
      <div class="field full"><label for="delConfirm">Type <b>${esc(c.id)}</b> to confirm</label><input id="delConfirm" autocomplete="off" /></div></div></div>
    <div class="modal-foot"><button class="button ghost" id="cancelDelete">Cancel</button><button class="button primary" id="confirmDelete" data-busy-label="Deleting…" disabled style="background:#b64b48;border-color:#b64b48">Delete case</button></div>`;
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
    <div class="modal-foot"><button class="button ghost" id="cancelPurge">Cancel</button><button class="button primary" id="confirmPurge" data-busy-label="Deleting…" disabled style="background:#b64b48;border-color:#b64b48">Delete everything</button></div>`;
  modalBackdrop.hidden = false;
  $("closeModal").addEventListener("click", closeModal); $("cancelPurge").addEventListener("click", closeModal);
  $("purgeConfirm").addEventListener("input", e => { $("confirmPurge").disabled = e.target.value !== "DELETE ALL DATA"; });
  $("confirmPurge").addEventListener("click", async () => {
    $("confirmPurge").disabled = true;
    const out = await act(() => api("/admin/purge-all", { method: "POST", body: { confirm: "DELETE ALL DATA" } }), "All data deleted.");
    if (out) closeModal();
  });
}

function closeModal() { modalBackdrop.hidden = true; modal.classList.remove("modal-sticky"); modal.innerHTML = ""; /* pasted rows and names must not linger in the page */ }

// ---- events -------------------------------------------------------------------------------------------------------------------------------------------
function go(view) { state.view = view; chrome(); window.scrollTo({ top: 0 }); }

function bindGo(root) { root.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", () => go(el.dataset.go))); }

function bind() {
  bindGo(appView);
  $("dashMission")?.addEventListener("change", e => { state.dashMission = e.target.value; refreshOverview(); });
  appView.querySelectorAll("[data-dash-clear]").forEach(el => el.addEventListener("click", () => { const s = $("dashMission"); s.value = ALL; s.dispatchEvent(new Event("change", { bubbles: true })); }));
  appView.querySelectorAll("[data-open-mission]").forEach(el => el.addEventListener("click", async () => { try { state.missionShown = await api(`/mission?version=${encodeURIComponent(el.dataset.openMission)}`); go("missions"); } catch (err) { toast(err.message, "warning"); } }));
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
      button: update ? "Update the form" : "Create the form", busy: update ? "Updating…" : "Creating…",
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
  if (name === "new-mission") openStudioModal();
  if (name === "delete-mission") openDeleteMissionModal(state.missionShown ?? state.mission);
  if (name === "run-batch") {
    act(() => api("/campaigns/run-now", { method: "POST" }), null).then(r => {
      if (!r) return;
      const queued = r.campaigns.reduce((n, c) => n + c.sent, 0);
      toast(`${plural(queued, "first message")} queued, ${r.sent} sent.${r.paused.length ? ` ${plural(r.paused.length, "campaign")} paused: ${r.paused[0].reason}` : ""}`, r.paused.length ? "warning" : "success");
    });
  }
  if (name === "voice-check") checkVoice();
  if (name === "read-wording") loadWording((state.missionShown ?? state.mission).version);
  if (name === "sign-off") {
    const m = state.missionShown ?? state.mission, ed = state.qeditor;
    if (ed?.isBusy()) { toast("Save or cancel the question you are editing first.", "warning"); return; }
    if (ed && ed.problems().length) { toast("Fix the problems listed above before signing off.", "warning"); return; }
    const edits = ed?.isChanged() ? { instrument: ed.getDef().instrument, evidence_requirements: ed.getDef().evidence_requirements } : undefined;
    confirmModal({
      title: "Sign off this wording?",
      text: `${edits ? "Your changes to the questions are included. " : ""}By signing off you confirm that someone responsible for the programme has read every question and message and approves them for real participants. This approves this mission as it is now. It does not create a second mission. Your name and the time are recorded on it, and after that it cannot be changed. People already loaded on it will follow the approved questions. If you use phone calls, publish the phone form again.`,
      button: "I have read it. Sign off", busy: "Signing off…",
      onConfirm: async () => {
        const out = await act(() => api("/missions/" + encodeURIComponent(m.version) + "/sign-off", { method: "POST", body: edits ? { confirm: true, edits } : { confirm: true } }), null);
        if (out) { state.missionShown = null; state.wording = null; state.wordingFor = null; state.qeditor = null; state.voiceFormFor = null; await loadAll(); state.missionShown = await api("/mission?version=" + encodeURIComponent(out.mission.version)); render(); toast("Signed off. The interview now continues on its own for participants on this mission.", "success"); }
      },
    });
  }
  if (name === "close-session") { state.session = null; state.replay = null; render(); }
  if (name === "pause-platform") confirmModal({ title: "Switch everything off?", text: "No message will be sent, no call placed, no campaign queued and the agent will not be woken until you switch it back on. Replies are still recorded.", button: "Switch everything off", busy: "Switching off…", onConfirm: () => saveControls({ paused: true, reason: "Switched off from the console" }, "Everything is switched off.") });
  if (name === "resume-platform") confirmModal({ title: "Switch back on?", text: "Queued messages and calls go out on the next scheduler pass, and timers that came due are acted on. Check the queue first if something wrong was going out.", button: "Switch back on", busy: "Switching on…", onConfirm: () => saveControls({ paused: false }, "Back on.") });
  if (name === "save-limits") saveControls({ daily_budget_usd: Number($("limDaily").value), case_budget_usd: Number($("limCase").value), max_wakes_per_case: Number($("limWakes").value) }, "Limits saved.");
  if (name === "export-cases") {
    const rows = filteredCases().map(c => [c.id, c.cohort, c.location, c.status_label || STATUS_LABEL[c.status], c.outcome, c.confidence, c.attempts, c.lastTouch]);
    download(`dozai-cases-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(["case", "cohort", "location", "status", "result", "confidence", "attempts", "last activity"], rows));
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
