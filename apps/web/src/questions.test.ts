// The changes the question editor makes to a mission: edit, remove, add. Each result is also run through the server's own check,
// so an edit that would break the mission (or make WhatsApp and phone calls disagree) is caught here. Everything is made up.
import { describe, it, expect } from "vitest";
import { PLACEMENT_RETENTION_V1 as BUILT_IN, checkMissionDefinition, type Instrument } from "@dozai/core";
import { addQuestion, categoriesOf, categoryKey, categoryTitle, defaultNext, findRepeat, normaliseWording, removeQuestion, slug, updateQuestion, whenText } from "./questions.js";

type Def = { instrument: Instrument; evidence_requirements: { key: string; label: string; required?: boolean; when?: { key: string; in: string[] }; verify_when?: { key: string; in: string[] } }[] } & Record<string, unknown>;
const fresh = (): Def => JSON.parse(JSON.stringify({
  mission_id: BUILT_IN.mission_id, version: "edit-test-v1.0", name: BUILT_IN.name, programme_name: "Project Udaan", intro_template: BUILT_IN.intro_template, templates: BUILT_IN.templates,
  policy: BUILT_IN.policy_overrides, agent_guidance: BUILT_IN.agent_guidance, employee_id: BUILT_IN.employee_id, employee_version: BUILT_IN.employee_version,
  objective: BUILT_IN.objective, evidence_requirements: BUILT_IN.evidence_requirements, strategy: BUILT_IN.strategy, instrument: BUILT_IN.instrument,
}));
const problems = (d: Def) => checkMissionDefinition(d).problems;
const ids = (d: Def) => d.instrument.questions.map(q => q.id);
const phoneOf = (d: Def, id: string) => checkMissionDefinition(d).phone.find(p => p.id === id)!.spoken;   // what a call says for a question

describe("the starting point is a mission the server accepts", () => {
  it("no problems before any edit", () => { expect(problems(fresh())).toEqual([]); });
});

describe("naming and wording helpers", () => {
  it("slug makes a short safe key", () => {
    expect(slug("What is your monthly income?")).toBe("what_is_your_monthly_income");
    expect(slug("What is your monthly income and how do you spend it each week?").length).toBeLessThanOrEqual(30);
    expect(slug("आप कहाँ काम करते हैं")).toBe("");
    expect(slug("  ---  ")).toBe("");
  });
  it("compares wording without capitals or punctuation, keeping Hindi vowel signs", () => {
    expect(normaliseWording("Where do you WORK?")).toBe("where do you work");
    expect(normaliseWording("आप कहाँ काम करते हैं?")).toBe("आप कहाँ काम करते हैं");
  });
  it("findRepeat names the question it repeats", () => {
    const d = fresh();
    expect(findRepeat(d, "which of these describes you best right now", undefined)).toMatchObject({ number: 1 });
    expect(findRepeat(d, "Which of these describes you best right now?", "q_status")).toBeNull();     // a question is not a repeat of itself
    expect(findRepeat(d, "something new", undefined)).toBeNull();
    expect(findRepeat(d, "   ", undefined)).toBeNull();
  });
  it("defaultNext follows the 'otherwise' rule, else the next question in the list, else the end", () => {
    const d = fresh();
    const q = (id: string) => d.instrument.questions.find(x => x.id === id)!;
    expect(defaultNext(d.instrument, q("q_same_role"))).toBe("q_support");              // its own "otherwise" rule
    expect(defaultNext(d.instrument, q("q_same_employer"))).toBe("q_same_role");        // next in the list
    expect(defaultNext(d.instrument, q("q_support"))).toBeNull();                       // the end
  });
});

