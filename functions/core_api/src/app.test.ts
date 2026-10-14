import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { CaseService, ConversationRunner, defaultControls, DEMO_TENANT, DRAFT_INSTRUMENT, GatewayTools, InMemoryStore, RuleClassifier } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { dispatchVoice, FakeVoice, ScriptedAgentRuntime } from "@dozai/adapters";
import { createApp } from "./app";

const KEY = randomBytes(32).toString("base64");
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function start(over: Record<string, unknown> = {}) {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const app = createApp({
    forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)), runner: new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true }) }), devAuth: true,
    pii: { key: KEY, defaultCountryCode: "91" }, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "test" }, ...over,
  });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown, role = "admin") => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-dozai-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return { call, store, svc };
}

const row = { name: "Ravi Test", phone: "9876543210", employer: "Acme", location: "Jaipur", cohort: "Batch 1" };

describe("participant import over the API", () => {
  it("needs the consent attestation, is limited by role, and creates cases", async () => {
    const { call } = start();
    expect((await call("POST", "/participants/import", { rows: [row] })).status).toBe(400);                         // no attestation
    expect((await call("POST", "/participants/import", { rows: [row], consent_attested: true }, "reviewer")).status).toBe(403);
    const ok = await call("POST", "/participants/import", { rows: [row], consent_attested: true }, "operator");
    expect(ok.status).toBe(200);
    expect(ok.json.created).toHaveLength(1);
    const list = await call("GET", "/cases");
    expect(list.json.cases).toHaveLength(1);
    expect(list.json.cases[0]).toMatchObject({ name: "Ravi Test", phone: "•••• 3210", status: "not-started" });
    expect(JSON.stringify(list.json)).not.toContain("9876543210");
  });

  it("is unavailable when no encryption key is configured", async () => {
    const { call } = start({ pii: undefined });
    expect((await call("POST", "/participants/import", { rows: [row], consent_attested: true })).status).toBe(503);
  });
});

describe("deleting a case over the API", () => {
  async function withCase() {
    const t = start({ allowPurge: false });
    const r = await t.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    return { ...t, id: r.json.created[0].case_id as string };
  }

  it("is admin only and needs the case id typed exactly", async () => {
    const { call, id } = await withCase();
    const body = { confirm: id, reason_code: "participant_request" };
    expect((await call("POST", `/cases/${id}/delete`, body, "operator")).status).toBe(403);
    expect((await call("POST", `/cases/${id}/delete`, { ...body, confirm: "nope" })).status).toBe(400);
    expect((await call("GET", `/cases/${id}`)).status).toBe(200); // still there
    expect((await call("POST", `/cases/${id}/delete`, { confirm: id, reason_code: "bad" })).status).toBe(400);
  });

  it("removes the case from every list and leaves only an anonymous trail", async () => {
    const { call, id } = await withCase();
    const del = await call("POST", `/cases/${id}/delete`, { confirm: id, reason_code: "participant_request" });
    expect(del.status).toBe(200);
    expect((await call("GET", "/cases")).json.cases).toHaveLength(0);
    expect((await call("GET", "/summary")).json.total).toBe(0);
    expect((await call("GET", `/cases/${id}`)).status).toBe(410);
    expect((await call("POST", `/cases/${id}/run-agent`, { scenario: "same_job" })).status).toBe(410);
    expect((await call("POST", `/cases/${id}/delete`, { confirm: id, reason_code: "participant_request" })).status).toBe(410);
    const audit = JSON.stringify((await call("GET", "/audit")).json);
    expect(audit).toContain("Case deleted");
    expect(audit).not.toContain("Ravi");
    expect((await call("GET", "/audit/verify")).json.ok).toBe(true);
  });
});

describe("purge and configuration", () => {
  it("purge exists only when explicitly enabled, and needs the typed phrase", async () => {
    const off = start();
    expect((await off.call("POST", "/admin/purge-all", { confirm: "DELETE ALL DATA" })).status).toBe(404);
    server?.close(); // the first instance; start() replaces the shared handle
    const on = start({ allowPurge: true });
    await on.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    expect((await on.call("POST", "/admin/purge-all", { confirm: "yes" })).status).toBe(400);
    expect((await on.call("POST", "/admin/purge-all", { confirm: "DELETE ALL DATA" }, "operator")).status).toBe(403);
    expect((await on.call("POST", "/admin/purge-all", { confirm: "DELETE ALL DATA" })).status).toBe(200);
    expect((await on.call("GET", "/cases")).json.cases).toHaveLength(0);
  });

  it("reports the real configuration, with nothing invented", async () => {
    const { call } = start();
    const m = (await call("GET", "/mission")).json;
    expect(m.version).toBe("MSN-001-v1.3");
    expect(m.instrument_signed_off).toBe(false);
    expect(m.templates.map((t: { key: string }) => t.key)).toEqual(["placement_intro_v1"]);
    expect(m.runtime).toMatchObject({ whatsapp: "off", agent: "scripted" });
    const me = (await call("GET", "/me")).json;
    expect(me).toMatchObject({ role: "admin", channel: "simulated", can_import: true, can_purge: false });
  });
});

const mission = (over: Record<string, unknown> = {}) => ({
  mission_id: "MSN-LOAN", version: "MSN-LOAN-v1", name: "Loan check-in", programme_name: "Kisan Credit", intro_template: "loan_intro_v1",
  templates: [{ key: "loan_intro_v1", language: "en", purpose: "Opens contact", provider_name: "loan_intro_v1", body_fields: ["first_name", "programme"] }],
  instrument: { ...DRAFT_INSTRUMENT, draft: false, version: "LOAN-1" }, ...over,
});

describe("missions over the API", () => {
  it("only an admin can add one, mistakes come back in plain words, and a saved version never changes", async () => {
    const { call } = start();
    expect((await call("POST", "/missions", mission(), "operator")).status).toBe(403);
    const bad = await call("POST", "/missions", mission({ intro_template: "nope" }));
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('intro_template "nope" is not in the templates list');
    const ok = await call("POST", "/missions", mission());
    expect(ok.status).toBe(201);
    expect(ok.json.mission).toMatchObject({ version: "MSN-LOAN-v1", instrument_signed_off: true, programme_name: "Kisan Credit", builtin: false });
    expect((await call("POST", "/missions", mission({ name: "Changed" }))).status).toBe(409);
  });

  it("lists the built-in mission and saved ones, with how many participants each has, and defaults to the newest", async () => {
    const { call } = start();
    await call("POST", "/missions", mission());
    await call("POST", "/participants/import", { rows: [row], consent_attested: true, mission_version: "MSN-001-v1.3" });
    await call("POST", "/participants/import", { rows: [{ ...row, phone: "9876500001" }, { ...row, phone: "9876500002" }], consent_attested: true });
    const list = (await call("GET", "/missions")).json;
    expect(list.missions.map((m: { version: string; participants: number }) => [m.version, m.participants])).toEqual([["MSN-001-v1.3", 1], ["MSN-LOAN-v1", 2]]);
    expect(list.default_version).toBe("MSN-LOAN-v1");
    expect((await call("GET", "/mission")).json.version).toBe("MSN-LOAN-v1");
    expect((await call("GET", "/mission?version=MSN-001-v1.3")).json.version).toBe("MSN-001-v1.3");
    expect((await call("GET", "/mission?version=MSN-NOPE-v1")).status).toBe(404);
    expect((await call("POST", "/participants/import", { rows: [row], consent_attested: true, mission_version: "MSN-NOPE-v1" })).status).toBe(404);
  });

  it("returns a mission in the shape the form accepts, so a new version can start from it", async () => {
    const { call } = start();
    await call("POST", "/missions", mission());
    const def = (await call("GET", "/missions/MSN-LOAN-v1/definition")).json.definition;
    expect((await call("POST", "/missions", { ...def, version: "MSN-LOAN-v2" })).status).toBe(201);
  });

  it("shows the goal and what the mission needs to know, and a new version can start from it", async () => {
    const { call } = start();
    const m = (await call("GET", "/mission")).json;
    expect(m.objective).toContain("still works");
    expect(m.strategy.channels).toEqual(["whatsapp", "voice"]);
    expect(m.requirements.map((r: { key: string }) => r.key)).toEqual(["work_status", "employer_name", "role_title", "change_reason", "not_working_reason", "job_search", "course", "support_requested"]);
    expect(m.requirements.find((r: { key: string }) => r.key === "employer_name")).toMatchObject({ required: true, min_confidence: 0.6, checked_against: "programme_employer", when: { key: "work_status", in: ["same_job", "changed_job"] } });
    const def = (await call("GET", "/missions/MSN-001-v1.3/definition")).json.definition;
    expect(def.evidence_requirements).toHaveLength(8);
    const copy = await call("POST", "/missions", { ...def, mission_id: "MSN-COPY", version: "MSN-COPY-v1", name: "Copy of the tracer", instrument: { ...def.instrument, draft: false } });
    expect(copy.status).toBe(201);
    expect(copy.json.mission.requirements).toHaveLength(8);
  });

  it("a participant's conversation view shows the questions of their own mission", async () => {
    const { call } = start();
    await call("POST", "/missions", mission({ instrument: { ...DRAFT_INSTRUMENT, draft: false, version: "L", questions: [{ id: "q_only", module: "m", type: "text", evidence_key: "k", text: "Only question here" }], faq: [] } }));
    const r = await call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    expect((await call("GET", `/cases/${id}/conversation`)).json.questions_total).toBe(1);
  });
});

