// Routes that authenticate themselves (not by a user session): health check, webhooks, one-time bootstrap and the scheduler jobs.
import type { Express, Request } from "express";
import { matchSignatureVariant, processVoiceInbox, recordRejected, storeInteraktEvent, storeVoiceCallback, tick } from "@dozai/adapters";
import type { AppDeps } from "../deps";
import { wrap } from "../http";
import { safeEqual } from "../http";

const jobAuth = (deps: AppDeps, req: Request) => !!deps.jobToken && safeEqual(String(req.header("x-job-token") ?? ""), deps.jobToken);

export function registerPublicRoutes(app: Express, deps: AppDeps) {
  app.get("/api/health", (_req, res) => res.json({ ok: true, service: "dozai-core-api", auth: deps.devAuth ? "dev-headers" : "token" }));

  app.post("/api/webhooks/interakt", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp webhook is not configured" } });
    const header = req.header("interakt-signature");
    const variant = matchSignatureVariant(req.rawBody ?? Buffer.alloc(0), header, cfg.webhookSecret);
    if (!variant) {
      // Leave a trace an admin can see (rate limited), then refuse. No secrets, no body.
      const ctx = await deps.forRequest(req);
      await recordRejected(ctx.svc, cfg.tenant, { had_signature_header: !!header, bytes: req.rawBody?.length ?? 0, user_agent: req.header("user-agent"), content_type: req.header("content-type") }).catch(() => undefined);
      return res.status(401).json({ error: { code: "BAD_SIGNATURE", message: "signature check failed" } });
    }
    const { svc, agent, runner } = await deps.forRequest(req);
    const r = await storeInteraktEvent(svc, cfg.tenant, req.body, cfg.piiKey); // one write, then acknowledge: Interakt does not retry
    res.status(200).json({ ok: true, stored: r.stored });
    // Best effort after the acknowledgement. If the platform stops the function early, the next tick picks it up.
    if (r.stored) setImmediate(() => { tick(svc, cfg.tenant, { piiKey: cfg.piiKey, channel: cfg.channel, agent, runner }).catch(err => console.error("tick", err)); });
  }));

  // The voice provider rings this when a call finishes. Authenticated by a secret in the address; the body is never trusted:
  // only the call id is kept, and the call is then fetched from the provider (see processVoiceInbox).
  app.post("/api/webhooks/zolabs/:token", wrap(async (req, res) => {
    const v = deps.voice;
    if (!v?.webhookSecret) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "the phone callback is not configured" } });
    if (!safeEqual(String(req.params.token ?? ""), v.webhookSecret)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const { svc, agent, runner } = await deps.forRequest(req);
    const r = await storeVoiceCallback(svc, v.tenant, req.body);
    res.status(200).json({ ok: true, stored: r.stored });
    if (r.stored) setImmediate(() => { tick(svc, v.tenant, { piiKey: v.cfg.piiKey, channel: deps.interakt?.channel, agent, runner, voice: { port: v.port, cfg: v.cfg } }).catch(err => console.error("tick", err)); });
  }));

  app.post("/api/bootstrap/invite", wrap(async (req, res) => {
    const b = deps.bootstrap;
    if (!b) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "bootstrap is not enabled" } });
    if (!safeEqual(String(req.header("x-bootstrap-token") ?? ""), b.token)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const results: Record<string, string> = {};
    for (const email of b.emails) { try { await b.invite(req, email); results[email] = "invited"; } catch (e) { results[email] = `not invited: ${(e as Error).message.slice(0, 120)}`; } }
    res.json({ results });
  }));

  // Scheduler routes: apply replies, retry sends, resume the agent. Read-only diagnostics for support.
  app.post("/api/jobs/tick", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp is not configured" } });
    if (!jobAuth(deps, req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const ctx = await deps.forRequest(req);
    res.json(await tick(ctx.svc, cfg.tenant, { piiKey: cfg.piiKey, channel: cfg.channel, agent: ctx.agent, runner: ctx.runner, voice: deps.voice && { port: deps.voice.port, cfg: deps.voice.cfg } }));
  }));

  app.get("/api/jobs/messages", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp is not configured" } });
    if (!jobAuth(deps, req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const { svc } = await deps.forRequest(req);
    const types = ["message_queued", "message_sent", "message_status", "message_received"];
    const events = (await svc.store.listEvents(cfg.tenant)).filter(e => types.includes(e.type)).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 15);
    res.json({ events: events.map(e => ({ ts: e.ts, case_id: e.case_id, type: e.type, actor: e.actor, summary: e.summary })) });
  }));

  // Support view of one case: the ledger (which holds no personal data) and where the interview stands. No names, numbers or answer text.
  app.get("/api/jobs/case/:id", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp is not configured" } });
    if (!jobAuth(deps, req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const { svc } = await deps.forRequest(req);
    const id = String(req.params.id);
    const c = await svc.store.getCase(cfg.tenant, id);
    if (!c) return res.status(404).json({ error: { code: "NOT_FOUND", message: "no such case" } });
    const conv = await svc.store.getConversation(cfg.tenant, id);
    const outbox = (await svc.store.listOutbox(cfg.tenant)).filter(o => o.case_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    res.json({
      case: { status: c.status, outcome: c.outcome, confidence: c.confidence, attempts: c.attempts, mission_version: c.mission_version ?? null, reason: c.reason, next_action: c.next_action },
      conversation: conv && { status: conv.status, current: conv.current, reasks: conv.reasks, answered: conv.answers.map(a => a.question_id), messages_sent: conv.messages_sent, escalation_reason: conv.escalation_reason ?? null },
      outbox: outbox.map(o => ({ at: o.created_at, kind: o.kind, status: o.status, what: o.payload.kind ?? o.payload.template_key ?? null, question: o.payload.question ?? null, error: o.payload.last_error ?? null })),
      events: (await svc.store.listEvents(cfg.tenant, id)).map(e => ({ ts: e.ts, type: e.type, actor: e.actor, summary: e.summary })),
    });
  }));
}
