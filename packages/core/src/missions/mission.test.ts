import { describe, it, expect } from "vitest";
import type { MissionInput, Participant, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, DozaiError } from "../cases/service";
import { DocStore, InMemoryDocDriver } from "../storage/docstore";
import { InMemoryStore, type Store } from "../storage/store";
import { ConversationRunner } from "../conversation/conversation";
import { RuleClassifier } from "../conversation/classifier";
import { GatewayTools } from "../agent/tools";
import { DRAFT_INSTRUMENT } from "./instrument";
import { instrumentProblems, missionProblems, parseMission, PLACEMENT_RETENTION_V1 } from "./mission";

const T = "t1";
const admin: Principal = { user_id: "a@x.org", tenant_id: T, role: "admin" };
const person = (id: string, cohort = "B1"): Participant => ({ participant_id: id, tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", location: "J", cohort, language: "en", consent: "unknown", recorded_employer: "Acme" });

/** A small but complete mission for a different client: its own questions, wording, window and intro template. */
const loan = (over: Partial<MissionInput> = {}): MissionInput => ({
  mission_id: "MSN-LOAN", version: "MSN-LOAN-v1", name: "Loan repayment check-in", programme_name: "Kisan Credit",
  intro_template: "loan_intro_v1",
  templates: [{ key: "loan_intro_v1", language: "en", purpose: "Opens contact", provider_name: "loan_intro_v1", body_fields: ["first_name", "programme"] }],
  policy: { maxAttempts: 2, windowStartHour: 11, windowEndHour: 16 },
  agent_guidance: "This is a loan check-in. Treat any mention of hardship as a reason to ask a person to review.",
  instrument: {
    version: "LOAN-1", draft: false,
    start_message: "Thanks. Two quick questions about your loan.", closing_message: "Thank you. We are done.",
    reask_prefix: "Sorry, please pick one.", unsupported_prefix: "Please send text only.", handover_message: "A colleague will call you.",
    wrong_person_message: "Sorry, wrong number.", distress_message: "We will call you soon.", deletion_message: "Noted.",
    faq: [{ id: "who", keywords: ["who"], answer: "We are the Kisan Credit team." }],
    max_reasks: 1, max_messages: 12,
    questions: [
      { id: "q_paid", module: "repayment", type: "yesno", evidence_key: "paid_on_time", text: "Did you pay your last instalment on time?", next: [{ when: { equals: "no" }, goto: "q_why" }, { goto: null }] },
      { id: "q_why", module: "repayment", type: "choice", evidence_key: "late_reason", text: "Why was it late?", options: [{ key: "1", label: "Crop failed", value: "crop" }, { key: "2", label: "Medical cost", value: "medical" }], next: [{ goto: null }] },
    ],
  },
  ...over,
});

const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore", () => new DocStore(new InMemoryDocDriver())]];

describe("checking a mission before it is saved", () => {
  it("accepts a complete mission", () => {
    expect(parseMission(loan(), "admin", new Date()).problems).toEqual([]);
  });

  it("explains each kind of mistake in plain words", () => {
    const base = loan();
    const q = base.instrument.questions;
    const bad = (m: MissionInput) => missionProblems(m).join(" | ");
    expect(bad({ ...base, intro_template: "nope" })).toContain('intro_template "nope" is not in the templates list');
    expect(bad({ ...base, version: PLACEMENT_RETENTION_V1.version })).toContain("built-in mission");
    expect(bad({ ...base, policy: { windowStartHour: 18, windowEndHour: 9 } })).toContain("must end after it starts");
    expect(bad({ ...base, instrument: { ...base.instrument, questions: [{ ...q[0]!, next: [{ goto: "q_missing" }] }, q[1]!] } })).toContain('"q_missing", which does not exist');
    expect(bad({ ...base, instrument: { ...base.instrument, questions: [{ ...q[0]!, id: "q_why" }, q[1]!] } })).toContain('"q_why" is used twice');
    expect(bad({ ...base, instrument: { ...base.instrument, questions: [q[0]!, { ...q[1]!, options: [q[1]!.options![0]!] }] } })).toContain("at least 2 options");
    expect(bad({ ...base, instrument: { ...base.instrument, questions: [{ ...q[0]!, next: [{ when: { equals: "maybe" }, goto: null }] }, q[1]!] } })).toContain('"maybe", which is not one of its options');
  });

  it("catches a loop in the question flow", () => {
    const base = loan();
    const looped = [{ ...base.instrument.questions[0]!, next: [{ goto: "q_why" }] }, { ...base.instrument.questions[1]!, next: [{ goto: "q_paid" }] }];
    expect(instrumentProblems({ ...(base.instrument as typeof DRAFT_INSTRUMENT), questions: looped })).toEqual([expect.stringContaining("loop")]);
    expect(instrumentProblems(DRAFT_INSTRUMENT)).toEqual([]); // the built-in flow is fine
  });

  it("returns schema problems as readable text, not a crash", () => {
    const r = parseMission({ ...loan(), version: "x" }, "admin", new Date());
    expect(r.bundle).toBeUndefined();
    expect(r.problems.join(" ")).toContain("version");
  });
});

describe.each(stores)("missions in the store: %s", (_n, make) => {
  it("saves a mission, lists it after the built-in one, and never lets a version be overwritten", async () => {
    const svc = new CaseService(make());
    const m = await svc.createMission(admin, loan());
    expect(m).toMatchObject({ version: "MSN-LOAN-v1", instrument_signed_off: true, created_by: "admin:a@x.org" });
    expect((await svc.listMissions(T)).map(x => x.version)).toEqual([PLACEMENT_RETENTION_V1.version, "MSN-LOAN-v1"]);
    expect((await svc.defaultMission(T)).version).toBe("MSN-LOAN-v1");
    await expect(svc.createMission(admin, loan({ name: "Changed" }))).rejects.toMatchObject({ code: "MISSION_EXISTS" });
    expect((await svc.getMission(T, "MSN-LOAN-v1")).name).toBe("Loan repayment check-in");
  });

  it("refuses an invalid mission with the list of problems", async () => {
    const svc = new CaseService(make());
    await expect(svc.createMission(admin, loan({ intro_template: "nope" }))).rejects.toMatchObject({ code: "INVALID_MISSION", httpStatus: 400 });
    await expect(svc.getMission(T, "MSN-NONE-v1")).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });

  it("keeps missions apart by tenant", async () => {
    const s = make();
    await new CaseService(s).createMission(admin, loan());
    await expect(new CaseService(s).getMission("other", "MSN-LOAN-v1")).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });
});

describe("DocStore mission storage", () => {
  it("stores a mission far bigger than one row and reads it back unchanged", async () => {
    const s = new DocStore(new InMemoryDocDriver());
    const svc = new CaseService(s);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `q_${i}`, module: "m", type: "text" as const, evidence_key: `k_${i}`, text: `Question number ${i}: ` + "words ".repeat(60) }));
    const big = loan({ instrument: { ...loan().instrument, questions: many } });
    const saved = await svc.createMission(admin, big);
    expect(JSON.stringify(saved).length).toBeGreaterThan(9000 * 3);
    const fresh = await new CaseService(s).getMission(T, big.version);
    expect(fresh).toEqual(saved);
  });

  it("when two people save the same version at once, exactly one wins and the stored mission is whole", async () => {
    const s = new DocStore(new InMemoryDocDriver());
    const results = await Promise.allSettled([
      new CaseService(s).createMission(admin, loan({ name: "Version from Asha" })),
      new CaseService(s).createMission(admin, loan({ name: "Version from Ravi" })),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{ name: string }>).value.name;
    expect((await new CaseService(s).getMission(T, "MSN-LOAN-v1")).name).toBe(winner);
  });

  it("purge-all removes people's records but keeps missions", async () => {
    const s = new DocStore(new InMemoryDocDriver());
    const svc = new CaseService(s);
    await svc.createMission(admin, loan());
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person("p1") });
    await s.purgeAll();
    expect(await s.listCases(T)).toHaveLength(0);
    expect((await new CaseService(s).getMission(T, "MSN-LOAN-v1")).name).toBe("Loan repayment check-in");

    const mem = new InMemoryStore();
    await mem.putMission(T, (await svc.getMission(T, "MSN-LOAN-v1")));
    await mem.purgeAll();
    expect(await mem.listMissions(T)).toHaveLength(1);
  });
});