const employee = (over: Record<string, unknown> = {}) => ({
  employee_id: "verification-employee", version: "VE-1.1.0", name: "Meera", purpose: "Verify what happened to each participant after a programme.",
  persona: "Calm and unhurried. Plain words, short sentences.", instructions: "You verify one participant's outcome for one case at a time. Read the case with case_get_context first.",
  allowed_tools: ["case_get_context", "mission_get_bundle", "decision_propose", "review_request"], ...over,
});

describe("employees over the API", () => {
  it("lists the built-in employee as current, with how many missions use it", async () => {
    const { call } = start();
    const r = (await call("GET", "/employees", undefined, "reviewer")).json;
    expect(r.employees).toHaveLength(1);
    expect(r.employees[0]).toMatchObject({ version: "VE-1.0.0", name: "Meera", builtin: true, current: true, tools: 9, missions_using: 1 });
    expect(r.can_edit).toBe(false);
  });

  it("only platform staff can add a version; mistakes come back in plain words; a saved version never changes", async () => {
    const { call } = start();
    for (const role of ["operator", "reviewer"]) expect((await call("POST", "/employees", employee(), role)).status).toBe(403);
    const bad = await call("POST", "/employees", employee({ allowed_tools: ["mission_get_bundle"] }), "agent_ops");
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("must be allowed case_get_context");
    const ok = await call("POST", "/employees", employee(), "agent_ops");
    expect(ok.status).toBe(201);
    expect(ok.json.employee).toMatchObject({ version: "VE-1.1.0", current: true });
    expect((await call("POST", "/employees", employee({ name: "Changed" }), "admin")).status).toBe(409);
    expect((await call("GET", "/employees", undefined, "agent_ops")).json.can_edit).toBe(true);
  });

  it("a new version becomes current, and missions follow it unless they pin one", async () => {
    const { call } = start();
    await call("POST", "/employees", employee(), "agent_ops");
    await call("POST", "/missions", mission({ version: "MSN-PIN-v1", employee_version: "VE-1.0.0" }));
    await call("POST", "/missions", mission({ version: "MSN-FOLLOW-v1" }));
    const list = (await call("GET", "/employees")).json.employees;
    expect(list.map((e: { version: string; current: boolean }) => [e.version, e.current])).toEqual([["VE-1.0.0", false], ["VE-1.1.0", true]]);
    const missions = (await call("GET", "/missions")).json.missions as { version: string; employee: { version: string; pinned: boolean } }[];
    const by = (v: string) => missions.find(m => m.version === v)!.employee;
    expect(by("MSN-FOLLOW-v1")).toMatchObject({ version: "VE-1.1.0", pinned: false });
    expect(by("MSN-PIN-v1")).toMatchObject({ version: "VE-1.0.0", pinned: true });
    expect(by("MSN-001-v1.3")).toMatchObject({ version: "VE-1.1.0", pinned: false });
    expect((await call("POST", "/missions", mission({ version: "MSN-BAD-v1", employee_version: "VE-9.9.9" }))).status).toBe(400);
  });

  it("shows exactly what the agent is told for a mission, layer by layer", async () => {
    const { call } = start();
    await call("POST", "/missions", mission({ objective: "Find out whether the borrower paid on time.", agent_guidance: "Short messages only." }));
    const c = (await call("GET", "/employees/VE-1.0.0/context?mission_version=MSN-LOAN-v1", undefined, "reviewer")).json;
    expect(c.layers.map((l: { layer: string }) => l.layer)).toEqual(["platform", "employee", "mission"]);
    expect(c.layers[2].text).toContain("Find out whether the borrower paid on time.");
    expect(c.layers[2].text).toContain("Short messages only.");
    expect(c.estimated_tokens).toBeGreaterThan(300);
    expect((await call("GET", "/employees/VE-9.9.9/context")).status).toBe(404);
  });

  it("the full definition comes back so a new version can start from it", async () => {
    const { call } = start();
    const e = (await call("GET", "/employees/VE-1.0.0")).json.employee;
    expect(e.allowed_tools).toHaveLength(9);
    const copy = await call("POST", "/employees", { ...e, version: "VE-1.0.1" }, "agent_ops");
    expect(copy.status).toBe(201);
  });
});

