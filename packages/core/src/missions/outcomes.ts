// What a case shows as its STATUS and its RESULT.
//
// Status says where the case is in the process: not started, waiting for a reply, on a call, being checked, needs a person, complete.
// Result says what was found out, in the words of the mission: "Same job" for a placement check, "Satisfied" for a feedback mission.
// Before this, one column mixed the two and used job words for every mission, so a finished feedback case read "Awaiting response".
import type { CaseRecord, Outcome } from "@dozai/contracts";

interface MissionWords { outcomes?: { key: string; label: string }[]; verdict_labels?: { confirmed?: string; not_confirmed?: string; inconclusive?: string } }

const GENERAL: Record<string, string> = { confirmed: "Confirmed", not_confirmed: "Not confirmed", inconclusive: "Inconclusive", opted_out: "Opted out", cancelled: "Cancelled" };

/** "same_job" -> "Same job", for a finding the mission did not label. */
export const humanize = (key: string): string => key.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

/** What "confirmed", "not confirmed" and "inconclusive" mean for this mission, or the plain word. */
export function verdictLabel(m: MissionWords | undefined, o: Outcome | null | undefined): string | null {
  if (!o) return null;
  if (o === "confirmed" || o === "not_confirmed" || o === "inconclusive") return m?.verdict_labels?.[o] ?? GENERAL[o]!;
  return GENERAL[o] ?? null;
}

/** The mission's label for a finding, or the finding made readable. */
export const findingLabel = (m: MissionWords | undefined, key: string): string => m?.outcomes?.find(o => o.key === key)?.label ?? humanize(key);

export interface CaseResult {
  /** The main text of the Result column. "—" when nothing is known yet. */
  label: string;
  /** A small line under it: the verdict for a finished case, or why nothing is shown yet. */
  note: string | null;
  finding: string | null;
  verdict: Outcome | null;
}

/** What was found out about this person, in the mission's words. Never says "awaiting" about a case that is finished. */
export function resultFor(m: MissionWords | undefined, c: Pick<CaseRecord, "status" | "outcome" | "livelihood_state" | "attempts">): CaseResult {
  const verdict = c.outcome, finding = c.livelihood_state;
  if (verdict === "opted_out") return { label: "Opted out", note: "Asked not to be contacted", finding: null, verdict };
  if (verdict === "cancelled") return { label: "Cancelled", note: null, finding: null, verdict };
  const done = c.status === "complete";
  if (finding) return { label: findingLabel(m, finding), note: done ? verdictLabel(m, verdict) : c.status === "review" ? "Needs a person to confirm" : "Reading so far", finding, verdict };
  if (done) return { label: verdictLabel(m, verdict) ?? "Complete", note: null, finding: null, verdict };
  if (c.status === "review") return { label: "—", note: "Needs a person to decide", finding: null, verdict };
  if (c.status === "draft" || c.status === "ready") return { label: "—", note: null, finding: null, verdict };
  return { label: "—", note: "Not known yet", finding: null, verdict };
}

/** Where the case is in the process, in plain words. */
export function statusLabel(c: Pick<CaseRecord, "status" | "outcome">, hasEvidence: boolean): string {
  switch (c.status) {
    case "draft": case "ready": return "Not started";
    case "running": return "Starting";
    case "waiting": return hasEvidence ? "In conversation" : "Waiting for a reply";
    case "call_scheduled": return "Call scheduled";
    case "calling": return "On a call";
    case "evaluating": return "Checking the answers";
    case "review": return "Needs a person";
    case "complete": return c.outcome === "opted_out" ? "Opted out" : c.outcome === "cancelled" ? "Cancelled" : "Complete";
  }
}
