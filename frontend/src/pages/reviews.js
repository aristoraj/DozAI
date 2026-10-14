// Review queue page and the decision buttons.
import { can, state } from "../lib/state.js";
import { empty, pageHead, statusPill } from "../components/page.js";
import { esc, plural } from "../lib/format.js";
import { $ } from "../lib/dom.js";
import { act, api } from "../lib/api.js";

// ---- review ------------------------------------------------------------------------------------------------------------------------------------
export function renderReviews() {
  const reviews = state.cases.filter(c => c.status === "review");
  if (!reviews.find(c => c.id === state.reviewSelected) && reviews[0]) state.reviewSelected = reviews[0].id;
  const active = reviews.find(c => c.id === state.reviewSelected);
  return `${pageHead("Human review", "Judgment where it matters.", "The agent gathers evidence and proposes an outcome. A person decides whenever policy or confidence requires it.")}
    <section class="card review-layout">
      <div class="review-list"><div class="review-list-head"><strong>Queue</strong><small>${plural(reviews.length, "case")} to decide</small></div>${reviews.map(c => `<button class="review-item ${c.id === state.reviewSelected ? "active" : ""}" data-review="${esc(c.id)}"><div class="review-item-top"><strong>${esc(c.name)}</strong><span class="t-xs muted">${esc(c.id)}</span></div><p>${esc(c.reason)}</p></button>`).join("") || empty("Queue is clear", "Nothing is waiting for a decision.")}</div>
      <div class="review-content">${active ? reviewDetail(active) : empty("Nothing waiting for review", "Cases that need a person appear here automatically.")}</div>
    </section>`;
}
function reviewDetail(c) {
  return `<div class="review-title"><div><div class="eyebrow">Decision required</div><h2>${esc(c.name)}</h2><p>${esc(c.id)} · ${esc(c.cohort)} · ${esc(c.location)}</p></div>${statusPill(c.status)}</div>
    <div class="evidence-grid">
      <div class="evidence-card"><small>Current reading</small><strong>${esc(c.outcome)}</strong><p>Proposed by the agent.</p></div>
      <div class="evidence-card flagged"><small>Programme record</small><strong>${esc(c.recorded_employer)}</strong><p>What the programme has on file.</p></div>
      <div class="evidence-card"><small>Reported employer</small><strong>${esc(c.employer)}</strong><p>From the participant's reply.</p></div>
      <div class="evidence-card"><small>Confidence</small><strong>${c.confidence}%</strong><p>Auto-confirm needs ${Math.round(state.mission.policy.auto_confirm_at * 100)}% and no conflict.</p></div></div>
    <div style="margin:14px 0"><h3 class="t-md" style="margin:0 0 6px">Conversation</h3><div id="reviewConv"></div></div>
    <div class="agent-callout"><small>Why this needs a person</small><h3>${esc(c.reason)}</h3><p>The agent's recommendation is not a final decision.</p></div>
    ${can("review") ? `<div class="review-notes"><label for="reviewNotes">Note (kept with the decision, removed if the case is deleted)</label><textarea id="reviewNotes" placeholder="Why did you decide this?"></textarea></div>
    <div class="decision-bar"><button class="button ghost" data-decision="inconclusive" data-id="${esc(c.id)}">Mark inconclusive</button><button class="button coral" data-decision="followup" data-id="${esc(c.id)}">Request follow-up</button><button class="button ghost" data-decision="not_confirm" data-id="${esc(c.id)}">Not confirmed</button><button class="button primary" data-decision="confirm" data-id="${esc(c.id)}">Confirm outcome</button></div>`
      : `<p class="muted t-sm">Only reviewers and administrators can decide.</p>`}`;
}
export async function decide(id, decision) {
  const c = state.cases.find(x => x.id === id);
  if (!c) return;
  const note = $("reviewNotes")?.value.trim() ?? "";
  await act(() => api(`/cases/${id}/review`, { method: "POST", body: { decision, note, expected_version: c.version } }), "Decision recorded in the audit trail");
}