describe("phone calls over the API", () => {
  const SECRET = "w".repeat(24);
  function withVoice() {
    const port = new FakeVoice();
    const cfg = { piiKey: KEY, callsEnabled: true };
    const t = start({ voice: { port, cfg, tenant: DEMO_TENANT, webhookSecret: SECRET, callbackUrl: `https://dozai.example/api/webhooks/zolabs/${SECRET}` } });
    t.svc.voiceEnabled = true;
    void t.svc.store.putControls({ ...defaultControls(DEMO_TENANT), autonomy: { ...defaultControls(DEMO_TENANT).autonomy, voice_call: "automatic" } });
    return { ...t, port, cfg };
  }
  const tools = (svc: CaseService, id: string) => ({ t: new GatewayTools(svc), s: { session_id: "s", tenant_id: DEMO_TENANT, case_id: id, mission_version: "MSN-001-v1.3", employee_version: "x" } });

  it("shows exactly what would be published, and says the provider is off when it is not configured", async () => {
    const on = withVoice();
    const p = (await on.call("GET", "/missions/MSN-001-v1.3/voice-form", undefined, "reviewer")).json;
    expect(p.definition.form_fields).toHaveLength(10);
    expect(p.definition.form_fields.slice(0, 2).map((f: { field_id: string }) => f.field_id)).toEqual(["identity_confirmed", "consent_given"]);
    expect(p).toMatchObject({ link: null, in_sync: false, voice: { enabled: true, kind: "simulated" } });
    const off = start();
    expect((await off.call("GET", "/missions/MSN-001-v1.3/voice-form")).json.voice).toEqual({ enabled: false, kind: "off" });
    expect((await off.call("GET", "/me")).json.voice).toBe("off");
    expect((await on.call("GET", "/me")).json.voice).toBe("simulated");
  });

  it("publishing needs platform staff, a confirmation and a configured provider; re-publishing updates the same form", async () => {
    const { call, port } = withVoice();
    for (const role of ["operator", "reviewer"]) expect((await call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, role)).status).toBe(403);
    expect((await call("POST", "/missions/MSN-001-v1.3/voice-form/publish", {}, "agent_ops")).status).toBe(400);
    expect((await start().call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true })).status).toBe(503);

    const first = (await call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops")).json;
    expect(first.link).toMatchObject({ form_id: 901, mission_version: "MSN-001-v1.3", published_by: "agent_ops:dev-user" });
    expect(first.in_sync).toBe(true);
    expect(port.forms.get(901)?.callbackUrl).toBe(`https://dozai.example/api/webhooks/zolabs/${SECRET}`);

    // the employee's tone changes: the published form no longer matches, until it is published again
    await call("POST", "/employees", { employee_id: "verification-employee", version: "VE-1.1.0", name: "Meera", purpose: "Verify what happened to each participant.", persona: "Calm and unhurried. Always thanks people for their time.", instructions: "You verify one participant's outcome for one case at a time. Read the case with case_get_context first.", allowed_tools: ["case_get_context", "decision_propose", "review_request", "voice_call_request"] }, "agent_ops");
    expect((await call("GET", "/missions/MSN-001-v1.3/voice-form")).json.in_sync).toBe(false);
    const again = (await call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops")).json;
    expect(again.link.form_id).toBe(901);
    expect(again.in_sync).toBe(true);
    expect(port.forms.size).toBe(1);
    expect(port.forms.get(901)?.form_context).toContain("Calm and unhurried");
  });

  async function inProgressCall() {
    const w = withVoice();
    const r = await w.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    await w.svc.beginSession(DEMO_TENANT, id, "t");
    await w.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    const { t, s } = tools(w.svc, id);
    const c = await w.svc.getCase(DEMO_TENANT, id);
    const asked = await t.call(s, "voice_call_request", { case_id: id, idempotency_key: "key-voice-0001", expected_version: c.version, reason: "No reply to WhatsApp for two days." });
    expect(asked.error).toBeUndefined();
    expect(await dispatchVoice(w.svc, DEMO_TENANT, w.port, w.cfg)).toBe(1);
    return { ...w, id };
  }

  it("the simulator finishes a call as you choose and applies it exactly like a real result", async () => {
    const { call, id, svc } = await inProgressCall();
    expect((await call("GET", `/cases/${id}`)).json.case.status).toBe("progress");
    const done = await call("POST", `/cases/${id}/simulate-call`, { outcome: "answered", answers: { work_status: "I work at the same place as before", employer_name: "Acme", role_title: "Packer" } });
    expect(done.status).toBe(200);
    expect(done.json.applied).toBe(1);
    expect((await svc.getCase(DEMO_TENANT, id)).status).toBe("complete"); // the agent was woken, judged the answers (employer matches the record) and the policy completed it
    const detail = (await call("GET", `/cases/${id}`)).json;
    expect(detail.requirements).toMatchObject({ gaps: [], collected: 3 });
    expect(detail.evidence.map((e: { source: string }) => e.source)).toEqual(["voice", "voice", "voice"]);
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0]).toMatchObject({ status: "completed", reason: "No reply to WhatsApp for two days.", asked: ["work_status", "employer_name", "role_title", "change_reason", "not_working_reason", "job_search", "course", "support_requested"] });
    expect((await call("POST", `/cases/${id}/simulate-call`, { outcome: "answered" })).status).toBe(400); // nothing in progress any more
  });

  it("a refusal, a wrong number and no answer each end up where they should", async () => {
    for (const [outcome, expected] of [["refused", { status: "complete", outcome: "opted_out" }], ["wrong_person", { status: "review" }], ["no_answer", { status: "waiting" }]] as const) {
      const { call, id, svc } = await inProgressCall();
      expect((await call("POST", `/cases/${id}/simulate-call`, { outcome })).status).toBe(200);
      expect(await svc.getCase(DEMO_TENANT, id)).toMatchObject(expected);
    }
    const { call, id } = await inProgressCall();
    expect((await call("POST", `/cases/${id}/simulate-call`, { outcome: "shrug" })).status).toBe(400);
  });

  it("transcripts and audio are shown only to reviewers and platform staff", async () => {
    const { call, id } = await inProgressCall();
    await call("POST", `/cases/${id}/simulate-call`, { outcome: "answered", answers: { work_status: "same_job" }, transcript: "Asha said she works at Acme." });
    const calls = async (role: string) => (await call("GET", `/cases/${id}`, undefined, role)).json.calls[0];
    expect((await calls("reviewer")).transcript).toContain("Asha said");
    expect((await calls("agent_ops")).audio_url).toMatch(new RegExp("^\/calls\/.+\/recording$")); // streamed by us, never a link to the provider
    expect(await calls("operator")).toMatchObject({ transcript: null, audio_url: null });
  });

  it("the simulator is refused when the provider is real", async () => {
    const real = { kind: "zolabs" } as never;
    const { call } = start({ voice: { port: real, cfg: { piiKey: KEY, callsEnabled: false }, tenant: DEMO_TENANT } });
    expect((await call("POST", "/cases/DZ-0001/simulate-call", { outcome: "answered" })).status).toBe(400);
  });

  it("the provider's callback needs the secret in the address, keeps only the call id, and a repeat is ignored", async () => {
    const { call, store } = withVoice();
    expect((await call("POST", `/webhooks/zolabs/wrong`, { communication_id: "call_9" })).status).toBe(401);
    const ok = await call("POST", `/webhooks/zolabs/${SECRET}`, { communication_id: "call_9", transcript: "SECRET WORDS" });
    expect(ok).toMatchObject({ status: 200, json: { ok: true, stored: true } });
    expect((await call("POST", `/webhooks/zolabs/${SECRET}`, { communication_id: "call_9" })).json.stored).toBe(false);
    expect((await call("POST", `/webhooks/zolabs/${SECRET}`, { hello: "there" })).json.stored).toBe(false);
    const kept = JSON.stringify(await store.listInbox(DEMO_TENANT));
    expect(kept).toContain("call_9");
    expect(kept).not.toContain("SECRET WORDS");
    // when no phone provider is configured the address does not exist
    expect((await start().call("POST", `/webhooks/zolabs/${SECRET}`, { communication_id: "x" })).status).toBe(404);
  });
});

