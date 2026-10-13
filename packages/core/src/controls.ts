// Operating controls for the agent: how much it may do without a person (the autonomy dial), the kill switch, and the
// spend limits. They are set per client, by people, and enforced by the platform: the agent cannot read or change them.
import { z } from "zod";
import type { OutboxItem } from "./store";

/** What the agent can do to a person. Each can be held for a person's approval or allowed to run on its own. */
export const ACTION_KINDS = ["message_template", "message_scripted", "message_free", "voice_call"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export type AutonomyMode = "approve_first" | "automatic";

export const ACTION_LABELS: Record<ActionKind, string> = {
  message_template: "WhatsApp template (approved wording)",
  message_scripted: "WhatsApp interview question (approved wording)",
  message_free: "WhatsApp message written by the agent",
  voice_call: "Phone call",
};

export interface Controls {
  tenant_id: string;
  autonomy: Record<ActionKind, AutonomyMode>;
  /** The kill switch. While true nothing is sent, no call is placed, no campaign queues, and the agent is not woken. */
  paused: boolean;
  paused_reason?: string;
  paused_by?: string;
  paused_at?: string;
  /** Most the agent may spend (USD, indicative rates) in the last 24 hours, and on one case in total. 0 means no limit. */
  daily_budget_usd: number;
  case_budget_usd: number;
  /** Most times the agent is woken on one case before a person is asked to look. */
  max_wakes_per_case: number;
  updated_at?: string;
  updated_by?: string;
}

/** Starts at "approve first" for anything the agent writes or says, as decided with the product leads. Approved wording runs on its own. */
export const defaultControls = (tenant: string): Controls => ({
  tenant_id: tenant,
  autonomy: { message_template: "automatic", message_scripted: "automatic", message_free: "approve_first", voice_call: "approve_first" },
  paused: false, daily_budget_usd: 10, case_budget_usd: 1, max_wakes_per_case: 6,
});

export const ControlsPatchSchema = z.object({
  autonomy: z.record(z.enum(ACTION_KINDS), z.enum(["approve_first", "automatic"])).optional(),
  paused: z.boolean().optional(),
  reason: z.string().trim().max(200).optional(),
  daily_budget_usd: z.number().min(0).max(100_000).optional(),
  case_budget_usd: z.number().min(0).max(10_000).optional(),
  max_wakes_per_case: z.number().int().min(1).max(50).optional(),
}).strict();
export type ControlsPatch = z.infer<typeof ControlsPatchSchema>;

/** The kind of action a queued item is. A text sent by the interview runner is approved wording; only agent-written text is "free". */
export function actionKindOf(o: Pick<OutboxItem, "kind" | "payload">): ActionKind {
  if (o.kind === "voice_call") return "voice_call";
  if (o.kind === "whatsapp_template") return "message_template";
  return o.payload.free === true ? "message_free" : "message_scripted";
}

/** How an action type has fared with the people who approve it. Ten approvals in a row and no refusal earns a suggestion to go automatic. */
export interface ApprovalStats { kind: ActionKind; mode: AutonomyMode; held: number; approved: number; rejected: number; suggest_automatic: boolean }

export const SUGGEST_AFTER = 10;

export function approvalStats(items: OutboxItem[], c: Controls): ApprovalStats[] {
  return ACTION_KINDS.map(kind => {
    const mine = items.filter(o => actionKindOf(o) === kind && o.approval);
    const approved = mine.filter(o => o.approval!.state === "approved").length, rejected = mine.filter(o => o.approval!.state === "rejected").length;
    return { kind, mode: c.autonomy[kind], held: mine.filter(o => o.approval!.state === "held").length, approved, rejected, suggest_automatic: c.autonomy[kind] === "approve_first" && approved >= SUGGEST_AFTER && rejected === 0 };
  });
}
