// Status is where a case is in the process. Result is what was found out, in the words of the mission. Every case here is made up.
import { describe, it, expect } from "vitest";
import type { Participant, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, DozaiError } from "./service";
import { InMemoryStore } from "./store";
import { buildAgentContext } from "./employee";
import { VERIFICATION_EMPLOYEE_V1 } from "./employee";
import { draftMission, ScriptedMissionDrafter } from "./studio";
import { findingProblem, missionProblems, PLACEMENT_RETENTION_V1 } from "./mission";
import { humanize, resultFor, statusLabel, verdictLabel } from "./outcomes";

const T = "t1";
const admin: Principal = { user_id: "u", tenant_id: T, role: "admin" };
const feedback = {
  outcomes: [{ key: "satisfied", label: "Satisfied" }, { key: "mixed", label: "Mixed feelings" }, { key: "unhappy", label: "Unhappy" }],
  verdict_labels: { confirmed: "Feedback collected", not_confirmed: "No feedback", inconclusive: "Unclear" },
};
const c = (over: Record<string, unknown> = {}) => ({ status: "waiting" as const, outcome: null, livelihood_state: null, attempts: 1, ...over }) as never;

describe("the result of a case, in the mission's own words", () => {
  it("a finished feedback case with no job finding says what it is, not 'Awaiting response'", () => {
    // this is the case in the cases list that read CONFIRMED and "Awaiting response"
    expect(resultFor(undefined, c({ status: "complete", outcome: "confirmed" }))).toMatchObject({ label: "Confirmed", note: null });
    expect(resultFor(feedback, c({ status: "complete", outcome: "confirmed" }))).toMatchObject({ label: "Feedback collected", note: null });
  });

  it("uses the mission's finding as the result, and the verdict as the small note once it is finished", () => {
    expect(resultFor(feedback, c({ status: "complete", outcome: "confirmed", livelihood_state: "satisfied" }))).toEqual({ label: "Satisfied", note: "Feedback collected", finding: "satisfied", verdict: "confirmed" });
    expect(resultFor(feedback, c({ status: "complete", outcome: "inconclusive", livelihood_state: "mixed" }))).toMatchObject({ label: "Mixed feelings", note: "Unclear" });
  });

  it("the placement mission keeps its job words, and a finding the mission did not label is made readable", () => {
    expect(resultFor(PLACEMENT_RETENTION_V1, c({ status: "complete", outcome: "confirmed", livelihood_state: "same_job" })).label).toBe("Same job");
    expect(resultFor(PLACEMENT_RETENTION_V1, c({ status: "complete", outcome: "not_confirmed", livelihood_state: "not_employed" })).label).toBe("Currently unemployed");
    expect(resultFor(undefined, c({ status: "review", livelihood_state: "same_job" }))).toMatchObject({ label: "Same job", note: "Needs a person to confirm" });
    expect(humanize("looking_for_work")).toBe("Looking for work");
  });

  it("says nothing is known yet while a case is in progress, instead of guessing", () => {
    expect(resultFor(feedback, c())).toEqual({ label: "—", note: "Not known yet", finding: null, verdict: null });
    expect(resultFor(feedback, c({ status: "draft", attempts: 0 }))).toEqual({ label: "—", note: null, finding: null, verdict: null });
    expect(resultFor(feedback, c({ status: "review" }))).toMatchObject({ label: "—", note: "Needs a person to decide" });
  });

  it("an opt-out or a cancellation is its own result", () => {
    expect(resultFor(feedback, c({ status: "complete", outcome: "opted_out" }))).toMatchObject({ label: "Opted out" });
    expect(resultFor(feedback, c({ status: "complete", outcome: "cancelled" }))).toMatchObject({ label: "Cancelled" });
  });

  it("the three general results use the mission's words, or the plain ones", () => {
    expect(verdictLabel(feedback, "confirmed")).toBe("Feedback collected");
    expect(verdictLabel({ verdict_labels: { confirmed: "Retained" } }, "not_confirmed")).toBe("Not confirmed");
    expect(verdictLabel(undefined, "inconclusive")).toBe("Inconclusive");
    expect(verdictLabel(undefined, null)).toBeNull();
  });
});

describe("the status of a case, in plain words", () => {
  const label = (status: string, hasEvidence = false, outcome: string | null = null) => statusLabel({ status, outcome } as never, hasEvidence);
  it("says where the case is in the process", () => {
    expect(label("draft")).toBe("Not started");
    expect(label("ready")).toBe("Not started");
    expect(label("waiting")).toBe("Waiting for a reply");
    expect(label("waiting", true)).toBe("In conversation");
    expect(label("call_scheduled")).toBe("Call scheduled");
    expect(label("calling")).toBe("On a call");
    expect(label("evaluating")).toBe("Checking the answers");
    expect(label("review")).toBe("Needs a person");
    expect(label("complete", true, "confirmed")).toBe("Complete");
    expect(label("complete", true, "opted_out")).toBe("Opted out");
  });
});