describe("campaigns over the API", () => {
  async function withPeople(n: number, over: Record<string, unknown> = {}) {
    const t = start(over);
    await t.call("POST", "/missions", mission());
    const rows = Array.from({ length: n }, (_, i) => ({ ...row, name: `Person ${i}`, phone: `98765${String(10000 + i)}`, cohort: i % 2 ? "Ajmer" : "Jaipur" }));
    await t.call("POST", "/participants/import", { rows, consent_attested: true });
    return t;
  }

  it("a reviewer cannot create or start one; an operator can; starting sends the first batch right away", async () => {
    const { call } = await withPeople(6);
    expect((await call("POST", "/campaigns", { name: "Jaipur batch" }, "reviewer")).status).toBe(403);
    const made = await call("POST", "/campaigns", { name: "Jaipur batch", cohort: "Jaipur", per_tick: 2, daily_cap: 10 }, "operator");
    expect(made.status).toBe(201);
    const id = made.json.campaign.campaign_id as string;
    const preview = (await call("GET", "/campaigns")).json.campaigns[0];
    expect(preview).toMatchObject({ status: "draft", mission_version: "MSN-LOAN-v1", progress: { queued: 3, contacted: 0 } });

    expect((await call("POST", `/campaigns/${id}/start`, undefined, "reviewer")).status).toBe(403);
    const started = await call("POST", `/campaigns/${id}/start`, undefined, "operator");
    expect(started.status).toBe(200);
    expect(started.json.campaign).toMatchObject({ status: "running", sent_total: 2, progress: { queued: 1, contacted: 2, waiting: 2 } });
    expect(started.json.pass.sent).toBe(2);

    const cases = (await call("GET", "/cases")).json.cases;
    expect(cases.filter((c: { status: string }) => c.status === "progress")).toHaveLength(2);
    expect(JSON.stringify(started.json)).not.toContain("98765");
  });

  it("pause, resume and stop work, and a bad action is refused", async () => {
    const { call } = await withPeople(6);
    const id = (await call("POST", "/campaigns", { name: "All", per_tick: 1 })).json.campaign.campaign_id as string;
    await call("POST", `/campaigns/${id}/start`);
    expect((await call("POST", `/campaigns/${id}/pause`)).json.campaign.status).toBe("paused");
    expect((await call("POST", "/campaigns/run-now")).json.campaigns).toEqual([]);
    expect((await call("POST", `/campaigns/${id}/resume`)).json.campaign.status).toBe("running");
    expect((await call("POST", `/campaigns/${id}/stop`)).json.campaign.status).toBe("stopped");
    expect((await call("POST", `/campaigns/${id}/start`)).status).toBe(409);
    expect((await call("POST", `/campaigns/${id}/explode`)).status).toBe(404);
    expect((await call("POST", "/campaigns/cmp_none/start")).status).toBe(404);
  });

  it("when WhatsApp is live it refuses to start a campaign whose questions are not approved, or whose template has no WhatsApp name", async () => {
    const live = { runtime: { whatsapp: "live", agent: "scripted", model: null, contact_window: "test", draft_instrument_allowed: false } };
    const t = start(live);
    await t.call("POST", "/missions", mission({ version: "MSN-DRAFT-v1", instrument: { ...DRAFT_INSTRUMENT, draft: true } }));
    await t.call("POST", "/missions", mission({ version: "MSN-NONAME-v1", templates: [{ key: "loan_intro_v1", language: "en", purpose: "x" }] }));
    for (const [version, code] of [["MSN-DRAFT-v1", "INSTRUMENT_NOT_APPROVED"], ["MSN-NONAME-v1", "TEMPLATE_NOT_CONFIGURED"]] as const) {
      const id = (await t.call("POST", "/campaigns", { name: "x1", mission_version: version })).json.campaign.campaign_id as string;
      const r = await t.call("POST", `/campaigns/${id}/start`);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe(code);
      expect((await t.call("GET", "/campaigns")).json.campaigns.find((c: { campaign_id: string }) => c.campaign_id === id).status).toBe("draft");
    }
  });
});

describe("conversation over the API", () => {
  it("a case with no conversation says so, and simulated replies drive the interview", async () => {
    const { call, svc } = start();
    const r = await call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    expect((await call("GET", `/cases/${id}/conversation`)).json).toMatchObject({ status: "not_started", messages: [], answered: 0 });

    await svc.beginSession("tenant_demo", id, "test"); // intro sent, waiting for a reply
    const yes = await call("POST", `/cases/${id}/simulate-reply`, { text: "yes" });
    expect(yes.status).toBe(200);
    expect(yes.json.result.action).toBe("started");
    const c = (await call("GET", `/cases/${id}/conversation`)).json;
    expect(c.status).toBe("asking");
    expect(c.messages.at(-1).text).toContain("Which of these describes you best");

    await call("POST", `/cases/${id}/simulate-reply`, { text: "2" });
    expect((await call("GET", `/cases/${id}/conversation`)).json.answered).toBe(1);
  });

  it("the case page says which things are known, which are missing and which do not match", async () => {
    const { call, svc } = start();
    const r = await call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    const empty = (await call("GET", `/cases/${id}`)).json.requirements;
    expect(empty).toMatchObject({ complete: false, collected: 0, gaps: ["work_status"] });

    await svc.beginSession("tenant_demo", id, "test");
    await call("POST", `/cases/${id}/simulate-reply`, { text: "yes" });
    await call("POST", `/cases/${id}/simulate-reply`, { text: "1" });               // same place as before
    await call("POST", `/cases/${id}/simulate-reply`, { text: "Acme Express" });   // the programme record says Acme
    const mid = (await call("GET", `/cases/${id}`)).json.requirements;
    expect(mid.gaps).toEqual(["role_title"]);
    expect(mid.conflicts).toBe(1);
    const emp = mid.items.find((i: { key: string }) => i.key === "employer_name");
    expect(emp).toMatchObject({ state: "conflict", note: "Differs from the programme record." });
    expect(JSON.stringify(mid)).not.toContain("Acme Express"); // states and references, not the answer text
  });

  it("simulated replies need the right role and are refused when WhatsApp is live", async () => {
    const off = start();
    const r = await off.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    expect((await off.call("POST", `/cases/${id}/simulate-reply`, { text: "yes" }, "reviewer")).status).toBe(403);
    server?.close();
    const live = start({ runtime: { whatsapp: "live", agent: "scripted", model: null, contact_window: "test" } });
    expect((await live.call("POST", "/cases/DZ-0001/simulate-reply", { text: "yes" })).status).toBe(400);
  });
});

