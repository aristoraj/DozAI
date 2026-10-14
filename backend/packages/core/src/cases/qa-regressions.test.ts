// Regressions found in a test-and-fix round. Each test failed before its fix.
import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { DocStore, InMemoryDocDriver } from "../storage/docstore";
import { InMemoryStore, type Store } from "../storage/store";
import { GatewayTools } from "../agent/tools";
import { PLACEMENT_RETENTION_V1, type MissionBundle } from "../missions/mission";
import { ingestVoiceResult } from "../conversation/voice";
import { CampaignService } from "./campaign";
import type { Principal } from "@dozai/contracts";
import { ConversationRunner } from "../conversation/conversation";
import { importParticipants } from "./intake";
import { normalizeMsisdn, redactForModel } from "./pii";
import { isStopRequest, RuleClassifier } from "../conversation/classifier";
import { DRAFT_INSTRUMENT, type Instrument } from "../missions/instrument";

const T = "t1";
const M = PLACEMENT_RETENTION_V1;
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore", () => new DocStore(new InMemoryDocDriver())]];
const person = { participant_id: "p", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", location: "J", cohort: "B", language: "en", consent: "unknown" as const, recorded_employer: "Acme" };

describe.each(stores)("found in testing: %s", (_n, make) => {
  it("a mission's own auto-confirm threshold is used: a stricter mission sends a 90% proposal to a person", async () => {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    const strict: MissionBundle = { ...M, version: "strict-v1", policy_overrides: { autoConfirmAt: 0.95 } };
    await svc.store.putMission(T, strict);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: strict.version, participant: person });
    const c = await svc.beginSession(T, "C-1", "t");
    const r = await svc.proposeDecision(T, "C-1", c.version, { proposed_outcome: "confirmed", livelihood_state: "same_job", confidence: 0.9, evidence_refs: [], rationale: "Says same job." }, "agent:s");
    expect(r.auto).toBe(false);
    expect(r.case.status).toBe("review");
    expect(r.case.reason).toContain("95%");
  });

  it("a scheduled call that reaches the wrong person goes to a human instead of leaving the case stuck as call_scheduled", async () => {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    svc.voiceEnabled = true;
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: person });
    await svc.beginSession(T, "C-1", "t");
    await svc.store.putVoiceForm({ tenant_id: T, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "2026-10-12T00:00:00Z", published_by: "agent_ops:x" });
    const tools = new GatewayTools(svc);
    const session = { session_id: "s", tenant_id: T, case_id: "C-1", mission_version: M.version, employee_version: "x" };
    const c = await svc.getCase(T, "C-1");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const req = await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: "key-sched-0001", expected_version: c.version, reason: "Asked to be called later.", start_at: at });
    expect(req.error).toBeUndefined();
    await svc.store.putCall({ communication_id: "call_s", tenant_id: T, case_id: "C-1", form_id: 900, status: "scheduled", scheduled_for: at, requested_at: new Date().toISOString(), asked: ["work_status"] });
    expect((await svc.getCase(T, "C-1")).status).toBe("call_scheduled");

    const r = await ingestVoiceResult(svc, T, "C-1", { communication_id: "call_s", status: "completed", consent_given: true, identity_confirmed: false, answers: { work_status: "same_job" } });
    expect(r).toMatchObject({ action: "wrong_person", finished: false });
    const after = await svc.getCase(T, "C-1");
    expect(after.status).toBe("review");
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
    expect((await svc.store.listReviewTasks(T)).filter(t => t.status === "open")).toHaveLength(1);
  });
});

describe.each(stores)("found in testing, replies and call results: %s", (_n, make) => {
  const staff: Principal = { user_id: "ops@x.org", tenant_id: T, role: "admin" };
  async function world() {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: person });
    await svc.beginSession(T, "C-1", "t");
    return svc;
  }

  it("the same reply delivered to two scheduler passes at once is recorded once", async () => {
    const svc = await world();
    const input = { provider_event_id: "wamid.1", channel: "whatsapp" as const, summary: "Participant replied", answers: [{ question_id: "work_status", value: "same_job", confidence: 0.9 }] };
    const r = await Promise.all([svc.recordInbound(T, "C-1", input), svc.recordInbound(T, "C-1", input)]);
    expect(r.filter(x => x.duplicate)).toHaveLength(1);
    expect((await svc.store.listEvents(T, "C-1")).filter(e => e.type === "message_received")).toHaveLength(1);
    expect(await svc.store.listEvidence("C-1")).toHaveLength(1);
  });

  it("a call result that arrives after the case was deleted does not bring back the erased transcript or audio", async () => {
    const svc = await world();
    await svc.store.putCall({ communication_id: "call_d", tenant_id: T, case_id: "C-1", form_id: 900, status: "in_progress", requested_at: new Date().toISOString(), asked: [] });
    await svc.deleteCase(staff, "C-1", "asked to be forgotten");
    expect(await svc.store.getCall(T, "call_d")).toBeUndefined();
    const r = await ingestVoiceResult(svc, T, "C-1", { communication_id: "call_d", status: "completed", consent_given: true, identity_confirmed: true, transcript: "Asha said she works at Acme.", audio_url: "https://a.example/d.mp3", answers: { work_status: "same_job" } });
    expect(r.applied).toBe(true);
    expect(await svc.store.getCall(T, "call_d")).toBeUndefined();
  });
});

