// Steps 4 and 5: the autonomy dial, approvals, decision traces and replay, the wake service, memory, the kill switch and spend limits.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { approvalStats, CaseService, DEMO_TENANT, DozaiError, encryptPhone, GatewayTools, InMemoryStore, phoneHash, PLACEMENT_RETENTION_V1, redactForModel, replaySession, defaultControls, type AgentSession, type OutboxItem } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant, Principal } from "@dozai/contracts";
import { ClaudeAgentRuntime, dispatchVoice, FakeChannels, FakeVoice, tick, type AgentRuntimePort } from "./index";

const T = DEMO_TENANT, M = PLACEMENT_RETENTION_V1;
const KEY = randomBytes(32).toString("base64"), PHONE = "919876543210";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const admin: Principal = { user_id: "u-admin", tenant_id: T, role: "admin" };
const HOUR = 3_600_000;

async function world(id = "C-1") {
  const clock = { t: new Date("2026-10-12T10:00:00Z") };
  const svc = new CaseService(new InMemoryStore(), () => new Date(clock.t), OPEN);
  svc.voiceEnabled = true;
  const participant: Participant = { participant_id: `p-${id}`, tenant_id: T, display_name: "Asha Kumari", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "hi", consent: "unknown", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: id, mission_version: M.version, participant });
  await svc.beginSession(T, id, "t");
  await svc.store.putVoiceForm({ tenant_id: T, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "x", published_by: "y" });
  const tools = new GatewayTools(svc);
  const session = (sid = "s") => ({ session_id: sid, tenant_id: T, case_id: id, mission_version: M.version, employee_version: "x" });
  let n = 0;
  const act = async (name: Parameters<GatewayTools["call"]>[1], extra: Record<string, unknown> = {}, sid = "s") => {
    const c = await svc.getCase(T, id);
    return tools.call(session(sid), name, { case_id: id, idempotency_key: `key-${++n}-${Math.random().toString(36).slice(2, 8)}`, expected_version: c.version, ...extra });
  };
  const askCall = () => act("voice_call_request", { reason: "No reply for two days." });
  const outbox = async () => svc.store.listOutbox(T);
  const voiceCfg = { piiKey: KEY, allowAll: true, callsEnabled: true };
  return { svc, clock, tools, act, askCall, outbox, voiceCfg, session, id };
}

