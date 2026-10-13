import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { buildVoiceForm, CaseService, defaultControls, DEMO_TENANT, encryptPhone, GatewayTools, InMemoryStore, phoneHash, PLACEMENT_RETENTION_V1, VERIFICATION_EMPLOYEE_V1 } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { dispatchVoice, FakeVoice, parseZolabsCommunication, processVoiceInbox, storeVoiceCallback, syncCalls, tick, ZolabsVoice, type McpCaller, type VoiceDispatchConfig, type VoicePort, type AgentRuntimePort } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";
const M = PLACEMENT_RETENTION_V1;
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const cfg = (over: Partial<VoiceDispatchConfig> = {}): VoiceDispatchConfig => ({ piiKey: KEY, allowlist: [PHONE], callsEnabled: true, ...over });

async function world(now = () => new Date()) {
  const svc = new CaseService(new InMemoryStore(), now, OPEN);
  svc.voiceEnabled = true;
  await svc.store.putControls({ ...defaultControls(DEMO_TENANT), autonomy: { ...defaultControls(DEMO_TENANT).autonomy, voice_call: "automatic" } }); // these tests are about placing the call; approvals have their own tests
  const participant: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Asha Kumari", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "hi", consent: "unknown", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", mission_version: M.version, participant });
  await svc.beginSession(DEMO_TENANT, "C-1", "t");
  await svc.store.putVoiceForm({ tenant_id: DEMO_TENANT, mission_version: M.version, form_id: 900, definition_hash: "h", published_at: "x", published_by: "y" });
  const tools = new GatewayTools(svc);
  const session = { session_id: "s", tenant_id: DEMO_TENANT, case_id: "C-1", mission_version: M.version, employee_version: "x" };
  const ask = async (extra: Record<string, unknown> = {}) => {
    const c = await svc.getCase(DEMO_TENANT, "C-1");
    const r = await tools.call(session, "voice_call_request", { case_id: "C-1", idempotency_key: `key-${Math.random().toString(36).slice(2, 12)}`, expected_version: c.version, reason: "No reply for two days.", ...extra });
    expect(r.error).toBeUndefined();
  };
  return { svc, ask };
}

