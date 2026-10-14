// Approvals page: things the agent proposed that wait for a person.
import { can, state } from "../lib/state.js";
import { esc, istDay, istTime } from "../lib/format.js";
import { empty, pageHead } from "../components/page.js";
import { act, api } from "../lib/api.js";
import { toast } from "../components/toast.js";

const approvalState = s => ({ held: ["review", "Waiting for a person"], approved: ["confirmed", "Approved"], rejected: ["not-confirmed", "Declined"] }[s] || ["progress", s]);
export function renderApprovals() {
  const list = state.approvals, waiting = list.filter(a => a.state === "held"), done = list.filter(a => a.state !== "held");
  const canDecide = can("approve");
  const row = a => `<tr><td><strong>${esc(a.participant)}</strong><small style="display:block;color:var(--muted)">${esc(a.case_id)}</small></td><td>${esc(a.label)}</td><td class="t-sm" style="max-width:420px">${esc(a.summary)}</td><td>${esc(istDay(a.held_at))} ${esc(istTime(a.held_at))}</td>
    <td>${a.state === "held" ? (canDecide ? `<div style="display:flex;gap:6px"><button class="button primary small" data-approve="${esc(a.outbox_id)}" data-busy-label="Approving…">Approve</button><button class="button ghost small" data-reject="${esc(a.outbox_id)}" data-busy-label="Declining…">Decline</button></div>` : `<small style="color:var(--muted)">Only reviewers, administrators and agent operations can decide.</small>`) : `<span class="status ${approvalState(a.state)[0]}">${esc(approvalState(a.state)[1])}</span><small style="display:block;color:var(--muted)">${esc(a.decided_by || "")} ${a.decided_at ? esc(istTime(a.decided_at)) : ""}${a.note ? " · " + esc(a.note) : ""}</small>`}</td></tr>`;
  const table = rows => `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Person</th><th>What</th><th>Details</th><th>Proposed</th><th></th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;
  return `${pageHead("Approvals", "A person says yes first.", "Some things the agent proposes are held until someone approves them. Nothing here is sent or placed until you do. You choose which kinds of action need this on the Controls tab of the Claude engine page.")}
    <section class="card card-pad"><div class="card-head"><div><h2>Waiting for you</h2><p>Approve to release it, or decline to stop it and send the case to a person</p></div><span class="status ${waiting.length ? "review" : "confirmed"}">${waiting.length}</span></div>
      ${waiting.length ? table(waiting) : empty("Nothing is waiting", "When the agent proposes something that needs a person's approval, it appears here.")}</section>
    ${done.length ? `<section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Decided</h2><p>The most recent decisions</p></div></div>${table(done.slice(0, 30))}</section>` : ""}`;
}
export async function decideApproval(id, decision) {
  await act(() => api(`/approvals/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: {} }), null).then(out => { if (!out) return; toast(decision === "reject" ? "Declined. The case was sent to a person." : out.call ? (out.call.placed ? "Approved. Calling now." : `Approved, but the call could not be placed: ${out.call.error ?? "unknown reason"}.`) : "Approved. It goes out on the next scheduler pass.", out.call && !out.call.placed ? "warning" : "success"); });
}