describe("the autonomy dial: phone calls wait for a person by default", () => {
  it("holds a call the agent asked for, tells the agent, and sends nothing until it is approved", async () => {
    const w = await world();
    const r = await w.askCall();
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ held: true });
    const [item] = await w.outbox();
    expect(item).toMatchObject({ status: "held", kind: "voice_call", approval: { state: "held" } });
    const voice = new FakeVoice();
    expect(await dispatchVoice(w.svc, T, voice, w.voiceCfg)).toBe(0);
    expect(voice.calls).toHaveLength(0);
    expect((await w.svc.store.listEvents(T, w.id)).some(e => e.type === "action_held")).toBe(true);
  });

  it("approving releases it; the scheduler then places the call, and the ledger shows who decided", async () => {
    const w = await world();
    await w.askCall();
    const [item] = await w.outbox();
    await w.svc.decideApproval(admin, item!.outbox_id, "approve", "Looks right");
    expect((await w.outbox())[0]).toMatchObject({ status: "pending", approval: { state: "approved", decided_by: "admin:u-admin", note: "Looks right" } });
    const voice = new FakeVoice();
    expect(await dispatchVoice(w.svc, T, voice, w.voiceCfg)).toBe(1);
    expect((await w.svc.store.listEvents(T, w.id)).find(e => e.type === "action_approved")).toMatchObject({ actor: "admin:u-admin" });
    await expect(w.svc.decideApproval(admin, item!.outbox_id, "approve")).rejects.toMatchObject({ code: "NOT_HELD" }); // only once
  });

  it("declining cancels it and hands the case to a person, so it does not wait for a call that will never come", async () => {
    const w = await world();
    await w.askCall();
    const [item] = await w.outbox();
    await w.svc.decideApproval(admin, item!.outbox_id, "reject", "Not this week");
    expect((await w.outbox())[0]).toMatchObject({ status: "failed", approval: { state: "rejected", note: "Not this week" } });
    expect(await w.svc.getCase(T, w.id)).toMatchObject({ status: "review" });
    expect((await w.svc.store.listReviewTasks(T))[0]!.reason).toContain("proposal_declined");
    expect(await dispatchVoice(w.svc, T, new FakeVoice(), w.voiceCfg)).toBe(0);
  });

  it("approving is refused if the person opted out while it waited, and the action is cancelled", async () => {
    const w = await world();
    await w.askCall();
    const [item] = await w.outbox();
    const p = (await w.svc.store.getParticipant(T, "p-C-1"))!;
    await w.svc.store.putParticipant({ ...p, consent: "declined" });
    await expect(w.svc.decideApproval(admin, item!.outbox_id, "approve")).rejects.toMatchObject({ code: "CONTACT_NOT_ALLOWED" });
    expect((await w.outbox())[0]!.status).toBe("failed");
  });

  it("an opt-out through the normal route cancels what is held, and its timers", async () => {
    const w = await world();
    await w.askCall();
    await w.svc.recordInbound(T, w.id, { provider_event_id: "e1", channel: "whatsapp", summary: "stop", opt_out: true });
    expect((await w.outbox())[0]!.status).toBe("failed");
    expect((await w.svc.store.listWakes(T)).every(x => x.status !== "pending")).toBe(true);
  });

  it("will not be approved outside the contact hours, so nobody is rung at a bad time", async () => {
    const w = await world();
    await w.askCall();
    const [item] = await w.outbox();
    w.svc.forceWindow = { windowStartHour: 9, windowEndHour: 10 }; // 10:00 UTC is 15:30 here
    await expect(w.svc.decideApproval(admin, item!.outbox_id, "approve")).rejects.toMatchObject({ code: "OUTSIDE_WINDOW" });
    expect((await w.outbox())[0]!.status).toBe("held"); // still waiting: try again inside the window
  });

  it("approved wording runs on its own until someone moves the dial; then templates wait too", async () => {
    const w = await world();
    const c = await w.svc.getCase(T, w.id);
    const a = await w.svc.queueOutbox(c, "whatsapp_template", { template_key: M.intro_template }, "k-a");
    expect(a.status).toBe("pending");
    await w.svc.updateControls(admin, { autonomy: { message_template: "approve_first" } });
    const b = await w.svc.queueOutbox(c, "whatsapp_template", { template_key: M.intro_template }, "k-b");
    expect(b.status).toBe("held");
    const sent = await new FakeChannels().dispatchOutbox(w.svc, T);
    expect(sent).toBe(1); // only the first
    expect((await w.outbox()).find(o => o.outbox_id === b.outbox_id)!.status).toBe("held");
  });

  it("a message the agent writes (not approved wording) is its own action type", async () => {
    const w = await world();
    const c = await w.svc.getCase(T, w.id);
    expect((await w.svc.queueOutbox(c, "whatsapp_text", { text: "Hi", free: true }, "k-free")).status).toBe("held");
    expect((await w.svc.queueOutbox(c, "whatsapp_text", { text: "Question 1" }, "k-scripted")).status).toBe("pending");
  });

  it("suggests going automatic after ten approvals and no refusals, never before", () => {
    const item = (state: "approved" | "rejected", i: number): OutboxItem => ({ outbox_id: `o${i}`, tenant_id: T, case_id: "C", kind: "voice_call", payload: {}, idempotency_key: `k${i}`, status: "sent", attempts: 1, created_at: "x", approval: { state, held_at: "x" } });
    const c = defaultControls(T);
    const nine = Array.from({ length: 9 }, (_, i) => item("approved", i));
    expect(approvalStats(nine, c).find(s => s.kind === "voice_call")).toMatchObject({ approved: 9, suggest_automatic: false });
    expect(approvalStats([...nine, item("approved", 9)], c).find(s => s.kind === "voice_call")!.suggest_automatic).toBe(true);
    expect(approvalStats([...nine, item("approved", 9), item("rejected", 10)], c).find(s => s.kind === "voice_call")!.suggest_automatic).toBe(false);
  });

  it("changes to the dial are validated and recorded with who made them", async () => {
    const w = await world();
    const next = await w.svc.updateControls({ ...admin, role: "agent_ops", user_id: "ops-1" }, { autonomy: { voice_call: "automatic" }, daily_budget_usd: 3 });
    expect(next).toMatchObject({ autonomy: { voice_call: "automatic", message_free: "approve_first" }, daily_budget_usd: 3, updated_by: "agent_ops:ops-1" });
    await expect(w.svc.updateControls(admin, { autonomy: { voice_call: "whenever" } })).rejects.toMatchObject({ code: "INVALID_CONTROLS" });
    await expect(w.svc.updateControls(admin, { unknown: 1 })).rejects.toMatchObject({ code: "INVALID_CONTROLS" });
  });
});

