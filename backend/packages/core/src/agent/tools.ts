// The MCP tool surface: business capabilities, not tables.
// Transport-agnostic. The MCP gateway (AppSail) and the scripted dev agent both call `GatewayTools.call`.
import { ToolInputs, type ToolEnvelope, type ToolName } from "@dozai/contracts";
import { newId } from "../storage/ledger";
import { localHour } from "@dozai/domain";
import { evaluateRequirements } from "../missions/requirements";
import { planCall } from "../conversation/voice";
import { CaseService, DozaiError } from "../cases/service";

/** One session maps to exactly one case and tenant. Tools cannot be pointed elsewhere. */
export interface ToolSession {
  session_id: string;
  tenant_id: string;
  case_id: string;
  mission_version: string;
  employee_version: string;
  /** The tools this session's employee may use. Set by the runtime and carried in the signed session token. Absent means no extra limit (older sessions). */
  allowed_tools?: ToolName[];
  /** Who is acting, when it is a person using the same door (a staff-requested call). Absent means the agent of this session. */
  actor?: string;
}

export type ToolResult = ToolEnvelope & { data?: unknown };

const ALLOWED: Record<string, ToolName[]> = {
  draft: [],
  ready: ["case_get_context", "mission_get_bundle"],
  running: ["case_get_context", "mission_get_bundle", "case_get_timeline", "whatsapp_send_template", "voice_call_request", "callback_schedule", "decision_propose", "review_request", "memory_note"],
  waiting: ["case_get_context", "mission_get_bundle", "case_get_timeline", "whatsapp_send_template", "voice_call_request", "callback_schedule", "decision_propose", "review_request", "memory_note"],
  call_scheduled: ["case_get_context", "mission_get_bundle", "case_get_timeline", "memory_note"],
  calling: ["case_get_context", "mission_get_bundle", "case_get_timeline", "decision_propose", "memory_note"],
  evaluating: ["case_get_context", "mission_get_bundle", "case_get_timeline", "decision_propose", "review_request", "memory_note"],
  review: ["case_get_context", "mission_get_bundle", "case_get_timeline"],
  complete: ["case_get_context", "mission_get_bundle", "case_get_timeline"],
};

export class GatewayTools {
  constructor(private svc: CaseService) {}

  async call(session: ToolSession, name: ToolName, rawInput: unknown): Promise<ToolResult> {
    const operation_id = newId("op");
    const permitted = (names: string[]) => (session.allowed_tools ? names.filter(n => session.allowed_tools!.includes(n as ToolName)) : names);
    const fail = async (code: string, message: string): Promise<ToolResult> => {
      const c = await this.svc.store.getCase(session.tenant_id, session.case_id);
      return { operation_id, case_version: c?.version ?? 0, next_allowed_actions: c ? permitted(ALLOWED[c.status] ?? []) : [], error: { code, message } };
    };

    const schema = ToolInputs[name];
    if (!schema) return fail("UNKNOWN_TOOL", `unknown tool ${name}`);
    // The employee's own allow-list, enforced here whatever the model asks for.
    if (session.allowed_tools && !session.allowed_tools.includes(name)) return fail("TOOL_NOT_ALLOWED_FOR_EMPLOYEE", `${name} is not one of this employee's tools`);
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) return fail("INVALID_INPUT", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    const input = parsed.data as Record<string, any>;

    // Case binding: a session can only act on its own case.
    if ("case_id" in input && input.case_id !== session.case_id) return fail("CASE_NOT_IN_SESSION", "this session is bound to a different case");

    // Idempotency for action tools: replay returns the first result.
    const idemKey = "idempotency_key" in input ? `tool:${session.session_id}:${name}:${input.idempotency_key}` : undefined;
    if (idemKey) {
      const prior = await this.svc.store.getIdem(idemKey);
      if (prior) return prior as ToolResult;
    }

    try {
      const result = await this.run(session, name, input, operation_id);
      if (idemKey) await this.svc.store.putIdem(idemKey, result);
      return result;
    } catch (e) {
      if (e instanceof DozaiError) return fail(e.code, e.message);
      throw e;
    }
  }

  private async envelope(session: ToolSession, operation_id: string, data?: unknown): Promise<ToolResult> {
    const c = await this.svc.getCase(session.tenant_id, session.case_id);
    const next = ALLOWED[c.status] ?? [];
    return { operation_id, case_version: c.version, next_allowed_actions: session.allowed_tools ? next.filter(n => session.allowed_tools!.includes(n)) : next, data };
  }

