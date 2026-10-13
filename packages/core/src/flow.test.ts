// WhatsApp and a phone call ask the same questions, in the same order, and save the same answers under the same keys.
// Every name, reply and answer here is made up.
import { describe, it, expect } from "vitest";
import type { MissionBrief, Participant, Requirement } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { InMemoryStore } from "./store";
import { ConversationRunner } from "./conversation";
import { RuleClassifier, matchOption, normaliseReply, validateAnswer } from "./classifier";
import { DRAFT_INSTRUMENT, type Instrument, type Question } from "./instrument";
import { PLACEMENT_RETENTION_V1 as BUILT_IN } from "./mission";
import { channelFlowProblems, compareChannels, whatsappPaths } from "./flow";
import { draftMission, ScriptedMissionDrafter, type MissionDrafter } from "./studio";
import { buildVoiceForm, ingestVoiceResult, normaliseVoiceAnswer, type VoiceResult } from "./voice";
import { VERIFICATION_EMPLOYEE_V1 } from "./employee";

const T = "t1";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const reqs = BUILT_IN.evidence_requirements ?? [];
const text = (id: string, key: string, over: Partial<Question> = {}): Question => ({ id, module: "m", type: "text", evidence_key: key, text: `Tell us ${key}.`, ...over });
const choice = (id: string, key: string, values: string[], over: Partial<Question> = {}): Question => ({ id, module: "m", type: "choice", evidence_key: key, text: `Which ${key}?`, options: values.map((v, n) => ({ key: String(n + 1), label: v, value: v })), ...over });
const instrumentOf = (questions: Question[]): Instrument => ({ ...DRAFT_INSTRUMENT, questions });
const need = (key: string, when?: Requirement["when"]): Requirement => ({ key, label: key, required: true, min_confidence: 0.6, ...(when ? { when } : {}) });

describe("the built-in mission: every path asks the same on both channels", () => {
  const paths = compareChannels(BUILT_IN.instrument as Instrument, reqs)!;

  it("there are paths to compare, and a call asks exactly what WhatsApp asks, in the same order, on every one", () => {
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const p of paths) expect(p.call, JSON.stringify(p.decided_by)).toEqual(p.whatsapp);
  });

  it("the four branches are all covered, each with the keys the mission lists for it", () => {
    const by = (status: string) => paths.find(p => p.decided_by.some(d => d.key === "work_status" && d.value === status))!.whatsapp;
    expect(by("same_job")).toEqual(["work_status", "employer_name", "role_title", "support_requested"]);
    expect(by("changed_job")).toEqual(["work_status", "employer_name", "role_title", "change_reason", "support_requested"]);
    expect(by("not_employed")).toEqual(["work_status", "not_working_reason", "job_search", "support_requested"]);
    expect(by("education_training")).toEqual(["work_status", "course", "support_requested"]);
  });

  it("no problems are reported for it", () => {
    expect(channelFlowProblems(BUILT_IN.instrument as Instrument, reqs)).toEqual([]);
  });

  it("every key WhatsApp asks has a field in the phone form, and the form asks only keys the mission lists", () => {
    const form = buildVoiceForm(BUILT_IN, VERIFICATION_EMPLOYEE_V1);
    const fields = new Set(form.form_fields.filter(f => f.field_kind === "outcome").map(f => f.field_id));
    const whatsapp = new Set((BUILT_IN.instrument as Instrument).questions.map(q => q.evidence_key));
    expect(fields).toEqual(whatsapp);
  });

  it("a field's 'ask only if' in the phone form is the mission's own condition", () => {
    const form = buildVoiceForm(BUILT_IN, VERIFICATION_EMPLOYEE_V1);
    const cond = (k: string) => form.form_fields.find(f => f.field_id === k)!.condition_for_asking_this_field;
    expect(cond("employer_name")).toContain("work_status = same_job or work_status = changed_job");
    expect(cond("course")).toContain("work_status = education_training");
    expect(cond("change_reason")).toContain("work_status = changed_job");
  });
});

