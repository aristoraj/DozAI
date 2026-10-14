// Claude engine, Employee tab: the reusable AI worker and the Add version dialog.
import { state } from "../../lib/state.js";
import { api, loadAll } from "../../lib/api.js";
import { render } from "../../shell.js";
import { toast } from "../../components/toast.js";
import { esc, istDay, istTime, plural } from "../../lib/format.js";
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
// ---- the three layers: platform, employee, mission ------------------------------------------------------------------------------------
export function layerStrip() {
  const cur = state.platform?.current_version, e = state.employeeDef || state.employees.find(x => x.current);
  const m = state.missionShown ?? state.mission;
  const box = (n, title, line, tab) => `<button type="button" class="summary-box" style="text-align:left;cursor:pointer" ${tab ? `data-agent-tab="${tab}"` : `data-go="missions"`}><small>${n}. ${title}</small><strong>${esc(line)}</strong></button>`;
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:0 0 14px">${box(1, "Platform rules", cur || "PL-1.0.0", "platform")}${box(2, "Employee", e ? `${e.name} · ${e.version}` : "—", "employee")}${box(3, "Mission", m ? m.name : "—", "")}</div>
    <p class="muted t-xs" style="margin:-4px 0 14px">The agent is told the platform rules first, then the employee, then the mission. Each layer is saved in versions that never change, and each can be edited here or on the Mission page.</p>`;
}

// ---- the platform layer ---------------------------------------------------------------------------------------------------------------
export function renderPlatform() {
  const pl = state.platform;
  if (!pl) return loadingState("Loading the platform rules…", "Reading the current version.");
  const shown = pl.platform.find(p => p.version === (state.platformShown || pl.current_version)) || pl.platform[0];
  const versions = pl.platform.map(p => `<button class="review-item ${p.version === shown.version ? "active" : ""}" data-platform="${esc(p.version)}"><div class="review-item-top"><strong>${esc(p.version)}</strong><span class="status ${p.current ? "confirmed" : "not-started"}">${p.current ? "In force" : "Older"}</span></div><p>${p.builtin ? "Built in" : `${esc(istTime(p.created_at))} · ${esc(String(p.created_by || "").split(":")[1] || "")}`}${p.note ? ` · ${esc(p.note)}` : ""}</p></button>`).join("");
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Platform rules <small class="muted t-lg t-regular">${esc(shown.version)}</small></h2><p>The rules every employee works under, on every mission. Safety is also enforced by the system, whatever is written here.</p></div><span class="status ${shown.current ? "confirmed" : "not-started"}">${shown.current ? "In force" : "Older version"}</span></div>
      <div class="config-list">${longText("Rules the agent is given first", shown.rules)}${shown.note ? longText("What changed", shown.note) : ""}</div></section>
    <aside class="card config-section"><div class="card-head"><div><h2>Versions</h2><p>Saved versions never change</p></div>${pl.can_edit ? `<button class="button primary small" data-action="add-platform">Add a version</button>` : ""}</div>
      <div class="review-list">${versions}</div>
      <p class="muted t-xs">The newest version applies to every employee and every mission as soon as it is saved. Check the result under Employees, "What the agent is told", first.${pl.can_edit ? "" : " Only platform staff (administrators and agent operations) can add a version."}</p></aside>
  </div>`;
}

function nextVersionName(taken, prefix) {
  let best = [1, 0, 0];
  for (const v of taken) { const m = String(v).match(/(\d+)\.(\d+)\.(\d+)$/); if (m) { const t = [Number(m[1]), Number(m[2]), Number(m[3])]; if (t[0] > best[0] || (t[0] === best[0] && (t[1] > best[1] || (t[1] === best[1] && t[2] > best[2])))) best = t; } }
  return `${prefix}-${best[0]}.${best[1] + 1}.0`;
}

