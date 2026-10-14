// Core API. Routes, auth and role checks only; business rules live in @dozai/core. The routes themselves are in ./routes, one file per area.
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { DozaiError } from "@dozai/core";
import type { AppDeps } from "./deps";
import { requireSignIn } from "./auth";
import { registerPublicRoutes } from "./routes/public";
import { registerIdentityRoutes } from "./routes/identity";
import { registerMissionRoutes } from "./routes/missions";
import { registerVoiceRoutes } from "./routes/voice";
import { registerEmployeeRoutes } from "./routes/employees";
import { registerApprovalRoutes } from "./routes/approvals";
import { registerCampaignRoutes } from "./routes/campaigns";
import { registerCaseRoutes } from "./routes/cases";
import { registerReportRoutes } from "./routes/reports";
import { registerAdminRoutes } from "./routes/admin";

export type { AppDeps, RequestContext } from "./deps";

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { (req as Request).rawBody = buf; } })); // raw body is needed for webhook signatures

  // Order matters: routes registered first win when two patterns overlap, and everything after the sign-in check needs a user.
  registerPublicRoutes(app, deps);
  app.use("/api", requireSignIn(deps));
  registerIdentityRoutes(app, deps);
  registerMissionRoutes(app, deps);
  registerVoiceRoutes(app, deps);
  registerEmployeeRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerCaseRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerAdminRoutes(app, deps);

  // ---- errors ---------------------------------------------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DozaiError) return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: "INVALID_INPUT", message: err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") } });
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL", message: "unexpected error" } });
  });

  return app;
}
