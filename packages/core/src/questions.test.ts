// Repeated questions, and the plain-words check of a whole draft. Every question here is made up.
import { describe, it, expect } from "vitest";
import type { MissionBrief } from "@dozai/contracts";
import { DRAFT_INSTRUMENT, type Instrument, type Question } from "./instrument";
import { checkMissionDefinition, duplicateProblems, normaliseWording, questionPaths } from "./questions";
import { draftMission, ScriptedMissionDrafter } from "./studio";
import { PLACEMENT_RETENTION_V1 as BASE } from "./mission";
import { spokenQuestion } from "./voice";

const text = (id: string, key: string, t: string, over: Partial<Question> = {}): Question => ({ id, module: "m", type: "text", evidence_key: key, text: t, ...over });
const yesno = (id: string, key: string, t: string, over: Partial<Question> = {}): Question => ({ id, module: "m", type: "yesno", evidence_key: key, text: t, ...over });
const ins = (questions: Question[]): Instrument => ({ ...DRAFT_INSTRUMENT, questions });

describe("normaliseWording", () => {
  it("ignores capitals, punctuation and extra spaces", () => {
    expect(normaliseWording("  Where do   you WORK?? ")).toBe("where do you work");
    expect(normaliseWording("Where do you work")).toBe(normaliseWording("where do you work?"));
  });
  it("keeps Hindi letters and their vowel signs", () => {
    expect(normaliseWording("आप कहाँ काम करते हैं?")).toBe("आप कहाँ काम करते हैं");
  });
});

describe("the roads through a questionnaire", () => {
  it("a straight list is one road; a branch makes one road per answer", () => {
    expect(questionPaths(ins([text("a", "one", "First?"), text("b", "two", "Second?")]))).toEqual([["a", "b"]]);
    const branching = ins([yesno("a", "k", "Working?", { next: [{ when: { equals: "yes" }, goto: "b" }, { when: { equals: "no" }, goto: "c" }] }), text("b", "w", "Where?", { next: [{ goto: null }] }), text("c", "r", "Why not?")]);
    expect(questionPaths(branching)).toEqual([["a", "b"], ["a", "c"]]);
  });
  it("a loop does not run forever, and an enormous questionnaire is not listed", () => {
    expect(questionPaths(ins([yesno("a", "k", "Again?", { next: [{ goto: "a" }] })]))).not.toBeNull();
    const big = ins(Array.from({ length: 12 }, (_, n) => yesno(`q${n}`, `k${n}`, `Question number ${n}?`)));
    expect(questionPaths(big)).toBeNull();
  });
});

describe("repeated questions", () => {
  it("none in a normal questionnaire, including the built-in one", () => {
    expect(duplicateProblems(ins([text("a", "one", "Where do you work?"), text("b", "two", "What is your job title?")]))).toEqual([]);
    expect(duplicateProblems(DRAFT_INSTRUMENT)).toEqual([]);
  });

  it("the same wording twice for one person, however it is written", () => {
    const p = duplicateProblems(ins([text("a", "one", "Where do you work?"), text("b", "two", "where do you   WORK")]));
    expect(p).toEqual([`Questions 1 and 2 are the same question: "Where do you work?". Keep one.`]);
  });

  it("two questions that save to the same answer for one person", () => {
    const p = duplicateProblems(ins([text("a", "employer", "Where do you work?"), text("b", "employer", "Name of your employer?")]));
    expect(p).toEqual([`Questions 1 and 2 both collect "employer" for the same person. Keep one.`]);
  });

  it("the same thing asked on two different branches is not a repeat", () => {
    const branching = ins([
      yesno("a", "moved", "Did you change jobs?", { next: [{ when: { equals: "yes" }, goto: "b" }, { when: { equals: "no" }, goto: "c" }] }),
      text("b", "employer", "Where do you work?", { next: [{ goto: null }] }),
      text("c", "employer", "Where do you work?"),
    ]);
    expect(duplicateProblems(branching)).toEqual([]);
  });

  it("but is one when both can be asked of the same person", () => {
    const sequential = ins([yesno("a", "moved", "Did you change jobs?"), text("b", "employer", "Where do you work?"), text("c", "employer", "Where do you work?")]);
    expect(duplicateProblems(sequential).length).toBeGreaterThan(0);
  });

  it("with too many roads to list, any repeat counts", () => {
    const qs = Array.from({ length: 12 }, (_, n) => yesno(`q${n}`, `k${n}`, `Question number ${n}?`));
    qs.push(text("dup", "other", "Question number 3?"));
    expect(duplicateProblems(ins(qs)).length).toBe(1);
  });
});

describe("checking a whole draft without saving it", () => {
  const brief: MissionBrief = {
    name: "Six-month placement check", programme_name: "Project Udaan",
    goal: "Find out whether people we placed in jobs are still working there six months on, and whether they want support.",
    people: "Young people who finished a three-month retail training with us last year.",
    find_out: "Whether they still work at the same place\n- The name of their employer\n- Their job title\nWhether they want job support",
  };
  const draft = async () => (await draftMission(new ScriptedMissionDrafter(), brief, BASE, [])).definition!;

  it("a good draft has no problems and says what the voice agent would say for every question", async () => {
    const d = await draft();
    const r = checkMissionDefinition(d);
    expect(r.problems).toEqual([]);
    expect(r.phone.map(p => p.id)).toEqual(d.instrument.questions.map(q => q.id));
    for (const q of d.instrument.questions) expect(r.phone.find(p => p.id === q.id)!.spoken).toBe(spokenQuestion(q as Question));
  });

  it("a question with its own spoken wording is shown with that wording", async () => {
    const d = await draft();
    d.instrument.questions[1] = { ...d.instrument.questions[1]!, spoken: "Tell me where you work." };
    expect(checkMissionDefinition(d).phone[1]!.spoken).toBe("Tell me where you work.");
  });

  it("says in plain words which question is wrong", async () => {
    const d = await draft();
    d.instrument.questions[2] = { ...d.instrument.questions[2]!, text: "" };
    const p = checkMissionDefinition(d).problems;
    expect(p[0]).toMatch(/^Question 3, text: /);
  });

  it("finds a repeated question", async () => {
    const d = await draft();
    d.instrument.questions[1] = { ...d.instrument.questions[1]!, text: d.instrument.questions[0]!.text };
    expect(checkMissionDefinition(d).problems.join(" ")).toContain("Questions 1 and 2 are the same question");
  });

  it("finds a question that nothing records, and a need with no question", async () => {
    const d = await draft();
    d.evidence_requirements = [...(d.evidence_requirements ?? []), { key: "extra_need", label: "Something extra", required: true, min_confidence: 0.6 }];
    expect(checkMissionDefinition(d).problems.join(" ")).toContain('evidence need "extra_need" has no question that can fill it');
  });

  it("says so when the draft is not a mission at all", () => {
    const r = checkMissionDefinition({ name: "x" });
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.phone).toEqual([]);
  });
});
