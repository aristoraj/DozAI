// The interview answers a participant's own questions instead of repeating itself, and a finished interview never leaves the case waiting
// for a reply that will not come. Everything here is made up.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Participant } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import {
  CaseService, ConversationRunner, InMemoryStore, RuleClassifier, ScriptedResponder, encryptPhone, phoneHash, replyProblem, DEMO_TENANT as T,
  DRAFT_INSTRUMENT, firstQuestion, type ConversationResponder, type ResponderInput,
} from "@dozai/core";
import { ClaudeConversationResponder, tick, type AgentRuntimePort } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";
const FIRST_Q = firstQuestion(DRAFT_INSTRUMENT).text;
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

async function world(responder?: ConversationResponder, automatic = true) {
  const clock = { t: new Date("2026-10-14T10:00:00Z") };
  const svc = new CaseService(new InMemoryStore(), () => new Date(clock.t), OPEN);
  const person: Participant = { participant_id: "p-1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "C", language: "en", consent: "granted", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: person });
  await svc.beginSession(T, "C-1", "t");
  if (automatic) await svc.updateControls({ user_id: "a", tenant_id: T, role: "admin" }, { autonomy: { message_free: "automatic" } });
  const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), responder, allowDraft: true });
  const sent = async () => (await svc.store.listOutbox(T)).filter(o => o.kind === "whatsapp_text").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const say = async (text: string) => { const r = await runner.handleReply(T, "C-1", text); return r; };
  await say("yes"); // consent: the first question is asked
  return { svc, runner, say, sent, clock };
}
const lastText = async (w: Awaited<ReturnType<typeof world>>) => String((await w.sent()).at(-1)!.payload.text);

/** Stands in for the model: answers "why" and "who" from the approved facts, and says it does not know anything else. */
const writer = (log: ResponderInput[] = []): ConversationResponder => ({
  async respond(i) {
    log.push(i);
    if (/who/i.test(i.text)) return { reply: "We are the programme team that ran your training. I am an automated assistant for them.", kind: "answered" };
    if (/why/i.test(i.text)) return { reply: "We want to know how you are doing now, so we can see if the programme helped.", kind: "answered" };
    if (/salary|pay/i.test(i.text)) return { reply: "I do not have that information, but I will pass your question to the team.", kind: "unknown" };
    if (/^\W*$/.test(i.text)) return { reply: "", kind: "noise" };
    return null;
  },
});

