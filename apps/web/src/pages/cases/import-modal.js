// The Add participants dialog: reading a CSV and importing it.
import { state } from "../../lib/state.js";
import { esc, plural } from "../../lib/format.js";
import { $, modal, modalBackdrop } from "../../lib/dom.js";
import { closeModal } from "../../components/modal.js";
import { api, loadAll } from "../../lib/api.js";

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
export function openImportModal() {
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