describe("the kill switch and the spend limits", () => {
  it("while it is on nothing is sent and no call is placed, and switching it off lets the queue go", async () => {
    const w = await world();
    const c = await w.svc.getCase(T, w.id);
    await w.svc.queueOutbox(c, "whatsapp_template", { template_key: M.intro_template }, "k1");
    await w.svc.updateControls(admin, { autonomy: { voice_call: "automatic" } });
    await w.askCall();
    await w.svc.updateControls(admin, { paused: true, reason: "Wrong template went out" });
    expect(await new FakeChannels().dispatchOutbox(w.svc, T)).toBe(0);
    expect(await dispatchVoice(w.svc, T, new FakeVoice(), w.voiceCfg)).toBe(0);
    expect((await w.outbox()).every(o => o.status === "pending")).toBe(true);
    expect(await w.svc.agentGate(T, w.id)).toMatchObject({ ok: false, code: "AGENT_PAUSED" });
    expect((await w.svc.controls(T))).toMatchObject({ paused: true, paused_by: "admin:u-admin", paused_reason: "Wrong template went out" });
    await w.svc.updateControls(admin, { paused: false });
    expect(await new FakeChannels().dispatchOutbox(w.svc, T)).toBe(1);
    expect((await w.svc.controls(T)).paused_by).toBeUndefined();
  });

  it("the scheduler still records replies while paused, but starts no campaign and wakes nobody", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    w.clock.t = new Date(w.clock.t.getTime() + 60 * HOUR);
    await w.svc.updateControls(admin, { paused: true });
    const woke: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); }, async resumeCase(_s, _t, id) { woke.push(id); return {} as never; } };
    const r = await tick(w.svc, T, { piiKey: KEY, agent });
    expect(r).toMatchObject({ paused: true, resumed: [], wakes: { fired: [] } });
    expect(woke).toEqual([]);
    expect((await w.svc.store.listWakes(T)).some(x => x.status === "pending")).toBe(true); // kept for when it is switched back on
  });

  const session = (o: Partial<AgentSession>): AgentSession => ({ session_id: `s-${Math.random().toString(36).slice(2, 8)}`, tenant_id: T, case_id: "C-1", employee_version: "x", mission_version: M.version, status: "idle", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: 0.5, simulated: false, trace: [], started_at: "2026-10-12T09:00:00.000Z", ...o });

  it("stops the agent when the last 24 hours reach the daily limit, counting real sessions only", async () => {
    const w = await world();
    await w.svc.updateControls(admin, { daily_budget_usd: 2 });
    await w.svc.store.putSession(session({ cost_usd: 1.5, case_id: "C-9" }));
    await w.svc.store.putSession(session({ cost_usd: 50, simulated: true, case_id: "C-9" })); // a simulation costs nothing real
    await w.svc.store.putSession(session({ cost_usd: 50, started_at: "2026-10-10T09:00:00.000Z", case_id: "C-9" })); // older than a day
    expect(await w.svc.agentGate(T, "C-1")).toEqual({ ok: true });
    await w.svc.store.putSession(session({ cost_usd: 0.6, case_id: "C-9" }));
    expect(await w.svc.agentGate(T, "C-1")).toMatchObject({ ok: false, code: "DAILY_BUDGET_REACHED" });
    expect(Math.round((await w.svc.spendLast24h(T)) * 10) / 10).toBe(2.1);
  });

  it("stops the agent on one expensive case, and the scheduler sends that case to a person", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    await w.svc.updateControls(admin, { case_budget_usd: 1 });
    await w.svc.store.putSession(session({ cost_usd: 1.2 }));
    expect(await w.svc.agentGate(T, "C-1")).toMatchObject({ ok: false, code: "CASE_BUDGET_REACHED" });
    expect(await w.svc.agentGate(T, "C-2")).toEqual({ ok: true });
    w.clock.t = new Date(w.clock.t.getTime() + 60 * HOUR);
    const woke: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); }, async resumeCase(_s, _t, id) { woke.push(id); return {} as never; } };
    await tick(w.svc, T, { piiKey: KEY, agent });
    expect(woke).toEqual([]);
    expect(await w.svc.getCase(T, w.id)).toMatchObject({ status: "review" });
    expect((await w.svc.store.listReviewTasks(T))[0]!.reason).toContain("case_budget");
  });

  it("the Claude runtime refuses to start, before any model call, when the agent is switched off or over a limit", async () => {
    const w = await world();
    const client = { messages: { async create(): Promise<never> { throw new Error("the model must not be called"); } } };
    const rt = new ClaudeAgentRuntime(w.tools, { client });
    await w.svc.updateControls(admin, { paused: true });
    await expect(rt.runCase(w.svc, T, w.id, "same_job")).rejects.toMatchObject({ code: "AGENT_PAUSED" });
    await w.svc.updateControls(admin, { paused: false, daily_budget_usd: 1 });
    await w.svc.store.putSession(session({ cost_usd: 1.5, case_id: "C-9" }));
    await expect(rt.resumeCase(w.svc, T, w.id)).rejects.toBeInstanceOf(DozaiError);
  });
});

