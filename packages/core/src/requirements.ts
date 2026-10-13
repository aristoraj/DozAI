// What do we still need to know about this person? A mission lists the evidence it needs; this compares that list with
// what has been collected so far. The agent uses the gaps to decide what to ask next, and people see the same list.
//
// The states are deliberately modest. "stated" means the participant said it. "verified" is kept for answers that were
// checked against something else (today: the employer on the programme record). Nothing here decides an outcome.
import type { Evidence, Requirement } from "@dozai/contracts";
import type { MissionBundle } from "./mission";

export type RequirementState = "not_needed_yet" | "missing" | "stated" | "verified" | "conflict";

export interface RequirementStatus {
  key: string;
  label: string;
  required: boolean;
  /** False while the answer it depends on is not known yet, or when that answer says it is not needed. */
  applicable: boolean;
  state: RequirementState;
  confidence: number | null;
  /** Reference to the evidence row, never its content. */
  evidence_ref: string | null;
  note: string | null;
}

export interface RequirementsReport {
  items: RequirementStatus[];
  /** Applicable, required needs. */
  needed: number;
  /** Of those, how many have a usable answer. */
  collected: number;
  verified: number;
  conflicts: number;
  /** Keys still missing, in mission order. */
  gaps: string[];
  /** Every applicable required need has a usable answer and nothing conflicts. */
  complete: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const blank = (s: string | undefined) => !s || s === "—" || s.trim() === "";

/** The latest answer for each key. A later answer replaces an earlier one; rows without a time keep their order. */
function latestByKey(evidence: Evidence[]): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  evidence.forEach(e => {
    const cur = out.get(e.question_id);
    if (!cur) { out.set(e.question_id, e); return; }
    // Both timed: compare. Only the new one timed: it is newer. Only the old one timed: keep it. Neither: list order, last wins.
    const later = e.at && cur.at ? e.at >= cur.at : !(cur.at && !e.at);
    if (later) out.set(e.question_id, e);
  });
  return out;
}

export function evaluateRequirements(mission: Pick<MissionBundle, "evidence_requirements">, evidence: Evidence[], programmeEmployer?: string): RequirementsReport {
  const reqs: Requirement[] = mission.evidence_requirements ?? [];
  const latest = latestByKey(evidence);
  const holds = (c: Requirement["when"]) => { const v = c && latest.get(c.key)?.value; return !!c && v !== undefined && c.in.includes(v); };
  const known = (c: Requirement["when"]) => !!c && latest.has(c.key);

  const items: RequirementStatus[] = reqs.map(r => {
    const base = { key: r.key, label: r.label, required: r.required ?? true };
    if (r.when && !holds(r.when)) {
      return { ...base, applicable: false, state: "not_needed_yet", confidence: null, evidence_ref: null, note: known(r.when) ? "Not needed for this person's situation." : "Depends on an earlier answer." };
    }
    const e = latest.get(r.key);
    if (!e) return { ...base, applicable: true, state: "missing", confidence: null, evidence_ref: null, note: null };
    const min = r.min_confidence ?? 0.6;
    if (e.confidence < min) return { ...base, applicable: true, state: "missing", confidence: e.confidence, evidence_ref: e.evidence_id, note: `The answer is not clear enough (${Math.round(e.confidence * 100)}%, needs ${Math.round(min * 100)}%).` };

    let state: RequirementState = "stated", note: string | null = null;
    if (r.verify_against === "programme_employer" && (!r.verify_when || holds(r.verify_when))) {
      if (blank(programmeEmployer)) note = "The programme record has no employer to check against.";
      else if (norm(e.value) === norm(programmeEmployer!)) { state = "verified"; note = "Matches the programme record."; }
      else { state = "conflict"; note = "Differs from the programme record."; }
    }
    return { ...base, applicable: true, state, confidence: e.confidence, evidence_ref: e.evidence_id, note };
  });

  const need = items.filter(i => i.applicable && i.required);
  const usable = (i: RequirementStatus) => ["stated", "verified"].includes(i.state);
  const conflicts = items.filter(i => i.state === "conflict").length;
  const gaps = items.filter(i => i.applicable && i.required && i.state === "missing").map(i => i.key);
  // Needs that depend on an answer we do not have yet are not counted as "needed", so complete means "nothing known is missing".
  const pendingCondition = items.some(i => i.required && !i.applicable && i.state === "not_needed_yet" && i.note === "Depends on an earlier answer.");
  return {
    items, needed: need.length, collected: need.filter(usable).length,
    verified: items.filter(i => i.state === "verified").length, conflicts, gaps,
    complete: reqs.length > 0 && !pendingCondition && gaps.length === 0 && conflicts === 0 && need.length > 0,
  };
}
