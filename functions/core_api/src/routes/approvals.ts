// Approvals, operating controls and session replay.
import type { Express } from "express";
import { ACTION_KINDS, ACTION_LABELS, actionKindOf, approvalStats, replaySession, type OutboxItem, DozaiError } from "@dozai/core";
import type { AppDeps } from "../deps";
import { CAN, need, wrap } from "../http";
import { placeCallNow } from "./voice";

export const approvalView = (o: OutboxItem) => ({
  outbox_id: o.outbox_id, case_id: o.case_id, action: actionKindOf(o), label: ACTION_LABELS[actionKindOf(o)], state: o.approval!.state, held_at: o.approval!.held_at,
  decided_by: o.approval!.decided_by ?? null, decided_at: o.approval!.decided_at ?? null, note: o.approval!.note ?? null,
  summary: o.kind === "voice_call" ? `Phone call: ${String(o.payload.reason ?? "")}${Array.isArray(o.payload.asked) ? ` Will ask about: ${(o.payload.asked as string[]).join(", ")}.` : ""}${typeof o.payload.start_at === "string" ? ` For ${o.payload.start_at}.` : ""}`
    : o.kind === "whatsapp_template" ? `WhatsApp template "${String(o.payload.template_key)}"` : `WhatsApp message: ${String(o.payload.text ?? "")}`,
});

export function registerApprovalRoutes(app: Express, deps: AppDeps) {

  app.get("/api/approvals", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const all = (await svc.store.listOutbox(t)).filter(o => o.approval);
    const rank = (o: OutboxItem) => (o.approval!.state === "held" ? 0 : 1);
    const rows = all.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.approval!.held_at.localeCompare(b.approval!.held_at) : (b.approval!.decided_at ?? "").localeCompare(a.approval!.decided_at ?? "")));
    const named = await Promise.all(rows.slice(0, 100).map(async o => { const c = await svc.store.getCase(t, o.case_id); const p = c && await svc.store.getParticipant(t, c.participant_id); return { ...approvalView(o), participant: p?.display_name ?? "—" }; }));
    res.json({ approvals: named, waiting: all.filter(o => o.approval!.state === "held").length, can_decide: CAN.approve!.includes(req.principal!.role) });
  }));

  app.post("/api/approvals/:id/:decision", need("approve"), wrap(async (req, res) => {
    const d = String(req.params.decision);
    if (d !== "approve" && d !== "reject") throw new DozaiError("NOT_FOUND", "unknown decision", 404);
    const note = typeof req.body?.note === "string" ? req.body.note : "";
    const o = await req.ctx.svc.decideApproval(req.principal!, String(req.params.id), d, note);
    const now = d === "approve" && o.kind === "voice_call" ? await placeCallNow(deps, req.ctx.svc, req.principal!.tenant_id, o.outbox_id) : undefined;
    res.json({ outbox_id: o.outbox_id, status: now ? now.status : o.status, ...(now ? { call: now } : {}) });
  }));

  app.get("/api/controls", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const controls = await svc.controls(t), outbox = await svc.store.listOutbox(t);
    res.json({
      controls, actions: ACTION_KINDS.map(k => ({ kind: k, label: ACTION_LABELS[k] })), stats: approvalStats(outbox, controls),
      spend_24h: Math.round((await svc.spendLast24h(t)) * 10_000) / 10_000,
      queued_unsent: outbox.filter(o => o.status === "pending").length, held: outbox.filter(o => o.status === "held").length,
      pending_wakes: (await svc.store.listWakes(t)).filter(w => w.status === "pending").length,
      can_change: CAN.controls!.includes(req.principal!.role), can_pause: CAN.killswitch!.includes(req.principal!.role),
    });
  }));

  // The kill switch is open to more people than the rest of the dial: stopping is always safe, loosening is not.
  app.post("/api/controls", wrap(async (req, res, ) => {
    const role = req.principal!.role;
    const onlyPause = Object.keys(req.body ?? {}).every(k => k === "paused" || k === "reason");
    if (!(onlyPause ? CAN.killswitch : CAN.controls)!.includes(role)) throw new DozaiError("FORBIDDEN", `${role} cannot do this`, 403);
    res.json({ controls: await req.ctx.svc.updateControls(req.principal!, req.body) });
  }));

  // What an agent session did, checked again under today's rules. Nothing is sent or changed.
  app.get("/api/sessions/:id/replay", need("read"), wrap(async (req, res) => {
    const r = await replaySession(req.ctx.svc, req.principal!.tenant_id, String(req.params.id));
    if (!r) throw new DozaiError("NOT_FOUND", "no such session", 404);
    res.json(r);
  }));
}
