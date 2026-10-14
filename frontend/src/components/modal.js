// The dialog: a confirm dialog that stays open while it works, and closing any dialog.
import { $, modal, modalBackdrop } from "../lib/dom.js";
import { esc } from "../lib/format.js";

// The dialog stays open while the work runs, with the button saying so ("Signing off…"), and closes when it is done, worked or not.
export function confirmModal({ title, text, button, danger, busy: busyLabel = "Working…", onConfirm }) {
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
export function closeModal() { modalBackdrop.hidden = true; modal.classList.remove("modal-sticky"); modal.innerHTML = ""; /* pasted rows and names must not linger in the page */ }
