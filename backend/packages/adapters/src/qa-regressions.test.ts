// Regressions found in a test-and-fix round. Each test failed before its fix.
import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { CaseService, DRAFT_INSTRUMENT, RuleClassifier, defaultControls, DEMO_TENANT, encryptPhone, GatewayTools, InMemoryStore, phoneHash, PLACEMENT_RETENTION_V1 } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { classifyReply, ClaudeAgentRuntime, ClaudeReplyClassifier, dispatchVoice, FakeVoice, InteraktChannels, processInbox, ScriptedAgentRuntime, storeInteraktEvent, syncCalls, tick, type AgentRuntimePort, type MessagesClient } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876500201";
const M = PLACEMENT_RETENTION_V1;
const T = DEMO_TENANT;
const session = { session_id: "s", tenant_id: T, case_id: "C-1", mission_version: M.version, employee_version: "x" };

/** Real contact hours (09:30 to 18:00 IST) and a clock the test moves. 11:30 UTC is 17:00 IST. */
async function world() {
  let now = new Date("2026-10-14T11:30:00Z");
  const svc = new CaseService(new InMemoryStore(), () => now, DEFAULT_POLICY);
  svc.voiceEnabled = true;
  await svc.store.putControls({ ...defaultControls(T), autonomy: { ...defaultControls(T).autonomy, voice_call: "automatic" } });
  const participant: Participant = { participant_id: "p1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•••• 0201", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", mission_version: M.version, participant });
  await svc.beginSession(T, "C-1", "t");
  await svc.store.putVoiceForm({ tenant_id: T, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "x", published_by: "y" });
  return { svc, tools: new GatewayTools(svc), at: (iso: string) => { now = new Date(iso); } };
}
const sends: unknown[] = [];
const channel = () => new InteraktChannels({ apiKey: "k", piiKey: KEY, fetch: (async (_u: string, init: RequestInit) => { sends.push(init.body); return new Response(JSON.stringify({ result: true, id: "prov-1" }), { status: 201 }); }) as never });

describe("found in testing: contact hours and consent are checked again when the message or call actually goes out", () => {
  it("a call requested at 17:00 IST that is still queued at 18:30 waits for the next morning instead of ringing in the evening", async () => {
    const { svc, tools, at } = await world();
    const c = await svc.getCase(T, "C-1");
    expect((await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: "key-late-0001", expected_version: c.version, reason: "No reply for two days." })).error).toBeUndefined();
    at("2026-10-14T13:00:00Z"); // 18:30 IST
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(0);
    expect(voice.calls).toHaveLength(0);
    expect((await svc.store.listOutbox(T)).find(o => o.kind === "voice_call")?.status).toBe("pending");
    expect((await svc.getCase(T, "C-1")).status).toBe("call_scheduled");
    at("2026-10-15T05:00:00Z"); // 10:30 IST the next day
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(1);
    expect(voice.calls).toHaveLength(1);
  });

  it("a WhatsApp template still queued after hours is not sent until the window opens", async () => {
    const { svc, tools, at } = await world();
    const c = await svc.getCase(T, "C-1");
    expect((await tools.call(session, "whatsapp_send_template", { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-late-0002", expected_version: c.version })).error).toBeUndefined();
    at("2026-10-14T13:00:00Z");
    sends.length = 0;
    expect(await channel().dispatchOutbox(svc, T)).toBe(0);
    expect(sends).toHaveLength(0);
    at("2026-10-15T05:00:00Z");
    expect(await channel().dispatchOutbox(svc, T)).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("a queued template is not sent to someone who declined after it was queued", async () => {
    const { svc, tools } = await world();
    const c = await svc.getCase(T, "C-1");
    expect((await tools.call(session, "whatsapp_send_template", { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-decl-0003", expected_version: c.version })).error).toBeUndefined();
    // A stop reply is processed by another scheduler pass after this one listed the outbox: the person is now declined.
    const p = (await svc.store.getParticipant(T, "p1"))!;
    await svc.store.putParticipant({ ...p, consent: "declined" });
    sends.length = 0;
    expect(await channel().dispatchOutbox(svc, T)).toBe(0);
    expect(sends).toHaveLength(0);
    expect((await svc.store.listOutbox(T))[0]?.status).toBe("failed");
  });
});

describe("found in testing: the kill switch stops the scripted agent too", () => {
  it("with the kill switch on, neither a new session nor a resume runs, and nothing is decided", async () => {
    const { svc, tools } = await world();
    await svc.updateControls({ user_id: "ops", tenant_id: T, role: "admin" }, { paused: true, reason: "Checking a template" });
    const agent = new ScriptedAgentRuntime(tools);
    const before = (await svc.getCase(T, "C-1")).version;
    await expect(agent.runCase(svc, T, "C-1", "same_job")).rejects.toMatchObject({ code: "AGENT_PAUSED" });
    await expect(agent.resumeCase(svc, T, "C-1")).rejects.toMatchObject({ code: "AGENT_PAUSED" });
    expect((await svc.getCase(T, "C-1")).version).toBe(before);
    expect(await svc.store.listOutbox(T)).toHaveLength(0);
  });
});

describe("found in testing: call results and failed replies", () => {
  it("a call scheduled more than a day ahead is still checked once it is due, so the case does not stay call_scheduled", async () => {
    const { svc, tools, at } = await world();
    const c = await svc.getCase(T, "C-1");
    // Requested at 17:00 IST on the 14th, for 10:30 IST on the 16th: 41.5 hours later.
    expect((await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: "key-later-0004", expected_version: c.version, reason: "Asked to be called on Friday.", start_at: "2026-10-16T05:00:00Z" })).error).toBeUndefined();
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(1);
    at("2026-10-16T05:15:00Z");
    voice.complete(voice.calls[0]!.communication_id, { answers: { work_status: "same_job", employer_name: "Acme" } });
    const r = await syncCalls(svc, T, voice);
    expect(r.checked).toBe(1);
    expect(r.applied).toBe(1);
    expect((await svc.getCase(T, "C-1")).status).toBe("evaluating");
  });

  it("a reply that could not be applied does not keep the participant's words in storage", async () => {
    const { svc } = await world();
    await storeInteraktEvent(svc, T, { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: "w-err-1", message: "I work at Acme near Jaipur" } } }, KEY);
    svc.recordInbound = async () => { throw new Error("store unavailable"); };
    const r = await processInbox(svc, T, KEY);
    expect(r.errors).toBe(1);
    const [item] = await svc.store.listInbox(T);
    expect(item?.status).toBe("error");
    expect(JSON.stringify(item)).not.toContain("Acme near Jaipur");
  });
});

describe("found in testing: a reply that could not wake the agent at once is not lost", () => {
  const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
  async function many(n: number) {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), OPEN);
    for (let i = 1; i <= n; i++) {
      const phone = `9198765002${String(i).padStart(2, "0")}`;
      await svc.createCase({ tenant_id: T, run_id: "r", case_id: `C-${i}`, participant: { participant_id: `p${i}`, tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", phone_enc: encryptPhone(KEY, phone), phone_hash: phoneHash(KEY, phone), location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" } });
      await svc.beginSession(T, `C-${i}`, "t");
      await storeInteraktEvent(svc, T, { type: "message_received", data: { customer: { channel_phone_number: phone }, message: { id: `w-${i}`, message: "I work at Nova now" } } }, KEY);
    }
    const resumed: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("not used"); }, async resumeCase(_s, _t, caseId) { resumed.push(caseId); return {} as never; } };
    return { svc, agent, resumed };
  }

  it("a reply that arrives while the kill switch is on wakes the agent once it is switched back on", async () => {
    const { svc, agent, resumed } = await many(1);
    await svc.updateControls({ user_id: "ops", tenant_id: T, role: "admin" }, { paused: true, reason: "Checking" });
    expect((await tick(svc, T, { piiKey: KEY, agent })).resumed).toEqual([]);
    await svc.updateControls({ user_id: "ops", tenant_id: T, role: "admin" }, { paused: false });
    await tick(svc, T, { piiKey: KEY, agent });
    expect(resumed).toEqual(["C-1"]);
    await tick(svc, T, { piiKey: KEY, agent });
    expect(resumed).toEqual(["C-1"]); // once, not again
  });

  it("more replies than one pass may handle are handled by the next pass", async () => {
    const { svc, agent, resumed } = await many(4);
    await tick(svc, T, { piiKey: KEY, agent, maxResumes: 3 });
    expect(resumed).toHaveLength(3);
    await tick(svc, T, { piiKey: KEY, agent, maxResumes: 3 });
    expect([...resumed].sort()).toEqual(["C-1", "C-2", "C-3", "C-4"]);
  });
});

describe("found in testing: a call that was placed is never marked as failed", () => {
  it("when saving the case change fails after the provider started the call, the call stays placed and is not placed again", async () => {
    const { svc, tools } = await world();
    const c = await svc.getCase(T, "C-1");
    expect((await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: "key-book-0005", expected_version: c.version, reason: "No reply for two days." })).error).toBeUndefined();
    const real = svc.transition.bind(svc);
    let once = true;
    svc.transition = (async (...a: Parameters<typeof real>) => { if (once) { once = false; throw new Error("case changed concurrently"); } return real(...a); }) as typeof real;
    const voice = new FakeVoice();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(1);
    const o = (await svc.store.listOutbox(T)).find(x => x.kind === "voice_call")!;
    expect(o.status).toBe("sent");
    expect(await svc.store.getCall(T, voice.calls[0]!.communication_id)).toBeTruthy();
    expect((await svc.store.listEvents(T, "C-1")).some(e => e.summary.includes("could not be placed"))).toBe(false);
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(0);
    expect(voice.calls).toHaveLength(1);
  });
});

