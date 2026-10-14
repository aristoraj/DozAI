import { describe, it, expect } from "vitest";
import { CaseService, GatewayTools, InMemoryStore, seedDemo, DEMO_TENANT, verifyChain, type ToolSession } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { FakeChannels, ScriptedAgentRuntime } from "./index";

const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

async function setup(policy = OPEN) {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), policy);
  const tools = new GatewayTools(svc);
  const agent = new ScriptedAgentRuntime(tools, new FakeChannels());
  const mk = async (id: string, consent: Participant["consent"] = "unknown") => {
    const participant: Participant = { participant_id: `p_${id}`, tenant_id: DEMO_TENANT, display_name: "Test Person", phone_masked: "•••• 0000", location: "Jaipur", cohort: "Test", language: "en", consent, recorded_employer: "Acme Retail" };
    return svc.createCase({ tenant_id: DEMO_TENANT, run_id: "run_test", case_id: id, participant });
  };
  return { store, svc, tools, agent, mk };
}

describe("walking skeleton: case reaches a proposed decision through MCP tools only", () => {
  it("same job: auto-completes with a valid ledger", async () => {
    const { svc, agent, mk, store } = await setup();
    await mk("T-1");
    const s = await agent.runCase(svc, DEMO_TENANT, "T-1", "same_job");
    const c = await svc.getCase(DEMO_TENANT, "T-1");
    expect(c).toMatchObject({ status: "complete", outcome: "confirmed", livelihood_state: "same_job" });
    expect(s.trace.filter(t => t.tool).map(t => t.tool)).toEqual(["case_get_context", "mission_get_bundle", "whatsapp_send_template", "case_get_context", "decision_propose"]);
    expect(verifyChain(await store.listEvents(DEMO_TENANT, "T-1")).ok).toBe(true);
  });

  it("employer conflict: policy sends it to review and opens a task", async () => {
    const { svc, agent, mk, store } = await setup();
    await mk("T-2");
    await agent.runCase(svc, DEMO_TENANT, "T-2", "employer_conflict");
    const c = await svc.getCase(DEMO_TENANT, "T-2");
    expect(c.status).toBe("review");
    expect(c.outcome).toBeNull();
    expect(c.reason).toContain("differs");
    expect((await store.listReviewTasks(DEMO_TENANT)).filter(t => t.case_id === "T-2" && t.status === "open")).toHaveLength(1);
  });

  it("low confidence goes to review, and a reviewer can then confirm", async () => {
    const { svc, agent, mk } = await setup();
    await mk("T-3");
    await agent.runCase(svc, DEMO_TENANT, "T-3", "changed_job");
    let c = await svc.getCase(DEMO_TENANT, "T-3");
    expect(c.status).toBe("review");
    c = await svc.reviewDecide({ user_id: "u1", tenant_id: DEMO_TENANT, role: "reviewer" }, "T-3", { decision: "confirm", note: "Verified employer", expected_version: c.version });
    expect(c).toMatchObject({ status: "complete", outcome: "confirmed" });
  });

  it("opt-out completes immediately and stops queued messages", async () => {
    const { svc, agent, mk, store } = await setup();
    await mk("T-4");
    await agent.runCase(svc, DEMO_TENANT, "T-4", "opt_out");
    expect(await svc.getCase(DEMO_TENANT, "T-4")).toMatchObject({ status: "complete", outcome: "opted_out" });
    expect((await store.getParticipant(DEMO_TENANT, "p_T-4"))?.consent).toBe("declined");
  });

  it("no response leaves the case waiting", async () => {
    const { svc, agent, mk } = await setup();
    await mk("T-5");
    await agent.runCase(svc, DEMO_TENANT, "T-5", "no_response");
    expect((await svc.getCase(DEMO_TENANT, "T-5")).status).toBe("waiting");
  });
});

