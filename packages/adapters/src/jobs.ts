// The periodic job: apply new inbound events, run the conversation, send what was queued, and wake the agent when an
// interview is finished. Idempotent and safe to run from several places at once (webhook, a Catalyst Cron, a dashboard
// button): every reply and every agent wake-up is claimed once.
import { CampaignService, type CampaignRunResult, type CaseService, type ConversationRunner, type WakeRequest } from "@dozai/core";
import type { AgentRuntimePort, ChannelPort } from "./index";
import { processInbox } from "./interakt";
import { dispatchVoice, processVoiceInbox, syncCalls, type VoiceDispatchConfig, type VoicePort } from "./voice";

export interface TickResult {
  inbox: { processed: number; errors: number };
  /** What the conversation runner did with each reply, e.g. "answered", "faq", "escalated". */
  conversation: string[];
  /** First messages queued by running campaigns this run. */
  campaigns: CampaignRunResult[];
  /** Campaigns paused automatically because their sends kept failing. */
  campaigns_paused: { campaign_id: string; reason: string }[];
  sent: number;
  /** Phone calls placed this run, and finished calls whose results were applied. */
  calls: { started: number; results: number; errors: number };
  resumed: string[];
  resume_errors: { case_id: string; error: string }[];
  /** Timers that came due: the agent woken on a sleeping case, and timers that did not need a wake-up (the person replied, the case closed). */
  wakes: { fired: string[]; skipped: { case_id: string; why: string }[] };
  /** The kill switch is on, so nothing was sent or started and the agent was not woken. Replies are still recorded. */
  paused: boolean;
  /** Why the agent was not run this pass, when a spend limit stopped it. */
  held_back?: string;
  webhook: { events: number; last_event_at: string | null; bad_signatures: number; last_bad_signature_at: string | null; last_bad_signature_info: Record<string, unknown> | null };
}