describe("found in testing: one case cannot stop the scheduler pass", () => {
  it("two passes that both find a case at its wake-up limit hand it to a person once, and neither pass fails", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: { participant_id: "p1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" } });
    const c = await svc.beginSession(T, "C-1", "t");
    await svc.transition(T, "C-1", c.version, "waiting", { actor: "t", summary: "sent" });
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 6; i++) await svc.store.putWake({ wake_id: `w${i}`, tenant_id: T, case_id: "C-1", at: past, reason: "silence", status: "done", created_at: past, created_by: "t", baseline_seq: 0 });
    await svc.store.putWake({ wake_id: "w-due", tenant_id: T, case_id: "C-1", at: past, reason: "agent_requested", status: "pending", created_at: past, created_by: "t", baseline_seq: 0 });
    const agent: AgentRuntimePort = { async runCase() { throw new Error("not used"); }, async resumeCase() { return {} as never; } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await Promise.allSettled([tick(svc, T, { piiKey: KEY, agent }), tick(svc, T, { piiKey: KEY, agent })]);
    expect(r.map(x => x.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await svc.getCase(T, "C-1")).status).toBe("review");
    expect((await svc.store.listReviewTasks(T)).filter(t => t.status === "open")).toHaveLength(1);
  });
});

describe("found in testing: when the model is down, no case is left stuck", () => {
  const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
  let shift = 0; // minutes the test has moved the clock on
  async function one() {
    shift = 0;
    const svc = new CaseService(new InMemoryStore(), () => new Date(Date.now() + shift * 60_000), OPEN);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: { participant_id: "p1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" } });
    await svc.beginSession(T, "C-1", "t");
    return svc;
  }

  it("a model call that fails closes the session and says why, instead of leaving it 'running'", async () => {
    const svc = await one();
    const client: MessagesClient = { messages: { async create() { throw new Error("Request timed out."); } } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new ClaudeAgentRuntime(new GatewayTools(svc), { client }).resumeCase(svc, T, "C-1")).rejects.toThrow("timed out");
    const [session] = await svc.store.listSessions(T);
    expect(session?.status).toBe("idle");
    expect(session?.trace.some(t => t.type === "error")).toBe(true);
    expect((await svc.store.listEvents(T, "C-1")).some(e => e.type === "agent_session_ended")).toBe(true);
  });

  it("a reply whose wake-up failed is tried again by a later pass", async () => {
    const svc = await one();
    await storeInteraktEvent(svc, T, { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: "w-down-1", message: "I work at Nova now" } } }, KEY);
    let down = true;
    const resumed: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("not used"); }, async resumeCase(_s, _t, id) { if (down) throw new Error("model unavailable"); resumed.push(id); return {} as never; } };
    const first = await tick(svc, T, { piiKey: KEY, agent });
    expect(first.resume_errors).toHaveLength(1);
    down = false;
    await tick(svc, T, { piiKey: KEY, agent });
    expect(resumed).toEqual([]); // not straight away: the model may still be down
    shift = 11;
    await tick(svc, T, { piiKey: KEY, agent });
    expect(resumed).toEqual(["C-1"]);
  });

  it("a timer wake-up that fails hands the case to a person, instead of leaving it waiting with no timer", async () => {
    const svc = await one();
    const c = await svc.getCase(T, "C-1");
    await svc.transition(T, "C-1", c.version, "waiting", { actor: "t", summary: "sent" });
    const past = new Date(Date.now() - 60_000).toISOString();
    await svc.store.putWake({ wake_id: "w-1", tenant_id: T, case_id: "C-1", at: past, reason: "agent_requested", status: "pending", created_at: past, created_by: "t", baseline_seq: 0 });
    const agent: AgentRuntimePort = { async runCase() { throw new Error("not used"); }, async resumeCase() { throw new Error("model unavailable"); } };
    await tick(svc, T, { piiKey: KEY, agent });
    const after = await svc.getCase(T, "C-1");
    expect(after.status).toBe("review");
    expect(after.reason).toContain("agent_failed");
  });
});

