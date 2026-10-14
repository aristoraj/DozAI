// Replay: take what an agent session did and check it again under today's rules, without sending or changing anything.
// It answers "would this still be allowed?" after a template was withdrawn, a person opted out, the kill switch was
// pressed or the autonomy dial moved. It checks the rules that do not depend on how far the case has progressed (so the
// attempt count is not re-applied to the action that made it). It does not re-run the model, which is not repeatable.
import { localHour } from "@dozai/domain";
import { actionKindOf } from "./controls";
import { memoryProblem } from "./memory";
import type { CaseService } from "../cases/service";
import type { TraceStep } from "../storage/store";
import { planCall } from "../conversation/voice";

export interface ReplayRow {
  /** Position of the step in the session's trace. */
  step: number;
  at: string;
  tool: string;
  /** What the platform did at the time. "unknown" for sessions recorded before outcomes were kept. */
  recorded: "executed" | "held" | "refused" | "unknown";
  recorded_detail: string;
  /** What the platform would do now. */
  now: "allowed" | "would_be_held" | "refused";
  code?: string;
  message?: string;
  /** The answer differs from the recorded one in a way that matters: something that ran would now be stopped, or the reverse. */
  changed: boolean;
}

export interface ReplayResult { session_id: string; case_id: string; trigger: string | null; rows: ReplayRow[]; note: string }

const ACTIONS = new Set(["whatsapp_send_template", "voice_call_request", "callback_schedule", "decision_propose", "review_request", "memory_note"]);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export async function replaySession(svc: CaseService, tenant: string, sessionId: string): Promise<ReplayResult | undefined> {
  const s = await svc.store.getSession(sessionId);
  if (!s || s.tenant_id !== tenant) return undefined;
  const c = await svc.store.getCase(tenant, s.case_id);
  const rows: ReplayRow[] = [];
  const controls = await svc.controls(tenant);

  for (let i = 0; i < s.trace.length; i++) {
    const t: TraceStep = s.trace[i]!;
    if (!t.tool || !ACTIONS.has(t.tool)) continue;
    const input = asObj(t.input);
    const recorded = t.outcome ?? "unknown";
    let verdict: { now: ReplayRow["now"]; code?: string; message?: string } = { now: "allowed" };
    const refuse = (code: string, message: string) => { verdict = { now: "refused", code, message }; };

    if (!c) refuse("CASE_NOT_FOUND", "the case no longer exists");
    else if (controls.paused) refuse("AGENT_PAUSED", "the agent is switched off");
    else {
      const person = await svc.store.getParticipant(tenant, c.participant_id);
      const mission = await svc.getMission(tenant, s.mission_version);
      const contact = t.tool === "whatsapp_send_template" || t.tool === "voice_call_request";
      if (c.deleted_at) refuse("CASE_DELETED", "the case was deleted");
      // A reminder contacts nobody, but the tool still refuses one for someone who declined: replay must say the same.
      else if ((contact || t.tool === "callback_schedule") && person?.consent === "declined") refuse("CONSENT_DECLINED", "the person has declined or opted out");
      else if (t.tool === "whatsapp_send_template" && !mission.templates.some(x => x.key === input.template_key)) refuse("TEMPLATE_NOT_APPROVED", `template ${String(input.template_key)} is not in the approved list`);
      else if (t.tool === "voice_call_request") {
        if (!svc.voiceEnabled) refuse("NO_PHONE_CHANNEL", "phone calls are not available");
        else {
          try { await planCall(svc, c); } catch (e) { refuse("NO_PHONE_FORM", (e as Error).message); }
          if (verdict.now === "allowed" && typeof input.start_at === "string") {
            const pol = svc.policyFor(mission), h = localHour(new Date(input.start_at), pol.utcOffsetMinutes);
            if (h < pol.windowStartHour || h >= pol.windowEndHour) refuse("OUTSIDE_WINDOW", "the chosen time is outside the approved contact hours");
          }
        }
      } else if (t.tool === "memory_note" && memoryProblem(String(input.key), String(input.value))) refuse("INVALID_MEMORY", memoryProblem(String(input.key), String(input.value))!);
      else if (t.tool === "decision_propose") {
        const known = new Set((await svc.store.listEvidence(c.case_id)).map(e => e.evidence_id));
        const gone = (Array.isArray(input.evidence_refs) ? input.evidence_refs : []).filter(r => !known.has(String(r)));
        if (gone.length) refuse("UNKNOWN_EVIDENCE", `evidence no longer exists: ${gone.join(", ")}`);
      }
      if (verdict.now === "allowed" && contact) {
        const mode = controls.autonomy[actionKindOf({ kind: t.tool === "voice_call_request" ? "voice_call" : "whatsapp_template", payload: {} })];
        if (mode === "approve_first") verdict = { now: "would_be_held", message: "a person would have to approve it first" };
      }
    }
    const was = recorded === "refused" ? "refused" : "ran";
    const nowRan = verdict.now !== "refused";
    rows.push({ step: i + 1, at: t.ts, tool: t.tool, recorded, recorded_detail: t.detail, ...verdict, changed: recorded !== "unknown" && ((was === "ran") !== nowRan) });
  }
  return { session_id: s.session_id, case_id: s.case_id, trigger: s.trigger ?? null, rows, note: "Checked against today's rules. Nothing was sent or changed, and the model was not run again." };
}
