// The page frame: the sidebar and top bar, choosing and drawing the current page, and wiring clicks to actions.
import { can, state } from "./lib/state.js";
import { $, appView } from "./lib/dom.js";
import { initials, istTime, plural } from "./lib/format.js";
import { CLOUD } from "./lib/config.js";
import { loadingState } from "./components/busy.js";
import { STATUS_LABEL, empty } from "./components/page.js";
import { refreshOverview, renderOverview } from "./pages/overview/index.js";
import { filteredCases, renderCases } from "./pages/cases/index.js";
import { campaignAct, openCampaignModal, renderCampaigns } from "./pages/campaigns.js";
import { decide, renderReviews } from "./pages/reviews.js";
import { renderAgent } from "./pages/agent/index.js";
import { decideApproval, renderApprovals } from "./pages/approvals.js";
import { checkVoice, renderCalls } from "./pages/phone-calls.js";
import { loadVoiceForm, renderMission } from "./pages/missions/index.js";
import { renderAudit } from "./pages/audit.js";
import { fillConversation, openCase } from "./components/case-drawer.js";
import { loadWording, syncSignOff } from "./pages/missions/wording.js";
import { ALL } from "./pages/overview/dashboard.js";
import { act, api, loadAll } from "./lib/api.js";
import { toast } from "./components/toast.js";
import { openEmployeeModal, openPlatformModal, showContext, showEmployee } from "./pages/agent/employee.js";
import { replaySession } from "./pages/agent/sessions.js";
import { saveControls } from "./pages/agent/controls.js";
import { openImportModal } from "./pages/cases/import-modal.js";
import { openDeleteMissionModal, openPurgeModal } from "./components/delete-modals.js";
import { confirmModal } from "./components/modal.js";
import { openMissionModal } from "./pages/missions/add-modal.js";
import { openStudioModal } from "./pages/missions/studio.js";
import { download, toCsv } from "./lib/csv.js";

// ---- page chrome ----------------------------------------------------------------------------------------------------------------
export function chrome() {
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
let lastHtml = "";
let shownView = null; // the page fades in when it changes, not each time the same page is redrawn after a click
export function render() {
  if (!state.loaded) { shownView = null; lastHtml = ""; appView.innerHTML = `<div class="view-enter">${loadingState("Loading…", "Reading the latest data.")}</div>`; return; }
  if (state.error) { shownView = null; lastHtml = ""; appView.innerHTML = `<div class="view-enter">${empty("Could not load data", state.error, `<button class="button primary" data-action="refresh">Try again</button>`)}</div>`; bind(); return; }
  const views = { overview: renderOverview, cases: renderCases, campaigns: renderCampaigns, reviews: renderReviews, agent: renderAgent, approvals: renderApprovals, calls: renderCalls, missions: renderMission, audit: renderAudit };
  const off = state.controlsInfo?.controls.paused ? `<div class="agent-callout" style="border-color:#b64b48;margin-bottom:14px"><small>Switched off</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>Open Claude engine, then Controls, to switch it back on.</p></div>` : "";
  const enter = shownView === state.view ? "" : "view-enter";
  const html = `<div class="${enter}">${off}${views[state.view]()}</div>`;
  if (!enter && html === lastHtml) return; // nothing changed: leave the page alone instead of flashing it
  shownView = state.view; lastHtml = html;
  appView.innerHTML = html;
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
// ---- events -------------------------------------------------------------------------------------------------------------------------------------------
export function go(view) { state.view = view; chrome(); window.scrollTo({ top: 0 }); }
export function bindGo(root) { root.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", () => go(el.dataset.go))); }
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
  appView.querySelectorAll("[data-platform]").forEach(el => el.addEventListener("click", () => { state.platformShown = el.dataset.platform; render(); }));
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
export function action(name) {
  if (name === "refresh") { state.loaded = false; render(); loadAll(); }
  if (name === "import") openImportModal();
  if (name === "purge") openPurgeModal();
  if (name === "new-campaign") openCampaignModal();
  if (name === "add-employee") openEmployeeModal();
  if (name === "add-platform") openPlatformModal();
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