describe("drift is found and named in plain words", () => {
  const ins = instrumentOf([
    choice("q1", "status", ["working", "not_working"], { next: [{ when: { equals: "working" }, goto: "q2" }, { when: { equals: "not_working" }, goto: "q3" }] }),
    text("q2", "employer", { next: [{ goto: null }] }),
    text("q3", "reason"),
  ]);
  const good = [need("status"), need("employer", { key: "status", in: ["working"] }), need("reason", { key: "status", in: ["not_working"] })];

  it("a mission whose two lists agree has no problems", () => {
    expect(channelFlowProblems(ins, good)).toEqual([]);
  });

  it("a call would ask something WhatsApp never asks on that path", () => {
    const drift = [need("status"), need("employer"), need("reason", { key: "status", in: ["not_working"] })]; // employer has lost its condition
    const p = channelFlowProblems(ins, drift);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("when status is not_working");
    expect(p[0]).toContain("WhatsApp never asks employer");
  });

  it("a call would skip something WhatsApp asks", () => {
    const drift = [need("status"), need("employer", { key: "status", in: ["working"] })]; // reason is not listed
    const p = channelFlowProblems(ins, drift);
    expect(p.join(" ")).toContain("a call never asks reason");
  });

  it("a call would ask a person who is not working about an employer: the condition names the wrong answer", () => {
    const drift = [need("status"), need("employer", { key: "status", in: ["not_working"] }), need("reason", { key: "status", in: ["working"] })];
    expect(channelFlowProblems(ins, drift).length).toBeGreaterThan(0);
  });

  it("the same things in a different order", () => {
    const linear = instrumentOf([text("a", "one"), text("b", "two"), text("c", "three")]);
    expect(channelFlowProblems(linear, [need("one"), need("two"), need("three")])).toEqual([]);
    const p = channelFlowProblems(linear, [need("three"), need("one"), need("two")]);
    expect(p[0]).toContain("in a different order");
  });

  it("a need that waits for one a call reaches later", () => {
    const p = channelFlowProblems(ins, [need("employer", { key: "status", in: ["working"] }), need("status"), need("reason", { key: "status", in: ["not_working"] })]);
    expect(p.join(" ")).toContain('"employer" waits for "status", but a call reaches "status" later');
  });

  it("a branching mission with no list of needs: a call would ask every question", () => {
    const p = channelFlowProblems(ins, []);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]).toContain("a call would ask every question");
  });

  it("a straight list of questions with no list of needs is fine: a call asks them all, in order", () => {
    expect(channelFlowProblems(instrumentOf([text("a", "one"), text("b", "two")]), [])).toEqual([]);
  });

  it("one key asked in two places must expect the same kind of answer", () => {
    const odd = instrumentOf([choice("a", "status", ["x", "y"], { next: [{ when: { equals: "x" }, goto: "b" }, { when: { equals: "y" }, goto: "c" }] }), text("b", "reason"), choice("c", "reason", ["p", "q"])]);
    expect(channelFlowProblems(odd, [need("status"), need("reason")]).join(" ")).toContain('"reason" is asked in more than one place with different kinds of answer');
  });

  it("two questions that ask the same key in the built-in mission have the same kind of answer", () => {
    expect(channelFlowProblems(BUILT_IN.instrument as Instrument, reqs).join(" ")).not.toContain("different kinds of answer");
  });

  it("a questionnaire with a loop does not run forever, and one with too many paths is simply not checked", () => {
    const loop = instrumentOf([choice("a", "k", ["x", "y"], { next: [{ goto: "a" }] })]);
    expect(whatsappPaths(loop)).not.toBeNull();
    const big = instrumentOf(Array.from({ length: 12 }, (_, n) => choice(`q${n}`, `k${n}`, ["a", "b"])));
    expect(whatsappPaths(big)).toBeNull();
    expect(channelFlowProblems(big, big.questions.map(q => need(q.evidence_key)))).toEqual([]);
  });
});

describe("Mission Studio drafts must agree on both channels", () => {
  const brief: MissionBrief = {
    name: "Six-month placement check", programme_name: "Project Udaan",
    goal: "Find out whether people we placed in jobs are still working there six months on, and whether they want support.",
    people: "Young people who finished a three-month retail training with us last year.",
    find_out: "Whether they still work at the same place\n- The name of their employer\n- Their job title\nWhether they want job support",
  };

  it("a draft whose needs are in a different order from its questions is sent back to be corrected", async () => {
    const seen: (string[] | undefined)[] = [];
    const drafter: MissionDrafter = {
      kind: "claude",
      async draft(_b, _base, fix) {
        seen.push(fix);
        const d = await new ScriptedMissionDrafter().draft(brief);
        return seen.length === 1 ? { ...d, evidence_requirements: [...d.evidence_requirements].reverse() } : d;
      },
    };
    const r = await draftMission(drafter, brief, BUILT_IN, []);
    expect(r.attempts).toBe(2);
    expect(seen[1]!.join(" ")).toContain("in a different order");
    expect(r.definition).not.toBeNull();
  });

  it("the plain scripted draft already agrees with itself", async () => {
    const r = await draftMission(new ScriptedMissionDrafter(), brief, BUILT_IN, []);
    expect(r.problems).toEqual([]);
    expect(channelFlowProblems(r.definition!.instrument as Instrument, r.definition!.evidence_requirements ?? [])).toEqual([]);
  });
});

