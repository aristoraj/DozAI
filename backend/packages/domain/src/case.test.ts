import { describe, it, expect } from "vitest";
import { STATUSES, OUTCOMES, newCase, transitionCase, type CaseState, type Status } from "./case";

const at = (status: Status, version = 1): CaseState => ({ status, outcome: null, version });

describe("transitionCase", () => {
  it("walks the happy path and bumps version each step", () => {
    let s = newCase();
    for (const to of ["ready", "running", "waiting", "call_scheduled", "calling", "evaluating"] as Status[]) {
      const r = transitionCase(s, { expectedVersion: s.version, to });
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    const done = transitionCase(s, { expectedVersion: s.version, to: "complete", outcome: "confirmed" });
    expect(done.ok && done.state).toMatchObject({ status: "complete", outcome: "confirmed", version: 8 });
  });

  it("rejects a stale version", () => {
    const r = transitionCase(at("ready", 3), { expectedVersion: 2, to: "running" });
    expect(r).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("rejects illegal jumps", () => {
    expect(transitionCase(at("draft"), { expectedVersion: 1, to: "calling" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("requires an outcome to complete, and forbids one otherwise", () => {
    expect(transitionCase(at("evaluating"), { expectedVersion: 1, to: "complete" })).toMatchObject({ ok: false, code: "OUTCOME_REQUIRED" });
    expect(transitionCase(at("evaluating"), { expectedVersion: 1, to: "review", outcome: "confirmed" })).toMatchObject({ ok: false, code: "OUTCOME_NOT_ALLOWED" });
  });

  it("review is a status, never an outcome", () => {
    expect((OUTCOMES as readonly string[]).includes("review")).toBe(false);
  });

  it("opt-out and cancel can end a case from any non-terminal status", () => {
    for (const status of STATUSES.filter(s => s !== "complete")) {
      for (const outcome of ["opted_out", "cancelled"] as const) {
        expect(transitionCase(at(status), { expectedVersion: 1, to: "complete", outcome }).ok).toBe(true);
      }
    }
  });

  it("other outcomes cannot skip the workflow", () => {
    expect(transitionCase(at("waiting"), { expectedVersion: 1, to: "complete", outcome: "confirmed" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("complete is terminal", () => {
    const done: CaseState = { status: "complete", outcome: "confirmed", version: 5 };
    expect(transitionCase(done, { expectedVersion: 5, to: "review" })).toMatchObject({ ok: false, code: "TERMINAL" });
  });
});
