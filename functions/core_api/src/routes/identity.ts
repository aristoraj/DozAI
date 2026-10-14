// Who is signed in and what is switched on.
import type { Express } from "express";
import type { AppDeps } from "../deps";
import { need } from "../http";

export function registerIdentityRoutes(app: Express, deps: AppDeps) {
  app.get("/api/me", need("read"), (req, res) => res.json({ user: req.principal!.user_id, role: req.principal!.role, tenant: req.principal!.tenant_id, channel: deps.runtime.whatsapp === "live" ? "interakt" : "simulated", voice: deps.voice ? deps.voice.port.kind : "off", can_import: !!deps.pii, can_purge: !!deps.allowPurge }));
}