describe("the same person gives the same answers on WhatsApp and on a call, and the same evidence is saved", () => {
  async function world() {
    const store = new InMemoryStore();
    const svc = new CaseService(store, () => new Date(), OPEN);
    const person: Participant = { participant_id: "p1", tenant_id: T, display_name: "Test Person", first_name: "Test", phone_masked: "•••• 0000", location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "Acme Retail" };
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
    await svc.beginSession(T, "C-1", "test");
    return { store, svc };
  }
  const evidenceOf = async (store: InMemoryStore) => Object.fromEntries((await store.listEvidence("C-1")).map(e => [e.question_id, e.value]));
  const call = (answers: Record<string, unknown>): VoiceResult => ({ communication_id: "call_1", status: "completed", consent_given: true, identity_confirmed: true, answers });

  const SCENARIOS: { name: string; whatsapp: string[]; voice: Record<string, unknown>; saved: Record<string, string> }[] = [
    { name: "same job", whatsapp: ["yes", "1", "Acme Retail", "Cashier", "yes"], voice: { work_status: "same_job", employer_name: "Acme Retail", role_title: "Cashier", support_requested: true }, saved: { work_status: "same_job", employer_name: "Acme Retail", role_title: "Cashier", support_requested: "yes" } },
    { name: "changed job", whatsapp: ["yes", "2", "Nova Services", "Front desk", "better pay", "no"], voice: { work_status: "changed_job", employer_name: "Nova Services", role_title: "Front desk", change_reason: "better_pay", support_requested: false }, saved: { work_status: "changed_job", employer_name: "Nova Services", role_title: "Front desk", change_reason: "better_pay", support_requested: "no" } },
    { name: "not working", whatsapp: ["yes", "3", "1", "yes", "yes"], voice: { work_status: "not_employed", not_working_reason: "seeking", job_search: true, support_requested: true }, saved: { work_status: "not_employed", not_working_reason: "seeking", job_search: "yes", support_requested: "yes" } },
    { name: "studying", whatsapp: ["yes", "4", "Diploma in electronics", "2"], voice: { work_status: "education_training", course: "Diploma in electronics", support_requested: false }, saved: { work_status: "education_training", course: "Diploma in electronics", support_requested: "no" } },
  ];

  for (const s of SCENARIOS) {
    it(`${s.name}: both channels save exactly the same keys and values`, async () => {
      const wa = await world();
      const runner = new ConversationRunner(wa.svc, { classifier: new RuleClassifier(), allowDraft: true });
      for (const r of s.whatsapp) await runner.handleReply(T, "C-1", r);
      const voice = await world();
      await ingestVoiceResult(voice.svc, T, "C-1", call(s.voice));
      expect(await evidenceOf(wa.store)).toEqual(s.saved);
      expect(await evidenceOf(voice.store)).toEqual(s.saved);
    });
  }
});

