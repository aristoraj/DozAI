// Pieces every page uses: the page header, the empty state, and status pills.
import { esc } from "../lib/format.js";

export const STATUS_LABEL = { review: "Needs review", confirmed: "Confirmed", progress: "In progress", "not-confirmed": "Not confirmed", inconclusive: "Inconclusive", "not-started": "Not started", "opted-out": "Opted out" };
export const statusPill = s => `<span class="status ${s}">${esc(STATUS_LABEL[s] || s)}</span>`;
// A case's status in plain words (where it is in the process), coloured by how it stands. The result, what was found out, is a separate column.
export const casePill = c => `<span class="status ${c.status}">${esc(c.status_label || STATUS_LABEL[c.status] || c.status)}</span>`;
export function pageHead(eyebrow, title, text, actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div><div class="page-actions">${actions}</div></div>`;
}
export const empty = (title, text, action = "") => `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
