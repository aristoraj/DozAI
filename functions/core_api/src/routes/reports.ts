// Reviews, audit trail, sessions and the summary numbers.
import type { Express } from "express";
import { type CaseRecord } from "@dozai/contracts";
import { DozaiError } from "@dozai/core";
import { auditView } from "../views";
import type { AppDeps } from "../deps";
import { need, wrap } from "../http";
import { live, views } from "./case-views";

export function registerReportRoutes(app: Express, deps: AppDeps) {
  app.get("/api/reviews", need("read"), wrap(async (req, res) => res.json({ cases: await views(req, (await live(req)).filter(c => c.status === "review")) })));

  app.get("/api/audit", need("read"), wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const events = (await req.ctx.svc.store.listEvents(req.principal!.tenant_id)).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
    res.json({ events: events.map(auditView) });
  }));

  app.get("/api/audit/verify", need("read"), wrap(async (req, res) => res.json(await req.ctx.svc.verifyLedger(req.principal!.tenant_id))));

  app.get("/api/sessions", need("read"), wrap(async (req, res) => {
    const sessions = (await req.ctx.svc.store.listSessions(req.principal!.tenant_id)).sort((a, b) => b.started_at.localeCompare(a.started_at));
    res.json({ sessions: sessions.map(s => ({ ...s, trace: undefined })) });
  }));

  app.get("/api/sessions/:id", need("read"), wrap(async (req, res) => {
    const s = await req.ctx.svc.store.getSession(String(req.params.id));
    if (!s || s.tenant_id !== req.principal!.tenant_id) throw new DozaiError("NOT_FOUND", "session not found", 404);
    res.json({ session: s });
  }));

  app.get("/api/summary", need("read"), wrap(async (req, res) => {
    const cases = await live(req);
    const count = (f: (c: CaseRecord) => boolean) => cases.filter(f).length;
    res.json({
      total: cases.length, review: count(c => c.status === "review"), confirmed: count(c => c.outcome === "confirmed"),
      reached: count(c => c.attempts > 0 || c.status === "complete"), responded: count(c => c.confidence > 25 || c.status === "complete" || c.status === "review"), complete: count(c => c.status === "complete"),
      mix: { same_job: count(c => c.livelihood_state === "same_job"), changed_job: count(c => c.livelihood_state === "changed_job"), not_employed: count(c => c.livelihood_state === "not_employed"), other: count(c => c.status === "complete" && !["same_job", "changed_job", "not_employed"].includes(c.livelihood_state ?? "")) },
    });
  }));
}
