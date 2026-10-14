// Campaigns page and the New campaign dialog.
import { TZ } from "../lib/config.js";
import { can, state } from "../lib/state.js";
import { empty, pageHead } from "../components/page.js";
import { esc, istTime, plural } from "../lib/format.js";
import { toast } from "../components/toast.js";
import { closeModal, confirmModal } from "../components/modal.js";
import { act, api, loadAll } from "../lib/api.js";
import { $, modal, modalBackdrop } from "../lib/dom.js";

// ---- campaigns -------------------------------------------------------------------------------------------------------------------------------
const CAMP_STATUS = { draft: ["not-started", "Draft"], running: ["progress", "Running"], paused: ["review", "Paused"], completed: ["confirmed", "Finished"], stopped: ["not-confirmed", "Stopped"] };
const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
/** Employer fields belong to missions that check an answer against the programme's employer record (the placement kind). A mission about
 *  anything else has no employer, so they are not shown for it. A mission that lists no needs is an older placement one. */
export const hasEmployer = c => {
  const m = state.missions.find(x => x.version === (c.mission_version ?? state.missions[0]?.version));
  return !m || !(m.requirements || []).length || m.requirements.some(r => r.checked_against === "programme_employer");
};
export const missionName = v => { const m = state.missions.find(x => x.version === v); return m ? `${m.name} (${m.version})` : v; };
export function renderCampaigns() {
  const list = state.campaigns;
  const running = list.some(c => c.status === "running");
  const actions = can("intake") ? `${running ? `<button class="button ghost" data-action="run-batch" data-busy-label="Sending…">Send next batch now</button>` : ""}<button class="button primary" data-action="new-campaign">New campaign</button>` : "";
  return `${pageHead("Campaigns", "Send the first message to many people, at a safe pace.", "A campaign sends each person their mission's first message in small batches, inside the contact hours and under a daily limit. Replies are handled automatically.", actions)}
    ${list.length ? list.map(campaignCard).join("") : empty("No campaigns yet", can("intake") ? "Add participants, then create a campaign to message them. Nothing is sent until you start it." : "No campaign has been created.", can("intake") ? `<button class="button primary" data-action="new-campaign">New campaign</button>` : "")}`;
}
function campaignCard(c) {
  const p = c.progress || { queued: 0, contacted: 0, waiting: 0, needs_review: 0, complete: 0, send_failed: 0, in_mission: 0, already_contacted: 0, in_other_campaign: 0 };
  const total = p.queued + p.contacted;
  const pct = total ? Math.round((p.contacted / total) * 100) : 0;
  const [cls, label] = CAMP_STATUS[c.status] || ["not-started", c.status];
  const today = c.sent_day === todayIst() ? c.sent_today : 0;
  const stale = c.status === "running" && c.last_run_at && Date.now() - new Date(c.last_run_at).getTime() > 3 * 60_000;
  const btn = (act, text) => `<button class="button ${act === "start" || act === "resume" ? "primary" : "ghost"} small" data-camp="${esc(c.campaign_id)}" data-act="${act}">${text}</button>`;
  const noOne = c.status === "draft" && !p.queued;
  const startBtn = noOne ? `<button class="button primary small" disabled title="Nobody can be messaged yet">Start sending</button>` : btn("start", "Start sending");
  const why = [p.already_contacted ? `${p.already_contacted} already contacted` : "", p.in_other_campaign ? `${p.in_other_campaign} in another campaign` : ""].filter(Boolean).join(", ");
  const scope = c.cohort ? ` in cohort ${esc(c.cohort)}` : "";
  const reachLine = c.status !== "draft"
    ? `<p class="muted t-xs" style="margin:10px 0 0">${plural(p.in_mission, "person", "people")} in this mission${scope}.</p>`
    : noOne
      ? `<p class="danger-text t-sm" style="margin:10px 0 0">Nobody can be messaged by this campaign. ${p.in_mission ? `This mission has ${plural(p.in_mission, "person", "people")}${scope}, but ${why || "none are waiting to be messaged"}.` : `There is nobody in this mission${scope} yet. Add people on the Cases page first.`}</p>`
      : `<p class="muted t-sm" style="margin:10px 0 0"><strong>${plural(p.queued, "person", "people")}</strong> will be messaged${p.in_mission > p.queued ? ` (of ${p.in_mission} in this mission${why ? `; ${why}` : ""})` : ""}.</p>`;
  const del = btn("delete", "Delete");
  const controls = !can("intake") ? "" : c.status === "draft" ? startBtn + del
    : c.status === "running" ? btn("pause", "Pause") + btn("stop", "Stop") : c.status === "paused" ? btn("resume", "Resume") + btn("stop", "Stop") + del : del;
  const tile = (l, v, tone = "") => `<div class="summary-box"><small>${l}</small><strong ${tone ? `style="color:${tone}"` : ""}>${v}</strong></div>`;
  return `<section class="card card-pad" style="margin-bottom:14px" data-campaign-card="${esc(c.campaign_id)}">
    <div class="card-head"><div><h2>${esc(c.name)}</h2><p>${esc(missionName(c.mission_version))} · ${c.cohort ? `cohort ${esc(c.cohort)}` : "everyone loaded before it started"} · up to ${c.daily_cap} a day, ${c.per_tick} a minute</p></div><span class="status ${cls}">${label}</span></div>
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 12px"><div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div><strong class="t-sm">${p.contacted} of ${total} messaged</strong></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">${tile("Waiting to send", p.queued)}${tile("Messaged", p.contacted)}${tile("Waiting for reply", p.waiting)}${tile("Needs review", p.needs_review, p.needs_review ? "#b64b48" : "")}${tile("Finished", p.complete)}${tile("Could not send", p.send_failed, p.send_failed ? "#b64b48" : "")}${tile("Sent today", `${today} / ${c.daily_cap}`)}</div>
    ${reachLine}
    ${c.pause_reason && c.status === "paused" ? `<p class="danger-text t-sm" style="margin:10px 0 0">${esc(c.pause_reason)}</p>` : c.last_note ? `<p class="muted t-sm" style="margin:10px 0 0">${esc(c.last_note)}${c.last_run_at ? ` (${esc(istTime(c.last_run_at))})` : ""}</p>` : ""}
    ${stale ? `<p class="danger-text t-sm" style="margin:6px 0 0">The scheduler has not run for a few minutes, so no new batches are going out. Check that the Cron job is set up, or press "Send next batch now".</p>` : ""}
    ${p.send_failed ? `<p class="muted t-xs" style="margin:6px 0 0">People marked "Could not send" stay in the waiting state. Open their case to see why.</p>` : ""}
    ${controls ? `<div style="display:flex;gap:8px;margin-top:12px">${controls}</div>` : ""}</section>`;
}
export function campaignAct(id, act) {
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
  if (act === "delete") {
    const sent = c.progress?.contacted ?? 0;
    return confirmModal({
      title: `Delete "${c.name}"?`,
      text: sent ? `The campaign is removed from this page. The ${plural(sent, "person", "people")} it messaged keep their cases and conversations, and cannot be added to a new campaign.` : "Nothing was sent by this campaign. It is removed from this page.",
      button: "Delete campaign", busy: "Deleting…", danger: true,
      onConfirm: async () => { if (await deleteCampaign(id)) toast("Campaign deleted.", "success"); },
    });
  }
  if (act === "stop") {
    return confirmModal({ title: `${c.status === "draft" ? "Discard" : "Stop"} "${c.name}"?`, text: c.status === "draft" ? "Nothing has been sent. The campaign is closed and cannot be started." : "No more first messages will be sent. People already messaged keep their conversations. A stopped campaign cannot be restarted.", button: c.status === "draft" ? "Discard" : "Stop campaign", busy: c.status === "draft" ? "Discarding…" : "Stopping…", danger: true, onConfirm: () => run(() => "Campaign stopped.") });
  }
  run(out => act === "pause" ? "Paused. Nothing more will be sent until you resume." : `Resumed. ${plural(out.pass?.sent ?? 0, "first message")} sent now.`);
}
// (campaignAct has a parameter called act, which hides the act() helper inside it, so deleting lives out here.)
const deleteCampaign = id => act(() => api(`/campaigns/${id}/delete`, { method: "POST" }), null);
const act_ = (id, a) => act(() => api(`/campaigns/${id}/${a}`, { method: "POST" }), null);
export function openCampaignModal() {
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
