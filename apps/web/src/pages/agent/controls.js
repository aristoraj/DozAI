// Claude engine, Controls tab: the autonomy dial, the kill switch and the limits.
import { state } from "../../lib/state.js";
import { loadingState } from "../../components/busy.js";
import { esc, istTime, plural } from "../../lib/format.js";
import { act, api } from "../../lib/api.js";

// ---- approvals and controls: a person's say over what the agent does -------------------------------------------------------------------
const ACTION_NOTE = { message_template: "Approved wording, chosen by the agent", message_scripted: "The interview's own questions, in approved wording", message_free: "Text the agent writes itself (not used yet)", voice_call: "The agent asks for a call; the voice agent then speaks" };
export function renderControls() {
  const k = state.controlsInfo;
  if (!k) return loadingState("Loading the controls…", "Reading the current settings.");
  const c = k.controls, canChange = k.can_change, stat = Object.fromEntries(k.stats.map(s => [s.kind, s]));
  const dial = k.actions.map(a => { const s = stat[a.kind]; return `<tr><td><strong>${esc(a.label)}</strong><small style="display:block;color:var(--muted)">${esc(ACTION_NOTE[a.kind])}</small></td>
    <td><select class="filter-select" data-dial="${esc(a.kind)}" ${canChange ? "" : "disabled"} aria-label="${esc(a.label)}"><option value="approve_first" ${c.autonomy[a.kind] === "approve_first" ? "selected" : ""}>A person approves first</option><option value="automatic" ${c.autonomy[a.kind] === "automatic" ? "selected" : ""}>Automatic</option></select></td>
    <td class="t-sm">${s.approved} approved, ${s.rejected} declined${s.held ? `, ${s.held} waiting` : ""}${s.suggest_automatic ? `<small style="display:block;color:var(--sys)">Ten approvals and no refusals: this could safely go automatic.</small>` : ""}</td></tr>`; }).join("");
  const sw = c.paused
    ? `<div class="agent-callout" style="border-color:#b64b48"><small>Switched off${c.paused_by ? " by " + esc(c.paused_by) : ""}${c.paused_at ? " at " + esc(istTime(c.paused_at)) : ""}</small><h3>Nothing is being sent or placed, and the agent is not being woken.</h3><p>${c.paused_reason ? esc(c.paused_reason) + ". " : ""}Replies are still recorded. ${plural(k.queued_unsent, "message")} and calls are queued and will go out when you switch it back on.</p>${k.can_pause ? `<button class="button primary small" data-action="resume-platform">Switch back on</button>` : ""}</div>`
    : `<div class="agent-callout"><small>Running normally</small><h3>The kill switch stops everything at once.</h3><p>No message is sent, no call is placed, no campaign queues and the agent is not woken. Replies are still recorded. Use it if something wrong is going out.</p>${k.can_pause ? `<button class="button coral small" data-action="pause-platform">Switch everything off</button>` : ""}</div>`;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Autonomy dial</h2><p>What the agent may do on its own, and what waits for a person</p></div><span class="status ${k.held ? "review" : "active"}">${k.held} waiting</span></div>
      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Rule</th><th>So far</th></tr></thead><tbody>${dial}</tbody></table></div>
      ${canChange ? "" : `<p class="muted t-xs">Only administrators and agent operations can change the dial and the limits.</p>`}</section>
    <aside class="card config-section"><div class="card-head"><div><h2>Kill switch</h2><p>Stop everything now</p></div></div>${sw}</aside></div>
    <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Limits</h2><p>The agent stops, and a person is asked, when a limit is reached. 0 means no limit.</p></div><span class="status active">$${k.spend_24h.toFixed(2)} in the last 24 hours</span></div>
      <div class="form-grid">
        <div class="field"><label for="limDaily">Most the agent may spend in 24 hours (USD)</label><input id="limDaily" type="number" min="0" step="0.5" value="${esc(c.daily_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limCase">Most on one case, in total (USD)</label><input id="limCase" type="number" min="0" step="0.1" value="${esc(c.case_budget_usd)}" ${canChange ? "" : "disabled"} /></div>
        <div class="field"><label for="limWakes">Most wake-ups on one case</label><input id="limWakes" type="number" min="1" step="1" value="${esc(c.max_wakes_per_case)}" ${canChange ? "" : "disabled"} /></div>
      </div>
      ${canChange ? `<div style="margin-top:10px"><button class="button primary small" data-action="save-limits" data-busy-label="Saving…">Save limits</button></div>` : ""}
      <small class="muted t-xs" style="display:block;margin-top:8px">Amounts use indicative prices. ${plural(k.pending_wakes, "wake-up")} are set for later.${c.updated_by ? ` Last changed by ${esc(c.updated_by)}.` : ""}</small></section>`;
}
export async function saveControls(patch, okMessage) { await act(() => api("/controls", { method: "POST", body: patch }), okMessage); }
