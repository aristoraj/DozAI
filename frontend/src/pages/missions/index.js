// Mission page: the overview cards, what to find out, results, and the phone form.
import { esc, istDay, istTime, plural } from "../../lib/format.js";
import { can, state } from "../../lib/state.js";
import { api } from "../../lib/api.js";
import { render } from "../../shell.js";
import { toast } from "../../components/toast.js";
import { pageHead } from "../../components/page.js";
import { wordingCard } from "./wording.js";

// The evidence a mission needs: the checklist the employee works through for every person.
// What a mission can conclude about a person, in its own words: the findings, and what the three general results mean here.
export function resultsHtml(outcomes, verdictLabels) {
  const found = (outcomes || []).map(o => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(o.label)}</strong><small>${esc(o.description || "")}</small></span></div>`).join("");
  const v = verdictLabels || {};
  const means = `Confirmed: ${esc(v.confirmed || "confirmed")}. Not confirmed: ${esc(v.not_confirmed || "not confirmed")}. Inconclusive: ${esc(v.inconclusive || "inconclusive")}.`;
  return `<div class="check-list">${found || '<p class="muted t-sm">This mission does not list its own findings, so the original job findings apply.</p>'}</div><p class="muted t-sm" style="margin:8px 0 0">${means}</p>`;
}
function resultsCard(m) {
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Results this mission can end with</h2><p>What the employee can conclude about each person. The cases list shows these, in these words</p></div><span class="status active">${(m.outcomes || []).length}</span></div>${resultsHtml(m.outcomes, m.verdict_labels)}</section>`;
}
function needsCard(m) {
  const rs = m.requirements || [];
  const label = k => rs.find(r => r.key === k)?.label || k;
  const body = rs.length ? rs.map(r => `<div class="check-item"><span class="check-mark">${r.required ? "●" : "○"}</span><span><strong>${esc(r.label)}</strong><small>${r.required ? "Required" : "Optional"}, counts at ${Math.round(r.min_confidence * 100)}% sure or more${r.when ? `, only if ${esc(label(r.when.key).toLowerCase())} is ${esc(r.when.in.map(v => v.replace(/_/g, " ")).join(" or "))}` : ""}${r.checked_against ? ", checked against the programme record" : ""}.${r.hint ? " " + esc(r.hint) : ""}</small></span></div>`).join("") : `<p class="muted t-sm">This mission does not list what it needs to know. Add evidence_requirements so the employee can tell what is still missing for each person.</p>`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>What the employee must find out</h2><p>For each person, the employee works until these are known, choosing the easiest way to ask</p></div><span class="status ${rs.length ? "active" : "progress"}">${rs.length}</span></div><div class="check-list">${body}</div></section>`;
}
// The phone form: what the voice provider is told for this mission, and whether what is published is still current.
function voiceCard(m) {
  const off = state.me?.voice === "off";
  const v = state.voiceFormFor === m.version ? state.voiceForm : null;
  const status = !v ? "" : v.link ? (v.in_sync ? `<span class="status confirmed">Published and current</span>` : `<span class="status review">Out of date</span>`) : `<span class="status progress">Not published</span>`;
  const note = !v ? "" : v.link ? `<p class="t-sm" style="margin:8px 0">Published as form ${esc(v.link.form_id)} on ${esc(istDay(v.link.published_at))} ${esc(istTime(v.link.published_at))} by ${esc(v.link.published_by)}.${v.in_sync ? "" : " The mission or the employee has changed since, so the voice agent is working from older instructions. Publish again to update it."}</p>` : `<p class="t-sm" style="margin:8px 0">Nothing is published yet, so the agent cannot ask for a phone call on this mission.</p>`;
  const fields = !v ? "" : `<details style="margin-top:8px"><summary class="t-sm" style="cursor:pointer"><strong>What the voice agent is told</strong> (instructions and ${v.definition.form_fields.length} fields)</summary><pre class="mono t-xs" style="white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0">${esc(v.definition.start_message + "\n\n" + v.definition.form_context)}</pre>
    <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Field</th><th>Type</th><th>What it asks</th></tr></thead><tbody>${v.definition.form_fields.map(f => `<tr><td><code>${esc(f.field_id)}</code><small style="display:block;color:var(--muted)">${esc(f.field_name)}</small></td><td>${esc(f.datatype)}</td><td class="t-xs">${esc(f.additional_info)}</td></tr>`).join("")}</tbody></table></div></details>`;
  const buttons = off ? "" : `<button class="button ghost small" data-action="voice-preview" data-busy-label="Loading…">${v ? "Refresh the preview" : "Preview the phone form"}</button>${v && state.employeeCanEdit ? (state.voicePublishing ? `<button class="button primary small" disabled>Publishing… this can take a minute</button>` : v.link && v.in_sync ? "" : `<button class="button primary small" data-action="voice-publish">${v.link ? "Update at ZoLabs" : "Create at ZoLabs"}</button>`) : ""}`;
  return `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Phone calls (ZoLabs)</h2><p>The form the voice agent follows for this mission. A person publishes it; the agent only asks for calls.</p></div>${status}</div>
    ${off ? `<p class="muted t-sm">Phone calls are not switched on for this platform yet.</p>` : `${note}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${buttons}</div>${fields}`}
    ${state.me?.voice === "simulated" ? `<small class="muted t-xs" style="display:block;margin-top:8px">Simulator: nobody is rung. Use the case page to finish a call yourself.</small>` : ""}</section>`;
}
export async function loadVoiceForm(version) {
  try { state.voiceForm = await api("/missions/" + encodeURIComponent(version) + "/voice-form"); state.voiceFormFor = version; render(); }
  catch (e) { toast(e.message, "warning"); }
}
export function renderMission() {
  const m = state.missionShown ?? state.mission, r = m.runtime;
  const picker = `<select class="filter-select" id="missionPick" aria-label="Choose a mission">${state.missions.map(x => `<option value="${esc(x.version)}" ${x.version === m.version ? "selected" : ""}>${esc(x.name)} · ${esc(x.version)} (${plural(x.participants, "participant")})</option>`).join("")}</select>`;
  const actions = `${picker}${can("admin") ? `<button class="button primary" data-action="new-mission">Create a mission</button><button class="button ghost" data-action="add-mission">Add from JSON</button>${m.builtin ? "" : `<button class="button ghost" data-action="delete-mission" style="color:#b64b48;border-color:#b64b48">Delete this mission</button>`}` : ""}`;
  const detail = `<section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Set up for this client</h2><p>What changes from one mission to the next</p></div>${m.builtin ? `<span class="status not-started">Built in</span>` : `<span class="status confirmed">Saved version</span>`}</div>
      <div class="check-list">
        ${m.employee ? `<div class="check-item"><span class="check-mark">☺</span><span><strong>Done by</strong><small>${esc(m.employee.name)}, ${esc(m.employee.version)} (${m.employee.pinned ? "this exact version" : "follows the current version"}). Open the Employee tab on the Claude engine page to see what it is told.</small></span></div>` : ""}
        ${m.objective ? `<div class="check-item"><span class="check-mark">◎</span><span><strong>Goal</strong><small>${esc(m.objective)}</small></span></div>` : ""}
        ${m.strategy ? `<div class="check-item"><span class="check-mark">↗</span><span><strong>Suggested approach</strong><small>Channels in order: ${m.strategy.channels.map(c => c === "voice" ? "phone call" : "WhatsApp").join(", then ")}. Follow up after about ${m.strategy.follow_up_after_hours} hours of silence.${m.strategy.notes ? " " + esc(m.strategy.notes) : ""} These are hints: the employee may deviate inside the safety rules.</small></span></div>` : ""}
        <div class="check-item"><span class="check-mark">·</span><span><strong>First message</strong><small>${esc(m.intro_template)}${m.programme_name ? ` · programme name "${esc(m.programme_name)}"` : ""}</small></span></div>
        ${m.templates.map(t => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(t.key)}</strong><small>${esc(t.purpose)} · ${esc(t.language)} · WhatsApp template: ${t.provider_name ? esc(t.provider_name) : "<b>not set</b>"}</small></span></div>`).join("")}
        <div class="check-item"><span class="check-mark">·</span><span><strong>Agent working notes</strong><small>${m.agent_guidance ? esc(m.agent_guidance) : "None. The agent follows the standard rules only."}</small></span></div>
        ${m.created_at ? `<div class="check-item"><span class="check-mark">·</span><span><strong>Added</strong><small>${esc(istDay(m.created_at))} ${esc(istTime(m.created_at))} by ${esc(m.created_by)}. Saved missions never change: a change is a new version.</small></span></div>` : ""}
      </div></section>`;
  const checks = [
    [m.instrument_signed_off, "Questionnaire wording signed off", m.instrument_signed_off ? "Approved" : `${m.questions_total} question slots exist but the wording is not approved yet`],
    [r.whatsapp === "live", "WhatsApp sending", r.whatsapp === "live" ? "On, to participants who have consented" : "Off. Replies are simulated"],
    [!m.instrument.draft, "Interview questions approved", m.instrument.draft ? `${m.instrument.questions} draft questions. ${r.draft_instrument_allowed ? "Allowed for testing only" : "Blocked for real conversations until approved"}` : "Approved"],
    [m.templates.length > 0, "Approved message template", m.templates.map(t => t.key).join(", ") || "None configured"],
    [state.cases.length > 0, "Participants loaded", state.cases.length ? plural(state.cases.length, "participant") : "None yet"],
    [r.agent === "claude", "Claude agent", r.agent === "claude" ? `Running ${r.model}` : "Scripted stand-in is running (no model key)"],
  ];
  return `${pageHead("Mission", m.name, "Each client or programme has its own mission: first message, questions, contact rules and agent notes. New participants join the most recently added one unless you choose.", actions)}
    <section class="card mission-hero"><div class="mission-meta"><span class="mission-icon">↗</span><div><h2>${esc(m.name)}</h2><p>${esc(m.mission_id)} · ${esc(m.version)}</p></div></div>
      <div class="mission-stats"><div class="mission-stat"><strong>${m.questions_total}</strong><small>Question slots</small></div><div class="mission-stat"><strong>${m.templates.length}</strong><small>Approved messages</small></div><div class="mission-stat"><strong>${m.policy.max_attempts}</strong><small>Contact attempts</small></div><div class="mission-stat"><strong>${esc(m.policy.contact_window)}</strong><small>Contact window</small></div></div></section>
    ${detail}
    ${wordingCard(m)}
    ${needsCard(m)}
    ${resultsCard(m)}
    ${voiceCard(m)}
    <div class="grid two" style="margin-top:16px">
      <section class="card card-pad"><div class="card-head"><div><h2>Questionnaire</h2><p>Modules and how many questions each holds</p></div></div>
        <div class="check-list">${m.modules.map(x => `<div class="check-item"><span class="check-mark">·</span><span><strong>${esc(x.title)}</strong><small>${esc(x.branch === "all" ? "Asked of everyone" : "Asked only on the " + x.branch.replace("_", " ") + " branch")}</small></span><span class="status active">${x.questions}</span></div>`).join("")}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Readiness</h2><p>What is in place before a real run</p></div></div>
        <div class="check-list">${checks.map(([ok, t, sub]) => `<div class="check-item ${ok ? "" : "pending"}"><span class="check-mark">${ok ? "✓" : "!"}</span><span><strong>${esc(t)}</strong><small>${esc(sub)}</small></span><span class="status ${ok ? "confirmed" : "progress"}">${ok ? "Ready" : "Pending"}</span></div>`).join("")}</div></section>
    </div>
    <section class="card card-pad" style="margin-top:16px"><div class="card-head"><div><h2>Decision policy</h2><p>Outcome and workflow status stay separate</p></div></div>
      <div class="check-list"><div class="check-item"><span class="check-mark">✓</span><span><strong>Auto-confirm</strong><small>At ${Math.round(m.policy.auto_confirm_at * 100)}% confidence or higher with no evidence conflict</small></span></div>
      <div class="check-item"><span class="check-mark">!</span><span><strong>Goes to a person</strong><small>Any conflict, an identity doubt, or lower confidence</small></span></div>
      <div class="check-item"><span class="check-mark">×</span><span><strong>Final outcomes</strong><small>Confirmed, not confirmed, inconclusive, opted out, cancelled</small></span></div></div></section>`;
}
