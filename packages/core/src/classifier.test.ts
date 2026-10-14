// The rule reader: what a reply means, without a model. Every reply here is made up.
import { describe, it, expect } from "vitest";
import { RuleClassifier, matchOption, normaliseReply, validateAnswer, isPlainSelection } from "./classifier";
import { DRAFT_INSTRUMENT, questionById } from "./instrument";

const rules = new RuleClassifier();
const status = questionById(DRAFT_INSTRUMENT, "q_status")!;     // choice, 4 options
const employer = questionById(DRAFT_INSTRUMENT, "q_same_employer")!; // text
const support = questionById(DRAFT_INSTRUMENT, "q_support")!;   // yes/no
const read = (text: string, q = status) => rules.classify({ text, question: q, context: "question", instrument: DRAFT_INSTRUMENT });
const readConsent = (text: string) => rules.classify({ text, question: null, context: "consent", instrument: DRAFT_INSTRUMENT });

describe("choosing an option", () => {
  it.each([
    ["1", "same_job"], ["2", "changed_job"], ["option 2", "changed_job"], ["number 3", "not_employed"], ["2 please", "changed_job"],
    ["Option 4 ji", "education_training"], ["second one", "changed_job"], ["the first", "same_job"],
    ["same place", "same_job"], ["I work at the same place", "same_job"], ["not working", "not_employed"], ["I am studying", "education_training"],
  ])("%s -> %s", async (text, value) => {
    expect(await read(text)).toMatchObject({ intent: "answer", value });
  });

  it("a number inside a sentence is not a pick", async () => {
    for (const text of ["2 months ago I left my job", "I left 2 weeks back", "3 saal se kaam kar raha hoon", "I earn 15000 a month", "1 year ago"]) {
      const r = await read(text);
      expect(r.intent, text).not.toBe("answer");
      expect(r.option_key, text).toBeUndefined();
    }
  });

  it("does not pick an option the reply turns around, or two at once", async () => {
    expect((await read("I do not work at the same place")).intent).not.toBe("answer");
    expect((await read("not the same place anymore")).intent).not.toBe("answer");
    expect((await read("same place or different place, not sure")).intent).not.toBe("answer");
    expect(matchOption(normaliseReply("same job but also studying"), status)).toBeUndefined(); // two options named
  });

  it("is_plain_selection tells a bare pick from a sentence that contains one", () => {
    expect(isPlainSelection("2", status)).toBe(true);
    expect(isPlainSelection(normaliseReply("same place"), status)).toBe(true);
    expect(isPlainSelection(normaliseReply("same place and I am a cashier at Acme"), status)).toBe(false);
  });

  it("'I am not working' is an answer, 'I am not <name>' is a wrong person", async () => {
    expect(await read("I am not working right now")).toMatchObject({ intent: "answer", value: "not_employed" });
    expect(await read("I'm not working")).toMatchObject({ intent: "answer", value: "not_employed" });
    expect((await read("I am not Asha")).intent).toBe("wrong_person");
  });
});

describe("Hindi, Hinglish and Devanagari", () => {
  it("reads Devanagari digits and ordinals", async () => {
    expect(await read("२")).toMatchObject({ intent: "answer", value: "changed_job" });
    expect(await read("दूसरा")).toMatchObject({ intent: "answer", value: "changed_job" });
    expect(await read("pehla")).toMatchObject({ intent: "answer", value: "same_job" });
  });

  it("keeps the vowel signs of Devanagari so a word is not cut to one letter", () => {
    expect(normaliseReply("हाँ!")).toBe("हाँ");
    expect(normaliseReply("नहीं।")).toBe("नहीं");
  });

  it("reads yes and no in all three ways of writing", async () => {
    for (const yes of ["haan", "Haan ji", "हाँ", "हां जी", "ji"]) expect(await read(yes, support), yes).toMatchObject({ intent: "answer", value: "yes" });
    for (const no of ["nahi", "nahin", "नहीं", "नही", "no"]) expect(await read(no, support), no).toMatchObject({ intent: "answer", value: "no" });
  });

  it("consent: Devanagari yes continues, Devanagari no stops", async () => {
    expect(await readConsent("हाँ")).toMatchObject({ intent: "answer", value: "yes" });
    expect(await readConsent("ठीक है")).toMatchObject({ intent: "answer", value: "yes" });
    expect((await readConsent("नहीं")).intent).toBe("stop");
    expect((await readConsent("nahi")).intent).toBe("stop");
  });

  it("stop in Devanagari", async () => {
    expect((await read("बंद करो")).intent).toBe("stop");
    expect((await read("band karo")).intent).toBe("stop");
  });
});

