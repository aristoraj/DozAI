import { describe, it, expect } from "vitest";
import type { Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "../cases/service";
import { DocStore, InMemoryDocDriver } from "../storage/docstore";
import { InMemoryStore, type Store } from "../storage/store";
import { GatewayTools } from "../agent/tools";
import { PLACEMENT_RETENTION_V1 } from "../missions/mission";
import { VERIFICATION_EMPLOYEE_V1 } from "../agent/employee";
import { buildCallContext, buildVoiceForm, ingestVoiceResult, normaliseVoiceAnswer, spokenQuestion, VOICE_META_FIELDS, voiceFormHash, type VoiceResult } from "./voice";
import { evaluateRequirements } from "../missions/requirements";
import { questionById, DRAFT_INSTRUMENT } from "../missions/instrument";

const T = "t1";
const M = PLACEMENT_RETENTION_V1;
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const staff: Principal = { user_id: "ops@x.org", tenant_id: T, role: "agent_ops" };
const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore", () => new DocStore(new InMemoryDocDriver())]];

describe("the form published to the voice provider", () => {
  const form = buildVoiceForm(M, VERIFICATION_EMPLOYEE_V1);
  const field = (id: string) => form.form_fields.find(f => f.field_id === id)!;

  it("starts with identity then consent, so the platform can tell a wrong number or a refusal from an answer, then one field per need", () => {
    expect(form.form_fields.map(f => f.field_id)).toEqual([...VOICE_META_FIELDS, "work_status", "employer_name", "role_title", "change_reason", "not_working_reason", "job_search", "course", "support_requested"]);
    expect(VOICE_META_FIELDS).toEqual(["identity_confirmed", "consent_given"]);
    expect(VOICE_META_FIELDS.map(id => field(id).field_kind)).toEqual(["meta", "meta"]);
    expect(field("consent_given").datatype).toBe("boolean");
    expect(field("identity_confirmed").condition_for_asking_this_field).toBe("");
    expect(field("consent_given").condition_for_asking_this_field).toBe("Ask only if identity_confirmed = true.");
    expect(form.form_fields.some(f => f.field_id === "language")).toBe(false);
  });

  it("gives every field the exact spoken question, the values to record, and how to map a spoken answer to them", () => {
    const ws = field("work_status");
    expect(ws.additional_info).toContain('Ask: "Which of these describes you best right now? You can say:');
    expect(ws.additional_info).not.toMatch(/reply with the number|type/i);
    expect(ws.additional_info).toContain("Record the answer as one of: same_job, changed_job, not_employed, education_training. Never say these codes aloud.");
    expect(ws.additional_parsing_comments).toContain("-> same_job");
    expect(ws.validation).toBe("Must be one of: same_job, changed_job, not_employed, education_training");
    expect(field("support_requested").datatype).toBe("boolean");
    expect(field("support_requested").additional_info).toContain("Record the answer as one of: true, false.");
    expect(field("support_requested").validation).toBe("Must be one of: true, false");
    expect(field("employer_name")).toMatchObject({ datatype: "string", analysis_type: "qualitative" });
    expect(ws).toMatchObject({ analysis_type: "quantitative" });
  });

  it("asks a dependent field only when it is still needed and its earlier answer allows it, in the provider's own style", () => {
    expect(field("work_status").condition_for_asking_this_field).toBe('Ask only if "work_status" is listed under Still needed in the call details.');
    expect(field("employer_name").condition_for_asking_this_field).toBe("Ask ONLY if work_status = same_job or work_status = changed_job. If the answer is anything else, skip this field completely and never ask it.");
    expect(field("course").condition_for_asking_this_field).toContain("Ask ONLY if work_status = education_training");
  });

  it("says a written question as speech, and lets a mission word it exactly", () => {
    const q = { ...M.instrument.questions.find(x => x.type === "text")!, text: "Please type your employer's name. Reply with the number." } as never;
    expect(spokenQuestion(q)).toBe("Please tell me your employer's name.");
    expect(spokenQuestion({ ...(q as object), spoken: "Where do you work now?" } as never)).toBe("Where do you work now?");
  });

  it("the voice agent's instructions carry the employee, the purpose, and the rules for stopping and for ending the call", () => {
    const c = form.form_context;
    expect(c).toContain("You are Meera");
    expect(c).toContain("Purpose of the call: Find out whether the participant still works");
    expect(c).toContain("Ask each question once");
    expect(c).toContain("asks for their data to be deleted");
    expect(c).toContain("Never promise jobs, money or outcomes");
    expect(c).toContain("Ask nothing after the last field");
    expect(c).toContain("never ask it again");
    expect(c).toContain("Before you finish, go back over the fields");
    expect(field("consent_given").additional_info).toContain("short yes, haan, ji or okay is a clear yes");
    expect(c).not.toMatch(/^\d+\. /m); // no numbered script: the fields carry the order
    expect(form.start_message).toBe("Hello, this is Meera calling on behalf of the programme.");
  });

  it("a mission with no list of needs publishes every question once, by evidence key", () => {
    const bare = { ...M, evidence_requirements: undefined };
    const ids = buildVoiceForm(bare, VERIFICATION_EMPLOYEE_V1).form_fields.map(f => f.field_id).filter(id => !(VOICE_META_FIELDS as readonly string[]).includes(id));
    expect(ids).toEqual(["work_status", "employer_name", "role_title", "change_reason", "not_working_reason", "job_search", "course", "support_requested"]);
  });

  it("has a fingerprint that changes when the employee's tone changes, so a stale form is noticed", () => {
    const same = buildVoiceForm(M, VERIFICATION_EMPLOYEE_V1);
    expect(voiceFormHash(same)).toBe(voiceFormHash(form));
    const calmer = buildVoiceForm(M, { ...VERIFICATION_EMPLOYEE_V1, persona: "Calm and unhurried. Always thanks people for their time." });
    expect(voiceFormHash(calmer)).not.toBe(voiceFormHash(form));
  });
});

describe("what the voice agent is told about one person", () => {
  it("is a first name, the language and what is missing, and nothing else about the person", () => {
    const c = buildCallContext({ first_name: "Asha", programme: "Project Udaan", language: "hi", missing: [{ key: "employer_name", label: "Employer" }, { key: "role_title", label: "Job title or work" }], known: ["Current work status"] });
    expect(c).toContain("first name Asha");
    expect(c).toContain("Language: Hindi");
    expect(c).toContain("1. Employer (field employer_name)");
    expect(c).toContain("2. Job title or work (field role_title)");
    expect(c).toContain("Already known (do not ask again): Current work status.");
    expect(buildCallContext({ first_name: "Asha", language: "en", missing: null })).toContain("ask every field in the form");
  });
});

describe("turning what was said into evidence", () => {
  const q = (id: string) => questionById(DRAFT_INSTRUMENT, id);
  it("a spoken choice becomes its option value, and a yes or no becomes yes or no", () => {
    expect(normaliseVoiceAnswer(q("q_status"), "I work at a different place now")).toEqual({ value: "changed_job", confidence: 0.85 }); // matched from a phrase
    expect(normaliseVoiceAnswer(q("q_status"), "same_job")).toEqual({ value: "same_job", confidence: 0.95 }); // the exact code from the voice service
    expect(normaliseVoiceAnswer(q("q_support"), true)).toEqual({ value: "yes", confidence: 0.95 });
    expect(normaliseVoiceAnswer(q("q_support"), "nahi")).toEqual({ value: "no", confidence: 0.85 });
  });
  it("free text is trusted enough to rely on, and an answer that matches no option stays below the bar", () => {
    expect(normaliseVoiceAnswer(q("q_same_employer"), "  Acme Retail  ")).toEqual({ value: "Acme Retail", confidence: 0.85 });
    expect(normaliseVoiceAnswer(q("q_status"), "it is complicated")).toEqual({ value: "it is complicated", confidence: 0.5 });
  });
  it("silence is not an answer", () => {
    for (const v of [null, undefined, "", "   "]) expect(normaliseVoiceAnswer(q("q_status"), v)).toBeNull();
  });
});

describe.each(stores)("a finished call on a case: %s", (_n, make) => {
  async function world(withForm = true) {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    svc.voiceEnabled = true;
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: { participant_id: "p", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", location: "J", cohort: "B", language: "en", consent: "unknown", recorded_employer: "Acme" } });
    await svc.beginSession(T, "C-1", "t");
    if (withForm) await svc.store.putVoiceForm({ tenant_id: T, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "2026-10-12T00:00:00Z", published_by: "agent_ops:x" });
    return { svc, tools: new GatewayTools(svc) };
  }
  const session = { session_id: "s", tenant_id: T, case_id: "C-1", mission_version: M.version, employee_version: "x" };
  /** The agent asks for a call and the dispatcher places it: the case is now calling, with a call on record. */
  async function placeCall(svc: CaseService, tools: GatewayTools, id = "call_1") {
    const c = await svc.getCase(T, "C-1");
    const r = await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: `key-${id}-0001`, expected_version: c.version, reason: "No reply to WhatsApp for two days." });
    expect(r.error).toBeUndefined();
    await svc.store.putCall({ communication_id: id, tenant_id: T, case_id: "C-1", form_id: 900, status: "in_progress", requested_at: new Date().toISOString(), asked: ["work_status"] });
    const k = await svc.getCase(T, "C-1");
    await svc.transition(T, "C-1", k.version, "calling", { actor: "zolabs", summary: "Phone call started" });
  }
  const answered = (over: Partial<VoiceResult> = {}): VoiceResult => ({ communication_id: "call_1", status: "completed", consent_given: true, identity_confirmed: true, language: "en", audio_url: "https://a.example/1.mp3", transcript: "Asha said she works at Acme Retail.", duration_seconds: 140, answers: { work_status: "same_job", employer_name: "Acme", role_title: "Packer", consent_given: true }, ...over });

  it("answers become evidence marked as from a phone call, the case goes to the agent, and the audio and transcript stay on the call", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    const r = await ingestVoiceResult(svc, T, "C-1", answered());
    expect(r).toMatchObject({ applied: true, action: "answered", finished: true });
    const ev = await svc.store.listEvidence("C-1");
    expect(ev.map(e => `${e.question_id}=${e.value}:${e.source}`).sort()).toEqual(["employer_name=Acme:voice", "role_title=Packer:voice", "work_status=same_job:voice"]);
    expect(ev.every(e => !!e.at)).toBe(true);
    expect((await svc.getCase(T, "C-1")).status).toBe("evaluating");
    expect((await svc.store.getParticipant(T, "p"))?.consent).toBe("granted");
    expect(await svc.store.getCall(T, "call_1")).toMatchObject({ status: "completed", audio_url: "https://a.example/1.mp3", transcript: "Asha said she works at Acme Retail.", duration_seconds: 140, asked: ["work_status"] });
    // the requirements report sees the new answers: the employer matches the programme record
    const report = evaluateRequirements(M, ev, "Acme");
    expect(report.items.find(i => i.key === "employer_name")?.state).toBe("verified");
    // the ledger says what happened and holds no transcript or audio
    const ledger = JSON.stringify(await svc.store.listEvents(T, "C-1"));
    expect(ledger).toContain("Call completed (2 min); 3 answers");
    expect(ledger).not.toContain("works at Acme Retail");
    expect(ledger).not.toContain("a.example");
  });

  it("applying the same result again changes nothing", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    await ingestVoiceResult(svc, T, "C-1", answered());
    const before = (await svc.store.listEvidence("C-1")).length, events = (await svc.store.listEvents(T, "C-1")).length;
    const again = await Promise.all([ingestVoiceResult(svc, T, "C-1", answered()), ingestVoiceResult(svc, T, "C-1", answered())]);
    expect(again.every(x => x.applied === false && x.action === "ignored")).toBe(true);
    expect((await svc.store.listEvidence("C-1")).length).toBe(before);
    expect((await svc.store.listEvents(T, "C-1")).length).toBe(events);
  });

  it("a refusal on the call closes the case as an opt-out and records no answers, even if some came back", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    const r = await ingestVoiceResult(svc, T, "C-1", answered({ consent_given: false }));
    expect(r).toMatchObject({ action: "opted_out", finished: false });
    expect(await svc.getCase(T, "C-1")).toMatchObject({ status: "complete", outcome: "opted_out" });
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
    expect((await svc.store.getParticipant(T, "p"))?.consent).toBe("declined");
  });

  it("the wrong person's answers are not recorded, and a human looks at the case", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    const r = await ingestVoiceResult(svc, T, "C-1", answered({ identity_confirmed: false }));
    expect(r).toMatchObject({ action: "wrong_person", finished: false });
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
    const c = await svc.getCase(T, "C-1");
    expect(c.status).toBe("review");
    expect(c.reason).toContain("identity_mismatch");
    expect((await svc.store.listReviewTasks(T)).filter(t => t.status === "open")).toHaveLength(1);
  });

  it("a call nobody answered puts the case back to waiting, and the agent is not woken", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    const r = await ingestVoiceResult(svc, T, "C-1", { communication_id: "call_1", status: "no_answer", answers: {} });
    expect(r).toMatchObject({ action: "no_answer", finished: false });
    expect((await svc.getCase(T, "C-1")).status).toBe("waiting");
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
    expect((await svc.store.getCall(T, "call_1"))?.status).toBe("no_answer");
  });

  it("a call that is still going is not applied, and can be applied later", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    expect(await ingestVoiceResult(svc, T, "C-1", answered({ status: "in_progress" }))).toMatchObject({ applied: false, action: "pending" });
    expect(await ingestVoiceResult(svc, T, "C-1", answered())).toMatchObject({ applied: true, action: "answered" });
  });

  it("an answer that cannot be placed is kept but does not count, so the gap stays open", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    await ingestVoiceResult(svc, T, "C-1", answered({ answers: { work_status: "it is complicated" } }));
    const report = evaluateRequirements(M, await svc.store.listEvidence("C-1"));
    expect(report.items.find(i => i.key === "work_status")).toMatchObject({ state: "missing", confidence: 0.5 });
  });

  it("only records the call when the case is already closed", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    await svc.recordInbound(T, "C-1", { provider_event_id: "stop-1", channel: "whatsapp", summary: "stop", opt_out: true });
    const r = await ingestVoiceResult(svc, T, "C-1", answered());
    expect(r).toMatchObject({ applied: true, action: "ignored", finished: false });
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
    expect(await svc.store.getCall(T, "call_1")).toBeDefined();
  });

  it("deleting the case erases the call, its audio reference and its transcript", async () => {
    const { svc, tools } = await world();
    await placeCall(svc, tools);
    await ingestVoiceResult(svc, T, "C-1", answered());
    await svc.deleteCase({ user_id: "a", tenant_id: T, role: "admin" }, "C-1", "participant_request");
    expect(await svc.store.listCalls(T, "C-1")).toHaveLength(0);
    expect(await svc.store.getCall(T, "call_1")).toBeUndefined();
  });

  describe("asking for a call", () => {
    const ask = (tools: GatewayTools, version: number, extra: Record<string, unknown> = {}) => tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}`, expected_version: version, reason: "No reply for two days.", ...extra });

    it("is refused when phone calls are not switched on, or the mission's form has not been published", async () => {
      const a = await world(false);
      expect((await ask(a.tools, (await a.svc.getCase(T, "C-1")).version)).error?.code).toBe("VOICE_FORM_NOT_PUBLISHED");
      const b = await world();
      b.svc.voiceEnabled = false;
      expect((await ask(b.tools, (await b.svc.getCase(T, "C-1")).version)).error?.code).toBe("VOICE_NOT_CONFIGURED");
    });

    it("asks only for what is still missing, and records the agent's reason", async () => {
      const { svc, tools } = await world();
      await svc.store.addEvidence({ evidence_id: "ev1", case_id: "C-1", question_id: "work_status", value: "same_job", source: "whatsapp", confidence: 0.95, event_id: "e", at: new Date().toISOString() });
      const r = await ask(tools, (await svc.getCase(T, "C-1")).version, { reason: "The WhatsApp replies stopped after the first answer." });
      expect(r.error).toBeUndefined();
      expect((r.data as { will_ask: string[] }).will_ask).toEqual(["Employer", "Job title or work", "Wants job support"]); // optional needs are asked too, but not "why they changed jobs": they work at the same place
      const out = (await svc.store.listOutbox(T)).find(o => o.kind === "voice_call")!;
      expect(out.payload).toMatchObject({ form_id: 900, asked: ["employer_name", "role_title", "support_requested"], start_at: null, reason: "The WhatsApp replies stopped after the first answer." });
      expect(await svc.getCase(T, "C-1")).toMatchObject({ status: "call_scheduled", attempts: 1 });
      expect(JSON.stringify(await svc.store.listEvents(T, "C-1"))).toContain("Phone call requested: The WhatsApp replies stopped after the first answer.");
    });

    it("does not ring someone when everything is already known", async () => {
      const { svc, tools } = await world();
      const e = (id: string, key: string, value: string) => svc.store.addEvidence({ evidence_id: id, case_id: "C-1", question_id: key, value, source: "whatsapp", confidence: 0.95, event_id: "e", at: new Date().toISOString() });
      await e("e1", "work_status", "not_employed"); await e("e2", "not_working_reason", "seeking"); await e("e3", "job_search", "yes"); await e("e4", "support_requested", "no");
      expect((await ask(tools, (await svc.getCase(T, "C-1")).version)).error?.code).toBe("NOTHING_MISSING");
    });

    it("a later time must be inside the contact hours, not in the past and not too far off", async () => {
      const svc = new CaseService(make(), () => new Date("2026-10-12T05:00:00Z"), DEFAULT_POLICY); // 10:30 IST, window 09:30 to 18:00
      svc.voiceEnabled = true;
      await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: { participant_id: "p", tenant_id: T, display_name: "Asha", phone_masked: "•", location: "J", cohort: "B", language: "en", consent: "unknown", recorded_employer: "Acme" } });
      await svc.beginSession(T, "C-1", "t");
      await svc.store.putVoiceForm({ tenant_id: T, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "x", published_by: "y" });
      const tools = new GatewayTools(svc);
      const v = (await svc.getCase(T, "C-1")).version;
      const code = async (start_at: string) => (await ask(tools, v, { start_at })).error?.code;
      expect(await code("2026-10-12T04:00:00Z")).toBe("START_IN_THE_PAST");
      expect(await code("2026-10-30T05:00:00Z")).toBe("START_TOO_FAR");
      expect(await code("2026-10-13T16:00:00Z")).toBe("OUTSIDE_WINDOW"); // 21:30 IST
      expect(await code("2026-10-13T05:00:00Z")).toBeUndefined();         // 10:30 IST tomorrow
      expect((await svc.store.listOutbox(T)).find(o => o.kind === "voice_call")?.payload.start_at).toBe("2026-10-13T05:00:00.000Z");
    });

    it("the agent can see that a call is possible and what has been tried, without any transcript", async () => {
      const { svc, tools } = await world();
      await placeCall(svc, tools);
      await ingestVoiceResult(svc, T, "C-1", { communication_id: "call_1", status: "no_answer", answers: {}, transcript: "SECRET WORDS" });
      const ctx = (await tools.call(session, "case_get_context", { case_id: "C-1" })).data as { channels: { phone_call_available: boolean }; calls: { status: string; asked: string[] }[] };
      expect(ctx.channels.phone_call_available).toBe(true);
      expect(ctx.calls).toEqual([expect.objectContaining({ status: "no_answer", asked: ["work_status"] })]);
      expect(JSON.stringify(ctx)).not.toContain("SECRET WORDS");
    });
  });
});