describe("the wake service", () => {
  const strategyHours = M.strategy?.follow_up_after_hours ?? 48;
  const pending = async (w: Awaited<ReturnType<typeof world>>) => (await w.svc.store.listWakes(T, w.id)).filter(x => x.status === "pending");
  const agentThatRecords = () => {
    const woke: { id: string; reason?: string }[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); }, async resumeCase(_s, _t, id, wake) { woke.push({ id, reason: wake?.reason }); return {} as never; } };
    return { woke, agent };
  };

  it("sending a message starts a silence timer for the mission's follow-up time, and a later message replaces it", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    const [t1] = await pending(w);
    expect(t1).toMatchObject({ reason: "silence", created_by: "policy-engine" });
    expect(Date.parse(t1!.at) - w.clock.t.getTime()).toBe(strategyHours * HOUR);
    const c = await w.svc.getCase(T, w.id);
    w.clock.t = new Date(w.clock.t.getTime() + HOUR);
    await w.svc.queueOutbox(c, "whatsapp_text", { text: "Next question" }, "k-next");
    const now = await pending(w);
    expect(now).toHaveLength(1);
    expect(now[0]!.wake_id).not.toBe(t1!.wake_id);
  });

  it("wakes the agent on a silent case once the time has passed, and not before", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    const { woke, agent } = agentThatRecords();
    w.clock.t = new Date(w.clock.t.getTime() + (strategyHours - 1) * HOUR);
    expect((await tick(w.svc, T, { piiKey: KEY, agent })).wakes.fired).toEqual([]);
    w.clock.t = new Date(w.clock.t.getTime() + 2 * HOUR);
    const r = await tick(w.svc, T, { piiKey: KEY, agent });
    expect(r.wakes.fired).toEqual([w.id]);
    expect(woke).toEqual([{ id: w.id, reason: "silence" }]);
    expect((await w.svc.store.listWakes(T)).map(x => x.status)).toEqual(["done"]);
    expect((await w.svc.store.listEvents(T, w.id)).some(e => e.type === "wake_fired")).toBe(true);
    expect((await tick(w.svc, T, { piiKey: KEY, agent })).wakes.fired).toEqual([]); // once only
    expect(woke).toHaveLength(1);
  });

  it("does not wake the agent when the person has replied, or the case has moved on", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    await w.svc.recordInbound(T, w.id, { provider_event_id: "r1", channel: "whatsapp", summary: "Replied yes" });
    const { woke, agent } = agentThatRecords();
    w.clock.t = new Date(w.clock.t.getTime() + 100 * HOUR);
    const r = await tick(w.svc, T, { piiKey: KEY, agent });
    expect(r.wakes).toEqual({ fired: [], skipped: [{ case_id: w.id, why: "the person replied" }] });
    expect(woke).toEqual([]);

    const w2 = await world("C-2");
    await w2.act("whatsapp_send_template", { template_key: M.intro_template });
    await w2.svc.requestReview(T, "C-2", (await w2.svc.getCase(T, "C-2")).version, "identity", "doubt", "t");
    w2.clock.t = new Date(w2.clock.t.getTime() + 100 * HOUR);
    expect((await tick(w2.svc, T, { piiKey: KEY, agent })).wakes.skipped[0]!.why).toBe("case is review");
  });

  it("the agent sets its own wake-up with callback_schedule, and a new request replaces the old one", async () => {
    const w = await world();
    const r = await w.act("callback_schedule", { after_hours: 6, channel: "voice" });
    expect(r.error).toBeUndefined();
    expect((r.data as { wake_at: string }).wake_at).toBe(new Date(w.clock.t.getTime() + 6 * HOUR).toISOString());
    await w.act("callback_schedule", { after_hours: 24, channel: "whatsapp" });
    const p = await pending(w);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ reason: "agent_requested", note: "via whatsapp" });
    const ctx = (await w.act("case_get_context")).data as { wake_ups: { reason: string }[] };
    expect(ctx.wake_ups.map(x => x.reason)).toEqual(["agent_requested"]);
  });

  it("stops waking the agent after the limit and asks a person to look instead", async () => {
    const w = await world();
    await w.svc.updateControls(admin, { max_wakes_per_case: 1 });
    await w.svc.store.putWake({ wake_id: "old", tenant_id: T, case_id: w.id, at: "2026-10-01T00:00:00.000Z", reason: "silence", status: "done", created_at: "x", created_by: "x", baseline_seq: 0 });
    await w.act("callback_schedule", { after_hours: 1, channel: "voice" });
    const { woke, agent } = agentThatRecords();
    w.clock.t = new Date(w.clock.t.getTime() + 2 * HOUR);
    const r = await tick(w.svc, T, { piiKey: KEY, agent });
    expect(woke).toEqual([]);
    expect(r.wakes.skipped[0]!.why).toBe("wake-up limit reached");
    expect(await w.svc.getCase(T, w.id)).toMatchObject({ status: "review" });
  });

  it("a runtime that cannot be woken leaves the timers alone", async () => {
    const w = await world();
    await w.act("whatsapp_send_template", { template_key: M.intro_template });
    w.clock.t = new Date(w.clock.t.getTime() + 100 * HOUR);
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); } };
    await tick(w.svc, T, { piiKey: KEY, agent });
    expect(await pending(w)).toHaveLength(1);
  });
});