describe("categories", () => {
  it("categoryKey makes one tidy key, the same as the server's rule", () => {
    expect(categoryKey("Same Job")).toBe("same_job");
    expect(categoryKey("same job")).toBe("same_job");
    expect(categoryKey("same_job")).toBe("same_job");
    expect(categoryKey("  Income & money! ")).toBe("income_money");
    expect(categoryKey("आय")).toBe("");
    expect(categoryKey("x".repeat(60)).length).toBeLessThanOrEqual(40);
  });
  it("categoryTitle reads like a heading", () => {
    expect(categoryTitle("same_job")).toBe("Same job");
    expect(categoryTitle("support")).toBe("Support");
  });
  it("categoriesOf lists them in the order they first appear, once each", () => {
    expect(categoriesOf(fresh())).toEqual(["status", "same_job", "changed_job", "not_employed", "education_training", "support"]);
  });
});

describe("when a question is asked, in words", () => {
  const d = fresh();
  const q = (id: string) => d.instrument.questions.find(x => x.id === id)!;
  it("the first question is asked of everyone; a branch says what leads to it", () => {
    expect(whenText(d, q("q_status"))).toBe("Asked of everyone");
    expect(whenText(d, q("q_support"))).toBe("Asked of everyone");
    expect(whenText(d, q("q_same_employer"))).toBe("Only if current work status is “I work at the same place as before”");
    expect(whenText(d, q("q_edu_course"))).toContain("studying");
  });
});

