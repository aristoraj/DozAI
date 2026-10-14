// The platform layer is data: versioned, the newest one applies, and the agent is told exactly that text. Everything here is made up.
import { describe, it, expect } from "vitest";
import type { MissionInput, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "../cases/service";
import { DocStore, InMemoryDocDriver } from "../storage/docstore";
import { InMemoryStore, type Store } from "../storage/store";
import { BASE_PROMPT, buildAgentContext, PLATFORM_V1, VERIFICATION_EMPLOYEE_V1 } from "./employee";
import { PLACEMENT_RETENTION_V1 } from "../missions/mission";

const T = "t1";
const staff: Principal = { user_id: "ops@x.org", tenant_id: T, role: "agent_ops" };
const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore", () => new DocStore(new InMemoryDocDriver())]];
const rules = (extra = "") => `You work for DozAI. You act only through the tools you are given. Never guess a fact about a person. ${extra}`.trim() + " Keep every action safe to repeat.";

describe.each(stores)("the platform layer: %s", (_n, make) => {
  const world = () => new CaseService(make(), () => new Date("2026-10-14T05:00:00Z"), DEFAULT_POLICY);

  it("starts with the built-in rules, and the newest saved version is the one in force", async () => {
    const svc = world();
    expect((await svc.currentPlatform()).version).toBe(PLATFORM_V1.version);
    await svc.createPlatform(staff, { version: "PL-1.1.0", rules: rules("Be brief."), note: "shorter" });
    await svc.createPlatform(staff, { version: "PL-1.2.0", rules: rules("Be kind.") });
    expect((await svc.listPlatform()).map(p => p.version)).toEqual(["PL-1.0.0", "PL-1.1.0", "PL-1.2.0"]);
    const now = await svc.currentPlatform();
    expect(now).toMatchObject({ version: "PL-1.2.0", created_by: "agent_ops:ops@x.org" });
  });

  it("never changes a saved version, and refuses the built-in name, rules without tools, and rules that are too short", async () => {
    const svc = world();
    await svc.createPlatform(staff, { version: "PL-2.0.0", rules: rules() });
    await expect(svc.createPlatform(staff, { version: "PL-2.0.0", rules: rules("changed") })).rejects.toMatchObject({ code: "PLATFORM_EXISTS" });
    await expect(svc.createPlatform(staff, { version: PLATFORM_V1.version, rules: rules() })).rejects.toMatchObject({ code: "INVALID_PLATFORM" });
    await expect(svc.createPlatform(staff, { version: "PL-3.0.0", rules: "x".repeat(120) })).rejects.toThrow(/only through tools/);
    await expect(svc.createPlatform(staff, { version: "PL-3.0.0", rules: "too short" })).rejects.toMatchObject({ code: "INVALID_PLATFORM" });
    await expect(svc.createPlatform(staff, { version: "bad version!", rules: rules() })).rejects.toMatchObject({ code: "INVALID_PLATFORM" });
  });

  it("the agent is told the platform text that is in force, then the employee, then the mission", async () => {
    const svc = world();
    const p = await svc.createPlatform(staff, { version: "PL-4.0.0", rules: rules("Always answer in the participant's language.") });
    const pack = buildAgentContext(VERIFICATION_EMPLOYEE_V1, PLACEMENT_RETENTION_V1 as never, p);
    expect(pack.platform_version).toBe("PL-4.0.0");
    expect(pack.layers.map(l => l.layer)).toEqual(["platform", "employee", "mission"]);
    expect(pack.layers[0]!.text).toContain("participant's language");
    expect(pack.layers[0]!.text).not.toBe(BASE_PROMPT);
    expect(pack.stable.startsWith(p.rules)).toBe(true);
    // without a saved version the built-in rules are used
    expect(buildAgentContext(VERIFICATION_EMPLOYEE_V1, PLACEMENT_RETENTION_V1 as never).layers[0]!.text).toBe(BASE_PROMPT);
  });
});

describe("a mission can name its employee when it is written", () => {
  it("the brief's employee wins over the start-from mission's, and a version only counts with an employee", async () => {
    const { assembleMission } = await import("../missions/studio");
    const brief = { name: "Feedback check", programme_name: "Project X", goal: "Find out how the experience was for people.", people: "People who used the service.", find_out: "How smooth it was\nWould they recommend us" };
    const draft = { objective: "Find out how it was.", evidence_requirements: [{ key: "smooth", label: "How smooth it was", required: true, question: { id: "smooth", type: "text", text: "How smooth was it?" } }], questions: [], strategy: undefined, agent_guidance: "", start_message: "", closing_message: "" };
    const base = { ...PLACEMENT_RETENTION_V1, employee_id: "verification-employee", employee_version: undefined } as never;
    const m1 = assembleMission({ ...brief, employee_id: "survey-worker" } as never, draft as never, base, { mission_id: "MSN-F", version: "f-v1.0" });
    expect(m1).toMatchObject({ employee_id: "survey-worker" });
    expect(m1.employee_version).toBeUndefined();
    const m2 = assembleMission({ ...brief, employee_id: "survey-worker", employee_version: "SW-1.0.0" } as never, draft as never, base, { mission_id: "MSN-F", version: "f-v1.0" });
    expect(m2).toMatchObject({ employee_id: "survey-worker", employee_version: "SW-1.0.0" });
    const m3 = assembleMission(brief as never, draft as never, base, { mission_id: "MSN-F", version: "f-v1.0" });
    expect(m3).toMatchObject({ employee_id: "verification-employee" });
  });
});
