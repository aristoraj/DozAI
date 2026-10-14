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
      if (c && ["running", "waiting"].includes(c.status)) await svc.requestReview(tenant, caseId, c.version, "case_budget", g.message, "policy-engine");
      return false;
    }
    held_back = g.message;
    return false;
  };
  if (deps.agent.resumeCase) {
    for (const w of wake) {
      if (resumed.length + resume_errors.length >= max) break;
      if (held_back) break;
      if (!(await svc.store.claim(`resume:${w.case_id}:${w.key}`))) continue; // someone else already woke it
      if (!(await allowed(w.case_id))) continue;
      try {
        await deps.agent.resumeCase(svc, tenant, w.case_id);
        resumed.push(w.case_id);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 160);
        resume_errors.push({ case_id: w.case_id, error: msg });
        const c = await svc.store.getCase(tenant, w.case_id);
        if (c) await svc.emit(c, "agent_session_ended", "system", `Automatic resume failed: ${msg}. Use "Resume after reply".`, {});
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
        await finish("skipped", "wake-up limit reached");
        if (["running", "waiting"].includes(c.status)) await svc.requestReview(tenant, c.case_id, c.version, "wake_limit", `The agent has been woken ${controls.max_wakes_per_case} times on this case, so a person should look.`, "policy-engine");
        continue;
      }
      if (!(await allowed(t.case_id))) { if (!held_back) await finish("skipped", "case spend limit reached"); continue; }
      if (!(await svc.store.claim(`wake:${t.wake_id}`))) continue;
      try {
        await svc.emit(c, "wake_fired", "scheduler", `Woke the agent (${t.reason.replace("_", " ")})`, { wake_id: t.wake_id, reason: t.reason });
        await deps.agent.resumeCase(svc, tenant, t.case_id, t);
        await finish("done", "agent woken");
        wakes.fired.push(t.case_id);
      } catch (e) {
        await finish("skipped", `wake failed: ${(e as Error).message.slice(0, 120)}`);
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
