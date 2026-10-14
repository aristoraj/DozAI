import { describe, it, expect } from "vitest";
import type { EmployeeInput, MissionInput, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, DozaiError } from "../cases/service";
import { DocStore, InMemoryDocDriver } from "../storage/docstore";
import { InMemoryStore, type Store } from "../storage/store";
import { GatewayTools } from "./tools";
import { mintSessionToken, verifySessionToken } from "./token";
import { BASE_PROMPT, buildAgentContext, employeeProblems, parseEmployee, VERIFICATION_EMPLOYEE_V1 } from "./employee";
import { PLACEMENT_RETENTION_V1 } from "../missions/mission";
import { DRAFT_INSTRUMENT } from "../missions/instrument";

const T = "t1";
const staff: Principal = { user_id: "ops@x.org", tenant_id: T, role: "agent_ops" };
const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore", () => new DocStore(new InMemoryDocDriver())]];

const emp = (over: Partial<EmployeeInput> = {}): EmployeeInput => ({
  employee_id: "verification-employee", version: "VE-1.1.0", name: "Meera",
  purpose: "Verify what happened to each participant after a programme.",
  persona: "Warm, respectful and brief. Plain words, short sentences.",
  instructions: "You verify one participant's outcome for one case at a time. Read the case with case_get_context first.",
  allowed_tools: ["case_get_context", "mission_get_bundle", "decision_propose", "review_request"],
  ...over,
});
const mission = (over: Partial<MissionInput> = {}): MissionInput => ({
  mission_id: "MSN-LOAN", version: "MSN-LOAN-v1", name: "Loan check-in", intro_template: "loan_intro_v1",
  templates: [{ key: "loan_intro_v1", language: "en", purpose: "Opens contact", provider_name: "loan_intro_v1" }],
  instrument: { ...DRAFT_INSTRUMENT, draft: false, version: "L1" }, ...over,
});

describe("checking an employee before it is saved", () => {
  it("accepts a complete employee", () => {
    expect(parseEmployee(emp(), "ops", new Date()).problems).toEqual([]);
  });

  it("refuses an employee that could not do its job, with the reason in plain words", () => {
    const bad = (e: Partial<EmployeeInput>) => parseEmployee(emp(e), "ops", new Date()).problems.join(" | ");
    expect(bad({ allowed_tools: ["mission_get_bundle", "decision_propose"] })).toContain("must be allowed case_get_context");
    expect(bad({ allowed_tools: ["case_get_context", "mission_get_bundle"] })).toContain("can never finish a case");
    expect(bad({ allowed_tools: ["case_get_context", "case_get_context", "decision_propose"] })).toContain('tool "case_get_context" is listed twice');
    expect(bad({ version: VERIFICATION_EMPLOYEE_V1.version })).toContain("built-in employee");
    expect(bad({ allowed_tools: [] as never })).toContain("allowed_tools");
    expect(bad({ allowed_tools: ["drop_table" as never] })).toContain("allowed_tools");
    expect(bad({ instructions: "too short" })).toContain("instructions");
    expect(employeeProblems(emp())).toEqual([]);
  });
});

describe.each(stores)("employees in the store: %s", (_n, make) => {
  it("saves a version, lists it after the built-in one, and never lets a version be overwritten", async () => {
    const svc = new CaseService(make());
    const e = await svc.createEmployee(staff, emp());
    expect(e).toMatchObject({ version: "VE-1.1.0", created_by: "agent_ops:ops@x.org" });
    expect((await svc.listEmployees()).map(x => x.version)).toEqual([VERIFICATION_EMPLOYEE_V1.version, "VE-1.1.0"]);
    await expect(svc.createEmployee(staff, emp({ name: "Changed" }))).rejects.toMatchObject({ code: "EMPLOYEE_EXISTS", httpStatus: 409 });
    expect((await svc.getEmployee("VE-1.1.0")).name).toBe("Meera");
    await expect(svc.getEmployee("VE-9.9.9")).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
  });

  it("is shared by every client: another client's service sees the same employee", async () => {
    const store = make();
    await new CaseService(store).createEmployee(staff, emp());
    expect((await new CaseService(store).getEmployee("VE-1.1.0")).version).toBe("VE-1.1.0");
  });

  it("purge-all removes records about people and keeps employees and missions", async () => {
    const store = make();
    const svc = new CaseService(store);
    await svc.createEmployee(staff, emp());
    await store.purgeAll();
    expect((await new CaseService(store).getEmployee("VE-1.1.0")).name).toBe("Meera");
  });
});