describe("gateway guardrails", () => {
  const sess = (case_id: string): ToolSession => ({ session_id: "sesn_test", tenant_id: DEMO_TENANT, case_id, mission_version: "MSN-001-v1.3", employee_version: "1.0.0" });

  it("refuses another case, stale versions, unapproved templates and replays idempotently", async () => {
    const { svc, tools, mk } = await setup();
    await mk("T-6");
    await svc.beginSession(DEMO_TENANT, "T-6", "test");
    const c = await svc.getCase(DEMO_TENANT, "T-6");

    expect((await tools.call(sess("T-6"), "case_get_context", { case_id: "T-OTHER" })).error?.code).toBe("CASE_NOT_IN_SESSION");
    expect((await tools.call(sess("T-6"), "whatsapp_send_template", { case_id: "T-6", template_key: "placement_intro_v1", idempotency_key: "k-12345678", expected_version: c.version + 5 })).error?.code).toBe("VERSION_CONFLICT");
    expect((await tools.call(sess("T-6"), "whatsapp_send_template", { case_id: "T-6", template_key: "made_up_template", idempotency_key: "k-22345678", expected_version: c.version })).error?.code).toBe("TEMPLATE_NOT_APPROVED");

    const first = await tools.call(sess("T-6"), "whatsapp_send_template", { case_id: "T-6", template_key: "placement_intro_v1", idempotency_key: "k-32345678", expected_version: c.version });
    const replay = await tools.call(sess("T-6"), "whatsapp_send_template", { case_id: "T-6", template_key: "placement_intro_v1", idempotency_key: "k-32345678", expected_version: c.version });
    expect(first.error).toBeUndefined();
    expect(replay.operation_id).toBe(first.operation_id);
    expect((await svc.getCase(DEMO_TENANT, "T-6")).attempts).toBe(1);
  });

  it("never exposes name or phone to the agent", async () => {
    const { svc, tools, mk } = await setup();
    await mk("T-7");
    const r = await tools.call(sess("T-7"), "case_get_context", { case_id: "T-7" });
    const text = JSON.stringify(r);
    expect(text).not.toContain("Test Person");
    expect(text).not.toContain("0000");
    void svc;
  });

  it("blocks contact outside the approved window", async () => {
    const { svc, tools, mk } = await setup({ ...DEFAULT_POLICY, windowStartHour: 3, windowEndHour: 3.01 });
    await mk("T-8");
    await svc.beginSession(DEMO_TENANT, "T-8", "test");
    const c = await svc.getCase(DEMO_TENANT, "T-8");
    const r = await tools.call(sess("T-8"), "whatsapp_send_template", { case_id: "T-8", template_key: "placement_intro_v1", idempotency_key: "k-42345678", expected_version: c.version });
    expect(r.error?.code).toBe("OUTSIDE_WINDOW");
  });

  it("an agent cannot propose an opt-out or complete a case directly", async () => {
    const { svc, tools, mk } = await setup();
    await mk("T-9", "granted");
    await svc.beginSession(DEMO_TENANT, "T-9", "test");
    const c = await svc.getCase(DEMO_TENANT, "T-9");
    const r = await tools.call(sess("T-9"), "decision_propose", { case_id: "T-9", idempotency_key: "k-52345678", expected_version: c.version, proposed_outcome: "opted_out", livelihood_state: null, confidence: 1, evidence_refs: [], rationale: "x" });
    expect(r.error?.code).toBe("OUTCOME_NOT_PROPOSABLE");
  });
});

describe("ledger", () => {
  it("detects tampering", async () => {
    const { store, svc, mk } = await setup();
    await mk("T-10");
    await svc.markReady(DEMO_TENANT, "T-10", "test");
    const evs = await store.listEvents(DEMO_TENANT, "T-10");
    expect(verifyChain(evs).ok).toBe(true);
    evs[0]!.summary = "tampered";
    expect(verifyChain(evs)).toMatchObject({ ok: false });
  });

  it("demo seed produces 12 cases with valid chains", async () => {
    const store = new InMemoryStore();
    expect((await seedDemo(store)).cases).toBe(12);
    const svc = new CaseService(store);
    const v = await svc.verifyLedger(DEMO_TENANT);
    expect(v.ok).toBe(true);
  });
});