describe("placing the calls the agent asked for", () => {
  it("rings the person with their number, a first-name-only context and the case id, and the case becomes 'calling'", async () => {
    const { svc, ask } = await world();
    await ask();
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, DEMO_TENANT, voice, cfg())).toBe(1);
    expect(voice.calls).toHaveLength(1);
    const call = voice.calls[0]!;
    expect(call).toMatchObject({ form_id: 900, phone: `+${PHONE}`, source_id: "C-1" });
    expect(call.context).toContain("first name Asha");
    expect(call.context).toContain("Language: Hindi");
    expect(call.context).toContain("1. Current work status (field work_status)\n");
    expect(call.context).toContain("2. Employer (field employer_name), only if current work status is same job or changed job");
    expect(call.context).toContain("5. What they study or train for (field course), only if current work status is education training");
    expect(call.context).not.toContain("Kumari");
    expect(call.context).not.toContain(PHONE);
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "calling" });
    expect(await svc.store.getCall(DEMO_TENANT, call.communication_id)).toMatchObject({ status: "in_progress", case_id: "C-1", form_id: 900, reason: "No reply for two days.", asked: ["work_status", "employer_name", "role_title", "not_working_reason", "course"] });
    expect((await svc.store.listOutbox(DEMO_TENANT)).find(o => o.kind === "voice_call")?.status).toBe("sent");
    expect(JSON.stringify(await svc.store.listEvents(DEMO_TENANT, "C-1"))).toContain("Phone call started");
    expect(JSON.stringify(await svc.store.listEvents(DEMO_TENANT, "C-1"))).not.toContain(PHONE);
  });

  it("a call for a later time is scheduled, and the case stays 'call_scheduled' until it happens", async () => {
    const { svc, ask } = await world(() => new Date("2026-10-12T05:00:00Z"));
    await ask({ start_at: "2026-10-13T05:00:00Z" });
    const voice = new FakeVoice();
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    expect(voice.calls[0]!.at).toBe("2026-10-13T05:00:00.000Z");
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "call_scheduled" });
    expect((await svc.store.getCall(DEMO_TENANT, voice.calls[0]!.communication_id))).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-13T05:00:00.000Z" });
  });

  it("never rings a number that is not on the allowlist, or when real calls are switched off, and the case goes back to waiting", async () => {
    for (const [why, c] of [["not on the call allowlist", cfg({ allowlist: ["910000000000"] })], ["phone calls are not switched on", cfg({ callsEnabled: false })]] as const) {
      const { svc, ask } = await world();
      await ask();
      const voice = new FakeVoice();
      expect(await dispatchVoice(svc, DEMO_TENANT, voice, c)).toBe(0);
      expect(voice.calls).toHaveLength(0);
      const out = (await svc.store.listOutbox(DEMO_TENANT)).find(o => o.kind === "voice_call")!;
      expect(out.status).toBe("failed");
      expect(String(out.payload.last_error)).toContain(why);
      expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("waiting");
    }
  });

  it("allowAll lets any number through (testing only)", async () => {
    const { svc, ask } = await world();
    await ask();
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, DEMO_TENANT, voice, cfg({ allowlist: [], allowAll: true }))).toBe(1);
  });

  it("never rings someone who declined", async () => {
    const { svc, ask } = await world();
    await ask();
    const p = (await svc.store.getParticipant(DEMO_TENANT, "p1"))!;
    await svc.store.putParticipant({ ...p, consent: "declined" });
    const voice = new FakeVoice();
    expect(await dispatchVoice(svc, DEMO_TENANT, voice, cfg())).toBe(0);
    expect(voice.calls).toHaveLength(0);
  });

  it("two schedulers at once ring the person once, not twice", async () => {
    const { svc, ask } = await world();
    await ask();
    const voice = new FakeVoice();
    const [a, b] = await Promise.all([dispatchVoice(svc, DEMO_TENANT, voice, cfg()), dispatchVoice(svc, DEMO_TENANT, voice, cfg())]);
    expect(a + b).toBe(1);
    expect(voice.calls).toHaveLength(1);
  });

  it("when the provider fails the call is not placed, not retried behind anyone's back, and the case goes back to waiting", async () => {
    const { svc, ask } = await world();
    await ask();
    const broken: VoicePort = Object.assign(new FakeVoice(), { startCall: async () => { throw new Error("provider is down"); } });
    expect(await dispatchVoice(svc, DEMO_TENANT, broken, cfg())).toBe(0);
    expect(await dispatchVoice(svc, DEMO_TENANT, broken, cfg())).toBe(0);
    const out = (await svc.store.listOutbox(DEMO_TENANT)).find(o => o.kind === "voice_call")!;
    expect(out).toMatchObject({ status: "failed", attempts: 1 });
    expect(String(out.payload.last_error)).toBe("provider is down");
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("waiting");
    expect(await svc.store.listCalls(DEMO_TENANT, "C-1")).toHaveLength(0);
  });
});

describe("the provider's callback is only a doorbell", () => {
  it("keeps just the call id, ignores junk, and ignores a repeat", async () => {
    const { svc } = await world();
    expect(await storeVoiceCallback(svc, DEMO_TENANT, { nothing: "here" })).toEqual({ stored: false });
    expect(await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: "x'; drop table--" })).toEqual({ stored: false });
    expect(await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: "call_7", transcript: "SECRET WORDS", form_data: { work_status: "same_job" } })).toEqual({ stored: true, communication_id: "call_7" });
    expect((await storeVoiceCallback(svc, DEMO_TENANT, { id: 77 })).communication_id).toBe("77");
    expect(await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: "call_7" })).toEqual({ stored: false, communication_id: "call_7" });
    expect(JSON.stringify(await svc.store.listInbox(DEMO_TENANT))).not.toContain("SECRET WORDS"); // nothing from the body is kept
  });

  it("a forged callback for a call we never placed does nothing", async () => {
    const { svc } = await world();
    const voice = new FakeVoice();
    voice.complete("forged_1", { answers: { work_status: "same_job" } });
    await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: "forged_1" });
    const r = await processVoiceInbox(svc, DEMO_TENANT, voice);
    expect(r).toMatchObject({ processed: 0, errors: 1, wake: [] });
    expect(await svc.store.listEvidence("C-1")).toHaveLength(0);
  });

  it("waits while the call is unfinished, gives up after a day, and applies a finished call once", async () => {
    let now = new Date("2026-10-12T05:00:00Z");
    const { svc, ask } = await world(() => now);
    await ask();
    const voice = new FakeVoice();
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    const id = voice.calls[0]!.communication_id;
    await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: id });

    expect(await processVoiceInbox(svc, DEMO_TENANT, voice)).toMatchObject({ processed: 0, errors: 0 }); // the provider has nothing final yet
    voice.complete(id, { answers: { work_status: "same_job", employer_name: "Acme", role_title: "Packer" } });
    const r = await processVoiceInbox(svc, DEMO_TENANT, voice);
    expect(r).toMatchObject({ processed: 1, wake: [{ case_id: "C-1", key: `voice:${id}` }] });
    expect(await processVoiceInbox(svc, DEMO_TENANT, voice)).toMatchObject({ processed: 0, wake: [] });
    expect((await svc.store.listEvidence("C-1")).map(e => e.question_id).sort()).toEqual(["employer_name", "role_title", "work_status"]);

    // a call that never finishes is dropped after a day
    const w2 = await world(() => now);
    await w2.ask();
    const v2 = new FakeVoice();
    await dispatchVoice(w2.svc, DEMO_TENANT, v2, cfg());
    await storeVoiceCallback(w2.svc, DEMO_TENANT, { communication_id: v2.calls[0]!.communication_id });
    now = new Date("2026-10-13T06:00:00Z");
    expect(await processVoiceInbox(w2.svc, DEMO_TENANT, v2)).toMatchObject({ processed: 0, errors: 1 });
  });
});