describe("editing a question", () => {
  it("changes the WhatsApp wording and keeps what is saved", () => {
    const r = updateQuestion(fresh(), "q_same_employer", { text: "Which company do you work for?", required: true });
    expect(r.error).toBeUndefined();
    expect(r.def!.instrument.questions.find(x => x.id === "q_same_employer")).toMatchObject({ text: "Which company do you work for?", evidence_key: "employer_name", id: "q_same_employer" });
    expect(problems(r.def as Def)).toEqual([]);
  });

  it("the phone wording is read only: it is never taken from an edit", () => {
    const d = fresh(), before = phoneOf(d, "q_same_employer");
    const r = updateQuestion(d, "q_same_employer", { text: "Which company do you work for?", spoken: "Something the person typed", required: true, phone: before });
    const q = r.def!.instrument.questions.find(x => x.id === "q_same_employer")!;
    expect(q.spoken).toBe(before);                                   // the wording the phone had, not what was typed
    expect(phoneOf(r.def as Def, "q_same_employer")).toBe(before);
  });

  it("when the written wording changes, the phone keeps sounding exactly as it did", () => {
    const d = fresh(), before = phoneOf(d, "q_same_employer");
    const r = updateQuestion(d, "q_same_employer", { text: "Which company do you work for?", required: true, phone: before });
    expect(phoneOf(r.def as Def, "q_same_employer")).toBe(before);   // it would have followed the new wording if it had not been pinned
    expect(phoneOf(updateQuestion(d, "q_same_employer", { text: "Which company do you work for?", required: true }).def as Def, "q_same_employer")).not.toBe(before); // (and it would have changed without the pin)
  });

  it("changing only the category or 'must be answered' does not touch the phone wording", () => {
    const d = fresh(), q = d.instrument.questions.find(x => x.id === "q_same_employer")!;
    const r = updateQuestion(d, "q_same_employer", { text: q.text, required: false, category: "Work", phone: phoneOf(d, "q_same_employer") });
    expect(r.def!.instrument.questions.find(x => x.id === "q_same_employer")).not.toHaveProperty("spoken");   // nothing was pinned: the wording did not change
  });

  it("a question whose phone wording is already its own keeps it", () => {
    const d = fresh(); d.instrument.questions.find(x => x.id === "q_same_employer")!.spoken = "Tell me where you work.";
    const r = updateQuestion(d, "q_same_employer", { text: "Which company do you work for?", required: true, phone: "ignored" });
    expect(r.def!.instrument.questions.find(x => x.id === "q_same_employer")!.spoken).toBe("Tell me where you work.");
  });

  it("rewording an answer choice pins the phone wording too, because a call reads the choices out", () => {
    const d = fresh(), labels = d.instrument.questions[0]!.options!.map(o => o.label); labels[0] = "I still work where I was placed";
    const before = phoneOf(d, "q_status");
    const r = updateQuestion(d, "q_status", { text: d.instrument.questions[0]!.text, labels, required: true, phone: before });
    expect(phoneOf(r.def as Def, "q_status")).toBe(before);
  });

  it("moves a question to another category, or a new one, and tidies the name", () => {
    const d = fresh(), q = d.instrument.questions.find(x => x.id === "q_support")!;
    expect(updateQuestion(d, "q_support", { text: q.text, required: true, category: "Same Job" }).def!.instrument.questions.find(x => x.id === "q_support")!.module).toBe("same_job");
    expect(updateQuestion(d, "q_support", { text: q.text, required: true, category: "Income & money!" }).def!.instrument.questions.find(x => x.id === "q_support")!.module).toBe("income_money");
    expect(updateQuestion(d, "q_support", { text: q.text, required: true, category: "  " }).error).toBe("Give the category a name.");
    expect(problems(updateQuestion(d, "q_support", { text: q.text, required: true, category: "Money" }).def as Def)).toEqual([]);
  });

  it("rewords answer choices without changing what each one saves", () => {
    const d = fresh();
    const labels = d.instrument.questions[0]!.options!.map(o => o.label);
    labels[0] = "I still work where I was placed";
    const r = updateQuestion(d, "q_status", { text: d.instrument.questions[0]!.text, labels, required: true });
    const q = r.def!.instrument.questions[0]!;
    expect(q.options![0]).toMatchObject({ label: "I still work where I was placed", value: "same_job", key: "1" });
    expect(q.options!.map(o => o.value)).toEqual(["same_job", "changed_job", "not_employed", "education_training"]);
    expect(problems(r.def as Def)).toEqual([]);
  });

  it("makes a question optional or required through its 'what to find out' entry", () => {
    const r = updateQuestion(fresh(), "q_same_role", { text: "What is your job title or the work you do?", required: false });
    expect(r.def!.evidence_requirements.find(x => x.key === "role_title")!.required).toBe(false);
  });

  it("the same wording on another branch is not a repeat: a question can be saved with its own wording", () => {
    // "What is your job title or the work you do?" is asked on two branches, so each can keep it
    expect(updateQuestion(fresh(), "q_same_role", { text: "What is your job title or the work you do?", required: true }).error).toBeUndefined();
    expect(findRepeat(fresh(), "What is your job title or the work you do?", "q_same_role")).toBeNull();
    // but a new question with that wording would be asked of everyone, so it is a repeat
    expect(findRepeat(fresh(), "What is your job title or the work you do?", undefined)).not.toBeNull();
  });

  it("refuses empty, too long, repeated and badly worded edits, in plain words", () => {
    const d = fresh(), edit = (p: object) => updateQuestion(d, "q_same_employer", { text: "ok text", required: true, ...p }).error;
    expect(edit({ text: "  " })).toBe("Write the question.");
    expect(edit({ text: "x".repeat(901) })).toContain("too long");
    expect(edit({ text: "WHICH of these describes you best right now" })).toBe("This is the same as question 1. Each question should be asked once.");
    expect(updateQuestion(d, "q_status", { text: "Fine?", labels: ["Same", "", "x", "y"], required: true }).error).toBe("Every answer choice needs some words.");
    expect(updateQuestion(d, "q_status", { text: "Fine?", labels: ["Same", "same!", "x", "y"], required: true }).error).toBe("Two answer choices say the same thing.");
    expect(updateQuestion(d, "no_such_question", { text: "Fine?", required: true }).error).toContain("no longer there");
  });

  it("does not change the definition it was given", () => {
    const d = fresh(), before = JSON.stringify(d);
    updateQuestion(d, "q_same_employer", { text: "Which company do you work for?", required: true });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("removing a question", () => {
  it("takes its 'what to find out' entry with it, and sends the branch past it", () => {
    const r = removeQuestion(fresh(), "q_edu_course");
    expect(r.blocked).toBeUndefined();
    const d = r.def as Def;
    expect(ids(d)).not.toContain("q_edu_course");
    expect(d.evidence_requirements.map(x => x.key)).not.toContain("course");
    // people who are studying now go straight from the first question to the last one
    expect(d.instrument.questions[0]!.next!.find(x => x.when?.equals === "education_training")!.goto).toBe("q_support");
    expect(problems(d)).toEqual([]);                                                    // and WhatsApp and phone calls still agree
  });

  it("removing the last question of a path makes the road end earlier, and still agrees on both channels", () => {
    const d = removeQuestion(fresh(), "q_new_reason").def as Def;
    expect(d.evidence_requirements.map(x => x.key)).not.toContain("change_reason");
    expect(problems(d)).toEqual([]);
  });

  it("taking a question out of the list does not change where the questions before it lead", () => {
    // q_new_role has no rule of its own: it used to go to the next question in the list, q_new_reason. Without q_new_reason it must go to q_support, not to the next branch.
    const d = removeQuestion(fresh(), "q_new_reason").def as Def;
    expect(d.instrument.questions.find(q => q.id === "q_new_role")!.next).toEqual([{ goto: "q_support" }]);
  });

  it("keeps the 'what to find out' entry while another question still collects it", () => {
    // employer_name is collected by two questions, one for each branch
    const d = removeQuestion(fresh(), "q_same_employer").def as Device;
    expect(d.evidence_requirements.map(x => x.key)).toContain("employer_name");
    // ...but the phone call would still ask people who stayed for their employer, which WhatsApp no longer does: the check says so
    expect(problems(d as unknown as Def).join(" ")).toContain("a call");
  });

  it("will not remove a question that other things depend on, and says what depends on it", () => {
    const r = removeQuestion(fresh(), "q_status");
    expect(r.def).toBeUndefined();
    expect(r.blocked).toContain("Other questions depend on the answer to this one");
    expect(r.blocked).toContain("Employer");
  });

  it("will not remove the only question", () => {
    let d = fresh() as Def;
    d = { ...d, instrument: { ...d.instrument, questions: [d.instrument.questions[0]!] } } as Def;
    expect(removeQuestion(d, "q_status").blocked).toBe("A mission needs at least one question.");
  });

  it("does not change the definition it was given", () => {
    const d = fresh(), before = JSON.stringify(d);
    removeQuestion(d, "q_edu_course");
    expect(JSON.stringify(d)).toBe(before);
  });
});
type Device = Def;

describe("adding a question", () => {
  const add = (spec: Partial<Parameters<typeof addQuestion>[1]> = {}) => addQuestion(fresh(), { text: "What is your monthly income?", type: "text", required: true, ...spec });

  it("goes to the end, for everyone, with its own key and its own 'what to find out' entry", () => {
    const r = add();
    const d = r.def as Def;
    expect(r.error).toBeUndefined();
    expect(ids(d).at(-1)).toBe("q_what_is_your_monthly_income");
    expect(d.instrument.questions.at(-1)).toMatchObject({ type: "text", evidence_key: "what_is_your_monthly_income", text: "What is your monthly income?" });
    expect(d.evidence_requirements.at(-1)).toMatchObject({ key: "what_is_your_monthly_income", label: "What is your monthly income", required: true, min_confidence: 0.6 });
    expect(whenText(d as never, d.instrument.questions.at(-1)!)).toBe("Asked of everyone");
  });

  it("every road that used to end now ends with the new question, and both channels agree", () => {
    const d = add().def as Def;
    expect(d.instrument.questions.find(q => q.id === "q_support")!.next).toEqual([{ goto: "q_what_is_your_monthly_income" }]);
    expect(problems(d)).toEqual([]);
  });

  it("a choice question gets numbered answers with their own saved values", () => {
    const d = add({ text: "How do you travel to work?", type: "choice", options: ["By bus", "By train", "On foot", "  "] }).def as Def;
    const q = d.instrument.questions.at(-1)!;
    expect(q.options).toEqual([{ key: "1", label: "By bus", value: "by_bus" }, { key: "2", label: "By train", value: "by_train" }, { key: "3", label: "On foot", value: "on_foot" }]);
    expect(problems(d)).toEqual([]);
  });

  it("a yes/no question needs no answer choices", () => {
    const d = add({ text: "Do you have a bank account?", type: "yesno" }).def as Def;
    expect(d.instrument.questions.at(-1)).toMatchObject({ type: "yesno" });
    expect(d.instrument.questions.at(-1)).not.toHaveProperty("options");
    expect(problems(d)).toEqual([]);
  });

  it("an optional question; a phone wording typed for it is ignored, because phone wording is made automatically", () => {
    const d = add({ required: false, spoken: "Something typed by hand" } as never).def as Def;
    expect(d.evidence_requirements.at(-1)!.required).toBe(false);
    expect(d.instrument.questions.at(-1)).not.toHaveProperty("spoken");
    expect(phoneOf(d, d.instrument.questions.at(-1)!.id)).toBe("What is your monthly income?");   // the written question, said as it is
  });

  it("is put in the category of the question before it, or in the one chosen, or in a new one", () => {
    expect(add().def!.instrument.questions.at(-1)!.module).toBe("support");                        // the last question of the built-in mission is in "support"
    expect(add({ category: "work_status" }).def!.instrument.questions.at(-1)!.module).toBe("work_status");
    expect(add({ category: "Monthly Income" }).def!.instrument.questions.at(-1)!.module).toBe("monthly_income");
    expect(categoriesOf(add({ category: "Monthly Income" }).def as never)).toContain("monthly_income");
    expect(add({ category: "  " }).error).toBe("Give the category a name.");
  });

  it("two questions with the same short name still get different keys", () => {
    const once = add().def as Def;
    const twice = addQuestion(once as never, { text: "What is your monthly income (in rupees)?", type: "text", required: true }).def as Def;
    const added = twice.instrument.questions.slice(-2);
    expect(added[0]!.evidence_key).not.toBe(added[1]!.evidence_key);
    expect(added[0]!.id).not.toBe(added[1]!.id);
  });

  it("a question in Hindi gets a key too", () => {
    const d = add({ text: "आप कहाँ काम करते हैं?" }).def as Def;
    expect(d.instrument.questions.at(-1)!.evidence_key).toBe("question");
    expect(problems(d)).toEqual([]);
  });

  it("refuses a repeat, and a choice without enough answers, in plain words", () => {
    expect(add({ text: "Which of these describes you best right now" }).error).toBe("This is the same as question 1. Each question should be asked once.");
    expect(add({ text: "How do you travel?", type: "choice", options: ["Bus"] }).error).toBe("Give between 2 and 10 answer choices, one per line.");
    expect(add({ text: "How do you travel?", type: "choice", options: Array.from({ length: 11 }, (_, n) => `Way ${n}`) }).error).toBe("Give between 2 and 10 answer choices, one per line.");
    expect(add({ text: "How do you travel?", type: "choice", options: ["Bus", "bus."] }).error).toBe("Two answer choices say the same thing.");
    expect(add({ text: "" }).error).toBe("Write the question.");
  });

  it("does not change the definition it was given", () => {
    const d = fresh(), before = JSON.stringify(d);
    addQuestion(d, { text: "What is your monthly income?", type: "text", required: true });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("the whole set of edits, then the server's check", () => {
  it("edit, remove and add together still give a mission the server accepts", () => {
    let d = fresh() as Def;
    const before = phoneOf(d, "q_same_role");
    d = updateQuestion(d, "q_same_role", { text: "What work do you do there?", required: true, phone: before }).def as Def;
    d = removeQuestion(d, "q_edu_course").def as Def;
    d = addQuestion(d, { text: "How satisfied are you with your job?", type: "choice", options: ["Very", "Somewhat", "Not at all"], required: false }).def as Def;
    const r = checkMissionDefinition(d);
    expect(r.problems).toEqual([]);
    expect(r.phone.find(p => p.id === "q_same_role")!.spoken).toBe(before);                       // the phone did not change when the written wording did
    expect(r.phone.at(-1)!.spoken).toContain("Very");                                  // a choice is offered in words on a call
  });
});