export function openPlatformModal() {
  const cur = state.platform.platform.find(p => p.current);
  const s = { version: nextVersionName(state.platform.platform.map(p => p.version), "PL"), rules: cur.rules, note: "", error: null, running: false };
  const draw = () => {
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Add a version of the platform rules</h2><p>Saved versions never change. The new one applies to every employee and every mission as soon as it is saved, so read it through before you save.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><div class="form-grid">
        <div class="field"><label for="plVersion">Version name</label><input id="plVersion" value="${esc(s.version)}" /></div>
        <div class="field"><label for="plNote">What changed <span class="opt">(optional)</span></label><input id="plNote" value="${esc(s.note)}" placeholder="Asked it to answer in the person's language" /></div>
        <div class="field full"><label for="plRules">Rules</label><small class="field-hint">Write them as instructions to the agent. They must say that it acts only through the tools it is given. Do not put names, numbers or anything about a person here.</small><textarea id="plRules" rows="14" spellcheck="false">${esc(s.rules)}</textarea></div>
        ${s.error ? `<p class="danger-text t-sm" style="grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></div>
      <div class="modal-foot"><button class="button ghost" id="cancelPl">Cancel</button><button class="button primary" id="savePl" data-busy-label="Saving…" ${s.running ? "disabled" : ""}>Save version</button></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelPl").addEventListener("click", closeModal);
    $("plVersion").addEventListener("input", e => { s.version = e.target.value; });
    $("plNote").addEventListener("input", e => { s.note = e.target.value; });
    $("plRules").addEventListener("input", e => { s.rules = e.target.value; });
    $("savePl").addEventListener("click", async () => {
      if (s.running) return;
      s.running = true; s.error = null; $("savePl").disabled = true;
      try {
        const body = { version: s.version.trim(), rules: s.rules }; if (s.note.trim()) body.note = s.note.trim();
        const out = await api("/platform", { method: "POST", body });
        closeModal(); state.platformShown = out.platform.version; await loadAll(); toast("Saved. Every employee and mission now uses these rules.", "success");
      } catch (e) { s.running = false; s.error = e.message; draw(); }
    });
  };
  draw(); modalBackdrop.hidden = false;
}

// ---- adding an employee, or a new version of one, with a form ---------------------------------------------------------------------------
// A starting point that is not tied to any one kind of mission: it works from the mission's own goal and questions.
const GENERIC_EMPLOYEE = {
  employee_id: "", version: "", name: "", purpose: "Work through one mission for each person: find out what the mission asks, using only approved wording and approved channels.",
  persona: "Polite, patient and brief. Plain words, short sentences. Treat every person's time and privacy as precious, and slow down if someone sounds worried.",
  instructions: "You work on one person's case at a time, for the mission you are given.\n- Read the case with case_get_context. It lists what is known and what is still missing.\n- The interview is run by the system using the mission's approved questions. You are woken when it finishes, or when the person is silent.\n- Judge only from the evidence: when it is clear and complete, call decision_propose with the finding that fits (one of the mission's findings), your honest confidence and the evidence you relied on.\n- If the evidence conflicts, the person may be someone else, or you are unsure, call review_request with a reason.\n- You cannot complete a case, record an opt-out or override a rule.",
  guardrails: ["Never reveal or guess personal details.", "Never promise anything on behalf of the organisation."],
  escalation_rules: ["The answers conflict with the record.", "The person is distressed or makes a complaint.", "The person asks for their data to be deleted."],
  memory_policy: "Remember only fixed facts about this person through memory_note. Never carry anything from one person's case to another's.",
  allowed_tools: ["case_get_context", "case_get_timeline", "decision_propose", "review_request", "memory_note"],
  model: { effort: "medium", max_turns: 12, budget_usd: 0.5 },
};

export function openEmployeeModal() {
  const base = state.employeeDef || state.employees[0];
  const tools = state.mission.tools;
  const lines = a => (a || []).join("\n");
  const fromDef = (d, mode) => ({
    mode, employee_id: d.employee_id || "", version: "", name: d.name || "", purpose: d.purpose || "", persona: d.persona || "", instructions: d.instructions || "",
    guardrails: lines(d.guardrails), escalation_rules: lines(d.escalation_rules), knowledge: (d.knowledge || []).map(k => `${k.title}: ${k.text}`).join("\n"), memory_policy: d.memory_policy || "",
    tools: new Set(d.allowed_tools || []), effort: d.model?.effort || "medium", max_turns: d.model?.max_turns ?? 12, budget_usd: d.model?.budget_usd ?? 0.5, model_name: d.model?.name || "",
  });
  const suggest = (mode, id) => nextVersionName(state.employees.filter(e => e.employee_id === id).map(e => e.version), id === "verification-employee" ? "VE" : (id || "EMP").split("-").map(w => w[0]).join("").toUpperCase().slice(0, 4) || "EMP");
  const s = { ...fromDef(base || GENERIC_EMPLOYEE, "version"), error: null, running: false };
  s.version = suggest("version", s.employee_id);
  const draw = () => {
    const isNew = s.mode === "new";
    modal.classList.add("modal-sticky");
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${isNew ? "Add a new employee" : "Add a version of " + esc(s.name || "an employee")}</h2><p>Saved versions never change. A mission that does not pin a version starts using the newest one straight away, so try the change on one mission first.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body"><fieldset class="studio-fields" ${s.running ? "disabled" : ""}><div class="form-grid">
        <div class="field"><label for="eMode">What are you adding?</label><select id="eMode"><option value="version" ${isNew ? "" : "selected"}>A new version of an existing employee</option><option value="new" ${isNew ? "selected" : ""}>A brand-new employee</option></select></div>
        <div class="field"><label for="eStart">Start from</label><select id="eStart">${state.employees.map(e => `<option value="v:${esc(e.version)}">${esc(e.name)} · ${esc(e.version)}</option>`).join("")}<option value="blank" ${isNew && s.fromBlank ? "selected" : ""}>A general-purpose starter (not tied to one kind of mission)</option></select></div>
        ${isNew ? `<div class="field"><label for="eId">Employee id</label><input id="eId" value="${esc(s.employee_id)}" placeholder="survey-worker" /><small class="field-hint">Lower-case letters, numbers and dashes. It cannot change later.</small></div>` : `<div class="field"><label for="eWho">Which employee</label><select id="eWho">${[...new Set(state.employees.map(e => e.employee_id))].map(id => `<option value="${esc(id)}" ${id === s.employee_id ? "selected" : ""}>${esc(state.employees.filter(e => e.employee_id === id).at(-1).name)} (${esc(id)})</option>`).join("")}</select></div>`}
        <div class="field"><label for="eVersion">Version name</label><input id="eVersion" value="${esc(s.version)}" /></div>
        <div class="field"><label for="eName">Name</label><input id="eName" value="${esc(s.name)}" placeholder="Meera" /></div>
        <div class="field full"><label for="ePurpose">What it is for</label><textarea id="ePurpose" rows="2">${esc(s.purpose)}</textarea></div>
        <div class="field full"><label for="ePersona">Tone and manner with people</label><textarea id="ePersona" rows="3">${esc(s.persona)}</textarea></div>
        <div class="field full"><label for="eInstr">How it works</label><small class="field-hint">The standing rules of the job, written as instructions to the employee.</small><textarea id="eInstr" rows="10">${esc(s.instructions)}</textarea></div>
        <div class="field full"><label for="eNever">Things it never does <span class="opt">(one per line)</span></label><textarea id="eNever" rows="3">${esc(s.guardrails)}</textarea></div>
        <div class="field full"><label for="eEsc">When it hands a case to a person <span class="opt">(one per line)</span></label><textarea id="eEsc" rows="3">${esc(s.escalation_rules)}</textarea></div>
        <div class="field full"><label for="eKnow">What it knows <span class="opt">(one item per line, as "Title: text")</span></label><textarea id="eKnow" rows="3">${esc(s.knowledge)}</textarea></div>
        <div class="field full"><label for="eMem">What it may remember between runs</label><textarea id="eMem" rows="2">${esc(s.memory_policy)}</textarea></div>
        <div class="field full"><label>Tools it may use</label><small class="field-hint">The system refuses any other tool, whatever the model asks for. It needs "case_get_context", and "decision_propose" or "review_request", to be able to finish a case.</small>
          <div class="tool-pick">${tools.map(t => `<label class="check-pill"><input type="checkbox" data-tool="${esc(t)}" ${s.tools.has(t) ? "checked" : ""}/> <span><code>${esc(t)}</code><small>${esc(TOOL_HELP[t]?.[1] || "")}</small></span></label>`).join("")}</div></div>
        <div class="field"><label for="eEffort">How hard it thinks</label><select id="eEffort">${["low", "medium", "high"].map(x => `<option ${x === s.effort ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        <div class="field"><label for="eTurns">Most steps in one run</label><input id="eTurns" type="number" min="2" max="30" value="${esc(s.max_turns)}" /></div>
        <div class="field"><label for="eBudget">Most one run may cost (US dollars)</label><input id="eBudget" type="number" min="0.05" max="5" step="0.05" value="${esc(s.budget_usd)}" /></div>
        <div class="field"><label for="eModel">Model <span class="opt">(leave empty for the platform's)</span></label><input id="eModel" value="${esc(s.model_name)}" /></div>
        ${s.error ? `<p class="danger-text t-sm" style="grid-column:1/-1;margin:0;white-space:pre-wrap">${esc(s.error)}</p>` : ""}
      </div></fieldset></div>
      <div class="modal-foot"><button class="button ghost" id="cancelE">Cancel</button><button class="button primary" id="saveE" data-busy-label="Saving…" ${s.running ? "disabled" : ""}>Save ${isNew ? "employee" : "version"}</button></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelE").addEventListener("click", closeModal);
    const keep = () => { // keep what was typed when the form is redrawn
      const v = id => $(id)?.value;
      Object.assign(s, { version: v("eVersion") ?? s.version, name: v("eName") ?? s.name, purpose: v("ePurpose") ?? s.purpose, persona: v("ePersona") ?? s.persona, instructions: v("eInstr") ?? s.instructions, guardrails: v("eNever") ?? s.guardrails, escalation_rules: v("eEsc") ?? s.escalation_rules, knowledge: v("eKnow") ?? s.knowledge, memory_policy: v("eMem") ?? s.memory_policy, effort: v("eEffort") ?? s.effort, max_turns: v("eTurns") ?? s.max_turns, budget_usd: v("eBudget") ?? s.budget_usd, model_name: v("eModel") ?? s.model_name });
      if ($("eId")) s.employee_id = $("eId").value;
      s.tools = new Set([...modal.querySelectorAll("[data-tool]")].filter(x => x.checked).map(x => x.dataset.tool));
    };
    $("eMode").addEventListener("change", e => { keep(); s.mode = e.target.value; if (s.mode === "new") { s.employee_id = ""; s.version = suggest("new", "emp"); } else { s.employee_id = base?.employee_id || "verification-employee"; s.version = suggest("version", s.employee_id); } draw(); });
    $("eWho")?.addEventListener("change", e => { keep(); s.employee_id = e.target.value; s.version = suggest("version", s.employee_id); draw(); });
    $("eStart").addEventListener("change", async e => {
      keep();
      const pick = e.target.value, mode = s.mode, id = s.employee_id;
      let d;
      if (pick === "blank") d = GENERIC_EMPLOYEE;
      else { try { d = (await api("/employees/" + encodeURIComponent(pick.slice(2)))).employee; } catch (err) { toast(err.message, "warning"); return; } }
      Object.assign(s, fromDef(d, mode), { employee_id: mode === "new" ? id : (d.employee_id || id), fromBlank: pick === "blank" });
      s.version = suggest(mode, s.employee_id); draw();
    });
    $("saveE").addEventListener("click", async () => {
      if (s.running) return;
      keep();
      const list = t => t.split("\n").map(x => x.trim()).filter(Boolean);
      const knowledge = [];
      for (const line of list(s.knowledge)) { const i = line.indexOf(":"); if (i < 1) { s.error = `"${line.slice(0, 40)}" needs a title, a colon and the text, like "Title: text".`; draw(); return; } knowledge.push({ title: line.slice(0, i).trim(), text: line.slice(i + 1).trim() }); }
      const body = { employee_id: s.employee_id.trim(), version: s.version.trim(), name: s.name.trim(), purpose: s.purpose.trim(), persona: s.persona.trim(), instructions: s.instructions.trim(), allowed_tools: [...s.tools], model: { effort: s.effort, max_turns: Number(s.max_turns), budget_usd: Number(s.budget_usd) } };
      if (s.model_name.trim()) body.model.name = s.model_name.trim();
      if (list(s.guardrails).length) body.guardrails = list(s.guardrails);
      if (list(s.escalation_rules).length) body.escalation_rules = list(s.escalation_rules);
      if (knowledge.length) body.knowledge = knowledge;
      if (s.memory_policy.trim()) body.memory_policy = s.memory_policy.trim();
      s.running = true; s.error = null; draw();
      try {
        const out = await api("/employees", { method: "POST", body });
        modal.classList.remove("modal-sticky"); closeModal(); state.employeeDef = null; await loadAll(); await showEmployee(out.employee.version);
        toast(s.mode === "new" ? "Employee saved. Pick it when you create a mission." : "Version saved. Missions that follow the newest version use it now.", "success");
      } catch (e) { s.running = false; s.error = e.message; draw(); }
    });
  };
  draw(); modalBackdrop.hidden = false;
}