describe("found in testing: a call with no result for a day is closed, not left 'calling' for ever", () => {
  it("is recorded as failed and the case goes back to waiting, so another attempt can be made", async () => {
    const { svc, tools, at } = await world();
    const c = await svc.getCase(T, "C-1");
    expect((await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: "key-stale-0001", expected_version: c.version, reason: "No reply for two days." })).error).toBeUndefined();
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, T, voice, { piiKey: KEY, callsEnabled: true })).toBe(1);
    expect((await svc.getCase(T, "C-1")).status).toBe("calling");
    at("2026-10-15T12:00:00Z"); // 24.5 hours later; the provider never reported a result
    await syncCalls(svc, T, voice);
    expect((await svc.getCase(T, "C-1")).status).toBe("waiting");
    expect((await svc.store.getCall(T, voice.calls[0]!.communication_id))?.status).toBe("failed");
    await syncCalls(svc, T, voice); // and only once
    expect((await svc.store.listEvents(T, "C-1")).filter(e => e.type === "call_result")).toHaveLength(1);
  });
});

describe("found in testing: the reply reader's model never sees the person's name", () => {
  it("is given the reply with the participant's name taken out", async () => {
    const sent: string[] = [];
    const client = { messages: { async create(p: Record<string, unknown>) { sent.push(JSON.stringify(p)); return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as never; } } };
    const q = DRAFT_INSTRUMENT.questions.find(x => x.type === "choice")!;
    await new ClaudeReplyClassifier(new RuleClassifier(), { client }).classify({ text: "This is Asha Kumari, honestly hard to say right now", question: q, context: "question", instrument: DRAFT_INSTRUMENT, names: ["Asha Kumari"] }).catch(() => undefined);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join(" ")).not.toMatch(/Asha|Kumari/);
  });
});

describe("found in testing: the webhook's stop check agrees with the conversation reader", () => {
  it.each([["mat bhejo", true], ["band kar do", true], ["I wait near the bus stop", false], ["I had to stop working last year", false], ["STOP", true]] as const)("'%s' -> opt out %s", (t, out) => {
    expect(classifyReply(t).optOut).toBe(out);
  });
});
