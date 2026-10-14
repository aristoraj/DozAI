// Adapters. Sprint 1A uses fakes only: no live WhatsApp, voice or Claude dependency.
// Real adapters (EdZola WhatsApp, ZoLabs, Claude Managed Agents) implement the same ports in Sprint 1B.
import type { RunAgentInput, ToolName } from "@dozai/contracts";
import { CaseService, DozaiError, GatewayTools, newId, type AgentSession, type ToolResult, type ToolSession, type TraceStep, type WakeRequest } from "@dozai/core";

// ---- Ports ------------------------------------------------------------------

export interface ChannelPort {
  /** Deliver pending outbox items. Returns how many were sent. */
  dispatchOutbox(svc: CaseService, tenant: string): Promise<number>;
}

export interface AgentRuntimePort {
  runCase(svc: CaseService, tenant: string, caseId: string, scenario: RunAgentInput["scenario"]): Promise<AgentSession>;
  /** Optional: continue after a real inbound reply. Only runtimes talking to a live channel need it. */
  resumeCase?(svc: CaseService, tenant: string, caseId: string, wake?: WakeRequest): Promise<AgentSession>;
}

// ---- Fake WhatsApp / voice ----------------------------------------------------

export class FakeChannels implements ChannelPort {
  async dispatchOutbox(svc: CaseService, tenant: string): Promise<number> {
    if ((await svc.controls(tenant)).paused) return 0; // the kill switch
    let n = 0;
    for (const o of await svc.store.listOutbox(tenant)) {
      if (o.status !== "pending" || o.kind === "voice_call") continue;
      await svc.store.putOutbox({ ...o, status: "sent", attempts: o.attempts + 1 });
      n++;
    }
    return n;
  }

  /** Scripted participant reply, delivered the way a signed webhook would be: ledger first. */
  async scenarioReply(svc: CaseService, tenant: string, caseId: string, scenario: RunAgentInput["scenario"]) {
    const c = await svc.getCase(tenant, caseId);
    const p = await svc.store.getParticipant(tenant, c.participant_id);
    const id = `fake_${caseId}_${scenario}_${svc.now().getTime()}`;
    const A = (question_id: string, value: string, confidence = 0.85) => ({ question_id, value, confidence });
    // The scenarios are named after the built-in placement mission. On any other mission an answering scenario answers that
    // mission's own required questions, so no placement answer (work status, employer) is ever written into an unrelated case.
    const mission = await svc.getMission(tenant, c.mission_version);
    if (!isPlacementShaped(mission) && scenario !== "no_response" && scenario !== "opt_out") {
      const keys = (mission.evidence_requirements ?? []).filter(r => r.required).map(r => r.key);
      return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant answered the questions (simulated)", consent: "granted", answers: keys.map(k => A(k, "(simulated answer)")) });
    }
    switch (scenario) {
      case "no_response": return undefined;
      case "opt_out": return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant replied: stop", opt_out: true });
      case "same_job": return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant confirmed the same job", consent: "granted", answers: [A("work_status", "working", 0.95), A("employer_name", p?.recorded_employer ?? "", 0.94)] });
      case "changed_job": return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant reported a new employer", consent: "granted", answers: [A("work_status", "working", 0.9), A("employer_name", "Nova Services", 0.68)] });
      case "employer_conflict": return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant reported the same job, different employer name", consent: "granted", answers: [A("work_status", "working", 0.9), A("employer_name", `${p?.recorded_employer ?? "Employer"} Express`, 0.7)] });
      case "not_employed": return svc.recordInbound(tenant, caseId, { provider_event_id: id, channel: "whatsapp", summary: "Participant is not working at present", consent: "granted", answers: [A("work_status", "not_working", 0.95)] });
    }
  }
}

// ---- Scripted agent (stands in for the Claude session) --------------------------