describe("a whole call, through the scheduler", () => {
  it("agent asks, tick places the call, the provider rings the doorbell, the next tick applies the answers and wakes the agent", async () => {
    const { svc, ask } = await world();
    const voice = new FakeVoice();
    const resumed: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); }, async resumeCase(_s, _t, id) { resumed.push(id); return {} as never; } };
    const deps = { piiKey: KEY, agent, voice: { port: voice, cfg: cfg() } };

    await ask();
    const t1 = await tick(svc, DEMO_TENANT, deps);
    expect(t1.calls).toEqual({ started: 1, results: 0, errors: 0 });
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "calling" });

    const id = voice.calls[0]!.communication_id;
    voice.complete(id, { answers: { work_status: "I work at the same place as before", employer_name: "Acme", role_title: "Packer", language: "hi" }, language: "hi" });
    await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: id });
    const t2 = await tick(svc, DEMO_TENANT, deps);
    expect(t2.calls.results).toBe(1);
    expect(resumed).toEqual(["C-1"]);
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("evaluating");
    expect((await tick(svc, DEMO_TENANT, deps)).calls.results).toBe(0);
    expect(resumed).toHaveLength(1);
  });
});

// ---- the ZoLabs adapter, against a stand-in for the MCP connection --------------------------------------------------------

function standIn(replies: Record<string, unknown | ((a: Record<string, unknown>) => unknown)>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp: McpCaller = { async callTool(name, args) { calls.push({ name, args }); const r = replies[name]; if (r === undefined) throw new Error(`unexpected tool ${name}`); return typeof r === "function" ? r(args) : r; } };
  return { mcp, calls };
}

