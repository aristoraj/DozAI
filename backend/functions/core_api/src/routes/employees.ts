// Employees: the reusable AI worker above every mission.
import type { Express } from "express";
import type { EmployeeDefinition } from "@dozai/core";
import { DozaiError } from "@dozai/core";
import { buildAgentContext } from "@dozai/core";
import type { AppDeps } from "../deps";
import { CAN, need, wrap } from "../http";

export function registerEmployeeRoutes(app: Express, deps: AppDeps) {
  const employeeSummary = (e: EmployeeDefinition, current: boolean, missionsUsing: number) => ({
    employee_id: e.employee_id, version: e.version, name: e.name, purpose: e.purpose, builtin: !e.created_at, current,
    created_at: e.created_at ?? null, created_by: e.created_by ?? null, tools: e.allowed_tools.length, missions_using: missionsUsing,
  });

  app.get("/api/employees", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx;
    const [all, missions] = await Promise.all([svc.listEmployees(), svc.listMissions(req.principal!.tenant_id)]);
    const used = new Map<string, number>();
    for (const m of missions) { const v = (await svc.employeeFor(m)).version; used.set(v, (used.get(v) ?? 0) + 1); }
    const newest = new Map<string, string>();
    for (const e of all) newest.set(e.employee_id, e.version); // listed oldest first, so the last one wins
    res.json({ employees: all.map(e => employeeSummary(e, newest.get(e.employee_id) === e.version, used.get(e.version) ?? 0)), can_edit: CAN.employee!.includes(req.principal!.role) });
  }));

  app.get("/api/employees/:version", need("read"), wrap(async (req, res) => res.json({ employee: await req.ctx.svc.getEmployee(String(req.params.version)) })));

  // Exactly what the agent is told for one mission, layer by layer. It never includes anything about a person.
  app.get("/api/employees/:version/context", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const e = await svc.getEmployee(String(req.params.version));
    const mv = typeof req.query.mission_version === "string" ? req.query.mission_version : undefined;
    const m = mv ? await svc.getMission(t, mv) : await svc.defaultMission(t);
    const pv = typeof req.query.platform_version === "string" ? req.query.platform_version : undefined;
    const platform = pv ? (await svc.listPlatform()).find(p => p.version === pv) : await svc.currentPlatform();
    if (!platform) throw new DozaiError("NOT_FOUND", `platform version ${pv} does not exist`, 404);
    const c = buildAgentContext(e, m, platform);
    res.json({ platform_version: c.platform_version, employee_version: c.employee_version, mission_version: m.version, estimated_tokens: c.estimated_tokens, layers: c.layers, cached_as: ["platform and employee (shared by every mission)", "mission (shared by every case of this mission)"] });
  }));

  // Saved employees never change. A change is a new version; a mission that does not pin a version follows the newest.
  app.post("/api/employees", need("employee"), wrap(async (req, res) => {
    const e = await req.ctx.svc.createEmployee(req.principal!, req.body);
    res.status(201).json({ employee: employeeSummary(e, true, 0) });
  }));

  // ---- the platform layer: the rules every employee works under ---------------------------------------------------------
  // Saved versions never change; the newest applies to every employee and mission at once, so a change is previewed before it is saved.
  app.get("/api/platform", need("read"), wrap(async (req, res) => {
    const all = await req.ctx.svc.listPlatform();
    const current = all.at(-1)!;
    res.json({ current_version: current.version, platform: all.map(p => ({ ...p, builtin: !p.created_at, current: p.version === current.version })).reverse(), can_edit: CAN.employee!.includes(req.principal!.role) });
  }));
  app.post("/api/platform", need("employee"), wrap(async (req, res) => {
    const p = await req.ctx.svc.createPlatform(req.principal!, req.body);
    res.status(201).json({ platform: p });
  }));
}