describe.each(stores)("found in testing, a call result that fails halfway: %s", (_n, make) => {
  it("is applied again by the next sync instead of being lost, and its answers are recorded once", async () => {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: person });
    let c = await svc.beginSession(T, "C-1", "t");
    c = await svc.transition(T, "C-1", c.version, "call_scheduled", { actor: "t", summary: "call" });
    c = await svc.transition(T, "C-1", c.version, "calling", { actor: "t", summary: "call" });
    await svc.store.putCall({ communication_id: "call_f", tenant_id: T, case_id: "C-1", form_id: 900, status: "in_progress", requested_at: new Date().toISOString(), asked: [] });
    const result = { communication_id: "call_f", status: "completed" as const, consent_given: true, identity_confirmed: true, answers: { work_status: "same_job" } };
    const real = svc.transition.bind(svc);
    let once = true;
    svc.transition = (async (...a: Parameters<typeof real>) => { if (once) { once = false; throw new Error("case changed concurrently"); } return real(...a); }) as typeof real;
    await expect(ingestVoiceResult(svc, T, "C-1", result)).rejects.toThrow("concurrently");
    expect((await svc.store.getCall(T, "call_f"))?.status).toBe("in_progress"); // still asked about by the next sync
    const again = await ingestVoiceResult(svc, T, "C-1", result);
    expect(again).toMatchObject({ applied: true, action: "answered", finished: true });
    expect((await svc.getCase(T, "C-1")).status).toBe("evaluating");
    expect(await svc.store.listEvidence("C-1")).toHaveLength(1);
  });
});

describe.each(stores)("found in testing, the order of answers: %s", (_n, make) => {
  it("answers come back oldest first in both stores, and a later employer answer is the one checked against the record", async () => {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: person });
    const c = await svc.beginSession(T, "C-1", "t");
    // ids that sort the other way round from the times
    await svc.store.addEvidence({ evidence_id: "ev_zzz", case_id: "C-1", question_id: "employer_name", value: "Acme", source: "whatsapp", confidence: 0.9, event_id: "e1", at: "2026-10-14T05:00:00.000Z" });
    await svc.store.addEvidence({ evidence_id: "ev_aaa", case_id: "C-1", question_id: "employer_name", value: "Nova Services", source: "voice", confidence: 0.9, event_id: "e2", at: "2026-10-14T06:00:00.000Z" });
    expect((await svc.store.listEvidence("C-1")).map(e => e.evidence_id)).toEqual(["ev_zzz", "ev_aaa"]);
    const r = await svc.proposeDecision(T, "C-1", c.version, { proposed_outcome: "confirmed", livelihood_state: "same_job", confidence: 0.95, evidence_refs: ["ev_aaa"], rationale: "Same job." }, "agent:s");
    expect(r.auto).toBe(false);
    expect(r.case.reason).toContain("Nova Services");
  });
});