describe("ZoLabs over MCP", () => {
  const def = buildVoiceForm(M, VERIFICATION_EMPLOYEE_V1);

  it("creates the form, then overwrites the provider's draft with our exact definition", async () => {
    const { mcp, calls } = standIn({ create_form: { form_fields_id: 4321, form_link: "https://zolabs.ai/chat?form_fields_id=4321" }, update_form: { message: "Form updated successfully." } }); // the shape the real service returned
    const r = await new ZolabsVoice(mcp).publishForm(def, { callbackUrl: "https://dozai.example/api/webhooks/zolabs/s3cret" });
    expect(r).toEqual({ form_id: 4321 });
    expect(calls.map(c => c.name)).toEqual(["create_form", "update_form"]);
    expect(calls[0]!.args).toMatchObject({ form_field_name: def.form_field_name, confirmed: true });
    expect(calls[1]!.args).toMatchObject({ form_id: 4321, form_context: def.form_context, start_message: def.start_message, is_active: true, callback_url: "https://dozai.example/api/webhooks/zolabs/s3cret" });
    expect(calls[1]!.args.form_fields).toEqual(def.form_fields);
  });

  it("brings an existing form up to date without creating another", async () => {
    const { mcp, calls } = standIn({ update_form: {} });
    expect(await new ZolabsVoice(mcp).publishForm(def, { existingFormId: 77 })).toEqual({ form_id: 77 });
    expect(calls.map(c => c.name)).toEqual(["update_form"]);
    expect(calls[0]!.args).not.toHaveProperty("callback_url");
  });

  it("says so when the provider does not return an id", async () => {
    await expect(new ZolabsVoice(standIn({ create_form: { ok: true } }).mcp).publishForm(def, {})).rejects.toThrow("did not return a form id");
    await expect(new ZolabsVoice(standIn({ start_phone_call: {} }).mcp).startCall({ form_id: 1, phone: "+91", context: "c", source_id: "C-1" })).rejects.toThrow("did not return a call id");
  });

  it("starts, schedules and ends calls with exactly the fields the provider expects", async () => {
    const { mcp, calls } = standIn({ start_phone_call: { call_id: "1013117_1791817779.061913", call_sid: "3fe01e87" }, schedule_phone_call: { id: "abc" }, end_phone_call: {} });
    const z = new ZolabsVoice(mcp);
    expect(await z.startCall({ form_id: 900, phone: "+919876543210", context: "ctx", source_id: "C-1" })).toEqual({ communication_id: "1013117" }); // the real call_id is "<communication id>_<timestamp>"
    expect(await z.scheduleCall({ form_id: 900, phone: "+919876543210", context: "ctx", source_id: "C-1", at: "2026-10-13T05:00:00.000Z" })).toEqual({ communication_id: "abc" });
    await z.endCall("55");
    expect(calls[0]).toEqual({ name: "start_phone_call", args: { phone_number: "+919876543210", form_id: 900, communication_context: "ctx", source_id: "C-1", confirmed: true } });
    expect(calls[1]).toEqual({ name: "schedule_phone_call", args: { phone_number: "+919876543210", form_id: 900, communication_context: "ctx", schedule_date_time: "2026-10-13T05:00:00.000Z", attempts: 1, interval_minutes: 1440, confirmed: true } });
    expect(calls[2]).toEqual({ name: "end_phone_call", args: { communication_id: 55, confirmed: true } });
  });

  it("fetches a finished call and its transcript when the list does not include it", async () => {
    const { mcp, calls } = standIn({
      list_communications: { result: [{ id: 55, status: "completed", form_data: { work_status: "same_job", consent_given: true, identity_confirmed: true }, audio_url: "https://a.example/55.mp3", duration: 130 }, { id: 56, status: "completed" }] },
      get_call_transcript: { transcript: "Asha: I work at Acme." },
    });
    const r = await new ZolabsVoice(mcp).fetchResult("55");
    expect(r).toMatchObject({ communication_id: "55", status: "completed", consent_given: true, identity_confirmed: true, audio_url: "https://a.example/55.mp3", transcript: "Asha: I work at Acme.", duration_seconds: 130, answers: { work_status: "same_job" } });
    expect(calls.map(c => c.name)).toEqual(["list_communications", "get_call_transcript"]);
    expect(await new ZolabsVoice(standIn({ list_communications: [] }).mcp).fetchResult("9")).toBeNull();
  });
});