describe("the interview answers what the participant actually asks", () => {
  it("answers 'who are you?' and 'why do you need this?' in its own words, then asks the same question again underneath", async () => {
    const w = await world(writer());
    await w.say("Who are you?");
    let t = await lastText(w);
    expect(t).toContain("automated assistant");
    expect(t).toContain(FIRST_Q);                       // the interview carries on under the answer
    await w.say("Why do you need this information?");
    t = await lastText(w);
    expect(t).toContain("how you are doing now");
    expect(t).toContain(FIRST_Q);
    expect(t).not.toMatch(/couldn't|could not|sorry/i);                      // not the generic "I did not get that"
    expect((await w.sent()).filter(o => o.payload.free === true)).toHaveLength(2); // written replies are marked as agent-written
  });

  it("still takes the answer afterwards: the question was only paused", async () => {
    const w = await world(writer());
    await w.say("Why do you need this?");
    const r = await w.say("1");
    expect(r.action).toBe("answered");
    const state = await w.runner.state(T, "C-1");
    expect(state!.answers.length).toBe(1);
  });

  it("says honestly when it has no approved answer, and carries on with the interview", async () => {
    const w = await world(writer());
    await w.say("What salary will I get?");
    const t = await lastText(w);
    expect(t).toContain("do not have that information");
    expect(t).toContain(FIRST_Q);
    const events = await w.svc.store.listEvents(T, "C-1");
    expect(events.some(e => e.type === "reply_handled" && /not approved an answer/.test(e.summary))).toBe(true);   // the team can see what was asked
  });

  it("uses the approved wording when agent-written messages are not switched on", async () => {
    const log: ResponderInput[] = [];
    const w = await world(writer(log), false);
    await w.say("Why do you need this?");
    expect(log).toHaveLength(0);                                              // the writer was never asked
    expect((await w.sent()).every(o => o.payload.free !== true)).toBe(true);
  });

  it("falls back to the approved wording when the writer fails, declines or is refused", async () => {
    for (const bad of [
      { async respond() { throw new Error("model down"); } },
      { async respond() { return null; } },
      { async respond() { return { reply: "Visit www.example.com for a guaranteed job offer", kind: "answered" as const }; } },
    ] as ConversationResponder[]) {
      const w = await world(bad);
      const r = await w.say("Why do you need this?");
      expect(["faq", "reasked"]).toContain(r.action);
      expect((await w.sent()).every(o => o.payload.free !== true)).toBe(true);
      expect(await lastText(w)).toContain(FIRST_Q);      // the question is never lost
    }
  });

  it("does not answer a message that says nothing, and hands over after too many side conversations", async () => {
    const log: ResponderInput[] = [];
    const w = await world(writer(log));
    await w.say("?!");
    expect(log.at(-1)!.text).toBe("?!");
    expect((await w.sent()).filter(o => o.payload.free === true)).toHaveLength(0);   // noise gets the approved re-ask, not a chat
    for (let i = 0; i < 6; i++) await w.say("Why do you ask?");
    const written = (await w.sent()).filter(o => o.payload.free === true).length;
    expect(written).toBe(5);                                                  // the sixth question is not answered by the writer
    const c = await w.svc.getCase(T, "C-1");
    expect(["waiting", "review", "running"]).toContain(c.status);
  });

  it("never lets a participant's words steer it: an instruction is data, and the checks refuse anything unsafe", () => {
    expect(replyProblem("We are the programme team.")).toBeNull();
    expect(replyProblem("")).toMatch(/empty/);
    expect(replyProblem("x".repeat(500))).toMatch(/longer/);
    expect(replyProblem("See https://example.com")).toMatch(/link/);
    expect(replyProblem("Call 9876543210 now")).toMatch(/number/);
    expect(replyProblem("We guarantee you a job")).toMatch(/promise/);
    expect(replyProblem("Please send money by UPI")).toMatch(/money/);
  });
});

describe("the plain stand-in writer", () => {
  it("answers the common questions from the approved facts and nothing else", async () => {
    const w = new ScriptedResponder();
    const facts = [{ id: "who", answer: "We are the Hiring team." }, { id: "why", answer: "To see how you are doing." }, { id: "time", answer: "It takes about a minute." }];
    const base = { question: null, context: "consent" as const, mission: {}, recent: [], names: [] };
    expect((await w.respond({ ...base, text: "who are you?", facts }))?.reply).toBe("We are the Hiring team.");
    expect((await w.respond({ ...base, text: "why do you want this", facts }))?.reply).toBe("To see how you are doing.");
    expect((await w.respond({ ...base, text: "how long will it take?", facts }))?.reply).toBe("It takes about a minute.");
    expect(await w.respond({ ...base, text: "what is the weather", facts })).toBeNull();
  });
});

describe("the model writer", () => {
  const client = (reply: unknown, seen: Record<string, unknown>[] = []) => ({ messages: { async create(p: Record<string, unknown>) { seen.push(p); return { content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }] } as never; } } });
  const input: ResponderInput = { text: "Why do you need this? I am Asha Test, call 9876543210", question: null, context: "consent", mission: { programme: "Project X", objective: "See how people are doing" }, facts: [{ id: "why", answer: "To see how you are doing." }], recent: [], names: ["Asha Test", "Asha"] };

  it("sends only redacted text and the approved facts, and returns the reply and its kind", async () => {
    const seen: Record<string, unknown>[] = [];
    const out = await new ClaudeConversationResponder({ client: client({ reply: "To see how you are doing.", kind: "answered" }, seen) }).respond(input);
    expect(out).toEqual({ reply: "To see how you are doing.", kind: "answered" });
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain("Asha");
    expect(sent).not.toContain("9876543210");
    expect(sent).toContain("To see how you are doing.");
    expect(sent).toContain("untrusted");
  });

  it("returns nothing for an invalid answer or a failure, so the approved wording is used", async () => {
    expect(await new ClaudeConversationResponder({ client: client("not json") }).respond(input)).toBeNull();
    expect(await new ClaudeConversationResponder({ client: client({ reply: "hi", kind: "chat" }) }).respond(input)).toBeNull();
    const broken = { messages: { async create() { throw new Error("down"); } } };
    expect(await new ClaudeConversationResponder({ client: broken }).respond(input)).toBeNull();
  });
});

describe("a finished interview does not leave the case waiting for a reply", () => {
  async function finish() {
    const w = await world(writer());
    await w.say("1");                       // working
    return w;
  }
  it("moves to 'checking the answers' as soon as the last question is answered", async () => {
    const w = await world(writer());
    // answer every question with the first option, or a short text, until the interview closes
    for (let i = 0; i < 12; i++) {
      const st = await w.runner.state(T, "C-1");
      if (st!.status === "done") break;
      await w.say(/employer|company|name/i.test(await lastText(w)) ? "Acme Retail" : "1");
    }
    expect((await w.runner.state(T, "C-1"))!.status).toBe("done");
    const c = await w.svc.getCase(T, "C-1");
    expect(c.status).toBe("evaluating");
    expect(c.next_action).toContain("judging the answers");
    void finish;
  });

  it("hands the case to a person when the agent looks twice and still reaches no decision", async () => {
    const w = await world(writer());
    for (let i = 0; i < 12; i++) { if ((await w.runner.state(T, "C-1"))!.status === "done") break; await w.say(/employer|company|name/i.test(await lastText(w)) ? "Acme Retail" : "1"); }
    expect((await w.svc.getCase(T, "C-1")).status).toBe("evaluating");
    const undecided: AgentRuntimePort = { async runCase() { throw new Error("not used"); }, async resumeCase() { return undefined as never; } } as never;
    // the first pass wakes the agent for the finished interview; it decides nothing, so a second look is scheduled
    await w.svc.scheduleWake(await w.svc.getCase(T, "C-1"), { at: new Date(w.clock.t), reason: "evidence_ready", by: "scheduler" });
    const first = await tick(w.svc, T, { piiKey: KEY, agent: undecided });
    expect(first.wakes.fired).toContain("C-1");
    expect((await w.svc.getCase(T, "C-1")).status).toBe("review");            // the second look also decided nothing: a person decides
    const events = await w.svc.store.listEvents(T, "C-1");
    expect(JSON.stringify(events)).toContain("did not reach a decision");
  });
});
