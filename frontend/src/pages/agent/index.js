// Claude engine page: the tabs and the agent overview.
import { state } from "../../lib/state.js";
import { pageHead } from "../../components/page.js";
import { layerStrip, renderEmployee, renderPlatform } from "./employee.js";
import { renderControls } from "./controls.js";
import { renderSessions } from "./sessions.js";
import { esc } from "../../lib/format.js";

// ---- Claude engine -------------------------------------------------------------------------------------------------------------------------
export const TOOL_HELP = {
  case_get_context: ["Read", "Authorised facts and evidence for one case. No names or phone numbers."],
  mission_get_bundle: ["Read", "The mission's modules, approved messages, contact policy and rubric."],
  case_get_timeline: ["Read", "Recent ledger events for the case."],
  whatsapp_send_template: ["Action", "Queue an approved message. Checks consent, window, attempt cap and opt-out."],
  callback_schedule: ["Action", "Set its own wake-up: the agent is woken at that time to look at the case again."],
  voice_call_request: ["Action", "Request a phone call for what is still missing. Checks consent, hours and attempts."],
  memory_note: ["Action", "Remember one fixed fact about the person (best time to call, preferred channel, language). Nothing else can be stored."],
  decision_propose: ["Gated", "Propose an outcome with evidence. The system decides whether it is final."],
  review_request: ["Gated", "Send the case to a person with a reason."],
};
export function renderAgent() {
  const tab = state.agentTab;
  const tabs = [["agent", "Agent"], ["platform", "Platform"], ["employee", "Employees"], ["controls", "Controls"], ["sessions", "Sessions"]];
  return `${pageHead("Claude engine", "The agent, its limits and what it has done.", "It can only use the tools below. It cannot read the database, see phone numbers, or complete a case on its own.")}
    ${layerStrip()}
    <div class="agent-tabs" role="tablist">${tabs.map(([id, l]) => `<button class="agent-tab ${tab === id ? "active" : ""}" data-agent-tab="${id}" role="tab">${l}</button>`).join("")}</div>
    ${tab === "agent" ? renderAgentInfo() : tab === "platform" ? renderPlatform() : tab === "employee" ? renderEmployee() : tab === "controls" ? renderControls() : renderSessions()}`;
}
function renderAgentInfo() {
  const r = state.mission.runtime;
  return `<div class="agent-layout">
    <section class="card config-section"><div class="card-head"><div><h2>Configuration</h2><p>What is running right now</p></div><span class="status ${r.agent === "claude" ? "confirmed" : "progress"}">${r.agent === "claude" ? "Claude" : "Scripted stand-in"}</span></div>
      <div class="config-list">
        ${configRow("Agent", r.agent === "claude" ? "Claude, through the tool gateway" : "Scripted stand-in (no model)", r.agent === "claude" ? "A real model decides which tool to use." : "No Anthropic key is set, so the agent follows a fixed script.")}
        ${configRow("Reading replies", r.classifier === "claude" ? "Rules, then a model for unclear replies" : "Rules only", r.classifier === "claude" ? "Participant text is sent to the model only when the rules cannot place it." : "No participant text goes to a model to be understood.")}
        ${configRow("Model", r.model || "None", "Pinned per release; changed in configuration.")}
        ${configRow("WhatsApp", r.whatsapp === "live" ? "Live" : "Off", r.whatsapp === "live" ? "Approved messages go to participants who have consented." : "Replies are simulated; nothing is sent.")}
        ${configRow("Contact window", r.contact_window, `At most ${state.mission.policy.max_attempts} approved attempts per participant.`)}
        ${configRow("Auto-confirm", `${Math.round(state.mission.policy.auto_confirm_at * 100)}% and no conflict`, "Anything lower or conflicting goes to a person.")}
      </div></section>
    <aside class="card config-section"><div class="card-head"><div><h2>What it cannot do</h2><p>Enforced by the system, not by instruction</p></div></div>
      <div class="prohibited-strip" style="flex-direction:column;align-items:flex-start;gap:6px"><span>× Query the database</span><span>× See names or phone numbers</span><span>× Complete or delete a case</span><span>× Record an opt-out on its own</span><span>× Send anything not on the approved list</span><span>× Contact someone who opted out</span></div></aside>
  </div>
  <section class="card card-pad" style="margin-top:15px"><div class="card-head"><div><h2>Tools</h2><p>The only things the agent can do</p></div><span class="status active">${state.mission.tools.length}</span></div>
    <div class="tool-registry">${state.mission.tools.map(t => `<div class="tool-card"><div class="tool-card-head"><code>${esc(t)}</code><span class="permission-pill ${TOOL_HELP[t]?.[0] === "Read" ? "allow" : "review"}">${esc(TOOL_HELP[t]?.[0] || "")}</span></div><p>${esc(TOOL_HELP[t]?.[1] || "")}</p></div>`).join("")}</div></section>`;
}
export const configRow = (label, value, desc) => `<div class="config-row"><span class="config-label">${esc(label)}</span><span class="config-value"><strong>${esc(value)}</strong><p>${esc(desc)}</p></span></div>`;