describe("reading the provider's record", () => {
  // The shape of one real finished call (12 Oct 2026), with the person's details replaced.
  const real = {
    communication_id: 1013117, communication_type: "phone_call", form_fields_id: 904, phone_number: "+910000000000",
    collected_answers: "[1] [4.8s–8.3s]: Hello. This is Meera calling on behalf of the program.\n[2] [11.6s–12.2s]: Hello",
    field_parsed_answers: { course: "<N/A>", language: "English", job_search: "<N/A>", role_title: "Software Engineer", work_status: "same_job", change_reason: "<N/A>", consent_given: true, employer_name: "Test Company", support_requested: true, identity_confirmed: true, not_working_reason: "<N/A>" },
    communication_status: "Completed", normalised_status: "completed", twilio_call_status: "completed",
    conversation_start_time: "2026-10-12T15:09:39", conversation_end_time: "2026-10-12T15:13:36", confidence: 0, emotion: "Unknown",
  };

  it("reads a real finished call: the answers that applied, consent and identity, the transcript, and how long it ran", () => {
    const r = parseZolabsCommunication(real)!;
    expect(r).toMatchObject({ communication_id: "1013117", status: "completed", consent_given: true, identity_confirmed: true, language: "English", duration_seconds: 237, ended_at: "2026-10-12T15:13:36Z" });
    expect(r.answers).toEqual({ language: "English", role_title: "Software Engineer", work_status: "same_job", consent_given: true, employer_name: "Test Company", support_requested: true, identity_confirmed: true });
    expect(r.transcript).toContain("This is Meera calling");
    expect(r.audio_url).toBeNull(); // the record carries no recording link
  });

  it("never turns the service's own judgement of the person into data: no emotion, no confidence score", () => {
    expect(JSON.stringify(parseZolabsCommunication(real))).not.toMatch(/emotion|Unknown|"confidence"/);
  });

  it("a call still in progress has no answers yet and is not treated as finished", () => {
    const r = parseZolabsCommunication({ communication_id: 1013117, collected_answers: {}, field_parsed_answers: null, communication_status: "In Progress", normalised_status: "in-progress", conversation_start_time: "2026-10-12T15:09:39", conversation_end_time: null })!;
    expect(r).toMatchObject({ status: "in_progress", answers: {}, transcript: null, duration_seconds: null });
  });

  it("a real call becomes evidence: values placed, not-applicable fields left out", async () => {
    const { svc, ask } = await world();
    await ask();
    const voice = new FakeVoice();
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    const id = voice.calls[0]!.communication_id;
    const parsed = parseZolabsCommunication({ ...real, communication_id: id })!;
    voice.complete(id, parsed);
    await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: id });
    await processVoiceInbox(svc, DEMO_TENANT, voice);
    const ev = await svc.store.listEvidence("C-1");
    expect(ev.map(e => `${e.question_id}=${e.value}`).sort()).toEqual(["employer_name=Test Company", "role_title=Software Engineer", "support_requested=yes", "work_status=same_job"]);
    expect((await svc.store.getCall(DEMO_TENANT, id))?.transcript).toContain("This is Meera calling");
  });

  it("accepts answers as an object or as a list, and reads consent and identity from them", () => {
    const a = parseZolabsCommunication({ id: "9", status: "Completed", form_data: { work_status: "same_job", consent_given: "true", identity_confirmed: "no", language: "hi" } });
    expect(a).toMatchObject({ communication_id: "9", status: "completed", consent_given: true, identity_confirmed: false, language: "hi" });
    const b = parseZolabsCommunication({ communication_id: 3, status: "ended", responses: [{ field_id: "employer_name", value: "Acme" }, { field_id: "consent_given", value: true }] });
    expect(b?.answers).toEqual({ employer_name: "Acme", consent_given: true });
    expect(b?.consent_given).toBe(true);
  });

  it("maps the provider's words for how a call ended", () => {
    const s = (status: string) => parseZolabsCommunication({ id: 1, status })?.status;
    expect([s("completed"), s("no-answer"), s("busy"), s("declined"), s("failed"), s("ringing"), s("scheduled"), s("in_progress"), s("something odd")]).toEqual(["completed", "no_answer", "busy", "declined", "failed", "in_progress", "scheduled", "in_progress", "in_progress"]);
  });

  it("returns nothing for a record with no id", () => {
    expect(parseZolabsCommunication({ status: "completed" })).toBeNull();
    expect(parseZolabsCommunication(null)).toBeNull();
  });
});