describe("approvals, controls and replay over the API", () => {
  async function withHeldCall() {
    const t = start();
    const r = await t.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    await t.svc.beginSession(DEMO_TENANT, id, "t");
    const c = await t.svc.getCase(DEMO_TENANT, id);
    const item = await t.svc.queueOutbox(c, "voice_call", { form_id: 900, asked: ["work_status"], reason: "No reply for two days." }, "k-api-1");
    return { ...t, id, item };
  }

  it("lists what is waiting with the person and the details, and shows it in the case", async () => {
    const { call, id, item } = await withHeldCall();
    const a = (await call("GET", "/approvals")).json;
    expect(a.waiting).toBe(1);
    expect(a.approvals[0]).toMatchObject({ outbox_id: item.outbox_id, case_id: id, participant: "Ravi Test", action: "voice_call", state: "held" });
    expect(a.approvals[0].summary).toContain("No reply for two days.");
    expect(JSON.stringify(a)).not.toContain("9876543210");
    const detail = (await call("GET", `/cases/${id}`)).json;
    expect(detail.approvals).toHaveLength(1);
    expect(detail).toMatchObject({ memory: [], wakes: [] });
  });

  it("only reviewers, administrators and agent operations may decide, and a decision is made once", async () => {
    const { call, item } = await withHeldCall();
    expect((await call("POST", `/approvals/${item.outbox_id}/approve`, {}, "operator")).status).toBe(403);
    expect((await call("POST", `/approvals/${item.outbox_id}/maybe`, {}, "reviewer")).status).toBe(404);
    expect((await call("POST", `/approvals/${item.outbox_id}/approve`, { note: "ok" }, "reviewer")).json).toMatchObject({ status: "pending" });
    expect((await call("POST", `/approvals/${item.outbox_id}/approve`, {}, "reviewer")).status).toBe(409);
    const done = (await call("GET", "/approvals")).json;
    expect(done.waiting).toBe(0);
    expect(done.approvals[0]).toMatchObject({ state: "approved", decided_by: "reviewer:dev-user", note: "ok" });
  });

  it("declining sends the case to a person", async () => {
    const { call, item, id } = await withHeldCall();
    expect((await call("POST", `/approvals/${item.outbox_id}/reject`, { note: "Not now" }, "agent_ops")).json).toMatchObject({ status: "failed" });
    expect((await call("GET", `/cases/${id}`)).json.case.status).toBe("review");
  });

  it("the dial starts at 'a person approves' for calls, and only administrators and agent operations can move it", async () => {
    const { call } = start();
    const k = (await call("GET", "/controls", undefined, "operator")).json;
    expect(k.controls.autonomy).toMatchObject({ voice_call: "approve_first", message_free: "approve_first", message_template: "automatic" });
    expect(k).toMatchObject({ can_change: false, can_pause: true, spend_24h: 0, held: 0 });
    expect((await call("POST", "/controls", { autonomy: { voice_call: "automatic" } }, "operator")).status).toBe(403);
    expect((await call("POST", "/controls", { autonomy: { voice_call: "automatic" } }, "reviewer")).status).toBe(403);
    expect((await call("POST", "/controls", { autonomy: { voice_call: "whenever" } }, "admin")).status).toBe(400);
    const set = await call("POST", "/controls", { autonomy: { voice_call: "automatic" }, daily_budget_usd: 4 }, "agent_ops");
    expect(set.json.controls).toMatchObject({ autonomy: { voice_call: "automatic" }, daily_budget_usd: 4, updated_by: "agent_ops:dev-user" });
    expect((await call("GET", "/controls")).json.controls.autonomy.voice_call).toBe("automatic");
  });

  it("the kill switch is open to operators too, and says who switched it off and why", async () => {
    const { call } = start();
    expect((await call("POST", "/controls", { paused: true, reason: "Wrong template" }, "reviewer")).status).toBe(403);
    expect((await call("POST", "/controls", { paused: true, reason: "Wrong template" }, "operator")).json.controls).toMatchObject({ paused: true, paused_by: "operator:dev-user", paused_reason: "Wrong template" });
    expect((await call("GET", "/controls")).json.controls.paused).toBe(true);
    expect((await call("POST", "/controls", { paused: false }, "operator")).json.controls.paused).toBe(false);
  });

  it("replays a session under today's rules, and says so when there is no such session", async () => {
    const { call, svc, id } = await withHeldCall();
    await svc.store.putSession({ session_id: "s-api", tenant_id: DEMO_TENANT, case_id: id, employee_version: "x", mission_version: "MSN-001-v1.3", status: "idle", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: 0.5, simulated: false, started_at: new Date().toISOString(), trigger: "resume",
      trace: [{ label: "memory_note", type: "MCP tool", detail: "ok", tool: "memory_note", input: { key: "best_time_to_call", value: "evening" }, ts: new Date().toISOString(), outcome: "executed", case_version: 2 }] });
    const r = (await call("GET", "/sessions/s-api/replay")).json;
    expect(r).toMatchObject({ session_id: "s-api", trigger: "resume" });
    expect(r.rows).toEqual([expect.objectContaining({ tool: "memory_note", recorded: "executed", now: "allowed", changed: false })]);
    expect((await call("GET", "/sessions/nope/replay")).status).toBe(404);
  });
});

describe("the phone channel at a glance, over the API", () => {
  function withVoiceOn() {
    const port = new FakeVoice();
    const t = start({ voice: { port, cfg: { piiKey: KEY, callsEnabled: true }, tenant: DEMO_TENANT, callbackUrl: "https://dozai.example/api/webhooks/zolabs/x" } });
    t.svc.voiceEnabled = true;
    return { ...t, port };
  }

  it("shows the connection, a form per mission and whether it is current", async () => {
    const { call } = withVoiceOn();
    const v = (await call("GET", "/voice")).json;
    expect(v).toMatchObject({ kind: "simulated", calls_enabled: true, who_can_be_called: "anyone who has consented", callback_ready: true, can_check: true });
    expect(v.forms).toEqual([expect.objectContaining({ mission_version: "MSN-001-v1.3", state: "not_published", form_id: null })]);
    await call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    expect((await call("GET", "/voice")).json.forms[0]).toMatchObject({ state: "current", form_id: 901, published_by: "agent_ops:dev-user" });
  });

  it("says nobody can be called when the provider is not configured", async () => {
    const { call } = start();
    expect((await call("GET", "/voice")).json).toMatchObject({ kind: "off", calls_enabled: false, who_can_be_called: "nobody (calls are switched off)" });
    expect((await call("POST", "/voice/check", {})).status).toBe(503);
  });

  it("checks the connection without placing a call, and only for platform staff", async () => {
    const { call, port } = withVoiceOn();
    expect((await call("POST", "/voice/check", {}, "operator")).status).toBe(403);
    expect((await call("POST", "/voice/check", {}, "agent_ops")).json).toMatchObject({ ok: true, kind: "simulated", account: { account: "simulator" } });
    expect(port.calls).toHaveLength(0);
  });

  it("reports a failed check as a plain message, not a crash", async () => {
    const { call, port } = withVoiceOn();
    port.whoami = async () => { throw new Error("The ZoLabs sign-in could not be renewed (invalid_grant)."); };
    expect((await call("POST", "/voice/check", {})).json).toMatchObject({ ok: false, error: expect.stringContaining("could not be renewed") });
  });

  it("lists the calls made, with the person, and keeps recordings and transcripts from people who should not see them", async () => {
    const { call, svc } = withVoiceOn();
    const r = await call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    await svc.store.putCall({ communication_id: "c-1", tenant_id: DEMO_TENANT, case_id: id, form_id: 901, status: "completed", requested_at: "2026-10-12T10:00:00.000Z", ended_at: "2026-10-12T10:03:00.000Z", duration_seconds: 180, asked: ["work_status"], reason: "No reply for two days.", audio_url: "https://audio.example/c-1.mp3", transcript: "Meera: hello" });
    const reviewer = (await call("GET", "/voice", undefined, "reviewer")).json.calls[0];
    expect(reviewer).toMatchObject({ communication_id: "c-1", person: "Ravi Test", status: "completed", duration_seconds: 180, audio_url: "https://audio.example/c-1.mp3", transcript: "Meera: hello" });
    const operator = (await call("GET", "/voice", undefined, "operator")).json.calls[0];
    expect(operator).toMatchObject({ has_audio: true, has_transcript: true, audio_url: null, transcript: null });
    expect(JSON.stringify(await call("GET", "/voice", undefined, "operator"))).not.toContain("hello");
  });
});

describe("listening to a recording", () => {
  async function withRecording() {
    const port = new FakeVoice();
    const t = start({ voice: { port, cfg: { piiKey: KEY, callsEnabled: true }, tenant: DEMO_TENANT } });
    const r = await t.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    const id = r.json.created[0].case_id as string;
    await t.svc.store.putCall({ communication_id: "c-9", tenant_id: DEMO_TENANT, case_id: id, form_id: 901, status: "completed", requested_at: "2026-10-12T10:00:00.000Z", asked: [], recording: true });
    port.recordings.set("c-9", Buffer.from("AUDIO-BYTES"));
    return { ...t, port, base: `` };
  }
  const get = async (call: Awaited<ReturnType<typeof withRecording>>["call"], path: string, role: string) => {
    const r = await call("GET", path, undefined, role);
    return r;
  };

  it("is streamed from the provider to reviewers and platform staff, and to nobody else", async () => {
    const { call } = await withRecording();
    expect((await get(call, "/calls/c-9/recording", "operator")).status).toBe(403);
    expect((await get(call, "/calls/nope/recording", "reviewer")).status).toBe(404);
    expect((await get(call, "/calls/c-9/recording", "reviewer")).status).toBe(200); // body is audio, not JSON
  });

  it("is not available once the call record is gone, so deleting a case closes our way to the audio", async () => {
    const { call, svc } = await withRecording();
    const id = (await call("GET", "/cases")).json.cases[0].id as string;
    await call("POST", `/cases/${id}/delete`, { confirm: id, reason_code: "participant_request" }, "admin");
    expect((await svc.store.getCall(DEMO_TENANT, "c-9"))).toBeUndefined();
    expect((await get(call, "/calls/c-9/recording", "reviewer")).status).toBe(404);
  });
});