describe("the same rules on a call as on WhatsApp", () => {
  async function world() {
    const store = new InMemoryStore();
    const svc = new CaseService(store, () => new Date(), OPEN);
    const person: Participant = { participant_id: "p1", tenant_id: T, display_name: "Test Person", first_name: "Test", phone_masked: "•••• 0000", location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "Acme Retail" };
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
    await svc.beginSession(T, "C-1", "test");
    return { store, svc };
  }
  const call = (answers: Record<string, unknown>, id = "call_1"): VoiceResult => ({ communication_id: id, status: "completed", consent_given: true, identity_confirmed: true, answers });
  const saved = async (store: InMemoryStore) => (await store.listEvidence("C-1")).map(e => `${e.question_id}=${e.value}@${e.confidence}`);
  const employer = DRAFT_INSTRUMENT.questions.find(q => q.id === "q_same_employer")!;
  const status = DRAFT_INSTRUMENT.questions.find(q => q.id === "q_status")!;

  it("'no', 'none' and 'I don't know' are not an answer on either channel", async () => {
    for (const said of ["no", "None", "I don't know", "pata nahi", "पता नहीं", "12345"]) {
      expect(validateAnswer(employer, { value: said }), `WhatsApp: ${said}`).toBeNull();
      expect(normaliseVoiceAnswer(employer, said), `call: ${said}`).toBeNull();
    }
    const w = await world();
    await ingestVoiceResult(w.svc, T, "C-1", call({ work_status: "same_job", employer_name: "I don't know", role_title: "none" }));
    expect(await saved(w.store)).toEqual(["work_status=same_job@0.95"]);
  });

  it("a real name is an answer on both", () => {
    expect(validateAnswer(employer, { value: "Acme Retail" })).toEqual({ value: "Acme Retail" });
    expect(normaliseVoiceAnswer(employer, "Acme Retail")).toMatchObject({ value: "Acme Retail" });
  });

  it("a phrase maps to the same option on both channels", () => {
    for (const phrase of ["I work at the same place", "same place", "not working", "I am studying", "different", "I do not work at the same place", "2 months ago I left my job"]) {
      const whatsapp = matchOption(normaliseReply(phrase), status)?.value;
      const voice = normaliseVoiceAnswer(status, phrase);
      if (whatsapp) expect(voice?.value, phrase).toBe(whatsapp);
      else expect(voice?.confidence ?? 0, phrase).toBeLessThan(0.6); // not placed: kept below the bar, never counted as an answer
    }
  });

  it("an answer to a question this person would not be asked is not kept", async () => {
    const w = await world();
    await ingestVoiceResult(w.svc, T, "C-1", call({ work_status: "not_employed", not_working_reason: "seeking", employer_name: "Acme Retail", course: "Nursing" }));
    expect((await saved(w.store)).map(x => x.split("=")[0]).sort()).toEqual(["not_working_reason", "work_status"]);
  });

  it("an answer is dropped when the answer it depends on was given earlier, on another channel", async () => {
    const w = await world();
    const runner = new ConversationRunner(w.svc, { classifier: new RuleClassifier(), allowDraft: true });
    await runner.handleReply(T, "C-1", "yes"); await runner.handleReply(T, "C-1", "3"); // WhatsApp: not working
    await ingestVoiceResult(w.svc, T, "C-1", call({ course: "Nursing", not_working_reason: "family_health" }));
    expect((await saved(w.store)).map(x => x.split("=")[0])).toEqual(["work_status", "not_working_reason"]);
  });

  it("an answer whose condition cannot be checked yet is kept, as a held answer would be on WhatsApp", async () => {
    const w = await world();
    await ingestVoiceResult(w.svc, T, "C-1", call({ employer_name: "Acme Retail" })); // the call never got the status
    expect(await saved(w.store)).toEqual(["employer_name=Acme Retail@0.85"]);
  });

  it("a clear answer is never replaced by an unclear one", async () => {
    const w = await world();
    const runner = new ConversationRunner(w.svc, { classifier: new RuleClassifier(), allowDraft: true });
    await runner.handleReply(T, "C-1", "yes"); await runner.handleReply(T, "C-1", "1"); // same_job at 0.95
    await ingestVoiceResult(w.svc, T, "C-1", call({ work_status: "it is complicated" }));
    expect(await saved(w.store)).toEqual(["work_status=same_job@0.95"]);
  });

  it("an unclear answer is still shown when there is nothing better, so a person can see it was said", async () => {
    const w = await world();
    await ingestVoiceResult(w.svc, T, "C-1", call({ work_status: "it is complicated" }));
    expect(await saved(w.store)).toEqual(["work_status=it is complicated@0.5"]);
  });

  it("a clear new answer does replace an earlier one: that is what a follow-up call is for", async () => {
    const w = await world();
    await ingestVoiceResult(w.svc, T, "C-1", call({ work_status: "same_job", employer_name: "Acme Retail" }, "call_1"));
    await ingestVoiceResult(w.svc, T, "C-1", call({ employer_name: "Nova Services" }, "call_2"));
    const latest = [...(await w.store.listEvidence("C-1"))].filter(e => e.question_id === "employer_name").at(-1)!;
    expect(latest.value).toBe("Nova Services");
  });
});
