// Synthetic demo cohort (the 12 sample cases from the prototype). No real participant data.
import type { LivelihoodState, Outcome, Participant } from "@dozai/contracts";
import { newId } from "./ledger";
import { CaseService } from "./service";
import type { Store } from "./store";

export const DEMO_TENANT = "tenant_demo";
export const DEMO_RUN = "run_udaan_pilot";

type Target = "ready" | "waiting" | "review" | "complete";
interface Seed {
  n: number; name: string; phone: string; location: string; cohort: string; consent: Participant["consent"];
  recorded: string; target: Target; outcome?: Outcome; state?: LivelihoodState; confidence: number;
  reported?: string; reason: string; next: string; minutesAgo: number; owner: string; attempts: number;
}

const SEEDS: Seed[] = [
  { n: 1024, name: "Asha Kumari", phone: "•••• 4821", location: "Jaipur", cohort: "Udaan · Batch 07", consent: "granted", recorded: "Aarav Supermarket", target: "review", state: "changed_job", confidence: 68, reported: "Sangam Retail", reason: "Employer name differs from the uploaded placement record.", next: "Compare the participant response with the placement record and decide.", minutesAgo: 8, owner: "Meera agent", attempts: 1 },
  { n: 1023, name: "Imran Khan", phone: "•••• 7734", location: "Ajmer", cohort: "Udaan · Batch 07", consent: "granted", recorded: "QuickServe Logistics", target: "complete", outcome: "confirmed", state: "same_job", confidence: 94, reported: "QuickServe Logistics", reason: "All answers align with prior evidence.", next: "No action needed. Case is ready for mission reporting.", minutesAgo: 14, owner: "Meera agent", attempts: 1 },
  { n: 1022, name: "Pooja Saini", phone: "•••• 9208", location: "Jaipur", cohort: "Udaan · Batch 06", consent: "granted", recorded: "Metro Garments", target: "waiting", confidence: 42, reason: "Participant answered consent but paused during employment questions.", next: "Send the approved reminder after the minimum 24-hour waiting period.", minutesAgo: 31, owner: "Vikram S.", attempts: 1 },
  { n: 1021, name: "Rahul Meena", phone: "•••• 1359", location: "Dausa", cohort: "Udaan · Batch 07", consent: "granted", recorded: "Field Link Services", target: "complete", outcome: "not_confirmed", state: "not_employed", confidence: 91, reason: "Participant confirmed they are no longer employed and requested job support.", next: "Create an opportunity-support referral according to the partner policy.", minutesAgo: 60, owner: "Meera agent", attempts: 1 },
  { n: 1020, name: "Neha Sharma", phone: "•••• 6640", location: "Jaipur", cohort: "Udaan · Batch 06", consent: "granted", recorded: "Bright Mart", target: "review", state: "same_job", confidence: 61, reported: "Bright Mart", reason: "Role is confirmed, but the reported joining month conflicts with the placement record.", next: "Resolve the joining-date discrepancy before confirming retention.", minutesAgo: 120, owner: "Meera agent", attempts: 1 },
  { n: 1019, name: "Sanjay Rawat", phone: "•••• 3012", location: "Tonk", cohort: "Udaan · Batch 07", consent: "unknown", recorded: "Tonk Cement", target: "waiting", confidence: 25, reason: "First WhatsApp message delivered; no participant reply yet.", next: "Wait until the retry window. Do not duplicate contact across channels.", minutesAgo: 180, owner: "Meera agent", attempts: 1 },
  { n: 1018, name: "Kavita Yadav", phone: "•••• 5198", location: "Ajmer", cohort: "Udaan · Batch 06", consent: "granted", recorded: "Prime Desk", target: "complete", outcome: "confirmed", state: "changed_job", confidence: 88, reported: "Nova Services", reason: "Change of employment was verified by the reviewer.", next: "No action needed. Include the transition in retention reporting.", minutesAgo: 1440, owner: "Rina P.", attempts: 2 },
  { n: 1017, name: "Arjun Singh", phone: "•••• 2470", location: "Jaipur", cohort: "Udaan · Batch 05", consent: "granted", recorded: "City Basket", target: "review", state: "changed_job", confidence: 57, reported: "Urban Basket", reason: "Free-text employer response has low entity-match confidence.", next: "Review the conversation and confirm the employer name.", minutesAgo: 1500, owner: "Meera agent", attempts: 2 },
  { n: 1016, name: "Farzana Bano", phone: "•••• 8851", location: "Dausa", cohort: "Udaan · Batch 07", consent: "declined", recorded: "Dausa Foods", target: "complete", outcome: "opted_out", confidence: 100, reason: "Participant declined to continue after consent information.", next: "No further contact. Consent preference is locked for this mission run.", minutesAgo: 2880, owner: "Meera agent", attempts: 1 },
  { n: 1015, name: "Deepak Verma", phone: "•••• 4316", location: "Tonk", cohort: "Udaan · Batch 07", consent: "unknown", recorded: "Tonk Logistics", target: "ready", confidence: 0, reason: "Case is scheduled for the next outreach window.", next: "The scheduler starts first contact at 10:00 tomorrow.", minutesAgo: 600, owner: "Unassigned", attempts: 0 },
  { n: 1014, name: "Meena Gurjar", phone: "•••• 7087", location: "Jaipur", cohort: "Udaan · Batch 05", consent: "granted", recorded: "Veda Textiles", target: "complete", outcome: "confirmed", state: "same_job", confidence: 96, reported: "Veda Textiles", reason: "Participant responses and programme record match.", next: "No action needed.", minutesAgo: 2900, owner: "Meera agent", attempts: 1 },
  { n: 1013, name: "Ravi Jangid", phone: "•••• 1624", location: "Ajmer", cohort: "Udaan · Batch 05", consent: "granted", recorded: "Ajmer Auto", target: "complete", outcome: "inconclusive", state: "unreachable_unclear", confidence: 39, reason: "Participant gave partial responses and could not be reached again.", next: "No further automation. Reporting keeps the inconclusive outcome.", minutesAgo: 4300, owner: "Vikram S.", attempts: 3 },
];

