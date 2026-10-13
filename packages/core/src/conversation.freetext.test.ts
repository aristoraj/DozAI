// Free-text replies through the whole conversation runner: what is saved, under which key, and which question comes next.
// The model is replaced by a script of what it would return, so these tests check OUR checks and flow, not the model.
// Every participant reply here is made up.
import { describe, it, expect } from "vitest";
import type { Classification } from "@dozai/contracts";
import type { Participant } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { InMemoryStore } from "./store";
import { ConversationRunner } from "./conversation";
import { RuleClassifier, type ClassifyInput, type ReplyClassifier } from "./classifier";
import { DRAFT_INSTRUMENT } from "./instrument";

const T = "t1";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

/** Returns the scripted classifications in order, then reads with the rules. Remembers what it was shown. */
class Scripted implements ReplyClassifier {
  seen: ClassifyInput[] = [];
  private rules = new RuleClassifier();
  constructor(private script: (Classification | null)[]) {}
  async classify(i: ClassifyInput): Promise<Classification> {
    this.seen.push(i);
    const next = this.script.shift();
    return next ?? this.rules.classify(i);
  }
}

async function setup(script: (Classification | null)[] = []) {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const person: Participant = { participant_id: "p1", tenant_id: T, display_name: "Test Person", first_name: "Test", phone_masked: "•••• 0000", location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "Acme Retail" };
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
  await svc.beginSession(T, "C-1", "test");
  const classifier = new Scripted(script);
  const runner = new ConversationRunner(svc, { classifier, allowDraft: true });
  const say = (text: string) => runner.handleReply(T, "C-1", text);
  const outbox = async () => (await store.listOutbox(T)).filter(o => o.kind === "whatsapp_text").sort((a, b) => Number(a.idempotency_key.split(":")[2]) - Number(b.idempotency_key.split(":")[2])).map(o => String(o.payload.text));
  const evidence = async () => Object.fromEntries((await store.listEvidence("C-1")).map(e => [e.question_id, e.value]));
  const state = () => store.getConversation(T, "C-1");
  return { store, say, outbox, evidence, state, classifier };
}

const asked = (texts: string[], re: RegExp) => texts.filter(t => re.test(t)).length;
const EMPLOYER_Q = /name of the place where you work/;
const ROLE_Q = /job title or the work you do/;
const STATUS_Q = /Which of these describes you best/;
const SUPPORT_Q = /contact you about job support/;

