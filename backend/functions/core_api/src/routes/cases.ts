// Cases and participant import.
import type { Express } from "express";
import { DeleteCaseInputSchema, ImportInputSchema, ReviewDecisionInputSchema, RunAgentInputSchema } from "@dozai/contracts";
import { MEMORY_SPEC, evaluateRequirements, questionById, DozaiError, importParticipants } from "@dozai/core";
import { FakeChannels } from "@dozai/adapters";
import { auditView } from "../views";
import type { AppDeps } from "../deps";
import { CAN, need, wrap } from "../http";
import { approvalView } from "./approvals";
import { live, views, oneView } from "./case-views";

export function registerCaseRoutes(app: Express, deps: AppDeps) {
  app.get("/api/cases", need("read"), wrap(async (req, res) => {
    const cases = (await live(req)).sort((a, b) => (b.last_touch ?? "").localeCompare(a.last_touch ?? ""));
    res.json({ cases: await views(req, cases) });
  }));

  app.get("/api/cases/:id", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const view = await oneView(req, id);
    const c = await svc.getCase(t, id);
    const evidence = await svc.store.listEvidence(id);
    const person = await svc.store.getParticipant(t, c.participant_id);
    const need = evaluateRequirements(await svc.getMission(t, c.mission_version), evidence, person?.recorded_employer);
    // Transcripts are personal data: only people who review cases or manage the platform see them.
    const seesTranscripts = CAN.review!.includes(req.principal!.role) || CAN.employee!.includes(req.principal!.role);
    const calls = (await svc.store.listCalls(t, id)).sort((a, b) => a.requested_at.localeCompare(b.requested_at)).map(k => ({ communication_id: k.communication_id, status: k.status, requested_at: k.requested_at, scheduled_for: k.scheduled_for ?? null, ended_at: k.ended_at ?? null, duration_seconds: k.duration_seconds ?? null, asked: k.asked, reason: k.reason ?? null, audio_url: seesTranscripts ? (k.recording ? `/calls/${k.communication_id}/recording` : k.audio_url ?? null) : null, transcript: seesTranscripts ? k.transcript ?? null : null }));
    res.json({
      calls, case: view, events: (await svc.store.listEvents(t, id)).map(auditView), evidence, decisions: await svc.store.listDecisions(id),
      // What the mission needs to know about this person and how much of it is settled. Labels and states only; answers stay in `evidence`.
      requirements: { complete: need.complete, needed: need.needed, collected: need.collected, verified: need.verified, conflicts: need.conflicts, gaps: need.gaps, items: need.items },
      sessions: (await svc.store.listSessions(t)).filter(s => s.case_id === id).map(s => ({ session_id: s.session_id, started_at: s.started_at, status: s.status, cost_usd: s.cost_usd, simulated: s.simulated, trigger: s.trigger ?? null })),
      // What the agent remembers (fixed facts only), when it is next due to wake, and what is waiting for a person's approval.
      memory: ((await svc.store.getMemory(t, id))?.items ?? []).map(m => ({ key: m.key, label: MEMORY_SPEC[m.key]?.label ?? m.key, value: m.value, at: m.at })),
      wakes: (await svc.store.listWakes(t, id)).filter(w => w.status === "pending").map(w => ({ wake_id: w.wake_id, at: w.at, reason: w.reason, note: w.note ?? null })),
      approvals: (await svc.store.listOutbox(t)).filter(o => o.case_id === id && o.approval).map(approvalView),
    });
  }));

  app.post("/api/cases/:id/review", need("review"), wrap(async (req, res) => {
    await req.ctx.svc.reviewDecide(req.principal!, String(req.params.id), ReviewDecisionInputSchema.parse(req.body));
    res.json({ case: await oneView(req, String(req.params.id)) });
  }));

  app.post("/api/cases/:id/ready", need("run"), wrap(async (req, res) => {
    await req.ctx.svc.markReady(req.principal!.tenant_id, String(req.params.id), `${req.principal!.role}:${req.principal!.user_id}`);
    res.json({ case: await oneView(req, String(req.params.id)) });
  }));

  app.post("/api/cases/:id/run-agent", need("run"), wrap(async (req, res) => {
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const { scenario } = RunAgentInputSchema.parse(req.body ?? {});
    const c = await svc.getCase(t, id);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    if (!["draft", "ready", "waiting", "running"].includes(c.status)) throw new DozaiError("ILLEGAL_STATE", `case is ${c.status}; an agent session cannot start`);
    const session = await agent.runCase(svc, t, id, scenario);
    res.json({ session, case: await oneView(req, id) });
  }));

  app.post("/api/cases/:id/resume-agent", need("run"), wrap(async (req, res) => {
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    if (!agent.resumeCase) throw new DozaiError("NOT_SUPPORTED", "this agent runtime cannot resume from a live reply");
    const session = await agent.resumeCase(svc, t, id);
    res.json({ session, case: await oneView(req, id) });
  }));

  // What was asked and what the participant answered, for reviewers. Approved wording plus recorded answers only.
  app.get("/api/cases/:id/conversation", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    await oneView(req, id); // 404/410 for missing or deleted cases
    const st = await svc.store.getConversation(t, id);
    const instrument = (await svc.getMission(t, (await svc.getCase(t, id)).mission_version)).instrument;
    const questions = instrument.questions;
    const sent = (await svc.store.listOutbox(t)).filter(o => o.case_id === id && o.kind === "whatsapp_text")
      .map(o => ({ at: o.created_at, from: "system" as const, text: String(o.payload.text ?? ""), delivered: o.status }));
    // What the person actually wrote is shown as they wrote it. Cases from before that was kept show the answers that were recorded instead.
    const wrote = (st?.transcript ?? []).map(m => ({ at: m.at, from: "participant" as const, text: m.text }));
    const since = wrote[0]?.at;
    const answered = (st?.answers ?? []).filter(a => !since || a.at < since).map(a => ({ at: a.at, from: "participant" as const, text: a.label ?? a.value, question: a.question_id }));
    const messages = [...sent, ...answered, ...wrote].sort((a, b) => a.at.localeCompare(b.at));
    res.json({
      status: st?.status ?? "not_started", current: st?.current ? { id: st.current, text: questionById(instrument, st.current)?.text ?? "" } : null,
      escalation_reason: st?.escalation_reason ?? null, reasks: st?.reasks ?? 0, answered: st?.answers.length ?? 0, questions_total: questions.length, messages,
    });
  }));

  // Simulated participant reply, only when WhatsApp is off. It goes through exactly the same conversation runner.
  app.post("/api/cases/:id/simulate-reply", need("run"), wrap(async (req, res) => {
    if (deps.runtime.whatsapp === "live") throw new DozaiError("NOT_ALLOWED", "WhatsApp is live: replies come from the participant", 400);
    const { svc, agent, runner } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    if (!runner) throw new DozaiError("NOT_CONFIGURED", "the conversation runner is not configured", 503);
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 500) : "";
    const result = await runner.handleReply(t, id, text);
    await new FakeChannels().dispatchOutbox(svc, t); // "send" what was queued
    let session = null;
    if (result.finished && agent.resumeCase) session = await agent.resumeCase(svc, t, id);
    res.json({ result, session, case: await oneView(req, id) });
  }));

  app.post("/api/cases/:id/delete", need("admin"), wrap(async (req, res) => {
    const id = String(req.params.id);
    const input = DeleteCaseInputSchema.parse(req.body);
    if (input.confirm !== id) throw new DozaiError("CONFIRMATION_MISMATCH", "type the case id exactly to confirm", 400);
    await req.ctx.svc.deleteCase(req.principal!, id, input.reason_code);
    res.json({ deleted: true, case_id: id });
  }));

  // ---- participants ---------------------------------------------------------------------------------------------
  app.post("/api/participants/import", need("intake"), wrap(async (req, res) => {
    if (!deps.pii) throw new DozaiError("NOT_CONFIGURED", "DOZAI_PII_KEY is not set, so contact numbers cannot be stored safely", 503);
    const input = ImportInputSchema.parse(req.body);
    res.json(await importParticipants(req.ctx.svc, req.principal!, input.rows, { piiKey: deps.pii.key, defaultCountryCode: deps.pii.defaultCountryCode, missionVersion: input.mission_version }));
  }));
}