describe("a long employee is stored whole, and two people saving one version at once cannot mix", () => {
  it("round-trips an employee far bigger than one row", async () => {
    const store = new DocStore(new InMemoryDocDriver());
    const svc = new CaseService(store);
    const big = emp({ instructions: "Do the job well. ".repeat(350), knowledge: Array.from({ length: 10 }, (_, i) => ({ title: `Topic ${i}`, text: `Detail about topic ${i}. `.repeat(70) })) });
    const saved = await svc.createEmployee(staff, big);
    expect(JSON.stringify(saved).length).toBeGreaterThan(9000 * 2);
    expect(await new CaseService(store).getEmployee(big.version)).toEqual(saved);
  });

  it("exactly one writer wins", async () => {
    const store = new DocStore(new InMemoryDocDriver());
    const results = await Promise.allSettled([new CaseService(store).createEmployee(staff, emp({ name: "From Asha" })), new CaseService(store).createEmployee(staff, emp({ name: "From Ravi" }))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{ name: string }>).value.name;
    expect((await new CaseService(store).getEmployee("VE-1.1.0")).name).toBe(winner);
  });
});

describe("which employee does a mission", () => {
  it("a mission with no choice follows the current version, so an improvement reaches it at once", async () => {
    const svc = new CaseService(new InMemoryStore());
    await svc.createMission(staff, mission());
    expect((await svc.employeeFor(await svc.getMission(T, "MSN-LOAN-v1"))).version).toBe(VERIFICATION_EMPLOYEE_V1.version);
    await svc.createEmployee({ ...staff }, emp({ version: "VE-1.1.0" }));
    expect((await svc.employeeFor(await svc.getMission(T, "MSN-LOAN-v1"))).version).toBe("VE-1.1.0");
    expect((await svc.employeeFor(PLACEMENT_RETENTION_V1)).version).toBe("VE-1.1.0"); // the built-in mission follows it too
  });

  it("a mission that pins a version keeps it when newer ones appear", async () => {
    const svc = new CaseService(new InMemoryStore());
    await svc.createEmployee(staff, emp({ version: "VE-1.1.0" }));
    await svc.createMission(staff, mission({ employee_version: "VE-1.1.0" }));
    await svc.createEmployee(staff, emp({ version: "VE-1.2.0" }));
    expect((await svc.employeeFor(await svc.getMission(T, "MSN-LOAN-v1"))).version).toBe("VE-1.1.0");
  });

  it("refuses a mission that names an employee or version that does not exist, or the wrong employee", async () => {
    const svc = new CaseService(new InMemoryStore());
    const err = (m: Partial<MissionInput>) => svc.createMission(staff, mission(m)).then(() => "saved", (e: DozaiError) => `${e.code}: ${e.message}`);
    expect(await err({ employee_version: "VE-9.9.9" })).toBe("INVALID_MISSION: employee version VE-9.9.9 does not exist");
    expect(await err({ employee_id: "no-such-employee" })).toContain("no employee called no-such-employee");
    await svc.createEmployee(staff, emp({ employee_id: "other-employee", version: "OE-1.0.0" }));
    expect(await err({ employee_id: "verification-employee", employee_version: "OE-1.0.0" })).toContain("belongs to other-employee");
  });
});

describe("what the agent is told", () => {
  it("is assembled in three layers, with the shared part first and nothing about any person", () => {
    const c = buildAgentContext(VERIFICATION_EMPLOYEE_V1, PLACEMENT_RETENTION_V1);
    expect(c.layers.map(l => l.layer)).toEqual(["platform", "employee", "mission"]);
    expect(c.layers[0]!.text).toBe(BASE_PROMPT);
    expect(c.stable).toContain("You are Meera.");
    expect(c.stable).toContain("Things you never do");
    expect(c.stable).toContain("Hand the case to a person when");
    expect(c.stable).not.toContain("Your mission:");
    expect(c.mission).toContain("Objective:");
    expect(c.mission).toContain("employer_name: Employer (required, counts at 60% or more, only if current work status is same_job or changed_job, checked against the programme record)");
    expect(c.mission).toContain("channels in order: WhatsApp, then a phone call");
    expect(c.system).toBe(`${c.stable}\n\n${c.mission}`);
    expect(c.estimated_tokens).toBeGreaterThan(400);
  });

  it("two missions share the identical first part, so it can be cached across them", async () => {
    const svc = new CaseService(new InMemoryStore());
    const a = buildAgentContext(VERIFICATION_EMPLOYEE_V1, PLACEMENT_RETENTION_V1);
    const loan = await svc.createMission(staff, mission({ objective: "Find out whether the borrower paid on time.", agent_guidance: "Short messages only." }));
    const b = buildAgentContext(VERIFICATION_EMPLOYEE_V1, loan);
    expect(b.stable).toBe(a.stable);
    expect(b.mission).not.toBe(a.mission);
    expect(b.mission).toContain("Working notes from the programme team");
    expect(b.mission).toContain("Short messages only.");
  });

  it("a new employee version changes the employee layer and leaves the platform rules alone", () => {
    const e = parseEmployee(emp({ persona: "Calm and unhurried. Never uses jargon, always thanks people for their time." }), "x", new Date()).employee!;
    const c = buildAgentContext(e, PLACEMENT_RETENTION_V1);
    expect(c.stable).toContain("Calm and unhurried");
    expect(c.layers[0]!.text).toBe(BASE_PROMPT);
  });
});

describe("the employee's tools are enforced by the gateway", () => {
  async function world() {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: { participant_id: "p", tenant_id: T, display_name: "Asha Test", phone_masked: "•", location: "J", cohort: "B", language: "en", consent: "unknown", recorded_employer: "Acme" } });
    await svc.beginSession(T, "C-1", "t");
    const c = await svc.getCase(T, "C-1");
    return { tools: new GatewayTools(svc), svc, version: c.version };
  }
  const session = (allowed?: string[]) => ({ session_id: "s", tenant_id: T, case_id: "C-1", mission_version: PLACEMENT_RETENTION_V1.version, employee_version: "VE", allowed_tools: allowed as never });

  it("refuses a tool outside the list and does nothing, even though the case state would allow it", async () => {
    const { tools, svc, version } = await world();
    const send = { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-12345678", expected_version: version };
    const r = await tools.call(session(["case_get_context", "decision_propose", "review_request"]), "whatsapp_send_template", send);
    expect(r.error?.code).toBe("TOOL_NOT_ALLOWED_FOR_EMPLOYEE");
    expect(r.next_allowed_actions).toEqual(["case_get_context", "decision_propose", "review_request"]); // only what it may use now
    expect((await svc.getCase(T, "C-1")).attempts).toBe(0);
    expect((await tools.call(session(), "whatsapp_send_template", send)).error).toBeUndefined(); // no list: no extra limit
  });

  it("the limit travels in the signed session token and cannot be removed by editing it", () => {
    const secret = "s".repeat(32);
    const token = mintSessionToken(secret, session(["case_get_context"]) as never);
    expect(verifySessionToken(secret, token)?.allowed_tools).toEqual(["case_get_context"]);
    const [body, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(body!, "base64url").toString());
    delete forged.allowed_tools;
    expect(verifySessionToken(secret, `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`)).toBeNull();
  });
});
