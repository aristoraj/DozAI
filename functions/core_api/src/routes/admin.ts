// Administrator and development-only routes (WhatsApp operations, purge, reset).
import type { Express } from "express";
import { DozaiError, InMemoryStore, seedDemo } from "@dozai/core";
import { processInbox, tick } from "@dozai/adapters";
import type { AppDeps } from "../deps";
import { need, wrap } from "../http";

export function registerAdminRoutes(app: Express, deps: AppDeps) {
  if (deps.interakt) {
    const cfg = deps.interakt;
    app.post("/api/admin/tick", need("admin"), wrap(async (req, res) => res.json(await tick(req.ctx.svc, req.principal!.tenant_id, { piiKey: cfg.piiKey, channel: cfg.channel, agent: req.ctx.agent, runner: req.ctx.runner, voice: deps.voice && { port: deps.voice.port, cfg: deps.voice.cfg } }))));
    app.post("/api/admin/process-inbox", need("admin"), wrap(async (req, res) => res.json(await processInbox(req.ctx.svc, req.principal!.tenant_id, cfg.piiKey))));
    app.post("/api/admin/dispatch-outbox", need("admin"), wrap(async (req, res) => {
      if (!cfg.channel) throw new DozaiError("NOT_CONFIGURED", "no live WhatsApp channel configured");
      res.json({ sent: await cfg.channel.dispatchOutbox(req.ctx.svc, req.principal!.tenant_id) });
    }));
  }

  // ---- development only ---------------------------------------------------------------------------------------------------
  if (deps.allowPurge) {
    app.post("/api/admin/purge-all", need("admin"), wrap(async (req, res) => {
      if (req.body?.confirm !== "DELETE ALL DATA") throw new DozaiError("CONFIRMATION_MISMATCH", "send {\"confirm\":\"DELETE ALL DATA\"}", 400);
      await req.ctx.svc.store.purgeAll();
      res.json({ purged: true });
    }));
  }

  if (deps.devAuth) {
    app.post("/api/dev/reset", need("admin"), wrap(async (req, res) => {
      const { svc } = req.ctx;
      if (!(svc.store instanceof InMemoryStore)) throw new DozaiError("NOT_SUPPORTED", "reset only works on the in-memory store");
      svc.store.reset();
      res.json(await seedDemo(svc.store));
    }));
  }
}
