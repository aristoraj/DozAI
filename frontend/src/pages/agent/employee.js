// Claude engine, Employee tab: the reusable AI worker and the Add version dialog.
import { state } from "../../lib/state.js";
import { api, loadAll } from "../../lib/api.js";
import { render } from "../../shell.js";
import { toast } from "../../components/toast.js";
import { esc, istDay, plural } from "../../lib/format.js";
import { loadingState } from "../../components/busy.js";
import { TOOL_HELP, configRow } from "./index.js";
import { $, modal, modalBackdrop } from "../../lib/dom.js";
import { closeModal } from "../../components/modal.js";

// ---- the employee: the reusable AI worker above every mission ------------------------------------------------------------------
export async function showEmployee(version) {
  try {
    state.employeeShown = version;
    state.employeeDef = (await api("/employees/" + encodeURIComponent(version))).employee;
    state.ctxPreview = null;
    render();
  } catch (e) { toast(e.message, "warning"); }
}
export async function showContext(missionVersion) {
  try { state.ctxPreview = await api("/employees/" + encodeURIComponent(state.employeeShown) + "/context?mission_version=" + encodeURIComponent(missionVersion)); render(); }
  catch (e) { toast(e.message, "warning"); }
}
const longText = (label, text) => `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><p style="white-space:pre-wrap;margin:0">${esc(text)}</p></span></div>`;
const listText = (label, items) => (items && items.length ? `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><ul style="margin:0;padding-left:18px">${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></span></div>` : "");
export function renderEmployee() {
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
export function openEmployeeModal() {
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