describe("found in testing: campaigns", () => {
  const ops: Principal = { user_id: "ops@x.org", tenant_id: T, role: "operator" };
  async function world() {
    let t = new Date("2026-10-12T05:00:00Z").getTime(); // 10:30 IST
    const svc = new CaseService(new InMemoryStore(), () => new Date(t), DEFAULT_POLICY);
    for (const i of [1, 2, 3]) await svc.createCase({ tenant_id: T, run_id: "r", case_id: `DZ-000${i}`, participant: { ...person, participant_id: `p${i}` } });
    return { svc, camps: new CampaignService(svc), advance: (min: number) => { t += min * 60_000; } };
  }

  it("someone who opted out is not in the queue, does not use up the daily cap, and the campaign still finishes", async () => {
    const w = await world();
    await w.svc.store.putParticipant({ ...person, participant_id: "p1", consent: "declined" });
    const camp = await w.camps.create(ops, { name: "Cohort 1", per_tick: 3, daily_cap: 4 });
    expect((await w.camps.progress(T, [camp])).get(camp.campaign_id)?.queued).toBe(2);
    await w.camps.act(ops, camp.campaign_id, "start");
    for (let i = 0; i < 3; i++) { await w.camps.run(T); w.advance(1); }
    expect((await w.svc.getCase(T, "DZ-0001")).status).toBe("draft");
    expect((await w.svc.store.listOutbox(T)).length).toBe(2);
    expect((await w.camps.get(T, camp.campaign_id)).status).toBe("completed");
  });

  it("a pause pressed while a batch is being written back is not undone by it", async () => {
    const w = await world();
    const camp = await w.camps.create(ops, { name: "Cohort 1", per_tick: 1, daily_cap: 10 });
    await w.camps.act(ops, camp.campaign_id, "start");
    // The run reads the campaign to record its batch; at that moment a person presses pause.
    const read = w.svc.store.getCampaign.bind(w.svc.store);
    let pressed = false, inRun = false;
    w.svc.store.getCampaign = async (t, id) => {
      const c = await read(t, id);
      if (inRun && !pressed) { pressed = true; await w.camps.act(ops, camp.campaign_id, "pause"); }
      return c;
    };
    inRun = true;
    await w.camps.run(T);
    inRun = false;
    expect(pressed).toBe(true);
    expect((await read(T, camp.campaign_id))?.status).toBe("paused");
  });

  it("a deleted campaign cannot be resumed, and is not run even if it was left running in storage", async () => {
    const w = await world();
    const camp = await w.camps.create(ops, { name: "Cohort 1", per_tick: 1, daily_cap: 10 });
    await w.camps.act(ops, camp.campaign_id, "start");
    await w.camps.act(ops, camp.campaign_id, "pause");
    await w.camps.remove(ops, camp.campaign_id);
    await expect(w.camps.act(ops, camp.campaign_id, "resume")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const gone = await w.camps.get(T, camp.campaign_id);
    await w.svc.store.putCampaign({ ...gone, status: "running" }); // e.g. a pass that read it before the delete wrote it back
    expect(await w.camps.run(T)).toEqual([]);
    expect(await w.svc.store.listOutbox(T)).toHaveLength(0);
  });
});

describe("found in testing: the conversation's message limit", () => {
  it("hands the case to a person when the limit is reached, instead of leaving it mid-interview with nobody told", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
    await svc.beginSession(T, "C-1", "t");
    const small: Instrument = { ...DRAFT_INSTRUMENT, max_messages: 2, draft: false };
    const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true, instrument: small });
    await runner.handleReply(T, "C-1", "yes");
    await runner.handleReply(T, "C-1", "1");
    await expect(runner.handleReply(T, "C-1", "Acme")).rejects.toMatchObject({ code: "MESSAGE_CAP" }); // still refused: nothing more is sent
    const c = await svc.getCase(T, "C-1");
    expect(c.status).toBe("review");
    expect(c.reason).toContain("message_limit");
    expect((await svc.store.getConversation(T, "C-1"))?.status).toBe("escalated");
    expect((await svc.store.listOutbox(T)).filter(o => o.kind === "whatsapp_text")).toHaveLength(2);
  });
});

describe("found in testing: phone numbers at import", () => {
  const admin: Principal = { user_id: "u", tenant_id: T, role: "admin" };
  const opts = { piiKey: Buffer.alloc(32, 7).toString("base64"), defaultCountryCode: "91", missionVersion: M.version };
  const svc = () => new CaseService(new InMemoryStore(), () => new Date(), OPEN);

  it("a number written with the country code and a trunk zero is the same number, so it is not added twice", async () => {
    expect(normalizeMsisdn("+91 098765 00201")).toBe("919876500201");
    expect(normalizeMsisdn("0091 98765 00201")).toBe("919876500201");
    const r = await importParticipants(svc(), admin, [{ name: "Asha Test", phone: "9876500201" }, { name: "Asha Test", phone: "+91 098765 00201" }], opts);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([{ row: 2, reason: expect.stringContaining("already in this mission") }]);
  });

  it("a number with letters in it is refused instead of silently becoming another number", async () => {
    const r = await importParticipants(svc(), admin, [{ name: "Asha Test", phone: "98765abc00201" }], opts);
    expect(r.created).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/phone/);
  });

  it("an Indian number that cannot be a mobile (it must start with 6 to 9) is refused, with the reason", async () => {
    const r = await importParticipants(svc(), admin, [{ name: "Asha Test", phone: "1234567890" }, { name: "Ravi Test", phone: "+91 5876500201" }, { name: "Mia Test", phone: "+44 7700 900123" }], opts);
    expect(r.skipped.map(x => x.row)).toEqual([1, 2]);
    expect(r.skipped[0]?.reason).toContain("mobile");
    expect(r.created).toHaveLength(1); // a number from another country is not judged by the Indian rule
  });
});