export async function seedDemo(store: Store, base: Date = new Date()): Promise<{ cases: number }> {
  for (const s of SEEDS) {
    const t0 = base.getTime() - s.minutesAgo * 60_000;
    let tick = 0;
    const svc = new CaseService(store, () => new Date(t0 + 1000 * tick++));
    const caseId = `DZ-${s.n}`;
    const participant: Participant = { participant_id: `ptc_${s.n}`, tenant_id: DEMO_TENANT, display_name: s.name, phone_masked: s.phone, location: s.location, cohort: s.cohort, language: "en", consent: s.consent, recorded_employer: s.recorded };
    let c = await svc.createCase({ tenant_id: DEMO_TENANT, run_id: DEMO_RUN, case_id: caseId, participant, owner: s.owner });
    const step = async (to: Parameters<CaseService["transition"]>[3], summary: string, extra: Parameters<CaseService["transition"]>[4]["patch"] = {}, outcome?: Outcome) => {
      c = await svc.transition(DEMO_TENANT, caseId, c.version, to, { actor: "seed", summary, outcome, patch: extra });
    };
    await step("ready", "Case ready for outreach", s.target === "ready" ? { next_action: s.next, reason: s.reason } : { next_action: "Scheduler starts first contact in the approved window" });
    if (s.target !== "ready") {
      await step("running", "Agent session started", { owner: s.owner });
      await step("waiting", "WhatsApp intro sent", { attempts: s.attempts });
    }
    const ev: string[] = [];
    if (s.reported) {
      const evidence = { evidence_id: newId("ev"), case_id: caseId, question_id: "employer_name", value: s.reported, source: "whatsapp" as const, confidence: 0.8, event_id: "seed" };
      await store.addEvidence(evidence); ev.push(evidence.evidence_id);
      await svc.emit(c, "evidence_added", "whatsapp", "Evidence captured: employer_name", { evidence_id: evidence.evidence_id });
    }
    if (s.target === "review" || s.target === "complete") {
      await step("evaluating", "Evaluating evidence");
      if (s.outcome !== "opted_out") {
        await store.addDecision({ decision_id: newId("dec"), case_id: caseId, kind: "proposal", proposed_outcome: s.outcome ?? "confirmed", livelihood_state: s.state ?? null, confidence: s.confidence / 100, evidence_refs: ev, rationale: s.reason, actor: "agent:seed", ts: new Date(t0).toISOString() });
        await svc.emit(c, "decision_proposed", "agent:seed", `Proposed ${s.outcome ?? "confirmed"} (${s.confidence}%)`, {});
      }
    }
    if (s.target === "review") {
      await step("review", "Sent to human review", { reason: s.reason, next_action: s.next, livelihood_state: s.state ?? null, confidence: s.confidence });
      await store.putReviewTask({ task_id: newId("rev"), tenant_id: DEMO_TENANT, case_id: caseId, reason: s.reason, status: "open", assignee: null, created_at: new Date(t0).toISOString() });
      await svc.emit(c, "review_requested", "policy-engine", `Review task created: ${s.reason}`, {});
    } else if (s.target === "complete") {
      await step("complete", `Completed: ${s.outcome}`, { reason: s.reason, next_action: s.next, livelihood_state: s.state ?? null, confidence: s.confidence }, s.outcome);
    } else if (s.target === "waiting") {
      c = await svc.transition(DEMO_TENANT, caseId, c.version, "waiting", { actor: "seed", summary: "Waiting for participant reply", patch: { reason: s.reason, next_action: s.next, confidence: s.confidence, attempts: s.attempts } });
    }
  }
  return { cases: SEEDS.length };
}