describe("one reply that answers several questions", () => {
  it("'I work at Acme as a cashier': the employer and the job title are kept, and neither is asked again", async () => {
    // The reply answers employer and job title but does not say whether it is the same place as before, so the status is not guessed.
    const t = await setup([null, { intent: "answer", confidence: 0.7, also: [{ key: "employer_name", value: "Acme", confidence: 0.7 }, { key: "role_title", value: "cashier", confidence: 0.7 }] }]);
    await t.say("yes");
    await t.say("I work at Acme as a cashier");
    expect(await t.evidence()).toEqual({});                       // nothing saved yet: the status is still unknown
    expect((await t.state())?.current).toBe("q_status");          // so the status is asked again
    expect((await t.state())?.reasks).toBe(0);                    // and that is not counted as a failed reply
    await t.say("1");                                             // "same place"
    expect(await t.evidence()).toMatchObject({ work_status: "same_job", employer_name: "Acme", role_title: "cashier" });
    const out = await t.outbox();
    expect(out.at(-1)).toMatch(SUPPORT_Q);                        // straight to the next question that is still missing
    expect(asked(out, EMPLOYER_Q)).toBe(0);
    expect(asked(out, ROLE_Q)).toBe(0);
    expect((await t.state())?.held).toBeUndefined();
  });

  it("the current answer and later answers in one reply: all saved, in the right order, one message sent", async () => {
    const t = await setup([null, { intent: "answer", option_key: "1", value: "same_job", confidence: 0.85, also: [{ key: "employer_name", value: "Acme", confidence: 0.7 }, { key: "role_title", value: "cashier", confidence: 0.7 }] }]);
    await t.say("yes");
    const before = (await t.outbox()).length;
    const r = await t.say("same place, Acme, cashier");
    expect(r).toMatchObject({ action: "answered" });
    expect(await t.evidence()).toMatchObject({ work_status: "same_job", employer_name: "Acme", role_title: "cashier" });
    const out = await t.outbox();
    expect(out.length).toBe(before + 1);
    expect(out.at(-1)).toMatch(SUPPORT_Q);
    expect((await t.state())?.answers.map(a => a.question_id)).toEqual(["q_status", "q_same_employer", "q_same_role"]);
  });

  it("follows the branch the answers lead to: an employer given on the way is used by the matching question", async () => {
    // "changed_job" leads to q_new_employer / q_new_role, which use the same keys as the same-job questions.
    const t = await setup([null, { intent: "answer", option_key: "2", value: "changed_job", confidence: 0.85, also: [{ key: "employer_name", value: "Nova Services", confidence: 0.7 }] }]);
    await t.say("yes");
    await t.say("I changed jobs, now at Nova Services");
    expect(await t.evidence()).toMatchObject({ work_status: "changed_job", employer_name: "Nova Services" });
    expect((await t.state())?.current).toBe("q_new_role");
    expect((await t.outbox()).at(-1)).toMatch(ROLE_Q);
  });

  it("never saves an answer for a question this person would not be asked", async () => {
    const t = await setup([null, { intent: "answer", option_key: "3", value: "not_employed", confidence: 0.85, also: [{ key: "employer_name", value: "Acme", confidence: 0.7 }, { key: "course", value: "Nursing", confidence: 0.7 }] }]);
    await t.say("yes");
    await t.say("not working now, earlier Acme");
    const ev = await t.evidence();
    expect(ev).toEqual({ work_status: "not_employed" });           // no employer, no course
    expect((await t.state())?.current).toBe("q_ne_reason");
  });

  it("keys that are not part of the mission are ignored", async () => {
    const t = await setup([null, { intent: "answer", option_key: "1", value: "same_job", confidence: 0.85, also: [{ key: "salary", value: "50000", confidence: 0.9 }] }]);
    await t.say("yes"); await t.say("same place");
    expect(Object.keys(await t.evidence())).toEqual(["work_status"]);
  });

  it("an answer already recorded is not replaced by a later guess, and its question is not asked again", async () => {
    const t = await setup([null, null, null, { intent: "answer", option_key: "1", value: "same_job", confidence: 0.85, also: [{ key: "employer_name", value: "Other Place", confidence: 0.7 }] }]);
    await t.say("yes"); await t.say("1"); await t.say("Acme Retail");   // employer recorded
    await t.say("Cashier");                                             // role recorded, now at the support question
    // A reply to the support question mentions another employer: the recorded one stays.
    await t.say("yes, and I work at Other Place");
    expect((await t.evidence()).employer_name).toBe("Acme Retail");
  });

  it("a held answer that is not valid for its question is dropped and the question is asked normally", async () => {
    const t = await setup([null, { intent: "answer", option_key: "1", value: "same_job", confidence: 0.85, also: [{ key: "employer_name", value: "no", confidence: 0.9 }, { key: "role_title", value: "I don't know", confidence: 0.9 }] }]);
    await t.say("yes"); await t.say("same place, no idea about the rest");
    expect(await t.evidence()).toEqual({ work_status: "same_job" });
    expect((await t.outbox()).at(-1)).toMatch(EMPLOYER_Q);
  });

  it("a reply that only answers another question is kept and the current question is asked again, without a failure", async () => {
    const t = await setup([null, { intent: "answer", confidence: 0.7, also: [{ key: "course", value: "Nursing", confidence: 0.7 }] }]);
    await t.say("yes");
    const r = await t.say("I am doing nursing");
    expect(r).toMatchObject({ action: "reasked", detail: "answered another question" });
    expect((await t.outbox()).at(-1)).toMatch(STATUS_Q);
    expect((await t.state())?.reasks).toBe(0);
    await t.say("4");                                                  // "studying"
    expect(await t.evidence()).toMatchObject({ work_status: "education_training", course: "Nursing" });
    expect((await t.outbox()).at(-1)).toMatch(SUPPORT_Q);
  });

  it("the interview can finish on one message", async () => {
    const t = await setup([null, { intent: "answer", option_key: "4", value: "education_training", confidence: 0.85, also: [{ key: "course", value: "Nursing", confidence: 0.7 }, { key: "support_requested", option_key: "2", value: "no", confidence: 0.7 }] }]);
    await t.say("yes");
    const r = await t.say("I study nursing and do not need any help");
    expect(r).toMatchObject({ action: "finished", finished: true });
    expect(await t.evidence()).toMatchObject({ work_status: "education_training", course: "Nursing", support_requested: "no" });
    expect((await t.outbox()).at(-1)).toMatch(/Thank you for your time/);
  });
});

