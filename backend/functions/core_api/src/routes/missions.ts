// Missions: list, view, create with the drafter, check, sign off and delete.
import type { Express } from "express";
import { MissionBriefSchema } from "@dozai/contracts";
import { draftMission, ScriptedMissionDrafter } from "@dozai/core";
import { checkMissionDefinition, phoneWordingProblems, CaseService, DozaiError, type MissionBundle } from "@dozai/core";
import type { AppDeps } from "../deps";
import { need, wrap } from "../http";
import { live } from "./case-views";

export function registerMissionRoutes(app: Express, deps: AppDeps) {
  const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  // Who does a mission: the pinned version, or the current version of the employee it names.
  const employeeInfo = async (svc: CaseService, b: MissionBundle) => {
    const e = await svc.employeeFor(b);
    return { employee_id: e.employee_id, version: e.version, name: e.name, pinned: !!b.employee_version };
  };
  const missionView = (svc: CaseService, b: MissionBundle) => {
    const p = svc.policyFor(b);
    return {
      mission_id: b.mission_id, version: b.version, name: b.name, instrument_signed_off: b.instrument_signed_off, signed_off: b.instrument.signed_off ?? null, builtin: !b.created_at,
      created_at: b.created_at ?? null, created_by: b.created_by ?? null, programme_name: b.programme_name ?? null, intro_template: b.intro_template, agent_guidance: b.agent_guidance ?? null,
      objective: b.objective ?? null, strategy: b.strategy ?? null, outcomes: b.outcomes ?? null, verdict_labels: b.verdict_labels ?? null,
      requirements: (b.evidence_requirements ?? []).map(r => ({ key: r.key, label: r.label, hint: r.hint ?? null, required: r.required ?? true, min_confidence: r.min_confidence ?? 0.6, when: r.when ?? null, checked_against: r.verify_against ?? null })),
      modules: b.modules.map(m => ({ key: m.key, title: m.title, branch: m.branch, questions: m.question_ids.length })),
      questions_total: b.modules.reduce((n, m) => n + m.question_ids.length, 0),
      templates: b.templates.map(t => ({ key: t.key, language: t.language, purpose: t.purpose, provider_name: t.provider_name ?? null, variables: t.body_fields?.length ?? 0 })),
      policy: { max_attempts: p.maxAttempts, auto_confirm_at: p.autoConfirmAt, contact_window: deps.runtime.window_forced ? deps.runtime.contact_window : `${hhmm(p.windowStartHour)}-${hhmm(p.windowEndHour)} IST` },
      runtime: deps.runtime,
      instrument: { version: b.instrument.version, draft: b.instrument.draft, questions: b.instrument.questions.length, max_reasks: b.instrument.max_reasks, max_messages: b.instrument.max_messages, faq_answers: b.instrument.faq.length },
      tools: ["case_get_context", "mission_get_bundle", "case_get_timeline", "whatsapp_send_template", "callback_schedule", "voice_call_request", "decision_propose", "review_request"],
    };
  };

  // The mission new participants join by default (the most recently added), or one chosen with ?version=.
  app.get("/api/mission", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const version = typeof req.query.version === "string" ? req.query.version : undefined;
    const b = version ? await svc.getMission(t, version) : await svc.defaultMission(t);
    res.json({ ...missionView(svc, b), employee: await employeeInfo(svc, b) });
  }));

  app.get("/api/missions", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx;
    const all = await svc.listMissions(req.principal!.tenant_id);
    const cases = await live(req);
    const count = (v: string) => cases.filter(c => (c.mission_version ?? all[0]!.version) === v).length;
    const missions = [];
    for (const m of all) missions.push({ ...missionView(svc, m), employee: await employeeInfo(svc, m), participants: count(m.version) });
    res.json({ missions, default_version: all.at(-1)!.version });
  }));

  // A mission in the shape the "add a mission" form accepts, so a new version can start from an existing one.
  const definitionOf = (m: MissionBundle) => ({ outcomes: m.outcomes, verdict_labels: m.verdict_labels, mission_id: m.mission_id, version: m.version, name: m.name, programme_name: m.programme_name, intro_template: m.intro_template, templates: m.templates, policy: m.policy_overrides, agent_guidance: m.agent_guidance, employee_id: m.employee_id, employee_version: m.employee_version, objective: m.objective, evidence_requirements: m.evidence_requirements, strategy: m.strategy, instrument: m.instrument });
  app.get("/api/missions/:version/definition", need("read"), wrap(async (req, res) => {
    const m = await req.ctx.svc.getMission(req.principal!.tenant_id, String(req.params.version));
    res.json({ definition: definitionOf(m) });
  }));

  // Deletes a mission nothing uses (a draft that was not wanted, a test). The ZoLabs form made for it stays at ZoLabs, which has no delete.
  app.post("/api/missions/:version/delete", need("admin"), wrap(async (req, res) => {
    const version = String(req.params.version);
    if (req.body?.confirm !== version) throw new DozaiError("CONFIRMATION_MISMATCH", "type the mission version exactly to confirm", 400);
    await req.ctx.svc.deleteMission(req.principal!, version);
    res.json({ deleted: true, version });
  }));

  // Signing off the wording approves the SAME mission: same version, no second mission. It records who did it and when. The questions may have
  // been edited on the way; they are checked like a new draft. After this the mission is approved and never changes again: a later change is a
  // new version, as for any approved mission.
  app.post("/api/missions/:version/sign-off", need("admin"), wrap(async (req, res) => {
    if (req.body?.confirm !== true) throw new DozaiError("CONFIRMATION_REQUIRED", "send {\"confirm\": true} after reading the wording", 400);
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const m = await svc.getMission(t, String(req.params.version));
    if (!m.instrument.draft) throw new DozaiError("ALREADY_SIGNED_OFF", "this wording is already signed off", 409);
    // Only the questions and what to find out can change here. Who signed and when is set by the platform whatever the request says.
    const edits = req.body?.edits as { instrument?: Record<string, unknown>; evidence_requirements?: unknown } | undefined;
    const def = { ...definitionOf(m), instrument: { ...m.instrument, draft: false } } as Record<string, unknown>;
    if (edits && typeof edits === "object") {
      if (edits.instrument && typeof edits.instrument === "object") def.instrument = { ...edits.instrument, version: m.instrument.version, draft: false };
      if (Array.isArray(edits.evidence_requirements)) def.evidence_requirements = edits.evidence_requirements;
      // The phone wording is fixed: editing the written questions must leave what is said on a call exactly as it was.
      const problems = [...checkMissionDefinition(def).problems, ...phoneWordingProblems(m.instrument, def.instrument as typeof m.instrument)];
      if (problems.length) throw new DozaiError("INVALID_MISSION", problems.slice(0, 6).join(" "), 400);
    }
    const signed = await svc.signOffMission(req.principal!, m.version, def);
    res.json({ mission: { ...missionView(svc, signed), employee: await employeeInfo(svc, signed) } });
  }));

  // Checks a mission definition without saving it, for the question editor: what is wrong in plain words, and what the voice agent would say
  // for each question. Nothing is stored and no model is called.
  app.post("/api/missions/check", need("read"), wrap(async (req, res) => { res.json(checkMissionDefinition(req.body)); }));

  // Mission Studio: a plain-language brief in, a draft mission out. Nothing is saved: a person reads the draft, saves it as a draft
  // mission, and later signs the wording off. The drafter sees the brief only, never anything about a person.
  const drafter = deps.drafter ?? new ScriptedMissionDrafter();
  app.post("/api/missions/draft", need("admin"), wrap(async (req, res) => {
    const parsed = MissionBriefSchema.safeParse(req.body);
    if (!parsed.success) throw new DozaiError("INVALID_BRIEF", parsed.error.issues.map(i => `${i.path.join(".") || "brief"}: ${i.message}`).join("; "), 400);
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const gate = await svc.agentGate(t); // drafting uses the model, so the kill switch and the spend limit apply
    if (!gate.ok) throw new DozaiError(gate.code, gate.message, 429);
    const base = await svc.getMission(t, parsed.data.start_from ?? (await svc.defaultMission(t)).version);
    res.json(await draftMission(drafter, parsed.data, base, (await svc.listMissions(t)).map(m => m.version)));
  }));

  // Saved missions never change. A change is a new version; participants already loaded keep the version they started with.
  app.post("/api/missions", need("admin"), wrap(async (req, res) => {
    const m = await req.ctx.svc.createMission(req.principal!, req.body);
    res.status(201).json({ mission: { ...missionView(req.ctx.svc, m), employee: await employeeInfo(req.ctx.svc, m) } });
  }));
}
