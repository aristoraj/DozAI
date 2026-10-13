// The real path, with the network mocked: Interakt webhook -> inbox -> tick -> conversation runner -> outbox -> Interakt send.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { CaseService, ConversationRunner, DEMO_TENANT, GatewayTools, InMemoryStore, RuleClassifier, encryptPhone, phoneHash, verifyChain } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { InteraktChannels, ScriptedAgentRuntime, storeInteraktEvent, tick } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

async function world() {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const p: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Asha Kumari", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "Acme Retail" };
  await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", participant: p });
  await svc.beginSession(DEMO_TENANT, "C-1", "test"); // the intro template went out; waiting for a reply
  const sentBodies: any[] = [];
  const channel = new InteraktChannels({ apiKey: "k", piiKey: KEY, allowlist: [PHONE], fetch: (async (_u: string, init: RequestInit) => { sentBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ result: true, id: `m${sentBodies.length}` }), { status: 201 }); }) as never });
  const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true });
  const agent = new ScriptedAgentRuntime(new GatewayTools(svc));
  let n = 0;
  const reply = async (text: string, type = "message_received") => {
    await storeInteraktEvent(svc, DEMO_TENANT, { type, data: { customer: { channel_phone_number: PHONE }, message: { id: `w${++n}`, message: text } } }, KEY);
    return tick(svc, DEMO_TENANT, { piiKey: KEY, channel, agent, runner });
  };
  return { store, svc, reply, sentBodies };
}

describe("participant replies drive the interview", () => {
  it("'Yes, continue' sends the first approved question as a WhatsApp text", async () => {
    const w = await world();
    const r = await w.reply("Yes, continue");
    expect(r.conversation[0]).toContain("started");
    expect(r.sent).toBe(1);
    expect(w.sentBodies[0]).toMatchObject({ type: "Text", countryCode: "+91", phoneNumber: "9876543210" });
    expect(w.sentBodies[0].data.message).toContain("Which of these describes you best");
    expect((await w.store.getParticipant(DEMO_TENANT, "p1"))?.consent).toBe("granted");
  });

  it("a button reply in Interakt's JSON shape works the same", async () => {
    const w = await world();
    const r = await w.reply(JSON.stringify({ button: { text: "Yes, continue", payload: "p" } }));
    expect(r.conversation[0]).toContain("started");
  });

  it("walks the whole interview, stores answers, and wakes the agent exactly once at the end", async () => {
    const w = await world();
    await w.reply("Yes, continue");
    await w.reply("1");
    await w.reply("Acme Retail");
    await w.reply("Sales associate");
    const last = await w.reply("2");
    expect(last.conversation[0]).toContain("finished");
    const ev = Object.fromEntries((await w.store.listEvidence("C-1")).map(e => [e.question_id, e.value]));
    expect(ev).toMatchObject({ work_status: "same_job", employer_name: "Acme Retail", role_title: "Sales associate", support_requested: "no" });
    expect(w.sentBodies.at(-1).data.message).toContain("Thank you for your time");
    expect((await w.store.getConversation(DEMO_TENANT, "C-1"))?.status).toBe("done");
    expect((await new CaseService(w.store).verifyLedger(DEMO_TENANT)).ok).toBe(true);
  });

  it("an irrelevant reply is re-asked with the same approved question, not ignored", async () => {
    const w = await world();
    await w.reply("Yes, continue");
    const r = await w.reply("lol what");
    expect(w.sentBodies.at(-1).data.message).toMatch(/could not understand[\s\S]*Which of these describes you best/);
    expect(r.conversation[0]).toContain("reasked");
  });

  it("a stop request ends it and nothing more is sent", async () => {
    const w = await world();
    await w.reply("Yes, continue");
    const before = w.sentBodies.length;
    await w.reply("please stop");
    expect((await w.svc.getCase(DEMO_TENANT, "C-1")).outcome).toBe("opted_out");
    await w.reply("hello?");
    expect(w.sentBodies.length).toBe(before);
  });

  it("the same webhook delivered twice does not ask twice", async () => {
    const w = await world();
    const body = { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: "dup", message: "Yes" } } };
    await storeInteraktEvent(w.svc, DEMO_TENANT, body, KEY);
    await storeInteraktEvent(w.svc, DEMO_TENANT, body, KEY);
    const channel = new InteraktChannels({ apiKey: "k", piiKey: KEY, allowlist: [PHONE], fetch: (async (_u: string, init: RequestInit) => { w.sentBodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ result: true, id: "x" }), { status: 201 }); }) as never });
    const runner = new ConversationRunner(w.svc, { classifier: new RuleClassifier(), allowDraft: true });
    await tick(w.svc, DEMO_TENANT, { piiKey: KEY, channel, agent: new ScriptedAgentRuntime(new GatewayTools(w.svc)), runner });
    await tick(w.svc, DEMO_TENANT, { piiKey: KEY, channel, agent: new ScriptedAgentRuntime(new GatewayTools(w.svc)), runner });
    expect(w.sentBodies.filter(b => b.data?.message?.includes("Which of these"))).toHaveLength(1);
  });

  it("when Interakt rejects a text send, the failure is recorded and visible", async () => {
    const w = await world();
    const bad = new InteraktChannels({ apiKey: "k", piiKey: KEY, allowlist: [PHONE], fetch: (async () => new Response(JSON.stringify({ result: false, message: "Type Text is not supported" }), { status: 400 })) as never });
    await storeInteraktEvent(w.svc, DEMO_TENANT, { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: "x1", message: "yes" } } }, KEY);
    const runner = new ConversationRunner(w.svc, { classifier: new RuleClassifier(), allowDraft: true });
    await tick(w.svc, DEMO_TENANT, { piiKey: KEY, channel: bad, agent: new ScriptedAgentRuntime(new GatewayTools(w.svc)), runner });
    const events = await w.store.listEvents(DEMO_TENANT, "C-1");
    expect(events.some(e => e.type === "message_status" && e.summary.includes("Type Text is not supported"))).toBe(true);
    expect(verifyChain(events).ok).toBe(true);
  });

  it("wakes the agent once when the interview finishes, even if the job runs again", async () => {
    const w = await world();
    const woke: string[] = [];
    const agent = { async runCase() { throw new Error("n/a"); }, async resumeCase(_s: unknown, _t: string, id: string) { woke.push(id); return {} as never; } };
    const runner = new ConversationRunner(w.svc, { classifier: new RuleClassifier(), allowDraft: true });
    const channel = new InteraktChannels({ apiKey: "k", piiKey: KEY, allowlist: [PHONE], fetch: (async () => new Response(JSON.stringify({ result: true, id: "m" }), { status: 201 })) as never });
    let n = 100;
    const say = async (text: string) => { await storeInteraktEvent(w.svc, DEMO_TENANT, { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: `z${++n}`, message: text } } }, KEY); return tick(w.svc, DEMO_TENANT, { piiKey: KEY, channel, agent, runner }); };
    for (const r of ["yes", "4", "Nursing"]) await say(r);
    expect(woke).toEqual([]); // not finished yet
    const done = await say("no");
    expect(done.resumed).toEqual(["C-1"]);
    await tick(w.svc, DEMO_TENANT, { piiKey: KEY, channel, agent, runner });
    expect(woke).toEqual(["C-1"]);
  });
});
