// View models: map the locked domain model (status + outcome) to what the operator UI shows.
import type { CaseEvent, CaseRecord, Evidence, Participant } from "@dozai/contracts";
import { resultFor, statusLabel } from "@dozai/core";
import type { MissionBundle } from "@dozai/core";

export type UiStatus = "review" | "confirmed" | "progress" | "not-confirmed" | "inconclusive" | "not-started" | "opted-out";

export function uiStatus(c: CaseRecord): UiStatus {
  if (c.status === "review") return "review";
  if (c.status === "complete") {
    return ({ confirmed: "confirmed", not_confirmed: "not-confirmed", inconclusive: "inconclusive", opted_out: "opted-out", cancelled: "inconclusive" } as const)[c.outcome ?? "inconclusive"];
  }
  if (c.status === "draft" || c.status === "ready") return "not-started";
  return "progress";
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

export function caseView(c: CaseRecord, p: Participant | undefined, evidence: Evidence[], mission?: MissionBundle) {
  const result = resultFor(mission, c);
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
    // Status is where the case is in the process; the result is what was found out, in this mission's own words.
    status_label: statusLabel(c, evidence.length > 0),
    result,
    outcome: result.label,
    outcome_note: result.note,
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
  callback_scheduled: { label: "Reminder set by the agent", icon: "◷", tone: "coral" },
  message_sent: { label: "WhatsApp message sent", icon: "↗", tone: "teal" },
  message_status: { label: "WhatsApp delivery update", icon: "↗", tone: "teal" },
  conversation_started: { label: "Interview started", icon: "WA", tone: "teal" },
  question_asked: { label: "Question or message sent", icon: "↗", tone: "teal" },
  answer_recorded: { label: "Answer recorded", icon: "◇", tone: "teal" },
  reply_handled: { label: "Reply understood", icon: "WA", tone: "teal" },
  case_deleted: { label: "Case deleted", icon: "×", tone: "coral" },
  action_held: { label: "Waiting for approval", icon: "!", tone: "coral" },
  action_approved: { label: "Approved by a person", icon: "✓", tone: "teal" },
  action_rejected: { label: "Declined by a person", icon: "×", tone: "coral" },
  wake_scheduled: { label: "Wake-up set", icon: "◷", tone: "coral" },
  wake_fired: { label: "Agent woken", icon: "AI", tone: "coral" },
  memory_noted: { label: "Agent remembered a preference", icon: "◇", tone: "teal" },
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
