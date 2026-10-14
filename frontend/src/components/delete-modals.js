// The dialogs that delete a mission, a case, or all data. Each asks for the exact name first.
import { state } from "../lib/state.js";
import { $, modal, modalBackdrop } from "../lib/dom.js";
import { esc, plural } from "../lib/format.js";
import { closeModal } from "./modal.js";
import { act, api, loadAll } from "../lib/api.js";
import { toast } from "./toast.js";
import { closeDrawer } from "./case-drawer.js";

// ---- delete case -----------------------------------------------------------------------------------------------------------------------------------
export function openDeleteMissionModal(m) {
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
export function openDeleteModal(c) {
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
export function openPurgeModal() {
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
