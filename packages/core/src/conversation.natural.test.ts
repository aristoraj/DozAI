// How the conversation sounds: a thank-you after an answer, a friendlier and different line each time a reply is not understood,
// and a helpful line when the participant asks what a question means. All of it is fixed wording from phrases.ts.
// Every participant reply here is made up.
import { describe, it, expect } from "vitest";
import type { Participant } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { InMemoryStore } from "./store";
import { ConversationRunner } from "./conversation";
import { RuleClassifier } from "./classifier";
import { DRAFT_INSTRUMENT } from "./instrument";
import { clarifyLine, reaskHint, thanks, type Lang } from "./phrases";

const T = "t1";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

async function setup(language = "en") {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const person: Participant = { participant_id: "p1", tenant_id: T, display_name: "Test Person", first_name: "Test", phone_masked: "•••• 0000", location: "J", cohort: "C", language, consent: "unknown", recorded_employer: "Acme Retail" };
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
  await svc.beginSession(T, "C-1", "test");
  const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true });
  const say = (text: string) => runner.handleReply(T, "C-1", text);
  const outbox = async () => (await store.listOutbox(T)).filter(o => o.kind === "whatsapp_text").sort((a, b) => Number(a.idempotency_key.split(":")[2]) - Number(b.idempotency_key.split(":")[2])).map(o => String(o.payload.text));
  return { say, outbox, state: () => store.getConversation(T, "C-1") };
}

describe("a thank-you after an answer", () => {
  it("is added before the next question, but not on the first question and not on the closing message", async () => {
    const t = await setup();
    await t.say("yes");
    let out = await t.outbox();
    expect(out.at(-1)).toMatch(/^Thank you\. We will now ask/);          // the instrument's start message already thanks them
    expect(out.at(-1)).not.toMatch(/Got it|Noted|Okay, thanks/);
    await t.say("1");
    out = await t.outbox();
    expect(out.at(-1)).toMatch(/^(Thank you\.|Got it, thanks\.|Noted, thank you\.|Okay, thanks\.)\n\nPlease type the name of the place where you work/);
    for (const r of ["Acme Retail", "Cashier"]) await t.say(r);
    await t.say("yes");
    out = await t.outbox();
    expect(out.at(-1)).toBe(DRAFT_INSTRUMENT.closing_message);          // the closing message is not given a second thank-you
  });

  it("does not use the same words twice in a row", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1"); await t.say("Acme Retail"); await t.say("Cashier");
    const thanksLines = (await t.outbox()).slice(1).map(x => x.split("\n")[0]);
    expect(new Set(thanksLines).size).toBe(thanksLines.length);
  });

  it("a reply that answers several questions gets a line that says so", async () => {
    const t = await setup();
    await t.say("yes");
    await t.say("1");                       // status
    // Employer and title typed together are two answers only through the model; here the rule reader saves one at a time, so use the unit lines
    expect(thanks("en", 2, 0)).toMatch(/few|all of that/);
    expect(thanks("en", 1, 0)).not.toMatch(/few|all of that/);
  });

  it("is in Hindi (English letters) for a participant whose language is Hindi", async () => {
    const t = await setup("hi");
    await t.say("haan"); await t.say("1");
    expect((await t.outbox()).at(-1)).toMatch(/^(Dhanyavaad\.|Theek hai, shukriya\.|Shukriya\.)\n\n/);
  });
});

describe("when a reply is not understood", () => {
  it("the first re-ask is gentle and shows both ways to reply, the second is plainer, and they are not the same words", async () => {
    const t = await setup();
    await t.say("yes");
    await t.say("blah");
    const out = await t.outbox();
    const first = out.find(x => /could not understand/.test(x))!;
    expect(first).toMatch(/You can reply with the number, or say it in your own words\.[\s\S]*Which of these describes you best/);
    await t.say("qwerty");
    const second = (await t.outbox()).filter(x => /could not understand/.test(x)).at(-1)!;
    expect(second).toMatch(/Please reply with one of the numbers below/);
    expect(second).not.toBe(first);
  });

  it("a text question is told what is wanted, in a few words", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1");
    await t.say("no");
    expect((await t.outbox()).at(-1)).toMatch(/could not understand that\.\nJust type it in a few words\.\n\nPlease type the name/);
    await t.say("I don't know");
    expect((await t.outbox()).at(-1)).toMatch(/No problem\. Please type just the name or the answer, in a few words\./);
  });

  it("still ends in a hand-over after the usual number of tries: nothing loops", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("1");
    for (const r of ["no", "idk", "nahi"]) await t.say(r);
    expect((await t.state())?.status).toBe("escalated");
  });

  it("a message with no text keeps the approved 'text only' notice", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("");
    expect((await t.outbox()).at(-1)).toMatch(/only read text messages/);
  });
});