describe("staff asking for a phone call on a case", () => {
  function withVoiceOn() {
    const port = new FakeVoice();
    const t = start({ voice: { port, cfg: { piiKey: KEY, callsEnabled: true }, tenant: DEMO_TENANT } });
    t.svc.voiceEnabled = true;
    return { ...t, port };
  }
  async function newCase(t: ReturnType<typeof withVoiceOn>) {
    const r = await t.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    return r.json.created[0].case_id as string;
  }

  it("goes through the same checks and the same approval as the agent, and is recorded as the person who asked", async () => {
    const w = withVoiceOn();
    const id = await newCase(w);
    // no phone form yet: refused for the same reason the agent would be
    expect((await w.call("POST", `/cases/${id}/request-call`, {}, "operator")).status).toBe(422);
    await w.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    const ok = await w.call("POST", `/cases/${id}/request-call`, { reason: "Test call for the pilot" }, "operator");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ requested: true, held: true });
    const [item] = await w.svc.store.listOutbox(DEMO_TENANT);
    expect(item).toMatchObject({ kind: "voice_call", status: "held", payload: { reason: "Test call for the pilot" } });
    const ev = (await w.svc.store.listEvents(DEMO_TENANT, id)).find(e => e.type === "call_requested")!;
    expect(ev.actor).toBe("operator:dev-user"); // a person, not "agent:"
    // nothing rings until it is approved and the scheduler runs
    expect(w.port.calls).toHaveLength(0);
    // approving places the call at once, not on the next scheduler run
    const approved = await w.call("POST", `/approvals/${item!.outbox_id}/approve`, {}, "reviewer");
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: "sent", call: { placed: true } });
    expect(w.port.calls).toHaveLength(1);
  });

  it("rings straight away when calls do not need approval, and says plainly when it cannot", async () => {
    const w = withVoiceOn();
    await w.call("POST", "/controls", { autonomy: { voice_call: "automatic" } }, "admin");
    const id = await newCase(w);
    await w.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    const r = await w.call("POST", `/cases/${id}/request-call`, {}, "operator");
    expect(r.json).toMatchObject({ held: false, placed: true, message: "Calling now." });
    expect(w.port.calls).toHaveLength(1);
    expect(w.port.calls[0]!.source_id).toBe(id);

    // calls switched off: refused, and the page is told why
    const off = withVoiceOn(); off.port.calls.length = 0;
    const closed = start({ voice: { port: new FakeVoice(), cfg: { piiKey: KEY, callsEnabled: false }, tenant: DEMO_TENANT } });
    closed.svc.voiceEnabled = true;
    await closed.call("POST", "/controls", { autonomy: { voice_call: "automatic" } }, "admin");
    const id2 = (await closed.call("POST", "/participants/import", { rows: [row], consent_attested: true })).json.created[0].case_id as string;
    await closed.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    const refused = await closed.call("POST", `/cases/${id2}/request-call`, {}, "operator");
    expect(refused.json).toMatchObject({ placed: false });
    expect(refused.json.message).toContain("not switched on");
  });

  it("is limited to people who can run cases, and says so when phone calls are off", async () => {
    const w = withVoiceOn();
    const id = await newCase(w);
    expect((await w.call("POST", `/cases/${id}/request-call`, {}, "reviewer")).status).toBe(403);
    const off = start();
    const r = await off.call("POST", "/participants/import", { rows: [row], consent_attested: true });
    expect((await off.call("POST", `/cases/${r.json.created[0].case_id}/request-call`, {})).status).toBe(503);
  });
});

