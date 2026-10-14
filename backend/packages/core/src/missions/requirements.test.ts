import { describe, it, expect } from "vitest";
import type { Evidence, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { evaluateRequirements } from "./requirements";
import { PLACEMENT_RETENTION_V1, requirementProblems } from "./mission";
import { CaseService } from "../cases/service";
import { InMemoryStore } from "../storage/store";
import { GatewayTools } from "../agent/tools";
import { ConversationRunner } from "../conversation/conversation";
import { RuleClassifier } from "../conversation/classifier";

const M = PLACEMENT_RETENTION_V1;
let n = 0;
const ev = (key: string, value: string, confidence = 0.9, at?: string): Evidence => ({ evidence_id: `ev_${++n}`, case_id: "C", question_id: key, value, source: "whatsapp", confidence, event_id: "e", at });
const by = (r: ReturnType<typeof evaluateRequirements>, key: string) => r.items.find(i => i.key === key)!;

describe("what a mission still needs to know", () => {
  it("with nothing collected, only the unconditional needs are open and the rest wait for an earlier answer", () => {
    const r = evaluateRequirements(M, []);
    expect(r.gaps).toEqual(["work_status"]);
    expect(by(r, "work_status")).toMatchObject({ applicable: true, state: "missing" });
    expect(by(r, "employer_name")).toMatchObject({ applicable: false, state: "not_needed_yet", note: "Depends on an earlier answer." });
    expect(r.complete).toBe(false);
  });

  it("the answer to one question decides which other needs apply", () => {
    const working = evaluateRequirements(M, [ev("work_status", "same_job")]);
    expect(working.gaps).toEqual(["employer_name", "role_title"]);
    expect(by(working, "course").applicable).toBe(false);
    expect(by(working, "course").note).toBe("Not needed for this person's situation.");

    const studying = evaluateRequirements(M, [ev("work_status", "education_training")]);
    expect(studying.gaps).toEqual(["course"]);
    expect(by(studying, "employer_name").applicable).toBe(false);

    const idle = evaluateRequirements(M, [ev("work_status", "not_employed")]);
    expect(idle.gaps).toEqual(["not_working_reason"]);
    expect(by(idle, "job_search")).toMatchObject({ applicable: true, required: false, state: "missing" }); // optional: not a gap
  });

  it("an answer that is not clear enough does not count", () => {
    const r = evaluateRequirements(M, [ev("work_status", "same_job"), ev("employer_name", "Acme", 0.4)]);
    expect(by(r, "employer_name")).toMatchObject({ state: "missing", confidence: 0.4 });
    expect(by(r, "employer_name").note).toContain("not clear enough");
    expect(r.gaps).toContain("employer_name");
  });

  it("the same employer as on file is verified, a different one is a conflict, and no record means only 'stated'", () => {
    const base = [ev("work_status", "same_job"), ev("role_title", "Packer")];
    expect(by(evaluateRequirements(M, [...base, ev("employer_name", "  acme   retail ")], "Acme Retail"), "employer_name").state).toBe("verified");
    const c = evaluateRequirements(M, [...base, ev("employer_name", "Nova Services")], "Acme Retail");
    expect(by(c, "employer_name").state).toBe("conflict");
    expect(c.conflicts).toBe(1);
    expect(c.complete).toBe(false);
    for (const none of [undefined, "—", ""]) {
      const r = evaluateRequirements(M, [...base, ev("employer_name", "Acme")], none);
      expect(by(r, "employer_name")).toMatchObject({ state: "stated", note: "The programme record has no employer to check against." });
    }
  });

  it("a new employer is not checked against the old one", () => {
    const r = evaluateRequirements(M, [ev("work_status", "changed_job"), ev("employer_name", "Nova Services"), ev("role_title", "Driver")], "Acme Retail");
    expect(by(r, "employer_name").state).toBe("stated");
    expect(r.conflicts).toBe(0);
    expect(r.complete).toBe(true);
  });

  it("is complete when everything required that applies has an answer and nothing conflicts", () => {
    const r = evaluateRequirements(M, [ev("work_status", "same_job"), ev("employer_name", "Acme", 0.9), ev("role_title", "Packer")], "Acme");
    expect(r).toMatchObject({ complete: true, needed: 3, collected: 3, verified: 1, gaps: [] });
    // Nothing known yet is never "complete".
    expect(evaluateRequirements(M, []).complete).toBe(false);
    // A mission with no list of needs is never "complete" either: there is nothing to measure against.
    expect(evaluateRequirements({ evidence_requirements: undefined }, [ev("work_status", "same_job")]).complete).toBe(false);
  });

  it("a later answer replaces an earlier one, by time when there is one and by order when there is not", () => {
    const timed = evaluateRequirements(M, [ev("work_status", "same_job"), ev("employer_name", "Acme", 0.9, "2026-10-12T10:00:00Z"), ev("employer_name", "Acme Retail Pvt", 0.9, "2026-10-12T11:00:00Z")], "Acme Retail Pvt");
    expect(by(timed, "employer_name").state).toBe("verified");
    const reversedInList = evaluateRequirements(M, [ev("work_status", "same_job"), ev("employer_name", "Acme Retail Pvt", 0.9, "2026-10-12T11:00:00Z"), ev("employer_name", "Acme", 0.9, "2026-10-12T10:00:00Z")], "Acme Retail Pvt");
    expect(by(reversedInList, "employer_name").state).toBe("verified");
    const untimed = evaluateRequirements(M, [ev("work_status", "same_job"), ev("employer_name", "Wrong"), ev("employer_name", "Acme")], "Acme");
    expect(by(untimed, "employer_name").state).toBe("verified");
  });

  it("returns references to the evidence, never its content", () => {
    const e = ev("work_status", "same_job");
    const r = evaluateRequirements(M, [e]);
    expect(by(r, "work_status").evidence_ref).toBe(e.evidence_id);
    expect(JSON.stringify(r)).not.toContain("same_job");
  });
});

describe("checking a mission's list of needs", () => {
  const i = M.instrument;
  const req = (over: object) => ({ key: "work_status", label: "Work status", required: true, min_confidence: 0.6, ...over }) as never;

  it("the built-in mission is consistent with its own questions", () => {
    expect(requirementProblems(M.evidence_requirements!, i)).toEqual([]);
  });

  it("explains each mistake", () => {
    const bad = (reqs: unknown[]) => requirementProblems(reqs as never, i).join(" | ");
    expect(bad([req({ key: "favourite_colour" })])).toContain('"favourite_colour" has no question that can fill it');
    expect(bad([req({}), req({})])).toContain('"work_status" is listed twice');
    expect(bad([req({ key: "employer_name", when: { key: "nope", in: ["x"] } })])).toContain('waits for "nope", which is not an evidence need');
    expect(bad([req({ when: { key: "work_status", in: ["x"] } })])).toContain("cannot depend on itself");
    expect(bad([req({}), req({ key: "employer_name", when: { key: "work_status", in: ["retired"] } })])).toContain('"retired", which "work_status" can never have');
    expect(bad([req({ key: "support_requested", required: false, verify_against: "programme_employer" })])).toContain("only required needs can be checked");
  });
});

describe("the agent sees what is still missing", () => {
  const admin: Principal = { user_id: "a", tenant_id: "t1", role: "admin" };
  it("case_get_context carries the evidence-needed report, with references and no answer text", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createCase({ tenant_id: "t1", run_id: "r", case_id: "C-1", participant: { participant_id: "p", tenant_id: "t1", display_name: "Asha Test", phone_masked: "•", location: "J", cohort: "B", language: "en", consent: "unknown", recorded_employer: "Acme" }, mission_version: M.version });
    await svc.beginSession("t1", "C-1", "t");
    const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true });
    await runner.handleReply("t1", "C-1", "yes");
    await runner.handleReply("t1", "C-1", "1"); // same place as before
    const tools = new GatewayTools(svc);
    const s = { session_id: "s", tenant_id: "t1", case_id: "C-1", mission_version: M.version, employee_version: "1" };
    const ctx = (await tools.call(s, "case_get_context", { case_id: "C-1" })).data as { requirements: { gaps: string[]; collected: number; items: { key: string; state: string }[] } };
    expect(ctx.requirements.gaps).toEqual(["employer_name", "role_title"]);
    expect(ctx.requirements.items.find(i => i.key === "work_status")?.state).toBe("stated");
    expect(JSON.stringify(ctx.requirements)).not.toContain("same_job");
    const bundle = (await tools.call(s, "mission_get_bundle", { mission_version_id: M.version })).data as { objective: string; evidence_requirements: unknown[]; strategy: { channels: string[] } };
    expect(bundle.objective).toContain("still works");
    expect(bundle.evidence_requirements).toHaveLength(8);
    expect(bundle.strategy.channels).toEqual(["whatsapp", "voice"]);
    void admin;
  });
});