export async function tick(
  svc: CaseService,
  tenant: string,
  deps: { piiKey: string; channel?: ChannelPort; agent: AgentRuntimePort; runner?: ConversationRunner; maxResumes?: number; voice?: { port: VoicePort; cfg: VoiceDispatchConfig } },
): Promise<TickResult> {
  const inbox = await processInbox(svc, tenant, deps.piiKey, { captureReplyText: !deps.runner });

  // 1. Conversation: each reply is handled once. Without a runner, a reply simply wakes the agent (older behaviour).
  const conversation: string[] = [];
  const wake: { case_id: string; key: string }[] = [];
  for (const r of inbox.replies) {
    if (!deps.runner) { wake.push({ case_id: r.case_id, key: r.inbox_id }); continue; }
    if (!(await svc.store.claim(`reply:${r.inbox_id}`))) continue;
    try {
      const res = await deps.runner.handleReply(tenant, r.case_id, r.text);
      conversation.push(`${r.case_id}: ${res.action}${res.detail ? ` (${res.detail})` : ""}`);
      if (res.finished) wake.push({ case_id: r.case_id, key: r.inbox_id });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160);
      conversation.push(`${r.case_id}: error (${msg})`);
      const c = await svc.store.getCase(tenant, r.case_id);
      if (c) await svc.emit(c, "reply_handled", "conversation-runner", `Could not handle the reply: ${msg}`, { error: true });
    }
  }

  // 1b. Phone calls that have finished: fetch their data, record the answers, and wake the agent where there are answers to judge.
  let callResults = { processed: 0, errors: 0 };
  if (deps.voice) {
    try {
      const v = await processVoiceInbox(svc, tenant, deps.voice.port); callResults = v; wake.push(...v.wake);
      // The provider's callback may never arrive, so unfinished calls are also asked about directly.
      const s = await syncCalls(svc, tenant, deps.voice.port); callResults = { processed: v.processed + s.applied, errors: v.errors }; wake.push(...s.wake);
    }
    catch (e) { console.error("voice results", (e as Error).message); callResults = { processed: 0, errors: 1 }; }
  }

  // 2. Campaigns queue the next batch of first messages. A failure here must not stop replies from being handled.
  const campaigns = new CampaignService(svc);
  let campaignRuns: CampaignRunResult[] = [];
  const controls = await svc.controls(tenant);
  if (!controls.paused) { try { campaignRuns = await campaigns.run(tenant); } catch (e) { console.error("campaign run", (e as Error).message); } }

  // 3. Send everything that was queued: the questions the runner just added and the campaign's first messages.
  const sent = deps.channel ? await deps.channel.dispatchOutbox(svc, tenant) : 0;

  // 3b. Place the phone calls the agent asked for.
  let callsStarted = 0;
  if (deps.voice) { try { callsStarted = await dispatchVoice(svc, tenant, deps.voice.port, deps.voice.cfg); } catch (e) { console.error("voice dispatch", (e as Error).message); } }

  // 4. If the first messages keep failing, pause the campaign instead of working through the whole list.
  let campaigns_paused: TickResult["campaigns_paused"] = [];
  if (campaignRuns.length) { try { campaigns_paused = await campaigns.checkHealth(tenant); } catch (e) { console.error("campaign health", (e as Error).message); } }

  // 5. Wake the agent only where an interview has finished.
  const resumed: string[] = [];
  const resume_errors: TickResult["resume_errors"] = [];
  const max = deps.maxResumes ?? 3; // keep one invocation inside the function time limit
  let held_back = undefined as string | undefined;
  // A spend limit on one case sends that case to a person. The kill switch and the daily limit leave the work for later.
  const allowed = async (caseId: string): Promise<boolean> => {
    const g = await svc.agentGate(tenant, caseId);
    if (g.ok) return true;
    if (g.code === "CASE_BUDGET_REACHED") {
      const c = await svc.store.getCase(tenant, caseId);
      // Another pass may hand it over at the same moment: that is fine, and must not stop this pass.
      try { if (c && ["running", "waiting"].includes(c.status)) await svc.requestReview(tenant, caseId, c.version, "case_budget", g.message, "policy-engine"); }
      catch (e) { console.error("case budget handover", caseId, (e as Error).message); }
      return false;
    }
    held_back = g.message;
    return false;
  };
  // Answers that cannot be judged in this pass (the kill switch, the daily limit, or more than this pass may handle) become a timer
  // that is already due, so a later pass wakes the agent for them. Nothing else would bring the agent back to these cases.
  const later = async (caseId: string, afterMs = 0) => {
    const c = await svc.store.getCase(tenant, caseId);
    if (c && !c.deleted_at && ["waiting", "running", "evaluating"].includes(c.status)) await svc.scheduleWake(c, { at: new Date(svc.now().getTime() + afterMs), reason: "evidence_ready", by: "scheduler" });
  };
  if (deps.agent.resumeCase) {
    for (const w of wake) {
      if (!(await svc.store.claim(`resume:${w.case_id}:${w.key}`))) continue; // someone else already woke it
      if (held_back || resumed.length + resume_errors.length >= max) { await later(w.case_id); continue; }
      if (!(await allowed(w.case_id))) { if (held_back) await later(w.case_id); continue; }
      try {
        await deps.agent.resumeCase(svc, tenant, w.case_id);
        resumed.push(w.case_id);
        // The interview was finished and the agent looked at it but reached no decision: do not leave the case waiting on nothing.
        // One more try a little later (the model may have misread), then a person decides.
        const after = await svc.store.getCase(tenant, w.case_id);
        if (after && after.status === "evaluating") {
          if (await svc.store.claim(`nodecision:${w.case_id}:1`)) await later(w.case_id, 5 * 60_000);
          else { try { await svc.requestReview(tenant, w.case_id, after.version, "no_decision", "The interview finished, but the agent did not reach a decision. A person should look.", "policy-engine"); } catch (e2) { console.error("no-decision handover", w.case_id, (e2 as Error).message); } }
        }
      } catch (e) {
        const msg = (e as Error).message.slice(0, 160);
        resume_errors.push({ case_id: w.case_id, error: msg });
        const c = await svc.store.getCase(tenant, w.case_id);
        // One more try by a later pass (the model may be briefly down). If that fails too, the case goes to a person (below).
        try { await later(w.case_id, 10 * 60_000); } catch (e2) { console.error("retry wake", w.case_id, (e2 as Error).message); }
        if (c) await svc.emit(c, "agent_session_ended", "system", `Automatic resume failed: ${msg}. It is tried again in a few minutes, or use "Resume after reply".`, {});
      }
    }
  }

  // 6. Timers that have come due: wake the agent on a sleeping case, unless the reason for waking has gone away.
  const wakes: TickResult["wakes"] = { fired: [], skipped: [] };
  if (deps.agent.resumeCase && !controls.paused) {
    for (const t of await svc.dueWakes(tenant)) {
      if (held_back || resumed.length + resume_errors.length + wakes.fired.length >= max) break;
      const finish = async (status: WakeRequest["status"], detail: string) => { await svc.store.putWake({ ...t, status, detail, done_at: svc.now().toISOString() }); if (status === "skipped") wakes.skipped.push({ case_id: t.case_id, why: detail }); };
      const c = await svc.store.getCase(tenant, t.case_id);
      if (!c || c.deleted_at || !["waiting", "running", "evaluating"].includes(c.status)) { await finish("skipped", `case is ${c?.deleted_at ? "deleted" : c?.status ?? "gone"}`); continue; }
      if (t.reason === "silence" && (await svc.store.listEvents(tenant, t.case_id)).some(e => e.type === "message_received" && e.seq > t.baseline_seq)) { await finish("skipped", "the person replied"); continue; }
      if ((await svc.wakesUsed(tenant, t.case_id)) >= controls.max_wakes_per_case) {
        // Hand over first, then close the timer: if the handover fails the timer stays due and the next pass tries again.
        // Another pass may have handed it over a moment ago, which is fine and must not stop this pass.
        try {
          const cur = await svc.getCase(tenant, c.case_id);
          if (["running", "waiting"].includes(cur.status)) await svc.requestReview(tenant, cur.case_id, cur.version, "wake_limit", `The agent has been woken ${controls.max_wakes_per_case} times on this case, so a person should look.`, "policy-engine");
          await finish("skipped", "wake-up limit reached");
        } catch (e) { console.error("wake limit handover", c.case_id, (e as Error).message); }
        continue;
      }
      if (!(await allowed(t.case_id))) { if (!held_back) await finish("skipped", "case spend limit reached"); continue; }
      if (!(await svc.store.claim(`wake:${t.wake_id}`))) continue;
      try {
        await svc.emit(c, "wake_fired", "scheduler", `Woke the agent (${t.reason.replace("_", " ")})`, { wake_id: t.wake_id, reason: t.reason });
        await deps.agent.resumeCase(svc, tenant, t.case_id, t);
        if (t.reason === "evidence_ready") { // this was the second look at a finished interview: if it is still undecided, a person decides
          const after = await svc.store.getCase(tenant, t.case_id);
          if (after && after.status === "evaluating") { try { await svc.requestReview(tenant, t.case_id, after.version, "no_decision", "The interview finished, but the agent did not reach a decision. A person should look.", "policy-engine"); } catch (e2) { console.error("no-decision handover", t.case_id, (e2 as Error).message); } }
        }
        await finish("done", "agent woken");
        wakes.fired.push(t.case_id);
      } catch (e) {
        const why = (e as Error).message.slice(0, 120);
        await finish("skipped", `wake failed: ${why}`);
        // Nothing else would bring the agent back to this case, so a person looks instead of it waiting with no timer.
        try {
          const cur = await svc.getCase(tenant, t.case_id);
          if (["running", "waiting", "evaluating"].includes(cur.status)) await svc.requestReview(tenant, cur.case_id, cur.version, "agent_failed", `The agent could not be woken: ${why}`, "policy-engine");
        } catch (e2) { console.error("wake failure handover", t.case_id, (e2 as Error).message); }
      }
    }
  }

  // Is Interakt reaching us? Count what has arrived, and how many calls failed the signature check.
  const all = (await svc.store.listInbox(tenant)).filter(i => i.source === "interakt"); // the WhatsApp webhook's health, not the phone callback's
  const good = all.filter(i => (i.event as { kind?: string }).kind !== "rejected");
  const bad = all.filter(i => (i.event as { kind?: string }).kind === "rejected");
  const webhook = { events: good.length, last_event_at: good.at(-1)?.received_at ?? null, bad_signatures: bad.length, last_bad_signature_at: bad.at(-1)?.received_at ?? null, last_bad_signature_info: bad.at(-1)?.event ?? null };
  return { inbox: { processed: inbox.processed, errors: inbox.errors }, conversation, campaigns: campaignRuns, campaigns_paused, sent, calls: { started: callsStarted, results: callResults.processed, errors: callResults.errors }, resumed, resume_errors, wakes, paused: controls.paused, ...(held_back ? { held_back } : {}), webhook };
}