describe("publishing a phone form twice at once", () => {
  it("creates one form, refuses the others while it runs, and allows an update afterwards", async () => {
    const port = new FakeVoice();
    const slow = port.publishForm.bind(port);
    port.publishForm = async (def, o) => { await new Promise(r => setTimeout(r, 60)); return slow(def, o); }; // ZoLabs is slow
    const t = start({ voice: { port, cfg: { piiKey: KEY, callsEnabled: true }, tenant: DEMO_TENANT } });
    t.svc.voiceEnabled = true;
    const out = await Promise.all(Array.from({ length: 6 }, () => t.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops")));
    expect(out.filter(r => r.status === 200)).toHaveLength(1);
    expect(out.filter(r => r.status === 409).every(r => r.json.error.code === "PUBLISH_IN_PROGRESS")).toBe(true);
    expect(port.forms.size).toBe(1); // not six
    // the lock was let go: a later publish is an update of the same form
    const again = await t.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    expect(again.status).toBe(200);
    expect(port.forms.size).toBe(1);
  });
});

describe("the page asking whether a call has finished", () => {
  it("applies a finished call with no callback, only for people who can run cases", async () => {
    const port = new FakeVoice();
    const t = start({ voice: { port, cfg: { piiKey: KEY, callsEnabled: true }, tenant: DEMO_TENANT } });
    t.svc.voiceEnabled = true;
    await t.call("POST", "/controls", { autonomy: { voice_call: "automatic" } }, "admin");
    const id = (await t.call("POST", "/participants/import", { rows: [row], consent_attested: true })).json.created[0].case_id as string;
    await t.call("POST", "/missions/MSN-001-v1.3/voice-form/publish", { confirm: true }, "agent_ops");
    await t.call("POST", `/cases/${id}/request-call`, {}, "operator");
    const callId = port.calls[0]!.communication_id;
    expect((await t.call("POST", "/voice/sync", {}, "operator")).json).toMatchObject({ checked: 1, applied: 0 }); // still ringing
    port.complete(callId, { answers: { work_status: "I work at the same place as before", employer_name: "Ravi Corp", role_title: "Packer" } });
    expect((await t.call("POST", "/voice/sync", {}, "reviewer")).status).toBe(403);
    const r = (await t.call("POST", "/voice/sync", {}, "operator")).json;
    expect(r).toMatchObject({ checked: 1, applied: 1 });
    expect((await t.svc.store.getCall(DEMO_TENANT, callId))?.status).toBe("completed");
    expect((await t.call("GET", "/voice")).json.calls[0]).toMatchObject({ status: "completed", person: "Ravi Test" });
  });

  it("answers an empty result when phone calls are off", async () => {
    expect((await start().call("POST", "/voice/sync", {})).json).toEqual({ checked: 0, applied: 0, woken: [], errors: [] });
  });
});

describe("signing off the questionnaire wording", () => {
  it("saves a new approved version with who signed it and when, and makes it the one new participants join", async () => {
    const { call } = start();
    const before = (await call("GET", "/missions")).json;
    expect(before.missions[0]).toMatchObject({ instrument_signed_off: false, signed_off: null });
    expect((await call("POST", "/missions/MSN-001-v1.3/sign-off", { confirm: true }, "reviewer")).status).toBe(403);
    expect((await call("POST", "/missions/MSN-001-v1.3/sign-off", {}, "admin")).status).toBe(400); // must say it was read
    const r = await call("POST", "/missions/MSN-001-v1.3/sign-off", { confirm: true }, "admin");
    expect(r.status).toBe(201);
    expect(r.json.mission).toMatchObject({ version: "MSN-001-v1.3-signed", instrument_signed_off: true, signed_off: { by: "admin:dev-user" } });
    expect(Date.parse(r.json.mission.signed_off.at)).not.toBeNaN();
    const after = (await call("GET", "/missions")).json;
    expect(after.default_version).toBe("MSN-001-v1.3-signed"); // new participants join the signed-off one
    expect(after.missions[0]).toMatchObject({ version: "MSN-001-v1.3", instrument_signed_off: false }); // the old version is untouched
    // the wording itself is unchanged: only the approval differs
    const a = (await call("GET", "/missions/MSN-001-v1.3/definition")).json.definition.instrument, b = (await call("GET", "/missions/MSN-001-v1.3-signed/definition")).json.definition.instrument;
    expect({ ...b, draft: true, signed_off: undefined }).toEqual({ ...a, signed_off: undefined });
  });

  it("cannot be done twice, and a second sign-off of the old version gets its own name", async () => {
    const { call } = start();
    await call("POST", "/missions/MSN-001-v1.3/sign-off", { confirm: true }, "admin");
    expect((await call("POST", "/missions/MSN-001-v1.3-signed/sign-off", { confirm: true }, "admin")).json.error.code).toBe("ALREADY_SIGNED_OFF");
    expect((await call("POST", "/missions/MSN-001-v1.3/sign-off", { confirm: true }, "admin")).json.mission.version).toBe("MSN-001-v1.3-signed2");
  });

  it("records the person who saved an approved wording, whatever the form claimed", async () => {
    const { call } = start();
    const def = (await call("GET", "/missions/MSN-001-v1.3/definition")).json.definition;
    const forged = { ...def, version: "MSN-001-v9.0", instrument: { ...def.instrument, draft: false, signed_off: { by: "someone-important", at: "2020-01-01T00:00:00.000Z" } } };
    const r = await call("POST", "/missions", forged, "admin");
    expect(r.status).toBe(201);
    expect(r.json.mission.signed_off.by).toBe("admin:dev-user");
    expect(r.json.mission.signed_off.at).not.toBe("2020-01-01T00:00:00.000Z");
    // and a draft never carries a sign-off
    const draft = await call("POST", "/missions", { ...def, version: "MSN-001-v9.1", instrument: { ...def.instrument, draft: true, signed_off: { by: "x", at: "y" } } }, "admin");
    expect(draft.json.mission.signed_off).toBeNull();
  });
});

describe("Mission Studio over the API", () => {
  const brief = { name: "Six-month placement check", programme_name: "Project Udaan", goal: "Find out whether people we placed in jobs are still working there six months on.", people: "Young people who finished a retail training with us.", find_out: "Whether they still work at the same place\nThe name of their employer\nWhether they want job support" };

  it("turns a plain brief into a draft mission that can be saved, read and signed off, and is limited to administrators", async () => {
    const { call } = start();
    expect((await call("POST", "/missions/draft", brief, "operator")).status).toBe(403);
    expect((await call("POST", "/missions/draft", { ...brief, goal: "too short" }, "admin")).status).toBe(400);
    expect((await call("POST", "/missions/draft", { ...brief, extra: "x" }, "admin")).status).toBe(400); // only what the brief asks for
    const r = (await call("POST", "/missions/draft", brief, "admin")).json;
    expect(r).toMatchObject({ problems: [], source: "scripted", attempts: 1 });
    expect(r.definition.instrument.draft).toBe(true);
    expect((await call("GET", "/missions")).json.missions).toHaveLength(1); // drafting saves nothing

    const saved = await call("POST", "/missions", r.definition, "admin");
    expect(saved.status).toBe(201);
    expect(saved.json.mission).toMatchObject({ version: r.definition.version, instrument_signed_off: false, signed_off: null, name: "Six-month placement check" });
    expect(saved.json.mission.requirements.map((x: { label: string }) => x.label)).toEqual(["Whether they still work at the same place", "The name of their employer", "Whether they want job support"]);

    const signed = await call("POST", `/missions/${r.definition.version}/sign-off`, { confirm: true }, "admin");
    expect(signed.json.mission).toMatchObject({ instrument_signed_off: true, signed_off: { by: "admin:dev-user" } });
  });

  it("copies the first message, contact rules and employee from the mission it starts from, and applies the brief's own contact rules", async () => {
    const { call } = start();
    const r = (await call("POST", "/missions/draft", { ...brief, start_from: "MSN-001-v1.3", max_attempts: 2, window_start_hour: 11, window_end_hour: 16 }, "admin")).json;
    expect(r.definition.intro_template).toBe("placement_intro_v1");
    expect(r.definition.policy).toMatchObject({ maxAttempts: 2, windowStartHour: 11, windowEndHour: 16 });
    expect((await call("POST", "/missions/draft", { ...brief, start_from: "no-such-mission" }, "admin")).status).toBe(404);
  });

  it("does not draft while the agent is switched off, because drafting uses the model", async () => {
    const { call } = start();
    await call("POST", "/controls", { paused: true, reason: "test" }, "admin");
    const r = await call("POST", "/missions/draft", brief, "admin");
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("AGENT_PAUSED");
  });

  it("each draft gets a version name nothing else uses", async () => {
    const { call } = start();
    const a = (await call("POST", "/missions/draft", brief, "admin")).json.definition;
    await call("POST", "/missions", a, "admin");
    const b = (await call("POST", "/missions/draft", brief, "admin")).json.definition;
    expect(b.version).not.toBe(a.version);
  });
});

describe("deleting a mission", () => {
  const brief = { name: "Throwaway check", programme_name: "Project Udaan", goal: "Find out whether people are still working where we placed them.", people: "People who finished a retail training with us.", find_out: "Whether they still work at the same place\nThe name of their employer" };
  async function withDraftMission() {
    const t = start();
    const draft = (await t.call("POST", "/missions/draft", brief, "admin")).json.definition;
    await t.call("POST", "/missions", draft, "admin");
    return { ...t, version: draft.version as string };
  }

  it("removes a mission nothing uses, after the version is typed exactly, for administrators only", async () => {
    const { call, version } = await withDraftMission();
    expect((await call("POST", `/missions/${version}/delete`, { confirm: version }, "operator")).status).toBe(403);
    expect((await call("POST", `/missions/${version}/delete`, { confirm: "something-else" }, "admin")).status).toBe(400);
    expect((await call("GET", "/missions")).json.missions.map((m: { version: string }) => m.version)).toContain(version);
    expect((await call("POST", `/missions/${version}/delete`, { confirm: version }, "admin")).json).toEqual({ deleted: true, version });
    const after = (await call("GET", "/missions")).json;
    expect(after.missions.map((m: { version: string }) => m.version)).not.toContain(version);
    expect(after.default_version).toBe("MSN-001-v1.3"); // new participants go back to the one before
    expect((await call("GET", `/missions/${version}/definition`)).status).toBe(404);
  });

  it("keeps a mission that has participants or campaigns, and says why", async () => {
    const { call, svc, version } = await withDraftMission();
    await call("POST", "/participants/import", { rows: [row], consent_attested: true, mission_version: version });
    const r = await call("POST", `/missions/${version}/delete`, { confirm: version }, "admin");
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("MISSION_IN_USE");
    expect(r.json.error.message).toContain("1 participant");
    expect(await svc.getMission(DEMO_TENANT, version)).toBeDefined();
  });

  it("never deletes the built-in mission, and a missing one is a plain not-found", async () => {
    const { call } = start();
    expect((await call("POST", "/missions/MSN-001-v1.3/delete", { confirm: "MSN-001-v1.3" }, "admin")).json.error.code).toBe("MISSION_BUILTIN");
    expect((await call("POST", "/missions/nope-v1/delete", { confirm: "nope-v1" }, "admin")).status).toBe(404);
  });

  it("frees the version name, so the same mission can be drafted again", async () => {
    const { call, version } = await withDraftMission();
    await call("POST", `/missions/${version}/delete`, { confirm: version }, "admin");
    const again = (await call("POST", "/missions/draft", brief, "admin")).json.definition;
    expect(again.version).toBe(version);
  });
});

describe("a whole WhatsApp interview on a local setup (simulated replies, scripted agent)", () => {
  async function started() {
    const t = start();
    const id = (await t.call("POST", "/participants/import", { rows: [row], consent_attested: true })).json.created[0].case_id as string;
    await t.call("POST", `/cases/${id}/run-agent`, { scenario: "no_response" }); // sends the first message and waits
    const reply = async (text: string) => (await t.call("POST", `/cases/${id}/simulate-reply`, { text })).json;
    return { ...t, id, reply };
  }

  it("asks the questions, and when the last is answered the agent judges the answers and the case is completed", async () => {
    const { reply, call, id } = await started();
    expect((await reply("yes")).result.action).toBe("started");
    expect((await reply("1")).result.action).toBe("answered");            // I work at the same place
    expect((await reply("Acme")).result.action).toBe("answered");         // the employer on the programme record
    expect((await reply("Packer")).result.action).toBe("answered");
    const last = await reply("1");                                         // yes to job support
    expect(last.result).toMatchObject({ action: "finished", finished: true });
    expect(last.session).toMatchObject({ status: "idle", simulated: true });  // the agent was woken
    expect(last.case).toMatchObject({ status: "confirmed", outcome: "Same job" });
    const d = (await call("GET", `/cases/${id}`)).json;
    expect(d.decisions.at(-1)).toMatchObject({ proposed_outcome: "confirmed", livelihood_state: "same_job" });
  });

  it("sends a different employer to a person, because it does not match the programme record", async () => {
    const { reply } = await started();
    await reply("yes"); await reply("1"); await reply("Some Other Company"); await reply("Packer");
    const last = await reply("2");
    expect(last.case.status).toBe("review");
  });

  it("someone not working is not confirmed, and someone who stops is left alone", async () => {
    const a = await started();
    await a.reply("yes"); await a.reply("3"); await a.reply("1"); await a.reply("1"); // not working, the reason, looking for work
    const done = await a.reply("2");                                                // and no to job support
    expect(done.case).toMatchObject({ status: "not-confirmed" });
    const b = await started();
    await b.reply("yes");
    const stopped = await b.reply("stop");
    expect(stopped.result.action).toBe("stopped");
    expect(stopped.case.status).toBe("opted-out");
  });
});

describe("the cases list: status says where a case is, the result says what was found out, in the mission's words", () => {
  const brief = { name: "Experience check", programme_name: "Project X", goal: "Find out how the experience was for people who used the service.", people: "People who used the service last month.", find_out: "How smooth the experience was\nWhether they would recommend it" };

  async function feedbackWorld() {
    const t = start();
    const draft = (await t.call("POST", "/missions/draft", brief, "admin")).json.definition;
    await t.call("POST", "/missions", draft, "admin");
    const key = draft.evidence_requirements[0].key as string;
    const make = async (name: string) => {
      const r = await t.call("POST", "/participants/import", { rows: [{ ...row, name, phone: `98765${String(Math.floor(Math.random() * 90000) + 10000)}` }], consent_attested: true, mission_version: draft.version });
      const id = r.json.created[0].case_id as string;
      await t.svc.beginSession(DEMO_TENANT, id, "t");
      return id;
    };
    const finish = async (id: string, finding: string | null) => {
      await t.svc.recordInbound(DEMO_TENANT, id, { provider_event_id: `e-${id}`, channel: "whatsapp", summary: "answered", answers: [{ question_id: key, value: "very smooth", confidence: 0.95 }] });
      const refs = (await t.svc.store.listEvidence(id)).map(e => e.evidence_id);
      return t.svc.proposeDecision(DEMO_TENANT, id, (await t.svc.getCase(DEMO_TENANT, id)).version, { proposed_outcome: "confirmed", livelihood_state: finding, confidence: 0.95, evidence_refs: refs, rationale: "Clear." }, "agent:test");
    };
    const row_ = async (id: string) => (await t.call("GET", "/cases")).json.cases.find((c: { id: string }) => c.id === id);
    return { ...t, draft, make, finish, row_ };
  }

  it("a finished feedback case shows its finding as the result and the verdict under it, not job words or 'Awaiting response'", async () => {
    const w = await feedbackWorld();
    const id = await w.make("Asha Test");
    await w.finish(id, "answered");
    expect(await w.row_(id)).toMatchObject({ status: "confirmed", status_label: "Complete", outcome: "Answered", outcome_note: "Answers collected", result: { finding: "answered", verdict: "confirmed" } });
  });

  it("a finished case with no finding shows the mission's word for the verdict: this is the case that used to say 'Awaiting response'", async () => {
    const w = await feedbackWorld();
    const id = await w.make("Ravi Test");
    await w.finish(id, null);
    const r = await w.row_(id);
    expect(r).toMatchObject({ status: "confirmed", status_label: "Complete", outcome: "Answers collected", outcome_note: null });
    expect(JSON.stringify(r)).not.toContain("Awaiting response");
  });

  it("a case still in progress shows plain status and no guessed result", async () => {
    const w = await feedbackWorld();
    const id = await w.make("Neha Test");
    const c = await w.svc.getCase(DEMO_TENANT, id);
    await w.svc.transition(DEMO_TENANT, id, c.version, "waiting", { actor: "t", summary: "Waiting", patch: { attempts: 1 } });
    expect(await w.row_(id)).toMatchObject({ status: "progress", status_label: "Waiting for a reply", outcome: "—", outcome_note: "Not known yet" });
    const fresh = (await w.call("POST", "/participants/import", { rows: [{ ...row, name: "Fresh Test", phone: "9812345678" }], consent_attested: true })).json.created[0].case_id as string;
    expect(await w.row_(fresh)).toMatchObject({ status: "not-started", status_label: "Not started", outcome: "—", outcome_note: null });
  });

  it("the placement mission keeps its job words, and a finding from another mission is refused for it", async () => {
    const t = start();
    const id = (await t.call("POST", "/participants/import", { rows: [row], consent_attested: true })).json.created[0].case_id as string;
    await t.svc.beginSession(DEMO_TENANT, id, "t");
    await t.svc.recordInbound(DEMO_TENANT, id, { provider_event_id: "e", channel: "whatsapp", summary: "x", answers: [{ question_id: "work_status", value: "same_job", confidence: 0.95 }] });
    const refs = (await t.svc.store.listEvidence(id)).map(e => e.evidence_id);
    const v = (await t.svc.getCase(DEMO_TENANT, id)).version;
    await expect(t.svc.proposeDecision(DEMO_TENANT, id, v, { proposed_outcome: "confirmed", livelihood_state: "satisfied", confidence: 0.95, evidence_refs: refs, rationale: "x" }, "agent:test")).rejects.toMatchObject({ code: "UNKNOWN_FINDING" });
    await t.svc.proposeDecision(DEMO_TENANT, id, v, { proposed_outcome: "confirmed", livelihood_state: "same_job", confidence: 0.95, evidence_refs: refs, rationale: "x" }, "agent:test");
    expect((await t.call("GET", "/cases")).json.cases.find((c: { id: string }) => c.id === id)).toMatchObject({ outcome: "Same job", outcome_note: "Confirmed", status_label: "Complete" });
  });

  it("the mission list carries each mission's findings and result words, for labelling the Command centre", async () => {
    const w = await feedbackWorld();
    const ms = (await w.call("GET", "/missions")).json.missions;
    expect(ms[0].outcomes.map((o: { key: string }) => o.key)).toContain("same_job");
    const mine = ms.find((m: { version: string }) => m.version === w.draft.version);
    expect(mine.outcomes.map((o: { key: string }) => o.key)).toEqual(["answered", "unclear"]);
    expect(mine.verdict_labels).toEqual({ confirmed: "Answers collected", not_confirmed: "Not answered", inconclusive: "Unclear" });
  });
});