describe("each case follows its own mission", () => {
  async function world() {
    const svc = new CaseService(new InMemoryStore(), () => new Date("2026-10-12T06:00:00Z"), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createMission(admin, loan());
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-A", participant: person("pA"), mission_version: PLACEMENT_RETENTION_V1.version });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-B", participant: person("pB"), mission_version: "MSN-LOAN-v1" });
    const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true });
    return { svc, runner };
  }
  const sentTexts = async (svc: CaseService, caseId: string) => (await svc.store.listOutbox(T)).filter(o => o.case_id === caseId).map(o => String(o.payload.text ?? ""));

  it("a case is pinned to a mission when it is created, and cannot be created under an unknown one", async () => {
    const { svc } = await world();
    expect((await svc.getCase(T, "C-B")).mission_version).toBe("MSN-LOAN-v1");
    await expect(svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-X", participant: person("pX"), mission_version: "MSN-NOPE-v1" })).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });

  it("two cases in the same system ask different questions in different words", async () => {
    const { svc, runner } = await world();
    for (const id of ["C-A", "C-B"]) { await svc.beginSession(T, id, "t"); await runner.handleReply(T, id, "yes"); }
    expect((await sentTexts(svc, "C-B")).join("\n")).toContain("Did you pay your last instalment on time?");
    expect((await sentTexts(svc, "C-B")).join("\n")).toContain("Two quick questions about your loan");
    expect((await sentTexts(svc, "C-A")).join("\n")).toContain("Which of these describes you best");
    expect((await sentTexts(svc, "C-A")).join("\n")).not.toContain("loan");
  });

  it("follows the mission's own branching, limits and closing words", async () => {
    const { svc, runner } = await world();
    await svc.beginSession(T, "C-B", "t");
    await runner.handleReply(T, "C-B", "yes");
    await runner.handleReply(T, "C-B", "no");                    // branches to q_why
    expect((await sentTexts(svc, "C-B")).at(-1)).toContain("Why was it late?");
    expect((await runner.handleReply(T, "C-B", "2")).finished).toBe(true);
    expect((await sentTexts(svc, "C-B")).at(-1)).toBe("Thank you. We are done.");
    expect((await svc.store.listEvidence("C-B")).map(e => `${e.question_id}=${e.value}`)).toEqual(["paid_on_time=no", "late_reason=medical"]);
  });

  it("this mission's limit of one re-ask hands over after one wrong reply", async () => {
    const { svc, runner } = await world();
    await svc.beginSession(T, "C-B", "t");
    await runner.handleReply(T, "C-B", "yes");
    expect((await runner.handleReply(T, "C-B", "banana")).action).toBe("reasked");
    expect((await runner.handleReply(T, "C-B", "banana again")).action).toBe("escalated");
    expect((await sentTexts(svc, "C-B")).at(-1)).toBe("A colleague will call you.");
  });

  it("a mission's own contact window applies to its cases and not to others, and the testing override beats it", async () => {
    // 06:00 UTC is 11:30 IST: inside the loan window (11 to 16) but outside a 12 to 16 one.
    const clock = () => new Date("2026-10-12T06:00:00Z");
    const svc = new CaseService(new InMemoryStore(), clock, DEFAULT_POLICY);
    await svc.createMission(admin, loan({ version: "MSN-LOAN-v2", policy: { windowStartHour: 12, windowEndHour: 16 } }));
    await svc.createMission(admin, loan({ version: "MSN-LOAN-v3", policy: { windowStartHour: 11, windowEndHour: 16 } }));
    for (const [id, v] of [["C-1", "MSN-LOAN-v2"], ["C-2", "MSN-LOAN-v3"]] as const) await svc.createCase({ tenant_id: T, run_id: "r", case_id: id, participant: person(`p${id}`), mission_version: v });
    expect(await svc.gateContact(await svc.getCase(T, "C-1"))).toMatchObject({ allowed: false, code: "OUTSIDE_WINDOW" });
    expect(await svc.gateContact(await svc.getCase(T, "C-2"))).toEqual({ allowed: true });
    svc.forceWindow = { windowStartHour: 0, windowEndHour: 24 };
    expect(await svc.gateContact(await svc.getCase(T, "C-1"))).toEqual({ allowed: true });
  });

  it("the agent's tool gateway serves the case's own mission, including its intro template and attempt limit", async () => {
    const { svc } = await world();
    await svc.beginSession(T, "C-B", "t");
    const tools = new GatewayTools(svc);
    const s = { session_id: "s1", tenant_id: T, case_id: "C-B", mission_version: "MSN-LOAN-v1", employee_version: "1" };
    const b = await tools.call(s, "mission_get_bundle", { mission_version_id: "MSN-LOAN-v1" });
    expect(b.data).toMatchObject({ version: "MSN-LOAN-v1", intro_template: "loan_intro_v1", contact_policy: { maxAttempts: 2 } });
    const wrong = await tools.call(s, "mission_get_bundle", { mission_version_id: PLACEMENT_RETENTION_V1.version });
    expect(wrong.error?.code).toBe("MISSION_VERSION_MISMATCH");
    // A template from the other mission is not approved here.
    const other = await tools.call(s, "whatsapp_send_template", { case_id: "C-B", template_key: "placement_intro_v1", idempotency_key: "key-12345678", expected_version: (await svc.getCase(T, "C-B")).version });
    expect(other.error?.code).toBe("TEMPLATE_NOT_APPROVED");
  });
});

describe("a mission that states its goal", () => {
  const goal = (over: Partial<MissionInput> = {}): MissionInput => loan({
    objective: "Find out whether the borrower paid the last instalment on time and, if not, why.",
    evidence_requirements: [
      { key: "paid_on_time", label: "Paid on time", required: true, min_confidence: 0.6 },
      { key: "late_reason", label: "Reason it was late", required: true, when: { key: "paid_on_time", in: ["no"] }, min_confidence: 0.6 },
    ],
    strategy: { channels: ["whatsapp"], follow_up_after_hours: 24, notes: "Short messages only." },
    ...over,
  });

  it("is saved and read back with its goal, needs and strategy, in both stores", async () => {
    for (const [, make] of stores) {
      const svc = new CaseService(make());
      await svc.createMission(admin, goal());
      const m = await new CaseService((svc as unknown as { store: Store }).store).getMission(T, "MSN-LOAN-v1");
      expect(m.objective).toContain("last instalment");
      expect(m.evidence_requirements).toHaveLength(2);
      expect(m.strategy).toEqual({ channels: ["whatsapp"], follow_up_after_hours: 24, notes: "Short messages only." });
    }
  });

  it("refuses needs that nothing can fill, or that wait for an answer that cannot happen", async () => {
    const svc = new CaseService(new InMemoryStore());
    const base = goal().evidence_requirements!;
    const reject = (reqs: MissionInput["evidence_requirements"]) => svc.createMission(admin, goal({ evidence_requirements: reqs })).then(() => "saved", (e: Error) => e.message);
    expect(await reject([...base, { key: "income", label: "Income", required: true, min_confidence: 0.6 }])).toContain('"income" has no question that can fill it');
    expect(await reject([base[0]!, { ...base[1]!, when: { key: "paid_on_time", in: ["maybe"] } }])).toContain('"maybe", which "paid_on_time" can never have');
    expect(await reject([base[1]!])).toContain('waits for "paid_on_time", which is not an evidence need');
  });

  it("missions saved before this existed still work and simply have no list of needs", async () => {
    const svc = new CaseService(new InMemoryStore());
    const m = await svc.createMission(admin, loan());
    expect(m.evidence_requirements).toBeUndefined();
    expect(m.objective).toBeUndefined();
  });
});

describe("DozaiError is still thrown for bad missions", () => {
  it("is a DozaiError with a 400", async () => {
    const svc = new CaseService(new InMemoryStore());
    const e = await svc.createMission(admin, { nope: true }).catch(x => x);
    expect(e).toBeInstanceOf(DozaiError);
    expect(e.httpStatus).toBe(400);
  });
});

// ---- signing off: the same mission is approved in place --------------------------------------------------------------------------------
import type { MissionBundle } from "./mission";

const definitionOf = (m: MissionBundle) => ({ mission_id: m.mission_id, version: m.version, name: m.name, programme_name: m.programme_name, intro_template: m.intro_template, templates: m.templates, policy: m.policy_overrides, agent_guidance: m.agent_guidance, employee_id: m.employee_id, employee_version: m.employee_version, objective: m.objective, evidence_requirements: m.evidence_requirements, strategy: m.strategy, instrument: m.instrument });
const approved = (m: MissionBundle, over: Record<string, unknown> = {}) => ({ ...definitionOf(m), instrument: { ...m.instrument, draft: false }, ...over });
const draftLoan = () => loan({ instrument: { ...loan().instrument, draft: true } });

describe.each(stores)("signing off a mission in place: %s", (_n, make) => {
  it("approves the same version: no second mission, same place in the list, who and when recorded", async () => {
    const s = make(), svc = new CaseService(s);
    const draft = await svc.createMission(admin, draftLoan());
    await svc.createMission(admin, loan({ mission_id: "MSN-OTHER", version: "MSN-OTHER-v1" }));
    const before = (await svc.listMissions(T)).map(m => m.version);
    expect(draft.instrument_signed_off).toBe(false);
    const signed = await svc.signOffMission(admin, draft.version, approved(draft));
    expect(signed).toMatchObject({ version: "MSN-LOAN-v1", instrument_signed_off: true, created_at: draft.created_at, created_by: draft.created_by });
    expect(signed.instrument.signed_off).toMatchObject({ by: "admin:a@x.org" });
    expect((await svc.listMissions(T)).map(m => m.version)).toEqual(before);            // same missions, same order
    const fresh = await new CaseService(s).getMission(T, draft.version);                 // another copy of the server reads the approved one
    expect(fresh.instrument.draft).toBe(false);
    expect(fresh).toEqual(signed);
  });

  it("can happen once: after it the mission never changes again", async () => {
    const svc = new CaseService(make());
    const draft = await svc.createMission(admin, draftLoan());
    await svc.signOffMission(admin, draft.version, approved(draft));
    await expect(svc.signOffMission(admin, draft.version, approved(draft, { name: "Changed after approval" }))).rejects.toMatchObject({ code: "ALREADY_SIGNED_OFF", httpStatus: 409 });
    expect((await svc.getMission(T, draft.version)).name).toBe("Loan repayment check-in");
    await expect(svc.createMission(admin, approved(draft))).rejects.toMatchObject({ code: "MISSION_EXISTS" }); // saving over it is still refused
  });

  it("takes the questions as edited on the way to sign-off", async () => {
    const svc = new CaseService(make());
    const draft = await svc.createMission(admin, draftLoan());
    const questions = draft.instrument.questions.map((q, n) => (n === 0 ? { ...q, text: "Was your last instalment paid on time?" } : q));
    const signed = await svc.signOffMission(admin, draft.version, approved(draft, { instrument: { ...draft.instrument, draft: false, questions } }));
    expect(signed.instrument.questions[0]!.text).toBe("Was your last instalment paid on time?");
    expect((await svc.getMission(T, draft.version)).instrument.questions[0]!.text).toBe("Was your last instalment paid on time?");
  });

  it("refuses a request that changes the version or leaves the wording a draft", async () => {
    const svc = new CaseService(make());
    const draft = await svc.createMission(admin, draftLoan());
    await expect(svc.signOffMission(admin, draft.version, approved(draft, { version: "MSN-LOAN-v2" }))).rejects.toMatchObject({ code: "INVALID_MISSION" });
    await expect(svc.signOffMission(admin, draft.version, definitionOf(draft))).rejects.toMatchObject({ code: "INVALID_MISSION" });   // still a draft
    await expect(svc.signOffMission(admin, "MSN-NONE-v1", approved(draft))).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    expect((await svc.getMission(T, draft.version)).instrument.draft).toBe(true);        // nothing changed
  });

  it("records who signed whatever the request claims", async () => {
    const svc = new CaseService(make());
    const draft = await svc.createMission(admin, draftLoan());
    const signed = await svc.signOffMission(admin, draft.version, approved(draft, { instrument: { ...draft.instrument, draft: false, signed_off: { by: "someone-important", at: "2020-01-01T00:00:00.000Z" } } }));
    expect(signed.instrument.signed_off!.by).toBe("admin:a@x.org");
    expect(signed.instrument.signed_off!.at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("two sign-offs at the same moment: one approval, and the other is refused", async () => {
    const s = make(), draft = await new CaseService(s).createMission(admin, draftLoan());
    const r = await Promise.allSettled([new CaseService(s).signOffMission(admin, draft.version, approved(draft)), new CaseService(s).signOffMission(admin, draft.version, approved(draft))]);
    expect(r.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter(x => x.status === "rejected")[0]).toMatchObject({ reason: { code: "ALREADY_SIGNED_OFF" } });
    expect((await new CaseService(s).listMissions(T)).filter(m => m.version === draft.version)).toHaveLength(1);
  });

  it("keeps the phone form that was published for the mission", async () => {
    const s = make(), svc = new CaseService(s);
    const draft = await svc.createMission(admin, draftLoan());
    await s.putVoiceForm({ tenant_id: T, mission_version: draft.version, form_id: 77, definition_hash: "h", published_at: "2026-10-12T00:00:00Z", published_by: "agent_ops:x" });
    await svc.signOffMission(admin, draft.version, approved(draft));
    expect(await s.getVoiceForm(T, draft.version)).toMatchObject({ form_id: 77 });        // the form is not lost; it shows as out of date until published again
  });

  it("people already on the mission follow the approved wording straight away", async () => {
    const svc = new CaseService(make(), () => new Date("2026-10-12T06:00:00Z"), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    const draft = await svc.createMission(admin, draftLoan());
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person("p1"), mission_version: draft.version });
    expect((await svc.getMission(T, (await svc.getCase(T, "C-1")).mission_version)).instrument.draft).toBe(true);
    await svc.signOffMission(admin, draft.version, approved(draft));
    expect((await svc.getMission(T, (await svc.getCase(T, "C-1")).mission_version)).instrument.draft).toBe(false);
    expect((await svc.getCase(T, "C-1")).mission_version).toBe(draft.version);            // the case still points at the same mission
  });

  it("another copy of the server sees the approval within a few seconds", async () => {
    const s = make(); let now = new Date("2026-10-12T06:00:00Z").getTime();
    const other = new CaseService(s, () => new Date(now));
    const draft = await new CaseService(s).createMission(admin, draftLoan());
    expect((await other.getMission(T, draft.version)).instrument.draft).toBe(true);       // it has read the draft
    await new CaseService(s).signOffMission(admin, draft.version, approved(draft));
    now += 6000;
    expect((await other.getMission(T, draft.version)).instrument.draft).toBe(false);
  });
});

describe.each(stores)("signing off the built-in mission: %s", (_n, make) => {
  const BUILT = PLACEMENT_RETENTION_V1.version;

  it("approves it in place: still one mission with that name, first in the list, used from then on", async () => {
    const s = make(), svc = new CaseService(s);
    await svc.createMission(admin, loan());
    expect((await svc.getMission(T)).instrument.draft).toBe(true);
    const signed = await svc.signOffMission(admin, BUILT, approved(PLACEMENT_RETENTION_V1));
    expect(signed).toMatchObject({ version: BUILT, instrument_signed_off: true });
    const list = await svc.listMissions(T);
    expect(list.map(m => m.version)).toEqual([BUILT, "MSN-LOAN-v1"]);                    // not listed twice, still first
    expect(list[0]!.instrument_signed_off).toBe(true);
    for (const asked of [await svc.getMission(T), await svc.getMission(T, BUILT), await new CaseService(s).getMission(T, BUILT)]) expect(asked.instrument.signed_off).toMatchObject({ by: "admin:a@x.org" });
    expect((await svc.defaultMission(T)).version).toBe("MSN-LOAN-v1");                   // what new people join does not change
  });

  it("with edits, and only once", async () => {
    const svc = new CaseService(make());
    const questions = PLACEMENT_RETENTION_V1.instrument.questions.map((q, n) => (n === 0 ? { ...q, text: "Which of these describes you right now?" } : q));
    await svc.signOffMission(admin, BUILT, approved(PLACEMENT_RETENTION_V1, { instrument: { ...PLACEMENT_RETENTION_V1.instrument, draft: false, questions } }));
    expect((await svc.getMission(T, BUILT)).instrument.questions[0]!.text).toBe("Which of these describes you right now?");
    await expect(svc.signOffMission(admin, BUILT, approved(PLACEMENT_RETENTION_V1))).rejects.toMatchObject({ code: "ALREADY_SIGNED_OFF" });
  });

  it("is still the built-in mission: it cannot be deleted, and its name cannot be used to save another", async () => {
    const svc = new CaseService(make());
    await svc.signOffMission(admin, BUILT, approved(PLACEMENT_RETENTION_V1));
    await expect(svc.deleteMission(admin, BUILT)).rejects.toMatchObject({ code: "MISSION_BUILTIN" });
    await expect(svc.createMission(admin, { ...approved(PLACEMENT_RETENTION_V1) })).rejects.toMatchObject({ code: "INVALID_MISSION" });
  });

  it("cases made before missions existed (no version) follow the approved wording", async () => {
    const svc = new CaseService(make(), () => new Date("2026-10-12T06:00:00Z"), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-OLD", participant: person("pOld") });
    await svc.signOffMission(admin, BUILT, approved(PLACEMENT_RETENTION_V1));
    expect((await svc.getMission(T, (await svc.getCase(T, "C-OLD")).mission_version)).instrument.draft).toBe(false);
  });
});
