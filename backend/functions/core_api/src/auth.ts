// Sign-in check for everything under /api that is not self-authenticating: finds the user and puts them on the request.
import type { NextFunction, Request, Response } from "express";
import { ROLES, type Principal, type Role } from "@dozai/contracts";
import { DEMO_TENANT } from "@dozai/core";
import type { AppDeps } from "./deps";

export const requireSignIn = (deps: AppDeps) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.ctx = await deps.forRequest(req);
    let p: Principal | null = null;
    if (deps.devAuth) {
      const role = String(req.header("x-dozai-role") ?? "admin") as Role;
      if (!ROLES.includes(role)) return res.status(400).json({ error: { code: "BAD_ROLE", message: "unknown role" } });
      p = { user_id: String(req.header("x-dozai-user") ?? "dev-user"), tenant_id: DEMO_TENANT, role };
    } else if (deps.resolvePrincipal) {
      p = await deps.resolvePrincipal(req);
    }
    if (!p) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "sign in required" } });
    req.principal = p;
    next();
  } catch (e) { next(e); }
};
