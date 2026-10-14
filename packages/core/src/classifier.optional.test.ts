// "No" and "nothing" are real answers to "Is there anything else you would like to tell us?", but not to "what is your employer called?".
// And "not smooth at all" picks "Not smooth", even though "smooth" is inside it. Every reply here is made up.
import { describe, it, expect } from "vitest";
import type { Participant } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { InMemoryStore } from "./store";
import { ConversationRunner } from "./conversation";
import { matchOption, normaliseReply, RuleClassifier, validateAnswer } from "./classifier";
import { DRAFT_INSTRUMENT, isOptionalText, NOTHING_TO_ADD, type Instrument, type Question } from "./instrument";

const smooth: Question = { id: "q_smooth", module: "m", type: "choice", evidence_key: "smoothness", text: "How smooth was the whole experience from start to finish?", options: [
  { key: "1", label: "Smooth", value: "smooth" }, { key: "2", label: "Okay", value: "okay" }, { key: "3", label: "Not smooth", value: "not_smooth" }] };
const anythingElse: Question = { id: "q_else", module: "m", type: "text", evidence_key: "anything_else", text: "Is there anything else you would like to tell us?" };
const employer: Question = { id: "q_emp", module: "m", type: "text", evidence_key: "employer_name", text: "Please type the name of the place where you work." };
const rules = new RuleClassifier();
const read = (text: string, q: Question) => rules.classify({ text, question: q, context: "question", instrument: DRAFT_INSTRUMENT });

describe("which questions accept 'no' or 'nothing'", () => {
  it("an open 'anything else?' question does, whether the mission says so or its words do; a name or a choice does not", () => {
    expect(isOptionalText(anythingElse)).toBe(true);
    for (const text of ["Do you have any other comments?", "Any feedback for us?", "Would you like to add something?", "Anything else to share?"]) expect(isOptionalText({ ...anythingElse, text }), text).toBe(true);
    expect(isOptionalText({ ...employer, optional: true })).toBe(true);   // a mission can say it outright
    expect(isOptionalText(employer)).toBe(false);
    expect(isOptionalText(smooth)).toBe(false);
  });

  it("'No', 'nothing', 'nope', 'that is all' and the Hindi ones are the answer, saved as 'Nothing to add'", async () => {
    for (const text of ["No", "Nothing", "nope", "nothing else", "no thanks", "No, nothing", "that's all", "all good", "no comments", "kuch nahi", "koi nahi", "नहीं", "कुछ नहीं"]) {
      expect(await read(text, anythingElse), text).toMatchObject({ intent: "answer", value: NOTHING_TO_ADD });
    }
  });

  it("a longer polite 'no' is still 'nothing', but a complaint that starts with 'no' is kept as a comment", async () => {
    for (const text of ["no there is nothing more to add thank you very much", "No, nothing else, thanks", "not really", "nothing special sir", "nahi kuch nahi dhanyavaad"]) {
      expect(await read(text, anythingElse), text).toMatchObject({ intent: "answer", value: NOTHING_TO_ADD });
    }
    for (const text of ["no, the app froze", "nothing works on my phone", "no good", "no network in my area"]) {
      const c = await read(text, anythingElse);
      expect(c, text).toMatchObject({ intent: "answer", value: text }); // saved as what they wrote, not as "nothing"
    }
  });

  it("an actual comment is kept exactly as written", async () => {
    expect(await read("The app was slow on my phone", anythingElse)).toMatchObject({ intent: "answer", value: "The app was slow on my phone" });
  });

  it("a name question still refuses 'no' and 'nothing', so a refusal is never saved as an employer", async () => {
    for (const text of ["No", "Nothing", "none", "kuch nahi"]) expect((await read(text, employer)).intent, text).toBe("unclear");
    expect(validateAnswer(employer, { value: "No" })).toBeNull();
    expect(validateAnswer(anythingElse, { value: "No" })).toEqual({ value: NOTHING_TO_ADD });
    expect(validateAnswer(anythingElse, { value: "n" })).toBeNull();
  });
});

describe("picking an option when one option's words sit inside another's", () => {
  const pick = (text: string) => matchOption(normaliseReply(text), smooth)?.value;
  it("takes the longer, more specific one", () => {
    expect(pick("not smooth at all")).toBe("not_smooth");
    expect(pick("it was not smooth")).toBe("not_smooth");
    expect(pick("Not smooth")).toBe("not_smooth");
  });
  it("still takes the plain one when that is what was said", () => {
    for (const text of ["its very good very smooth", "very smooth", "it was smooth", "Smooth", "2", "pretty okay"]) expect(pick(text), text).toBeDefined();
    expect(pick("its very good very smooth")).toBe("smooth");
    expect(pick("pretty okay")).toBe("okay");
  });
  it("does not guess when the reply turns the answer around", () => {
    expect(pick("it was not very smooth")).toBeUndefined();
    expect(pick("I would not say smooth")).toBeUndefined();
  });
});

describe("a whole conversation that ends with 'anything else?'", () => {
  const ins: Instrument = {
    ...DRAFT_INSTRUMENT, draft: false,
    questions: [
      { ...smooth, next: [{ goto: "q_else" }] },
      { ...anythingElse, next: [{ goto: null }] },
    ],
  };
  async function run() {
    const store = new InMemoryStore();
    const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    const person: Participant = { participant_id: "p1", tenant_id: "t1", display_name: "Test Person", first_name: "Test", phone_masked: "•••• 0000", location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "Acme" };
    await svc.createCase({ tenant_id: "t1", run_id: "r", case_id: "C-1", participant: person });
    await svc.beginSession("t1", "C-1", "test");
    const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), instrument: ins });
    return { say: (t: string) => runner.handleReply("t1", "C-1", t), store };
  }

  it("finishes when the participant says 'No', instead of asking the same question again", async () => {
    const w = await run();
    await w.say("yes");
    expect((await w.say("2")).action).toBe("answered");
    expect(await w.say("No")).toMatchObject({ action: "finished", finished: true });
    expect((await w.store.listEvidence("C-1")).map(e => `${e.question_id}=${e.value}`)).toEqual(["smoothness=okay", `anything_else=${NOTHING_TO_ADD}`]);
  });

  it("and also when the first thing they say is 'Nothing'", async () => {
    const w = await run();
    await w.say("yes"); await w.say("1");
    expect((await w.say("Nothing")).action).toBe("finished");
  });
});