  private async run(s: ToolSession, name: ToolName, i: Record<string, any>, op: string): Promise<ToolResult> {
    const svc = this.svc;
    const c = await svc.getCase(s.tenant_id, s.case_id);
    const allowed = ALLOWED[c.status] ?? [];
    if (!allowed.includes(name)) throw new DozaiError("TOOL_NOT_ALLOWED", `${name} is not allowed while the case is ${c.status}`);

    const needVersion = () => {
      if ("expected_version" in i && i.expected_version !== c.version) throw new DozaiError("VERSION_CONFLICT", `expected v${i.expected_version}, case is v${c.version}. Re-read the case.`);
    };

    switch (name) {
      case "case_get_context": {
        const p = await svc.store.getParticipant(c.tenant_id, c.participant_id);
        const evidence = await svc.store.listEvidence(c.case_id);
        const missionOfCase = await svc.getMission(c.tenant_id, c.mission_version);
        const need = evaluateRequirements(missionOfCase, evidence, p?.recorded_employer);
        const calls = await svc.store.listCalls(c.tenant_id, c.case_id);
        const phoneForm = svc.voiceEnabled && !!(await svc.store.getVoiceForm(c.tenant_id, missionOfCase.version));
        const memory = await svc.store.getMemory(c.tenant_id, c.case_id);
        const timers = (await svc.store.listWakes(c.tenant_id, c.case_id)).filter(w => w.status === "pending");
        // Minimum necessary: no name, no phone, no free-text transcripts.
        return this.envelope(s, op, {
          case_id: c.case_id, participant_ref: c.participant_id, status: c.status, outcome: c.outcome,
          livelihood_state: c.livelihood_state, attempts: c.attempts,
          participant: p && { language: p.language, consent: p.consent, cohort: p.cohort, programme_record: { employer: p.recorded_employer } },
          evidence: evidence.map(e => ({ evidence_ref: e.evidence_id, question_id: e.question_id, value: e.value, source: e.source, confidence: e.confidence })),
          // Which ways of reaching the person exist, and what has been tried. No transcripts, numbers or audio.
          channels: { phone_call_available: phoneForm },
          calls: calls.map(k => ({ status: k.status, requested_at: k.requested_at, ended_at: k.ended_at ?? null, asked: k.asked })),
          // What you remembered about this person (fixed keys only) and when you are next due to be woken.
          memory: (memory?.items ?? []).map(m => ({ key: m.key, value: m.value })),
          wake_ups: timers.map(w => ({ reason: w.reason, at: w.at })),
          // What the mission still needs to know about this person, and what is already settled.
          requirements: { complete: need.complete, needed: need.needed, collected: need.collected, gaps: need.gaps, conflicts: need.conflicts, items: need.items.map(r => ({ key: r.key, label: r.label, applicable: r.applicable, state: r.state, confidence: r.confidence, evidence_ref: r.evidence_ref, note: r.note })) },
        });
      }
      case "mission_get_bundle": {
        if (i.mission_version_id !== s.mission_version) throw new DozaiError("MISSION_VERSION_MISMATCH", "this session is pinned to a different mission version");
        const b = await svc.getMission(s.tenant_id, s.mission_version);
        return this.envelope(s, op, { version: b.version, objective: b.objective ?? null, outcomes: b.outcomes ?? null, verdict_labels: b.verdict_labels ?? null, evidence_requirements: b.evidence_requirements ?? [], strategy: b.strategy ?? null, intro_template: b.intro_template, instrument_signed_off: b.instrument_signed_off, modules: b.modules, templates: b.templates, contact_policy: svc.policyFor(b), rubric: b.rubric });
      }
      case "case_get_timeline": {
        const evs = (await svc.store.listEvents(c.tenant_id, c.case_id)).slice(-i.limit);
        return this.envelope(s, op, evs.map(e => ({ seq: e.seq, type: e.type, summary: e.summary, ts: e.ts })));
      }
      case "whatsapp_send_template": {
        needVersion();
        const bundle = await svc.getMission(s.tenant_id, s.mission_version);
        if (!bundle.templates.some(t => t.key === i.template_key)) throw new DozaiError("TEMPLATE_NOT_APPROVED", `template ${i.template_key} is not in the approved list`);
        // Already asked and nothing has come back: do not send again. (Reminders are a separate, policy-driven step.)
        if (c.status === "waiting") {
          const evs = await svc.store.listEvents(c.tenant_id, c.case_id);
          const last = (types: string[]) => evs.filter(e => types.includes(e.type)).reduce((m, e) => Math.max(m, e.seq), 0);
          if (last(["message_queued", "message_sent"]) > last(["message_received"])) {
            throw new DozaiError("ALREADY_WAITING", "A message was already sent to this participant and no reply has arrived yet. Wait for the reply; do not send again.");
          }
        }
        const gate = await svc.gateContact(c);
        if (!gate.allowed) throw new DozaiError(gate.code, `${gate.message} (attempts so far: ${c.attempts}, status: ${c.status}, consent: ${(await svc.store.getParticipant(c.tenant_id, c.participant_id))?.consent ?? "unknown"})`);
        const out = await svc.queueOutbox(c, "whatsapp_template", { template_key: i.template_key }, i.idempotency_key);
        await svc.emit(c, "message_queued", `agent:${s.session_id}`, `WhatsApp template ${i.template_key} queued`, { outbox_id: out.outbox_id });
        const next = await svc.transition(c.tenant_id, c.case_id, c.version, "waiting", { actor: `agent:${s.session_id}`, summary: "Waiting for participant reply", patch: { attempts: c.attempts + 1, next_action: "Wait for the participant response. The retry window is protected by policy." } });
        return this.envelope(s, op, { outbox_id: out.outbox_id, state: next.status, ...(out.status === "held" ? { held: true, note: "A person must approve this message before it is sent." } : {}) });
      }
      case "callback_schedule": {
        needVersion();
        // Setting a reminder contacts nobody, so consent, contact hours and the attempt cap do not apply to it: they apply when the agent
        // is woken and tries to contact the person. (Before, this was checked like a message, so a reminder set right after the first
        // message was refused for "consent required", because the person had not replied yet.) Only someone who has opted out or declined
        // is refused, because there is nothing left to look at again.
        const person = await svc.store.getParticipant(c.tenant_id, c.participant_id);
        if (person?.consent === "declined") throw new DozaiError("CONTACT_NOT_ALLOWED", "this person has opted out or declined, so there is nothing to look at again");
        const via = i.channel ? ` (plan: ${i.channel === "voice" ? "a call" : "WhatsApp"})` : "";
        await svc.emit(c, "callback_scheduled", `agent:${s.session_id}`, `The agent will look at this case again in ${i.after_hours}h${via}`, { after_hours: i.after_hours, ...(i.channel ? { channel: i.channel } : {}) });
        // A real timer: the agent is woken at that time, whatever else is happening.
        const w = await svc.scheduleWake(c, { at: new Date(svc.now().getTime() + i.after_hours * 3_600_000), reason: "agent_requested", note: i.channel ? `via ${i.channel}` : undefined, by: `agent:${s.session_id}` });
        return this.envelope(s, op, { scheduled: true, after_hours: i.after_hours, wake_at: w.at });
      }
      case "voice_call_request": {
        needVersion();
        const gate = await svc.gateContact(c);
        if (!gate.allowed) throw new DozaiError(gate.code, gate.message);
        // The call asks only for what is still missing. It needs the mission's phone form to have been published by a person.
        const { form, missing } = await planCall(svc, c);
        let startAt: string | null = null;
        if (i.start_at) {
          const when = new Date(i.start_at), now = svc.now();
          if (when.getTime() < now.getTime() - 60_000) throw new DozaiError("START_IN_THE_PAST", "start_at is in the past");
          if (when.getTime() > now.getTime() + 14 * 86_400_000) throw new DozaiError("START_TOO_FAR", "start_at must be within 14 days");
          const pol = svc.policyFor(await svc.getMission(c.tenant_id, c.mission_version)), h = localHour(when, pol.utcOffsetMinutes);
          if (h < pol.windowStartHour || h >= pol.windowEndHour) throw new DozaiError("OUTSIDE_WINDOW", "the chosen time is outside the approved contact hours");
          startAt = when.toISOString();
        }
        const out = await svc.queueOutbox(c, "voice_call", { form_id: form.form_id, asked: missing?.map(m => m.key) ?? null, start_at: startAt, reason: i.reason }, i.idempotency_key);
        const who = s.actor ?? `agent:${s.session_id}`;
        await svc.emit(c, "call_requested", who, `Phone call requested${startAt ? " for a later time" : ""}: ${i.reason}`, { outbox_id: out.outbox_id, asks: missing?.map(m => m.key) ?? "everything" });
        const next = await svc.transition(c.tenant_id, c.case_id, c.version, "call_scheduled", { actor: who, summary: "Phone call requested", patch: { attempts: c.attempts + 1, next_action: "The call is placed inside the approved contact hours." } });
        return this.envelope(s, op, { outbox_id: out.outbox_id, state: next.status, will_ask: missing?.map(m => m.label) ?? "every question in the form", ...(out.status === "held" ? { held: true, note: "A person must approve this call before it is placed." } : {}) });
      }
      case "decision_propose": {
        needVersion();
        const r = await svc.proposeDecision(c.tenant_id, c.case_id, c.version, {
          proposed_outcome: i.proposed_outcome, livelihood_state: i.livelihood_state, confidence: i.confidence, evidence_refs: i.evidence_refs, rationale: i.rationale,
        }, `agent:${s.session_id}`);
        return this.envelope(s, op, { decision_id: r.decision.decision_id, auto_completed: r.auto, state: r.case.status });
      }
      case "memory_note": {
        const m = await svc.rememberNote(c, i.key, String(i.value).trim().toLowerCase(), `agent:${s.session_id}`);
        return this.envelope(s, op, { remembered: m.items.map(x => ({ key: x.key, value: x.value })) });
      }
      case "review_request": {
        needVersion();
        const next = await svc.requestReview(c.tenant_id, c.case_id, c.version, i.reason_code, i.note, `agent:${s.session_id}`);
        return this.envelope(s, op, { state: next.status });
      }
    }
  }
}
