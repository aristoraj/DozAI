// Add from JSON dialog (for developers).
import { state } from "../../lib/state.js";
import { $, modal, modalBackdrop } from "../../lib/dom.js";
import { esc } from "../../lib/format.js";
import { closeModal } from "../../components/modal.js";
import { api, loadAll } from "../../lib/api.js";
import { toast } from "../../components/toast.js";

// ---- add a mission (administrators) -----------------------------------------------------------------------------------------------------
/** Options for choosing an employee: follow one (its newest version) or pin one exact version. */
export function employeeChoices(selected) {
  const ids = [...new Set(state.employees.map(e => e.employee_id))];
  return ids.map(id => {
    const mine = state.employees.filter(e => e.employee_id === id), cur = mine.at(-1);
    return `<optgroup label="${esc(cur.name)} (${esc(id)})"><option value="${esc(id)}" ${selected === id ? "selected" : ""}>Follow ${esc(cur.name)}: always the newest version</option>${mine.map(e => `<option value="${esc(id)}|${esc(e.version)}" ${selected === id + "|" + e.version ? "selected" : ""}>Pin ${esc(e.version)}</option>`).join("")}</optgroup>`;
  }).join("");
}

export function openMissionModal(prefill) {
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