describe("finding out that a call has finished without waiting for the provider to say so", () => {
  const answered = { answers: { work_status: "I work at the same place as before", employer_name: "Acme", role_title: "Packer" }, language: "hi" };

  it("applies a finished call that no callback ever announced, once", async () => {
    const { svc, ask } = await world();
    const voice = new FakeVoice();
    await ask();
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    const id = voice.calls[0]!.communication_id;
    expect(await syncCalls(svc, DEMO_TENANT, voice)).toMatchObject({ checked: 1, applied: 0, wake: [] }); // still ringing: nothing to apply
    voice.complete(id, answered);                                                                         // the call ends; no callback is sent
    const r = await syncCalls(svc, DEMO_TENANT, voice);
    expect(r).toMatchObject({ checked: 1, applied: 1, wake: [{ case_id: "C-1", key: `voice:${id}` }] });
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("evaluating");
    expect((await svc.store.getCall(DEMO_TENANT, id))?.status).toBe("completed");
    expect((await syncCalls(svc, DEMO_TENANT, voice)).checked).toBe(0); // nothing left to ask about
  });

  it("does not apply a call twice when the callback also arrives", async () => {
    const { svc, ask } = await world();
    const voice = new FakeVoice();
    await ask();
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    const id = voice.calls[0]!.communication_id;
    voice.complete(id, answered);
    await syncCalls(svc, DEMO_TENANT, voice);
    await storeVoiceCallback(svc, DEMO_TENANT, { communication_id: id });
    await processVoiceInbox(svc, DEMO_TENANT, voice);
    expect((await svc.store.listEvidence("C-1")).filter(e => e.question_id === "employer_name")).toHaveLength(1);
  });

  it("leaves a call that is scheduled for later alone until it is due", async () => {
    const clock = { t: new Date("2026-10-12T10:00:00Z") };
    const { svc, ask } = await world(() => new Date(clock.t));
    const voice = new FakeVoice();
    await ask({ start_at: "2026-10-12T12:00:00Z" });
    await dispatchVoice(svc, DEMO_TENANT, voice, cfg());
    expect((await syncCalls(svc, DEMO_TENANT, voice)).checked).toBe(0);
    clock.t = new Date("2026-10-12T12:30:00Z");
    expect((await syncCalls(svc, DEMO_TENANT, voice)).checked).toBe(1);
  });

  it("the scheduler pass does it too, so a finished call shows up within the hour even with no callback", async () => {
    const { svc, ask } = await world();
    const voice = new FakeVoice();
    const woke: string[] = [];
    const agent: AgentRuntimePort = { async runCase() { throw new Error("no"); }, async resumeCase(_s, _t, id) { woke.push(id); return {} as never; } };
    await ask();
    const deps = { piiKey: KEY, agent, voice: { port: voice, cfg: cfg() } };
    await tick(svc, DEMO_TENANT, deps);
    voice.complete(voice.calls[0]!.communication_id, answered);
    const t = await tick(svc, DEMO_TENANT, deps);
    expect(t.calls.results).toBe(1);
    expect(woke).toEqual(["C-1"]);
  });
});

describe("looking a call up at the provider", () => {
  const item = (id: number, over: Record<string, unknown> = {}) => ({ communication_id: id, normalised_status: "completed", communication_status: "Completed", field_parsed_answers: { work_status: "same_job", consent_given: true, identity_confirmed: true }, collected_answers: "[1]: Hello", conversation_start_time: "2026-10-12T15:09:39", conversation_end_time: "2026-10-12T15:13:36", ...over });

  it("lists the calls of the form the call belongs to, because a search by call number finds nothing", async () => {
    const { mcp, calls } = standIn({ list_communications: () => ({ communications: [item(1013118)], pagination: { page: 1, has_next: false } }) });
    const r = await new ZolabsVoice(mcp).fetchResult("1013118", { formId: 904 });
    expect(r).toMatchObject({ communication_id: "1013118", status: "completed", answers: { work_status: "same_job" } });
    expect(calls[0]).toEqual({ name: "list_communications", args: { form_id: 904, per_page: 50, page: 1 } });
    expect(JSON.stringify(calls[0]!.args)).not.toContain("search");
  });

  it("goes on to the next page when the call is not on the first", async () => {
    const full = Array.from({ length: 50 }, (_, i) => item(2000 + i));
    const { mcp, calls } = standIn({ list_communications: (a: Record<string, unknown>) => ({ communications: a.page === 1 ? full : [item(1013118)] }) });
    const r = await new ZolabsVoice(mcp).fetchResult("1013118", { formId: 904 });
    expect(r?.communication_id).toBe("1013118");
    expect(calls.map(c => c.args.page)).toEqual([1, 2]);
  });

  it("says the call is not there (rather than failing) when it is on no page", async () => {
    const { mcp } = standIn({ list_communications: () => ({ communications: [item(5)] }) });
    expect(await new ZolabsVoice(mcp).fetchResult("1013118", { formId: 904 })).toBeNull();
  });

  it("falls back to a search only when the form is not known", async () => {
    const { mcp, calls } = standIn({ list_communications: () => ({ communications: [item(7)] }) });
    await new ZolabsVoice(mcp).fetchResult("7");
    expect(calls[0]!.args).toMatchObject({ search: "7" });
  });
});
