// Audit trail page.
import { state } from "../lib/state.js";
import { empty, pageHead } from "../components/page.js";
import { esc } from "../lib/format.js";

// ---- audit -------------------------------------------------------------------------------------------------------------------------------------
export function renderAudit() {
  const q = state.auditSearch.toLowerCase();
  const actorOf = a => (a.actor === "Claude agent" ? "agent" : /^(admin|operator|reviewer|agent_ops)/.test(a.actor) ? "human" : ["interakt", "whatsapp", "voice"].includes(a.actor) ? "channel" : "system");
  const list = state.audits.filter(a => (state.auditActor === "all" || actorOf(a) === state.auditActor) && `${a.action} ${a.detail} ${a.actor}`.toLowerCase().includes(q));
  return `${pageHead("Audit trail", "Every change has an actor and a reason.", "A tamper-evident record of what the system, the agent and people did. Deleted cases remain only as anonymous entries.", `<button class="button ghost" data-action="verify-ledger" data-busy-label="Verifying…">Verify integrity</button><button class="button primary" data-action="export-audit">Export CSV</button>`)}
    <div class="audit-toolbar"><label class="search-box"><input id="auditSearch" value="${esc(state.auditSearch)}" placeholder="Search events" aria-label="Search audit events" /></label>
      <select class="filter-select" id="auditActor">${[["all", "All actors"], ["human", "People"], ["agent", "Agent"], ["system", "System"], ["channel", "WhatsApp"]].map(([v, l]) => `<option value="${v}" ${state.auditActor === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <section class="card audit-list">${list.map(a => `<div class="audit-row"><span class="audit-time"><strong>${esc(a.time)}</strong><small>${esc(a.date)}</small></span><span class="event-dot ${a.tone === "coral" ? "coral" : ""}">${esc(a.icon)}</span><span class="audit-action"><strong>${esc(a.action)}</strong><small>${esc(a.detail)}</small></span><span class="actor-pill"><span>${esc(a.actorCode)}</span>${esc(a.actor)}</span><span class="hash">${esc(a.hash)}</span></div>`).join("") || empty("No events", state.audits.length ? "Nothing matches the search." : "Events appear here as the system works.")}</section>`;
}