const DECISIONS: Record<RunAgentInput["scenario"], { outcome: "confirmed" | "not_confirmed"; state: "same_job" | "changed_job" | "not_employed"; confidence: number; why: string } | null> = {
  same_job: { outcome: "confirmed", state: "same_job", confidence: 0.93, why: "Employer and status match the programme record." },
  changed_job: { outcome: "confirmed", state: "changed_job", confidence: 0.68, why: "Participant reports a new employer; entity match is low-confidence." },
  employer_conflict: { outcome: "confirmed", state: "same_job", confidence: 0.9, why: "Participant says same job but gave a different employer name." },
  not_employed: { outcome: "not_confirmed", state: "not_employed", confidence: 0.9, why: "Participant reports not working; placement retention not confirmed." },
  opt_out: null,
  no_response: null,
};

/**
 * A fixed stand-in for the model's judgement once evidence has arrived (from the WhatsApp interview or a phone call). It reads what the
 * participant said and proposes the matching outcome with a plain confidence. The platform's own policy then decides whether that
 * completes the case or goes to a person (a conflict with the programme record, or confidence below the threshold).
 */
export function scriptedJudgement(evidence: { question_id: string; value: string }[]): { outcome: "confirmed" | "not_confirmed" | "inconclusive"; state: "same_job" | "changed_job" | "not_employed" | "education_training" | "unreachable_unclear"; confidence: number; why: string } | null {
  const latest = (key: string) => evidence.filter(e => e.question_id === key && e.value && e.value !== "[erased]").at(-1)?.value;
  const status = latest("work_status");
  if (!status) return null;
  switch (status) {
    case "same_job": return { outcome: "confirmed", state: "same_job", confidence: latest("employer_name") ? 0.92 : 0.8, why: latest("employer_name") ? "The participant says they still work at the same place and named the employer." : "The participant says they still work at the same place but did not name the employer." };
    case "changed_job": return { outcome: "confirmed", state: "changed_job", confidence: 0.7, why: "The participant reports a new employer, which is not on the programme record, so a person should check." };
    case "not_employed": return { outcome: "not_confirmed", state: "not_employed", confidence: 0.9, why: "The participant reports not working at present, so retention is not confirmed." };
    case "education_training": return { outcome: "inconclusive", state: "education_training", confidence: 0.9, why: "The participant is studying or training, so there is no job to confirm." };
    default: return null;
  }
}

/** The built-in placement mission and missions written like it ask for a work status; the scripted stand-ins only understand those. */
function isPlacementShaped(m: { evidence_requirements?: { key: string }[] }): boolean {
  return !m.evidence_requirements?.length || m.evidence_requirements.some(r => r.key === "work_status");
}

export class ScriptedAgentRuntime implements AgentRuntimePort {
  constructor(private tools: GatewayTools, private channels: FakeChannels = new FakeChannels(), private employeeVersion = "1.0.0") {}

