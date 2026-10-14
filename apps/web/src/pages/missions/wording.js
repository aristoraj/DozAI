// Mission page, Questionnaire wording card: the question editor and sign-off.
import { esc, istDay } from "../../lib/format.js";
import { can, state } from "../../lib/state.js";
import { loadingLine } from "../../components/busy.js";
import { render } from "../../shell.js";
import { api } from "../../lib/api.js";
import { createQuestionEditor } from "../../components/question-editor.js";
import { toast } from "../../components/toast.js";

// ---- mission (read only) ---------------------------------------------------------------------------------------------------------------
// ---- the questionnaire wording: read it, and sign it off --------------------------------------------------------------------------------
// Everything a participant will be sent, in the order they will see it. Reading it here is what a sign-off is based on.
// The messages that are not questions: the fixed replies and the answers to common questions. Read only, folded away.
export function wordingHtml(ins) {
  const fixed = [["Opening after they agree", ins.start_message], ["Closing", ins.closing_message], ["When we could not understand", ins.reask_prefix], ["When they hand over to a person", ins.handover_message], ["Wrong person", ins.wrong_person_message], ["Someone in distress", ins.distress_message], ["Asking for data to be deleted", ins.deletion_message], ["Not a text message", ins.unsupported_prefix]];
  return `<details class="q-more" style="margin-top:14px"><summary class="t-sm" style="cursor:pointer"><strong>Fixed messages and answers to common questions</strong> (${fixed.length} messages, ${ins.faq.length} answers)</summary>
    <h3 class="t-md" style="margin:14px 0 4px">Fixed messages</h3><div class="check-list">${fixed.map(([t, v]) => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(t)}</strong><small>${esc(v)}</small></span></div>`).join("")}</div>
    <h3 class="t-md" style="margin:14px 0 4px">Answers to common questions (${ins.faq.length})</h3><div class="check-list">${ins.faq.map(f => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(f.keywords.join(", "))}</strong><small>${esc(f.answer)}</small></span></div>`).join("")}</div></details>`;
}
export function wordingCard(m) {
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
export async function loadWording(version) {
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
export function syncSignOff() {
  const b = document.querySelector('[data-action="sign-off"]'), ed = state.qeditor;
  if (!b || !ed) return;
  const why = ed.isBusy() ? "Save or cancel the question you are editing first." : !ed.isChecked() ? "Checking the questions…" : ed.problems().length ? "Fix the problems listed above first." : "";
  b.disabled = !!why; b.title = why;
  b.textContent = ed.isChanged() ? "Sign off with my changes" : "Sign off this wording";
}