describe("when the participant asks what a question means", () => {
  it("is told how to reply, and the question comes again, for a choice and for a text question", async () => {
    const t = await setup();
    await t.say("yes");
    await t.say("what do you mean?");
    expect((await t.outbox()).at(-1)).toMatch(/^(Of course|Sure)[\s\S]*own words[\s\S]*Which of these describes you best/);
    await t.say("1");
    await t.say("samajh nahi aaya");
    expect((await t.outbox()).at(-1)).toMatch(/^(Of course|Sure)[\s\S]*(own words|few words)[\s\S]*name of the place where you work/);
  });

  it("answering afterwards works and the failure count starts again", async () => {
    const t = await setup();
    await t.say("yes"); await t.say("what do you mean?"); await t.say("3");
    expect((await t.state())?.reasks).toBe(0);
    expect((await t.state())?.current).toBe("q_ne_reason");
  });

  it("asking again and again still ends in a hand-over", async () => {
    const t = await setup();
    await t.say("yes");
    for (const r of ["what do you mean", "I do not understand", "please explain"]) await t.say(r);
    expect((await t.state())?.status).toBe("escalated");
  });
});

describe("the wording is fixed text, never generated", () => {
  const types = ["choice", "yesno", "text"] as const;
  const langs: Lang[] = ["en", "hi"];

  it("every phrase is a short plain sentence with no placeholders", () => {
    const all: string[] = [];
    for (const l of langs) {
      for (let n = 0; n < 4; n++) { all.push(thanks(l, 1, n), thanks(l, 3, n)); for (const ty of types) all.push(clarifyLine(l, ty, n)); }
      for (const ty of types) for (const a of [1, 2]) all.push(reaskHint(l, ty, a));
    }
    for (const s of all) { expect(s.length, s).toBeGreaterThan(5); expect(s.length, s).toBeLessThan(140); expect(s, s).not.toMatch(/[{}<>$]|undefined|null/); }
  });

  it("the Hindi lines avoid gendered verbs", () => {
    for (const s of [thanks("hi", 1, 0), thanks("hi", 1, 1), thanks("hi", 1, 2), thanks("hi", 2, 0), thanks("hi", 2, 1), clarifyLine("hi", "choice", 0), clarifyLine("hi", "text", 1), reaskHint("hi", "choice", 1), reaskHint("hi", "text", 2)]) {
      expect(s, s).not.toMatch(/\b(gaya|gayi|raha|rahi|karta|karti)\b/i);
    }
  });

  it("every message the runner sends is an approved instrument text, or one of these fixed lines followed by an instrument question", async () => {
    const t = await setup();
    for (const r of ["yes", "blah", "what do you mean", "2", "Nova", "no", "Desk", "pay", "yes"]) await t.say(r);
    const fixed = [...langs.flatMap(l => [0, 1, 2, 3].flatMap(n => [thanks(l, 1, n), thanks(l, 2, n), ...types.map(ty => clarifyLine(l, ty, n))])), ...langs.flatMap(l => types.flatMap(ty => [1, 2].map(a => reaskHint(l, ty, a))))];
    const approved = [DRAFT_INSTRUMENT.start_message, DRAFT_INSTRUMENT.closing_message, DRAFT_INSTRUMENT.reask_prefix, DRAFT_INSTRUMENT.unsupported_prefix, ...DRAFT_INSTRUMENT.questions.map(q => q.text)];
    for (const message of await t.outbox()) {
      let rest = message;
      for (const part of [...approved, ...fixed, "Reply with the number."]) // the instrument's texts first, because its start message begins with the same words as a thank-you
       rest = rest.split(part).join("");
      // what remains is only the option lines ("1. Yes") and blank space
      expect(rest.replace(/^\s*\d+\. .*$/gm, "").trim(), message).toBe("");
    }
  });
});