describe("memory: a few fixed facts, never free text", () => {
  it("keeps a note, replaces it on the same key, and shows it in the case context", async () => {
    const w = await world();
    expect((await w.act("memory_note", { key: "best_time_to_call", value: "evening" })).error).toBeUndefined();
    await w.act("memory_note", { key: "best_time_to_call", value: "morning" });
    await w.act("memory_note", { key: "preferred_language", value: "ta" });
    const ctx = (await w.act("case_get_context")).data as { memory: { key: string; value: string }[] };
    expect(ctx.memory).toEqual([{ key: "best_time_to_call", value: "morning" }, { key: "preferred_language", value: "ta" }]);
  });

  it("refuses anything outside the fixed keys and values, so a name or an instruction can never be stored", async () => {
    const w = await world();
    for (const bad of [{ key: "note", value: "evening" }, { key: "best_time_to_call", value: "call after Ravi finishes work" }, { key: "preferred_channel", value: "telegram" }, { key: "preferred_language", value: "tamil" }]) {
      expect((await w.act("memory_note", bad)).error?.code).toMatch(/INVALID_MEMORY|INVALID_INPUT/);
    }
    expect(await w.svc.store.getMemory(T, w.id)).toBeUndefined();
  });

  it("is erased with the case, and is not available once the case is closed", async () => {
    const w = await world();
    await w.act("memory_note", { key: "preferred_channel", value: "voice" });
    expect((await w.svc.store.getMemory(T, w.id))?.items).toHaveLength(1);
    await w.svc.deleteCase(admin, w.id, "request");
    expect(await w.svc.store.getMemory(T, w.id)).toBeUndefined();
    const w2 = await world("C-2");
    await w2.svc.recordInbound(T, "C-2", { provider_event_id: "x", channel: "whatsapp", summary: "stop", opt_out: true });
    expect((await w2.act("memory_note", { key: "preferred_channel", value: "voice" })).error?.code).toBe("TOOL_NOT_ALLOWED");
  });

  it("the employee's tool list can leave memory out, and the gateway then refuses it", async () => {
    const w = await world();
    const c = await w.svc.getCase(T, w.id);
    const r = await w.tools.call({ ...w.session(), allowed_tools: ["case_get_context"] }, "memory_note", { case_id: w.id, idempotency_key: "key-memory-1", key: "preferred_channel", value: "voice" });
    expect(r.error?.code).toBe("TOOL_NOT_ALLOWED_FOR_EMPLOYEE");
    expect(c.status).toBe("running");
  });
});

