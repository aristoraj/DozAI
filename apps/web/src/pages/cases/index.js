// Cases page: the list, search, filter and export.
import { can, state } from "../../lib/state.js";
import { casePill, empty, pageHead } from "../../components/page.js";
import { colorFor, esc, initials } from "../../lib/format.js";

// ---- cases ---------------------------------------------------------------------------------------------------------------------------------
export function filteredCases() {
  const q = state.caseSearch.toLowerCase();
  return state.cases.filter(c => (state.caseFilter === "all" || c.status === state.caseFilter) && `${c.name} ${c.id} ${c.location} ${c.cohort}`.toLowerCase().includes(q));
}
export function renderCases() {
  const list = filteredCases();
  const actions = `${state.me?.can_purge && can("admin") ? `<button class="button ghost" data-action="purge" style="color:#b64b48;border-color:#b64b48">Delete ALL data…</button>` : ""}${can("admin") ? `<button class="button ghost" data-action="check-replies" data-busy-label="Checking…">Check for replies</button>` : ""}<button class="button ghost" data-action="export-cases">Export CSV</button>${can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : ""}`;
  const options = [["all", "All statuses"], ["review", "Needs review"], ["progress", "In progress"], ["not-started", "Not started"], ["confirmed", "Confirmed"], ["not-confirmed", "Not confirmed"], ["inconclusive", "Inconclusive"], ["opted-out", "Opted out"]];
  return `${pageHead("Cases", "Every participant has one accountable case.", "The current state, the evidence behind it, and the next permitted action.", actions)}
    <section class="card table-card">
      <div class="table-toolbar"><div class="filters"><label class="search-box"><input id="caseSearch" value="${esc(state.caseSearch)}" placeholder="Search name, case or place" aria-label="Search cases" /></label>
      <select class="filter-select" id="caseFilter">${options.map(([v, l]) => `<option value="${v}" ${state.caseFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <span class="t-xs muted">${list.length} of ${state.cases.length}</span></div>
      ${state.cases.length === 0 ? empty("No cases yet", can("intake") ? "Add participants to create their cases." : "No participants have been loaded.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")
        : list.length === 0 ? empty("No cases match", "Change the search or the status filter.")
        : `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Participant</th><th>Status</th><th>Result</th><th>Confidence</th><th>Last activity</th><th></th></tr></thead><tbody>${list.map(caseRow).join("")}</tbody></table></div>`}
    </section>`;
}
const caseRow = c => `<tr data-case="${esc(c.id)}" style="cursor:pointer"><td><div class="participant-cell"><span class="mini-avatar" style="background:${colorFor(c.id)}">${esc(initials(c.name))}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.id)} · ${esc(c.location)}</small></span></div></td><td>${casePill(c)}</td><td><strong class="t-sm">${esc(c.outcome)}</strong>${c.outcome_note ? `<div class="muted t-xs" style="margin-top:3px">${esc(c.outcome_note)}</div>` : ""}</td><td><div class="confidence"><div class="confidence-bar"><span style="width:${c.confidence}%"></span></div><span>${c.confidence}%</span></div></td><td style="color:var(--muted)">${esc(c.lastTouch)}</td><td><button class="row-action" data-case="${esc(c.id)}" aria-label="Open ${esc(c.name)}">›</button></td></tr>`;