describe.each(stores)("found in testing, deleting a case when the person is in two missions: %s", (_n, make) => {
  it("keeps their unprocessed reply while their other case is open, and erases it once no case of theirs is", async () => {
    const svc = new CaseService(make(), () => new Date(), OPEN);
    const admin: Principal = { user_id: "u", tenant_id: T, role: "admin" };
    const other: MissionBundle = { ...M, version: "second-v1" };
    await svc.store.putMission(T, other);
    const who = (id: string) => ({ ...person, participant_id: id, phone_hash: "hash-of-9876500201" });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-A", mission_version: M.version, participant: who("pa") });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-B", mission_version: other.version, participant: who("pb") });
    await svc.beginSession(T, "C-B", "t");
    await svc.store.putInbox({ inbox_id: "in:w1", tenant_id: T, source: "interakt", event: { kind: "inbound", phone: "", phone_hash: "hash-of-9876500201", text: "My answer for the second survey" }, status: "pending", received_at: new Date().toISOString() });
    await svc.deleteCase(admin, "C-A", "participant_request");
    expect((await svc.store.listInbox(T)).map(i => i.inbox_id)).toEqual(["in:w1"]); // still there for case C-B
    await svc.deleteCase(admin, "C-B", "participant_request");
    expect(await svc.store.listInbox(T)).toHaveLength(0);
  });
});

describe("found in testing: the person's name never reaches a model", () => {
  it("redaction removes the person's own name, in any case, as whole words only", () => {
    expect(redactForModel("I am Asha Kumari, call me on 98765 00201", ["Asha Kumari"])).toBe("I am [name] [name], call me on [number]");
    expect(redactForModel("asha here", ["Asha"])).toBe("[name] here");
    expect(redactForModel("Ashadeep Traders", ["Asha"])).toBe("Ashadeep Traders");
    expect(redactForModel("no names given", [])).toBe("no names given");
  });

  it("the agent's view of the case carries answers with the name and number taken out", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant: { ...person, display_name: "Asha Kumari", first_name: "Asha" } });
    await svc.beginSession(T, "C-1", "t");
    await svc.recordInbound(T, "C-1", { provider_event_id: "w1", channel: "whatsapp", summary: "reply", answers: [{ question_id: "employer_name", value: "Asha Kumari here, I work at Acme, my number is 98765 00201", confidence: 0.9 }] });
    const r = await new GatewayTools(svc).call({ session_id: "s", tenant_id: T, case_id: "C-1", mission_version: M.version, employee_version: "x" }, "case_get_context", { case_id: "C-1" });
    const seen = JSON.stringify(r.data);
    expect(seen).toContain("I work at Acme");
    expect(seen).not.toMatch(/Asha|Kumari|98765/);
    expect((await svc.store.listEvidence("C-1"))[0]?.value).toContain("Asha Kumari"); // the record itself is unchanged
  });
});

describe("found in testing: stop, wrong number and deletion in the words people actually use", () => {
  const ins = DRAFT_INSTRUMENT;
  const text = ins.questions.find(q => q.type === "text")!;
  const intent = async (t: string) => (await new RuleClassifier().classify({ text: t, question: text, context: "question", instrument: ins })).intent;

  it.each(["mat bhejo", "message mat karo", "msg mat bhejna", "band kar do", "bandh karo", "please don't message me", "do not send messages", "no more messages", "STOP!!", "stop it", "Stop, I don't want this"])("'%s' is a stop", async t => {
    expect(await intent(t)).toBe("stop");
    expect(isStopRequest(t)).toBe(true);
  });

  it.each(["I wait near the bus stop", "I had to stop working last year", "non-stop shifts at Acme", "nahi chahiye"])("'%s' is not a stop", async t => {
    expect(await intent(t)).not.toBe("stop");
    expect(isStopRequest(t)).toBe(false);
  });

  it.each(["galat number", "wrong no.", "aap galat number par message kar rahe ho"])("'%s' goes to a person as a wrong number", async t => expect(await intent(t)).toBe("wrong_person"));
  it.each(["mera data delete karo", "mera number hata do", "meri details hata do"])("'%s' goes to a person as a deletion request", async t => expect(await intent(t)).toBe("deletion"));
});
