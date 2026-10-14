// Claude engine, Sessions tab: the list, the viewer and the replay.
import { state } from "../../lib/state.js";
import { api } from "../../lib/api.js";
import { render } from "../../shell.js";
import { toast } from "../../components/toast.js";
import { esc, istDay, istTime } from "../../lib/format.js";
import { empty, statusPill } from "../../components/page.js";

// What the platform would do now with what an agent session did.
export async function replaySession(id) {
  try { state.replay = await api(`/sessions/${encodeURIComponent(id)}/replay`); render(); }
  catch (e) { toast(e.message, "warning"); }
}
function replayHtml(r) {
  if (!r) return "";
  const lab = { allowed: "Still allowed", would_be_held: "Would wait for a person", refused: "Would be refused" };
  const body = r.rows.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Action</th><th>Then</th><th>Now</th><th></th></tr></thead><tbody>${r.rows.map(x => `<tr><td><code>${esc(x.tool)}</code></td><td>${esc(x.recorded === "unknown" ? "not recorded" : { executed: "ran", held: "held", refused: "refused" }[x.recorded])}</td><td>${esc(lab[x.now])}${x.message ? `<small style="display:block;color:var(--muted)">${esc(x.message)}</small>` : ""}</td><td>${x.changed ? `<span class="status review">Changed</span>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted t-sm">This session took no action that can be checked.</p>`;
  return `<section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Replay under today's rules</h2><p>${esc(r.note)}</p></div></div>${body}</section>`;
}
export function renderSessions() {
  if (state.session) return renderSessionViewer(state.session);
  const ss = state.sessions;
  if (!ss.length) return empty("No agent sessions yet", "Open a case and run an agent session. Each run is recorded here with its steps and cost.");
  const total = ss.reduce((n, s) => n + s.cost_usd, 0);
  return `<div class="monitor-kpis">
      <div class="card monitor-kpi"><small>Sessions</small><strong>${ss.length}</strong><span>all time</span></div>
      <div class="card monitor-kpi"><small>Total cost</small><strong>$${total.toFixed(2)}</strong><span>${ss.some(s => s.simulated) ? "includes simulated runs" : "from token usage"}</span></div>
      <div class="card monitor-kpi"><small>Average cost</small><strong>$${(total / ss.length).toFixed(3)}</strong><span>per session</span></div>
      <div class="card monitor-kpi"><small>Hit the budget</small><strong>${ss.filter(s => s.status === "budget_reached").length}</strong><span>stopped early</span></div></div>
    <section class="card session-monitor-table" style="margin-top:15px"><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Session</th><th>Case</th><th>Started</th><th>Status</th><th>Tokens</th><th>Cost</th><th></th></tr></thead><tbody>${ss.map(s => `<tr><td><code class="t-xs">${esc(s.session_id)}</code></td><td><strong>${esc(s.case_id)}</strong></td><td>${esc(istDay(s.started_at))} ${esc(istTime(s.started_at))}</td><td>${esc(s.status)}${s.simulated ? " (simulated)" : ""}</td><td>${(s.tokens_in + s.tokens_out).toLocaleString()}</td><td>$${s.cost_usd.toFixed(3)}</td><td><button class="row-action" data-open-session="${esc(s.session_id)}">›</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function renderSessionViewer(s) {
  const turns = s.trace.length ? s.trace.map(t => {
    const actor = t.tool ? "Claude · tool request" : t.type.startsWith("session") ? "Session state" : t.type === "system.message" ? "System event" : "Runtime";
    const body = t.tool
      ? `<p>Calling an approved capability.</p><div class="tool-call"><div class="tool-call-head"><strong>${esc(t.tool)}</strong><span>${t.outcome === "held" ? "held for approval" : t.result?.code ? "refused" : "completed"}</span></div><pre>INPUT  ${esc(JSON.stringify(t.input))}\nRESULT ${esc(JSON.stringify(t.result).slice(0, 360))}</pre></div>`
      : `<p>${esc(t.detail)}</p>`;
    return `<div class="model-turn"><div class="turn-meta"><span class="turn-actor"><span>${t.tool ? "AI" : "S"}</span>${actor}</span><span>${esc(istTime(t.ts))}</span></div>${body}</div>`;
  }).join("") : `<p class="muted t-sm">The step-by-step record was removed (the case was deleted).</p>`;
  const steps = s.trace.map(t => `<div class="trace-event complete"><span class="trace-index">✓</span><span class="trace-copy"><strong>${esc(t.label)}</strong><small>${esc(t.type)}${t.tool ? "" : ` · ${esc(t.detail)}`}</small></span></div>`).join("");
  return `<div style="margin-bottom:12px"><button class="button ghost small" data-action="close-session">← All sessions</button></div>
    <section class="card session-header"><div class="session-identity"><span class="session-pulse">Ⅱ</span><div><h2>Session ${esc(s.session_id)}</h2><p>Case ${esc(s.case_id)} · Agent v${esc(s.employee_version)} · ${esc(s.mission_version)}</p></div>${statusPill(s.status === "budget_reached" ? "review" : "confirmed")}</div><div class="session-actions"><span class="beta-chip">${s.simulated ? "Simulated agent" : "Claude"} · same tool gateway</span><button class="button ghost small" data-replay="${esc(s.session_id)}">Replay under today's rules</button></div></section>
    <section class="card session-grid"><aside class="trace-sidebar"><h3>Steps</h3>${steps}</aside>
      <div class="transcript"><div class="transcript-head"><h3>Transcript</h3><span class="t-xs muted">Recorded from the tool gateway</span></div>${turns}</div>
      <aside class="inspector"><div class="inspector-tabs"><button class="inspector-tab active">Session</button></div><div class="inspector-body">
        ${field("Status", s.status)}${field("Woken by", (s.trigger || "first run").replace("wake:", "timer: ").replace(/_/g, " "))}${field("Tool calls", `${s.trace.filter(t => t.tool).length} · ${s.trace.filter(t => t.result?.code).length} refused`)}${field("Tokens in / out", `${s.tokens_in.toLocaleString()} / ${s.tokens_out.toLocaleString()}`)}
        <div class="inspector-field"><small>Budget</small><strong>$${s.cost_usd.toFixed(3)} of $${s.budget_usd.toFixed(2)}</strong><div class="budget-track"><span style="width:${Math.min(100, (s.cost_usd / s.budget_usd) * 100)}%"></span></div></div></div></aside></section>${replayHtml(state.replay && state.replay.session_id === s.session_id ? state.replay : null)}`;
}
const field = (l, v) => `<div class="inspector-field"><small>${esc(l)}</small><strong>${esc(v)}</strong></div>`;
