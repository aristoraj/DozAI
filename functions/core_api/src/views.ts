// View models: map the locked domain model (status + outcome) to what the operator UI shows.
import type { CaseEvent, CaseRecord, Evidence, Participant } from "@dozai/contracts";

export type UiStatus = "review" | "confirmed" | "progress" | "not-confirmed" | "inconclusive" | "not-started" | "opted-out";

export function uiStatus(c: CaseRecord): UiStatus {
  if (c.status === "review") return "review";
  if (c.status === "complete") {
    return ({ confirmed: "confirmed", not_confirmed: "not-confirmed", inconclusive: "inconclusive", opted_out: "opted-out", cancelled: "inconclusive" } as const)[c.outcome ?? "inconclusive"];
  }
  if (c.status === "draft" || c.status === "ready") return "not-started";
  return "progress";
}

const STATE_LABEL: Record<string, string> = { same_job: "Same job", changed_job: "Changed job", not_employed: "Currently unemployed", education_training: "Education or training", unreachable_unclear: "Unclear" };

export function outcomeLabel(c: CaseRecord): string {
  if (c.outcome === "opted_out") return "Opted out";
  if (c.outcome === "inconclusive") return "Inconclusive";
  if (c.livelihood_state) return STATE_LABEL[c.livelihood_state] ?? "—";
  if (c.status === "draft" || c.status === "ready") return "—";
  return c.attempts > 0 && c.confidence <= 25 ? "No response" : "Awaiting response";
}

function stage(c: CaseRecord, hasEvidence: boolean): string {
  if (c.status === "complete") return "Complete";
  if (c.status === "review") return "Review";
  if (c.status === "draft" || c.status === "ready") return "Not started";
  return hasEvidence || c.attempts > 1 || c.confidence > 25 ? "Follow-up" : "Contacting";
}

export function relative(ts: string | null, now = Date.now()): string {
  if (!ts) return "—";
  const m = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "Yesterday" : `${d} days ago`;
}

export function caseView(c: CaseRecord, p: Participant | undefined, evidence: Evidence[]) {
  const reported = evidence.find(e => e.question_id === "employer_name")?.value;
  return {
    id: c.case_id,
    name: p?.display_name ?? "Unknown",
    phone: p?.phone_masked ?? "—",
    location: p?.location ?? "—",
    cohort: p?.cohort ?? "—",
    stage: stage(c, evidence.length > 0),
    status: uiStatus(c),
    workflow_status: c.status,
    final_outcome: c.outcome,
    livelihood_state: c.livelihood_state,
    outcome: outcomeLabel(c),
    confidence: c.confidence,
    lastTouch: relative(c.last_touch),
    owner: c.owner,
    employer: reported ?? "—",
    recorded_employer: p?.recorded_employer ?? "—",
    role: "—",
    reason: c.reason,
    next: c.next_action,
    attempts: c.attempts,
    version: c.version,
    mission_version: c.mission_version ?? null,
  };
}

const ACTION: Record<string, { label: string; icon: string; tone: "teal" | "coral" }> = {
  case_created: { label: "Case created", icon: "+", tone: "teal" },
  status_changed: { label: "Status changed", icon: "→", tone: "teal" },
  message_queued: { label: "Approved message queued", icon: "↗", tone: "coral" },
  message_received: { label: "Participant response received", icon: "WA", tone: "teal" },
  call_requested: { label: "Voice call requested", icon: "☎", tone: "coral" },
  call_result: { label: "Call result received", icon: "☎", tone: "teal" },
  call_started: { label: "Phone call placed", icon: "☎", tone: "coral" },
  evidence_added: { label: "Evidence recorded", icon: "◇", tone: "teal" },
  decision_proposed: { label: "Agent proposed outcome", icon: "AI", tone: "coral" },
  review_requested: { label: "Review requested", icon: "!", tone: "coral" },
  review_decided: { label: "Human review completed", icon: "✓", tone: "teal" },
  agent_session_started: { label: "Agent session started", icon: "AI", tone: "coral" },
  agent_session_ended: { label: "Agent session idled", icon: "AI", tone: "coral" },
  callback_scheduled: { label: "Callback scheduled", icon: "◷", tone: "coral" },
};

export function auditView(e: CaseEvent) {
  const a = ACTION[e.type] ?? { label: e.type, icon: "•", tone: "teal" as const };
  const actorCode = e.actor.startsWith("agent") ? "AI" : e.actor.startsWith("reviewer") || e.actor.startsWith("admin") ? e.actor.split(":")[1]?.slice(0, 2).toUpperCase() ?? "HR" : e.actor.slice(0, 2).toUpperCase();
  const ts = new Date(e.ts);
  return {
    time: ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date: relative(e.ts).includes("day") || relative(e.ts) === "Yesterday" ? relative(e.ts) : "Today",
    icon: a.icon, tone: a.tone, action: a.label, detail: `${e.case_id} · ${e.summary}`,
    actor: e.actor.startsWith("agent") ? "Claude agent" : e.actor, actorCode,
    hash: `evt_${e.hash.slice(0, 6)}`, seq: e.seq, case_id: e.case_id, ts: e.ts,
  };
}
