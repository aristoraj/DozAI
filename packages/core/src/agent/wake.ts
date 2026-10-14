// The wake service: how a sleeping case gets looked at again. The agent never waits in a process. It sets a timer, or the
// platform sets one (silence after a message), and a scheduler pass wakes the agent when the time comes.
export const WAKE_REASONS = ["silence", "agent_requested", "call_followup"] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

export interface WakeRequest {
  wake_id: string;
  tenant_id: string;
  case_id: string;
  /** When to wake the agent (ISO time). */
  at: string;
  reason: WakeReason;
  /** The agent's own short reason, for the timeline. Kept to a fixed length and erased with the case. */
  note?: string;
  status: "pending" | "done" | "skipped" | "cancelled";
  created_at: string;
  created_by: string;
  /** Last ledger sequence number when this was set: a reply after it means the person is not silent. */
  baseline_seq: number;
  done_at?: string;
  detail?: string;
}

/** What the agent is told when it is woken. Identifiers and a reason only, never anything about the person. */
export function wakeMessage(w: Pick<WakeRequest, "reason" | "note" | "at">, caseId: string, mission: string): string {
  const why: Record<WakeReason, string> = {
    silence: "the participant has not replied to the last message within the follow-up time. Choose one: ask for a phone call if that is available and allowed, set a later wake-up, or ask a person to look.",
    agent_requested: `you asked to be woken now${w.note ? ` (your note: ${w.note})` : ""}. Re-read the case and decide the next step.`,
    call_followup: "a phone call has finished without enough answers. Decide what is still needed and how to get it.",
  };
  return `System event: wake-up on case ${caseId} (mission ${mission}): ${why[w.reason]} Read the context first.`;
}