  async runCase(svc: CaseService, tenant: string, caseId: string, scenario: RunAgentInput["scenario"]): Promise<AgentSession> {
    await this.gate(svc, tenant, caseId);
    const mission = await svc.getMission(tenant, (await svc.getCase(tenant, caseId)).mission_version);
    const employee = await svc.employeeFor(mission);
    const ctx: ToolSession = { session_id: newId("sesn"), tenant_id: tenant, case_id: caseId, mission_version: mission.version, employee_version: employee.version, allowed_tools: employee.allowed_tools };
    const session: AgentSession = { session_id: ctx.session_id, tenant_id: tenant, case_id: caseId, employee_version: employee.version, mission_version: ctx.mission_version, status: "running", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: 0.5, simulated: true, trace: [], started_at: svc.now().toISOString() };
    let n = 0;
    const step = (label: string, type: string, detail: string, extra: Partial<TraceStep> = {}) => {
      session.trace.push({ label, type, detail, ts: svc.now().toISOString(), ...extra });
      session.tokens_in += 700; session.tokens_out += 220;
      session.cost_usd = Math.round((session.tokens_in * 3 + session.tokens_out * 15) / 10_000) / 100; // illustrative rates, simulated
    };
    const call = async (name: ToolName, input: Record<string, unknown>): Promise<ToolResult> => {
      const r = await this.tools.call(ctx, name, input);
      const held = !r.error && !!(r.data as { held?: boolean } | undefined)?.held;
      step(`${name}`, "MCP tool", r.error ? `${r.error.code}: ${r.error.message}` : held ? "ok (held for approval)" : "ok", { tool: name, input, result: r.error ?? r.data, outcome: r.error ? "refused" : held ? "held" : "executed", case_version: r.case_version });
      return r;
    };
    const key = () => `${ctx.session_id}-${++n}`;

    await svc.store.putSession(session);
    step("Session created", "session.created", "Pinned employee + mission version");
    await svc.beginSession(tenant, caseId, `agent:${ctx.session_id}`);
    await svc.emit({ tenant_id: tenant, case_id: caseId }, "agent_session_started", `agent:${ctx.session_id}`, "Agent session started", { session_id: ctx.session_id, simulated: true });
    step("Objective received", "user.message", "Case and mission IDs only");

    let r = await call("case_get_context", { case_id: caseId });
    await call("mission_get_bundle", { mission_version_id: ctx.mission_version });
    r = await call("whatsapp_send_template", { case_id: caseId, template_key: mission.intro_template, idempotency_key: key(), expected_version: r.case_version });
    if (r.error) return this.finish(svc, session, "idle", r.error.message);

    step("Waiting for reply", "session.status_idle", "Catalyst owns the wait");
    await this.channels.dispatchOutbox(svc, tenant);
    await this.channels.scenarioReply(svc, tenant, caseId, scenario);

    const after = await svc.getCase(tenant, caseId);
    if (after.status === "complete") return this.finish(svc, session, "completed", "Participant opted out. No further contact.");
    if (!isPlacementShaped(mission) && scenario !== "no_response") {
      // Not the placement mission: this stand-in cannot judge the answers, so a complete interview goes to a person (as on resume).
      r = await call("case_get_context", { case_id: caseId });
      if (!(r.data as { requirements?: { complete?: boolean } } | undefined)?.requirements?.complete) return this.finish(svc, session, "idle", "Nothing to judge yet.");
      r = await call("review_request", { case_id: caseId, idempotency_key: key(), expected_version: r.case_version, reason_code: "interview_complete", note: "Every answer this mission needs is in. A person judges them." });
      return this.finish(svc, session, "idle", r.error ? `Stopped: review_request was refused (${r.error.code}).` : "Handed to a human reviewer.");
    }
    const plan = DECISIONS[scenario];
    if (!plan) return this.finish(svc, session, "idle", "No reply yet. The retry window is protected by policy.");

    step("Participant event", "system.message", "Normalised inbound response");
    r = await call("case_get_context", { case_id: caseId });
    const refs = ((r.data as { evidence?: { evidence_ref: string }[] })?.evidence ?? []).map(e => e.evidence_ref);
    r = await call("decision_propose", { case_id: caseId, idempotency_key: key(), expected_version: r.case_version, proposed_outcome: plan.outcome, livelihood_state: plan.state, confidence: plan.confidence, evidence_refs: refs, rationale: plan.why });
    const state = (r.data as { state?: string } | undefined)?.state;
    // Say what really happened: a refused proposal leaves the case where it was, it is not "handed to a reviewer".
    return this.finish(svc, session, "idle", r.error ? `Stopped: decision_propose was refused (${r.error.code}).` : state === "complete" ? "Auto-completed by policy." : "Handed to a human reviewer.");
  }

