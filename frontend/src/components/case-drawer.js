// The case panel that slides in from the right, its tabs, the live conversation, and running the agent on a case.
import { can, state } from "../lib/state.js";
import { $, caseDrawer, drawerBackdrop } from "../lib/dom.js";
import { colorFor, esc, initials, istDay, istTime, plural, withIst } from "../lib/format.js";
import { STATUS_LABEL, statusPill } from "./page.js";
import { loadingLine } from "./busy.js";
import { missionName } from "../pages/campaigns.js";
import { go } from "../shell.js";
import { act, api } from "../lib/api.js";
import { confirmModal } from "./modal.js";
import { toast } from "./toast.js";
import { openDeleteModal } from "./delete-modals.js";
import { timelineEvent } from "../pages/overview/index.js";
import { decideApproval } from "../pages/approvals.js";
import { recordingSrc } from "../pages/phone-calls.js";

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
export async function openCase(id) {
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
export async function fillConversation(boxId, caseId) {
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
export function closeDrawer() { caseDrawer.classList.remove("open"); caseDrawer.setAttribute("aria-hidden", "true"); drawerBackdrop.hidden = true; caseDrawer.innerHTML = ""; /* do not leave personal data in the page */ }
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