describe("the agent must pick one of the mission's own findings", () => {
  it("accepts a listed finding or none, and rejects anything else with the allowed ones named", () => {
    expect(findingProblem(feedback, "satisfied")).toBeNull();
    expect(findingProblem(feedback, null)).toBeNull();
    expect(findingProblem(feedback, "same_job")).toContain("Use one of: satisfied, mixed, unhappy");
    expect(findingProblem({}, "same_job")).toBeNull();                       // a mission with no list uses the original placement findings
    expect(findingProblem({}, "satisfied")).toContain("same_job");
  });

  async function world(findings: typeof feedback | undefined) {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    const def = (await draftMission(new ScriptedMissionDrafter(), { name: "Feedback check", programme_name: "Project X", goal: "Find out how the experience was for people.", people: "People who used the service.", find_out: "How smooth it was\nWhether they would recommend it" }, PLACEMENT_RETENTION_V1, [])).definition!;
    const { outcomes: _o, verdict_labels: _v, ...bare } = def;
    const mission = await svc.createMission(admin, findings ? { ...bare, ...findings } : bare);
    const p: Participant = { participant_id: "p1", tenant_id: T, display_name: "Test Person", phone_masked: "•••• 0000", location: "J", cohort: "C", language: "en", consent: "granted", recorded_employer: "Acme" };
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "C-1", participant: p, mission_version: mission.version });
    await svc.beginSession(T, "C-1", "t");
    const key = def.evidence_requirements![0]!.key;
    await svc.recordInbound(T, "C-1", { provider_event_id: "e1", channel: "whatsapp", summary: "answered", answers: [{ question_id: key, value: "smooth", confidence: 0.95 }] });
    const refs = (await svc.store.listEvidence("C-1")).map(e => e.evidence_id);
    const propose = (finding: string | null) => svc.proposeDecision(T, "C-1", 0, { proposed_outcome: "confirmed", livelihood_state: finding, confidence: 0.95, evidence_refs: refs, rationale: "Clear." }, "agent:test");
    return { svc, mission, propose, version: async () => (await svc.getCase(T, "C-1")).version, refs };
  }

  it("a feedback mission cannot end with a job finding, and the rejection tells the agent what is allowed", async () => {
    const w = await world(feedback);
    const v = await w.version();
    await expect(w.svc.proposeDecision(T, "C-1", v, { proposed_outcome: "confirmed", livelihood_state: "same_job", confidence: 0.95, evidence_refs: w.refs, rationale: "x" }, "agent:test")).rejects.toMatchObject({ code: "UNKNOWN_FINDING", message: expect.stringContaining("satisfied, mixed, unhappy") });
    const ok = await w.svc.proposeDecision(T, "C-1", v, { proposed_outcome: "confirmed", livelihood_state: "satisfied", confidence: 0.95, evidence_refs: w.refs, rationale: "Clear." }, "agent:test");
    expect(ok.case).toMatchObject({ status: "complete", outcome: "confirmed", livelihood_state: "satisfied" });
  });

  it("a mission with no findings of its own still accepts the original ones, and an empty finding", async () => {
    const w = await world(undefined);
    const v = await w.version();
    await expect(w.svc.proposeDecision(T, "C-1", v, { proposed_outcome: "confirmed", livelihood_state: "totally_made_up", confidence: 0.95, evidence_refs: w.refs, rationale: "x" }, "agent:test")).rejects.toBeInstanceOf(DozaiError);
    const ok = await w.svc.proposeDecision(T, "C-1", v, { proposed_outcome: "confirmed", livelihood_state: null, confidence: 0.95, evidence_refs: w.refs, rationale: "x" }, "agent:test");
    expect(ok.case.status).toBe("complete");
  });

  it("a mission that lists the same finding twice is refused when it is saved", async () => {
    const def = (await draftMission(new ScriptedMissionDrafter(), { name: "Feedback check", programme_name: "Project X", goal: "Find out how the experience was for people.", people: "People who used the service.", find_out: "How smooth it was\nWhether they would recommend it" }, PLACEMENT_RETENTION_V1, [])).definition!;
    expect(missionProblems({ ...def, outcomes: [{ key: "a", label: "A" }, { key: "a", label: "A again" }] })).toContain('finding "a" is listed twice');
  });
});

describe("what the agent is told", () => {
  it("lists the mission's findings and what the general results mean, and says to use exactly one", () => {
    const m = { ...PLACEMENT_RETENTION_V1, ...feedback };
    const text = buildAgentContext(VERIFICATION_EMPLOYEE_V1, m as never).mission;
    expect(text).toContain("What you can conclude about a person");
    expect(text).toContain("- satisfied: Satisfied");
    expect(text).toContain("- unhappy: Unhappy");
    expect(text).toContain('"confirmed" means Feedback collected');
    expect(text).toContain("exactly one of these keys");
  });
  it("the placement mission lists its job findings", () => {
    const text = buildAgentContext(VERIFICATION_EMPLOYEE_V1, PLACEMENT_RETENTION_V1).mission;
    expect(text).toContain("- same_job: Same job");
    expect(text).toContain("- unreachable_unclear: Unclear");
  });
});