describe("replies that do not answer", () => {
  it("'I don't know' and the like are never an answer to a text question", async () => {
    for (const text of ["I don't know", "idk", "not sure", "pata nahi", "mujhe pata nahi hai", "पता नहीं", "मालूम नहीं", "no idea"]) {
      expect((await read(text, employer)).intent, text).toBe("unclear");
    }
  });

  it("yes, no, none, nothing and bare digits are not an employer name", async () => {
    for (const text of ["no", "No.", "nope", "none", "nothing", "nahi", "नहीं", "कुछ नहीं", "yes", "haan", "12345", "n/a"]) {
      const r = await read(text, employer);
      expect(r.intent === "answer", text).toBe(false);
    }
  });

  it("'I don't know' to a choice question is unclear, not an option", async () => {
    expect((await read("I don't know")).intent).toBe("unclear");
    expect((await read("pata nahi")).intent).toBe("unclear");
  });

  it("a real name is an answer", async () => {
    expect(await read("Acme Retail", employer)).toMatchObject({ intent: "answer", value: "Acme Retail" });
    expect(await read("Repeat Retail Pvt Ltd", employer)).toMatchObject({ intent: "answer" }); // the word 'repeat' inside a name
  });
});

describe("asking what a question means", () => {
  it.each(["what do you mean?", "what does same place mean", "can you repeat that", "please explain", "I don't understand", "samajh nahi aaya", "kya matlab?", "क्या मतलब", "मुझे समझ नहीं आया"])("%s -> clarify", async text => {
    expect((await read(text)).intent).toBe("clarify");
    expect((await read(text, employer)).intent).toBe("clarify");
  });

  it("asking who we are is still a question about us, not about the question", async () => {
    expect(await read("who are you?")).toMatchObject({ intent: "faq", faq_id: "who" });
  });
});

describe("validateAnswer: the check every answer passes before it is saved", () => {
  it("a choice must name one of its own options", () => {
    expect(validateAnswer(status, { option_key: "3" })).toEqual({ value: "not_employed", label: "I am not working right now" });
    expect(validateAnswer(status, { option_key: "9" })).toBeNull();
    expect(validateAnswer(status, { value: "made_up" })).toBeNull();
    expect(validateAnswer(support, { option_key: "2" })).toMatchObject({ value: "no" });
  });

  it("a text answer must be real text of a sensible size", () => {
    expect(validateAnswer(employer, { value: "  Acme   Retail " })).toEqual({ value: "Acme Retail" });
    for (const value of ["", " ", "a", "no", "None", "I don't know", "पता नहीं", "123", "!!!", "x".repeat(301)]) expect(validateAnswer(employer, { value }), value).toBeNull();
    expect(validateAnswer(employer, {})).toBeNull();
  });
});

describe("yes/no answered in a sentence", () => {
  // Written the way a drafted mission writes it: a choice whose only options are Yes and No.
  const changed = { id: "q_changed", module: "status", type: "choice", evidence_key: "changed_job", text: "Have you changed jobs since your training?",
    options: [{ key: "1", label: "Yes", value: "yes" }, { key: "2", label: "No", value: "no" }] } as const;

  it.each([
    ["I am planning to change jobs", "no"], ["Not yet, thinking about it", "no"], ["I have not changed", "no"], ["No, I have not", "no"],
    ["I will change next month", "no"], ["abhi nahi, soch raha hoon", "no"],
    ["Yes, I already changed", "yes"], ["I have, last year", "yes"], ["haan badal liya", "yes"],
  ])("'Have you changed jobs?' + '%s' -> %s", async (text, value) => {
    expect(await read(text, changed as never)).toMatchObject({ intent: "answer", value });
  });

  it.each([["I don't need any support", "no"], ["Sure, please do", "yes"], ["of course", "yes"]])("'Would you like support?' + '%s' -> %s", async (text, value) => {
    expect(await read(text, support)).toMatchObject({ intent: "answer", value });
  });

  it("a reply that could go either way is not guessed", async () => {
    for (const text of ["I am not sure", "maybe, I don't know", "it is complicated", "pata nahi"]) expect((await read(text, changed as never)).intent, text).not.toBe("answer");
  });

  it("only for yes/no: a sentence with 'not' does not pick an option of a longer list", async () => {
    expect((await read("I have not decided", status)).intent).not.toBe("answer");
  });
});
