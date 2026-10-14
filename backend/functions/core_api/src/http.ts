// Shared pieces of the HTTP layer: who may do what, the async error wrapper, the role check and the constant-time comparison.
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Role } from "@dozai/contracts";

export const CAN: Record<string, Role[]> = {
  read: ["admin", "agent_ops", "operator", "reviewer"],
  review: ["admin", "reviewer"],
  run: ["admin", "agent_ops", "operator"],
  intake: ["admin", "operator"],
  // Employees are set up by platform staff, never by a client. Until per-client users exist, administrators and agent operations are the platform staff.
  employee: ["admin", "agent_ops"],
  admin: ["admin"],
  // People who may say yes or no to what the agent proposes, change the autonomy dial and limits, or press the kill switch.
  approve: ["admin", "reviewer", "agent_ops"],
  controls: ["admin", "agent_ops"],
  killswitch: ["admin", "agent_ops", "operator"],
};

export type Handler = (req: Request, res: Response) => Promise<unknown>;
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
export const need = (cap: keyof typeof CAN) => (req: Request, res: Response, next: NextFunction) =>
  CAN[cap]!.includes(req.principal!.role) ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: `${req.principal!.role} cannot do this` } });
