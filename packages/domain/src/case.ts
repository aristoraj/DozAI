// Case state machine. Pure: no I/O, no clock, no storage.
// Workflow status and business outcome are separate (Core Team Walkthrough, slide 11).

import { STATUSES, OUTCOMES, type Status, type Outcome } from "@dozai/contracts";
export { STATUSES, OUTCOMES };
export type { Status, Outcome };

export interface CaseState {
  status: Status;
  outcome: Outcome | null;
  version: number;
}

// Forward moves allowed from each status. "complete" is terminal.
const FORWARD: Record<Status, readonly Status[]> = {
  draft: ["ready"],
  ready: ["running"],
  running: ["waiting", "evaluating", "call_scheduled"], // call_scheduled: a call as the first contact (the person is not on WhatsApp)
  waiting: ["running", "call_scheduled", "evaluating", "waiting"], // waiting->waiting: a follow-up attempt
  call_scheduled: ["calling", "waiting"],
  calling: ["evaluating", "waiting"],
  evaluating: ["waiting", "review", "complete"],
  review: ["waiting", "complete"],
  complete: [],
};

export type TransitionResult =
  | { ok: true; state: CaseState }
  | { ok: false; code: "VERSION_CONFLICT" | "ILLEGAL_TRANSITION" | "OUTCOME_REQUIRED" | "OUTCOME_NOT_ALLOWED" | "TERMINAL"; message: string };

export interface TransitionInput {
  expectedVersion: number;
  to: Status;
  outcome?: Outcome;
}

/**
 * Every status change goes through here. Callers persist the returned state
 * and write the ledger event; this function decides only whether the move is legal.
 */
export function transitionCase(current: CaseState, input: TransitionInput): TransitionResult {
  if (input.expectedVersion !== current.version) {
    return { ok: false, code: "VERSION_CONFLICT", message: `expected v${input.expectedVersion}, case is v${current.version}` };
  }
  if (current.status === "complete") {
    return { ok: false, code: "TERMINAL", message: "case is complete" };
  }
  const allowed = FORWARD[current.status].includes(input.to);
  // Opt-out and cancellation may end a case from any non-terminal status.
  const isStop = input.to === "complete" && (input.outcome === "opted_out" || input.outcome === "cancelled");
  if (!allowed && !isStop) {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: `${current.status} -> ${input.to}` };
  }
  if (input.to === "complete" && !input.outcome) {
    return { ok: false, code: "OUTCOME_REQUIRED", message: "complete needs a final outcome" };
  }
  if (input.to !== "complete" && input.outcome) {
    return { ok: false, code: "OUTCOME_NOT_ALLOWED", message: "outcome is set only on complete" };
  }
  return {
    ok: true,
    state: { status: input.to, outcome: input.outcome ?? null, version: current.version + 1 },
  };
}

export const newCase = (): CaseState => ({ status: "draft", outcome: null, version: 1 });