describe("replies that do not answer", () => {
  it("'2 months ago I left my job' does not select option 2, and the question is asked again", async () => {
    const t = await setup();
    await t.say("yes");
    await t.say("2 months ago I left my job");
    expect(await t.evidence()).toEqual({});
    expect((await t.state())?.current).toBe("q_status");
    expect((await t.outbox()).at(-1)).toMatch(/could not understand[\s\S]*Which of these/);
  });

  it("'I don't know' and 'no' are not saved as an employer name", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1");
    for (const reply of ["I don't know", "no", "pata nahi", "पता नहीं"]) {
      await t.say(reply);
      expect((await t.evidence()).employer_name, reply).toBeUndefined();
      expect((await t.state())?.current).toBe("q_same_employer");
    }
  });

  it("repeated non-answers still end in a hand-over, never a loop", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1");
    for (const reply of ["no", "I don't know", "nahi"]) await t.say(reply);
    expect((await t.state())?.status).toBe("escalated");
  });

  it("asking what the question means repeats it and does not save anything", async () => {
    const t = await setup();
    await t.say("yes");
    const r = await t.say("what do you mean?");
    expect(r).toMatchObject({ action: "reasked" });
    expect(await t.evidence()).toEqual({});
    expect((await t.outbox()).at(-1)).toMatch(/^(Of course|Sure)[\s\S]*Which of these describes you best/);
    await t.say("3");                                                   // and answering afterwards works
    expect((await t.evidence()).work_status).toBe("not_employed");
    expect((await t.state())?.reasks).toBe(0);
  });

  it("a model's 'clarify' is handled the same way as the rules'", async () => {
    const t = await setup([null, { intent: "clarify", confidence: 0.8 }]);
    await t.say("yes"); await t.say("kuch samajh nahi aaya");
    expect((await t.outbox()).at(-1)).toMatch(/^(Of course|Sure)/);
  });
});

describe("Hindi, Hinglish and Devanagari through the whole flow", () => {
  it("a full interview in Devanagari and Hinglish saves the same keys", async () => {
    const t = await setup();
    await t.say("हाँ");              // consent
    await t.say("दूसरा");            // option 2: changed job
    await t.say("नोवा सर्विसेज");     // employer, typed in Devanagari, kept as typed
    await t.say("front desk");       // job title
    await t.say("pay");              // reason
    await t.say("nahi");             // support: no
    expect(await t.evidence()).toEqual({ work_status: "changed_job", employer_name: "नोवा सर्विसेज", role_title: "front desk", change_reason: "better_pay", support_requested: "no" });
    expect((await t.state())?.status).toBe("done");
  });

  it("Hinglish consent and answers", async () => {
    const t = await setup();
    await t.say("haan ji"); await t.say("pehla"); await t.say("Acme Retail"); await t.say("cashier"); await t.say("haan");
    expect(await t.evidence()).toMatchObject({ work_status: "same_job", support_requested: "yes" });
  });
});

describe("what the reader is told", () => {
  it("gets the answers so far and the last questions, and not the full history", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1"); await t.say("Acme Retail"); await t.say("Cashier");
    const last = t.classifier.seen.at(-1)!;
    expect(last.question?.id).toBe("q_same_role");                    // the reply "Cashier" is read while this question is open
    expect(last.known).toEqual([{ key: "work_status", value: "same_job" }, { key: "employer_name", value: "Acme Retail" }]);
    expect(last.recent?.map(r => r.answer)).toEqual(["I work at the same place as before", "Acme Retail"]);
  });
});