describe("decision traces and replay", () => {
  const traceSession = (w: Awaited<ReturnType<typeof world>>, steps: AgentSession["trace"]): AgentSession => ({ session_id: "s-trace", tenant_id: T, case_id: w.id, employee_version: "x", mission_version: M.version, status: "idle", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: 0.5, simulated: false, trace: steps, started_at: w.clock.t.toISOString(), trigger: "wake:silence" });
  const step = (tool: string, input: unknown, outcome: "executed" | "held" | "refused") => ({ label: tool, type: "MCP tool", detail: outcome, tool, input, ts: "2026-10-12T10:00:00.000Z", outcome, case_version: 2 });

  it("the runtime records what the platform did with every action, and which case version the agent saw", async () => {
    const w = await world();
    let calls = 0;
    const client = { messages: { async create() {
      calls++;
      return calls === 1
        ? { stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "t1", name: "voice_call_request", input: { case_id: w.id, idempotency_key: "key-trace-1", expected_version: (await w.svc.getCase(T, w.id)).version, reason: "No reply for two days." } }] }
        : { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Held for approval." }] };
    } } };
    const rt = new ClaudeAgentRuntime(w.tools, { client: client as never });
    const s = await rt.resumeCase(w.svc, T, w.id);
    const tool = s.trace.find(t => t.tool === "voice_call_request")!;
    expect(tool).toMatchObject({ outcome: "held", case_version: expect.any(Number) });
    expect(s.trigger).toBe("resume");
    expect((await w.svc.store.getSession(s.session_id))?.trace.find(t => t.tool)?.outcome).toBe("held");
  });

  it("replay re-checks recorded actions against today's rules and flags what would now be stopped", async () => {
    const w = await world();
    await w.svc.store.putSession(traceSession(w, [
      step("whatsapp_send_template", { template_key: M.intro_template }, "executed"),
      step("whatsapp_send_template", { template_key: "no_such_template" }, "refused"),
      step("voice_call_request", { reason: "No reply for two days." }, "held"),
      step("case_get_context", {}, "executed"),
    ]));
    let r = (await replaySession(w.svc, T, "s-trace"))!;
    expect(r.trigger).toBe("wake:silence");
    expect(r.rows.map(x => [x.tool, x.now, x.changed])).toEqual([["whatsapp_send_template", "allowed", false], ["whatsapp_send_template", "refused", false], ["voice_call_request", "would_be_held", false]]);
    expect(r.rows[1]).toMatchObject({ code: "TEMPLATE_NOT_APPROVED" });

    // the person opts out, then the kill switch goes on: what ran would now be stopped
    const p = (await w.svc.store.getParticipant(T, "p-C-1"))!;
    await w.svc.store.putParticipant({ ...p, consent: "declined" });
    r = (await replaySession(w.svc, T, "s-trace"))!;
    expect(r.rows[0]).toMatchObject({ now: "refused", code: "CONSENT_DECLINED", changed: true });
    await w.svc.updateControls(admin, { paused: true });
    expect((await replaySession(w.svc, T, "s-trace"))!.rows.every(x => x.code === "AGENT_PAUSED")).toBe(true);
  });

  it("replay does not send or change anything, and does not show another client's sessions", async () => {
    const w = await world();
    await w.svc.store.putSession(traceSession(w, [step("voice_call_request", { reason: "No reply for two days." }, "executed")]));
    const before = JSON.stringify([await w.outbox(), await w.svc.store.listEvents(T, w.id)]);
    await replaySession(w.svc, T, "s-trace");
    expect(JSON.stringify([await w.outbox(), await w.svc.store.listEvents(T, w.id)])).toBe(before);
    expect(await replaySession(w.svc, "someone-else", "s-trace")).toBeUndefined();
    expect(await replaySession(w.svc, T, "nope")).toBeUndefined();
  });

  it("a session recorded before outcomes were kept replays as 'unknown' and is never flagged", async () => {
    const w = await world();
    await w.svc.store.putSession(traceSession(w, [{ label: "x", type: "MCP tool", detail: "ok", tool: "whatsapp_send_template", input: { template_key: "gone" }, ts: "x" }]));
    const r = (await replaySession(w.svc, T, "s-trace"))!;
    expect(r.rows[0]).toMatchObject({ recorded: "unknown", now: "refused", changed: false });
  });
});

describe("what goes to a model", () => {
  it("hides phone numbers, e-mail addresses and ID numbers, and keeps ordinary numbers", () => {
    const out = redactForModel("call me on +91 98765 43210 or asha@example.com, PAN ABCDE1234F, aadhaar 1234 5678 9012. I earn 12000 and worked 2 years");
    expect(out).toBe("call me on [number] or [email], PAN [id], aadhaar [number]. I earn 12000 and worked 2 years");
  });
});