  /** Woken after an interview or a phone call has produced evidence: read it, propose the matching outcome, and go back to sleep. */
  async resumeCase(svc: CaseService, tenant: string, caseId: string): Promise<AgentSession> {
    await this.gate(svc, tenant, caseId);
    const mission = await svc.getMission(tenant, (await svc.getCase(tenant, caseId)).mission_version);
    const employee = await svc.employeeFor(mission);
    const ctx: ToolSession = { session_id: newId("sesn"), tenant_id: tenant, case_id: caseId, mission_version: mission.version, employee_version: employee.version, allowed_tools: employee.allowed_tools };
    const session: AgentSession = { session_id: ctx.session_id, tenant_id: tenant, case_id: caseId, employee_version: employee.version, mission_version: ctx.mission_version, status: "running", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: 0.5, simulated: true, trace: [], started_at: svc.now().toISOString(), trigger: "resume" };
    const step = (label: string, type: string, detail: string, extra: Partial<TraceStep> = {}) => {
      session.trace.push({ label, type, detail, ts: svc.now().toISOString(), ...extra });
      session.tokens_in += 700; session.tokens_out += 220;
      session.cost_usd = Math.round((session.tokens_in * 3 + session.tokens_out * 15) / 10_000) / 100;
    };
    await svc.store.putSession(session);
    step("Session created", "session.created", "Woken after evidence arrived");
    await svc.emit({ tenant_id: tenant, case_id: caseId }, "agent_session_started", `agent:${ctx.session_id}`, "Agent session started", { session_id: ctx.session_id, simulated: true });
    const r = await this.tools.call(ctx, "case_get_context", { case_id: caseId });
    step("case_get_context", "MCP tool", r.error ? `${r.error.code}: ${r.error.message}` : "ok", { tool: "case_get_context", input: { case_id: caseId }, result: r.error ?? r.data, outcome: r.error ? "refused" : "executed", case_version: r.case_version });
    const evidence = ((r.data as { evidence?: { evidence_ref: string; question_id: string; value: string }[] } | undefined)?.evidence ?? []);
    const plan = scriptedJudgement(evidence);
    if (r.error) return this.finish(svc, session, "idle", "Nothing to judge yet.");
    if (!plan) {
      // This stand-in only understands the built-in placement answers. For any other mission it cannot judge what was said, so once
      // the mission has everything it needs a person decides, instead of the case waiting for a judgement that will never come.
      const done = (r.data as { requirements?: { complete?: boolean } } | undefined)?.requirements?.complete && evidence.length > 0;
      if (!done) return this.finish(svc, session, "idle", "Nothing to judge yet.");
      const input = { case_id: caseId, idempotency_key: `${ctx.session_id}-review`, expected_version: r.case_version, reason_code: "interview_complete", note: "Every answer this mission needs is in. A person judges them." };
      const v = await this.tools.call(ctx, "review_request", input);
      step("review_request", "MCP tool", v.error ? `${v.error.code}: ${v.error.message}` : "ok", { tool: "review_request", input, result: v.error ?? v.data, outcome: v.error ? "refused" : "executed", case_version: v.case_version });
      return this.finish(svc, session, "idle", v.error ? v.error.message : "Handed to a human reviewer.");
    }
    const input = { case_id: caseId, idempotency_key: `${ctx.session_id}-resume`, expected_version: r.case_version, proposed_outcome: plan.outcome, livelihood_state: plan.state, confidence: plan.confidence, evidence_refs: evidence.map(e => e.evidence_ref), rationale: plan.why };
    const d = await this.tools.call(ctx, "decision_propose", input);
    step("decision_propose", "MCP tool", d.error ? `${d.error.code}: ${d.error.message}` : "ok", { tool: "decision_propose", input, result: d.error ?? d.data, outcome: d.error ? "refused" : "executed", case_version: d.case_version });
    const state = (d.data as { state?: string } | undefined)?.state;
    return this.finish(svc, session, "idle", d.error ? d.error.message : state === "complete" ? "Auto-completed by policy." : "Handed to a human reviewer.");
  }

  /** The kill switch and spend limits apply to the stand-in agent exactly as to the real one. */
  private async gate(svc: CaseService, tenant: string, caseId: string): Promise<void> {
    const g = await svc.agentGate(tenant, caseId);
    if (!g.ok) throw new DozaiError(g.code, g.message, 429);
  }

  private async finish(svc: CaseService, session: AgentSession, status: AgentSession["status"], detail: string): Promise<AgentSession> {
    session.trace.push({ label: "Session idled", type: "session.status_idle", detail, ts: svc.now().toISOString() });
    session.status = status;
    await svc.store.putSession(session);
    await svc.emit({ tenant_id: session.tenant_id, case_id: session.case_id }, "agent_session_ended", `agent:${session.session_id}`, `Agent session ${status}: ${detail}`, { session_id: session.session_id, cost_usd: session.cost_usd, simulated: true });
    return session;
  }
}
export * from "./claude";
export * from "./interakt";
export * from "./jobs";
export * from "./classifier";
export * from "./voice";
export * from "./zolabs-auth";
export * from "./claude-missions";
