// Core API. Routes, auth and role checks only; business rules live in @dozai/core.
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { timingSafeEqual } from "node:crypto";
import { DeleteCaseInputSchema, ImportInputSchema, MissionBriefSchema, ReviewDecisionInputSchema, RunAgentInputSchema, ROLES, type CaseRecord, type Principal, type Role } from "@dozai/contracts";
import type { EmployeeDefinition, MissionDrafter } from "@dozai/core";
import { draftMission, ScriptedMissionDrafter } from "@dozai/core";
import { checkMissionDefinition, phoneWordingProblems, GatewayTools, ACTION_KINDS, ACTION_LABELS, actionKindOf, approvalStats, MEMORY_SPEC, replaySession, type OutboxItem, buildAgentContext, buildVoiceForm, voiceFormHash, CampaignService, CaseService, ConversationRunner, evaluateRequirements, questionById, DozaiError, DEMO_TENANT, InMemoryStore, importParticipants, seedDemo, type CampaignAction, type MissionBundle } from "@dozai/core";
import { dispatchVoice, syncCalls, FakeChannels, FakeVoice, matchSignatureVariant, processInbox, processVoiceInbox, recordRejected, storeInteraktEvent, storeVoiceCallback, tick, type VoiceDispatchConfig, type VoicePort, type AgentRuntimePort, type ChannelPort } from "@dozai/adapters";
import { auditView, caseView } from "./views";

export interface RequestContext { svc: CaseService; agent: AgentRuntimePort; runner?: ConversationRunner }

export interface AppDeps {
  /** Builds the service for one request (per-request Catalyst SDK context in the cloud). */
  forRequest: (req: Request) => RequestContext | Promise<RequestContext>;
  /** Local development only: trust x-dozai-role / x-dozai-user headers. Never enable in a deployed environment. */
  devAuth: boolean;
  /** Resolves the signed-in user. Return null for "not signed in"; throw DozaiError(403) for "signed in but not allowed". */
  resolvePrincipal?: (req: Request) => Promise<Principal | null>;
  /** Encrypts contact numbers on import. Without it, participant import is unavailable. */
  pii?: { key: string; defaultCountryCode: string };
  /** What is switched on, shown on the Mission and Agent pages. */
  runtime: { whatsapp: "live" | "off"; agent: "claude" | "scripted"; model: string | null; contact_window: string; window_forced?: boolean; classifier?: "rules" | "claude"; draft_instrument_allowed?: boolean };
  /** Enables POST /api/admin/purge-all (deletes every record). Development projects only. */
  allowPurge?: boolean;
  /** One-time setup: invites the people listed in DOZAI_ROLES to sign in. Guarded by a long random token. */
  bootstrap?: { token: string; emails: string[]; invite: (req: Request, email: string) => Promise<void> };
  /** Token for the scheduler routes under /api/jobs. Long random value; unset disables them. */
  jobToken?: string;
  /** Turns a plain-language brief into a draft mission. Claude when a key is set, otherwise a plain scripted draft. */
  drafter?: MissionDrafter;
  /** Interakt WhatsApp: webhook verification and (optionally) the live channel. */
  interakt?: { webhookSecret: string; piiKey: string; tenant: string; channel?: ChannelPort; defaultCountryCode?: string };
  /** Phone calls. `webhookSecret` is part of the callback address; the callback body is never trusted, only the call id it names. */
  voice?: { port: VoicePort; cfg: VoiceDispatchConfig; tenant: string; webhookSecret?: string; callbackUrl?: string };
}

declare module "express-serve-static-core" {
  interface Request { principal?: Principal; ctx: RequestContext; rawBody?: Buffer }
}

const CAN: Record<string, Role[]> = {
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

type Handler = (req: Request, res: Response) => Promise<unknown>;
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { (req as Request).rawBody = buf; } })); // raw body is needed for webhook signatures

  const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
  const need = (cap: keyof typeof CAN) => (req: Request, res: Response, next: NextFunction) =>
    CAN[cap]!.includes(req.principal!.role) ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: `${req.principal!.role} cannot do this` } });
  const jobAuth = (req: Request) => !!deps.jobToken && safeEqual(String(req.header("x-job-token") ?? ""), deps.jobToken);

  // ---- routes that authenticate themselves (not by user session) -----------------------------------
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
    if (!jobAuth(req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const ctx = await deps.forRequest(req);
    res.json(await tick(ctx.svc, cfg.tenant, { piiKey: cfg.piiKey, channel: cfg.channel, agent: ctx.agent, runner: ctx.runner, voice: deps.voice && { port: deps.voice.port, cfg: deps.voice.cfg } }));
  }));

  app.get("/api/jobs/messages", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp is not configured" } });
    if (!jobAuth(req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
    const { svc } = await deps.forRequest(req);
    const types = ["message_queued", "message_sent", "message_status", "message_received"];
    const events = (await svc.store.listEvents(cfg.tenant)).filter(e => types.includes(e.type)).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 15);
    res.json({ events: events.map(e => ({ ts: e.ts, case_id: e.case_id, type: e.type, actor: e.actor, summary: e.summary })) });
  }));

  // Support view of one case: the ledger (which holds no personal data) and where the interview stands. No names, numbers or answer text.
  app.get("/api/jobs/case/:id", wrap(async (req, res) => {
    const cfg = deps.interakt;
    if (!cfg) return res.status(404).json({ error: { code: "NOT_CONFIGURED", message: "WhatsApp is not configured" } });
    if (!jobAuth(req)) return res.status(401).json({ error: { code: "BAD_TOKEN", message: "bad token" } });
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

  // ---- everything below needs a signed-in user --------------------------------------------------------
  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
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
  });

  const live = async (req: Request): Promise<CaseRecord[]> => (await req.ctx.svc.store.listCases(req.principal!.tenant_id)).filter(c => !c.deleted_at);
  const views = async (req: Request, cases: CaseRecord[]) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const [people, evidence] = await Promise.all([svc.store.listParticipants(t), svc.store.listAllEvidence()]);
    const byPerson = new Map(people.map(p => [p.participant_id, p]));
    return cases.map(c => caseView(c, byPerson.get(c.participant_id), evidence.filter(e => e.case_id === c.case_id)));
  };
  const oneView = async (req: Request, caseId: string) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const c = await svc.getCase(t, caseId);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    return caseView(c, await svc.store.getParticipant(t, c.participant_id), await svc.store.listEvidence(caseId));
  };

  // ---- identity and configuration -------------------------------------------------------------------
  app.get("/api/me", need("read"), (req, res) => res.json({ user: req.principal!.user_id, role: req.principal!.role, tenant: req.principal!.tenant_id, channel: deps.runtime.whatsapp === "live" ? "interakt" : "simulated", voice: deps.voice ? deps.voice.port.kind : "off", can_import: !!deps.pii, can_purge: !!deps.allowPurge }));

  // ---- missions ---------------------------------------------------------------------------------------------------------
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
      objective: b.objective ?? null, strategy: b.strategy ?? null,
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
  const definitionOf = (m: MissionBundle) => ({ mission_id: m.mission_id, version: m.version, name: m.name, programme_name: m.programme_name, intro_template: m.intro_template, templates: m.templates, policy: m.policy_overrides, agent_guidance: m.agent_guidance, employee_id: m.employee_id, employee_version: m.employee_version, objective: m.objective, evidence_requirements: m.evidence_requirements, strategy: m.strategy, instrument: m.instrument });
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

  // ---- phone calls: the form a mission is published as ------------------------------------------------------------------
  const voiceState = async (svc: CaseService, t: string, version: string) => {
    const m = await svc.getMission(t, version);
    const def = buildVoiceForm(m, await svc.employeeFor(m));
    const link = (await svc.store.getVoiceForm(t, m.version)) ?? null;
    return { definition: def, link, in_sync: !!link && link.definition_hash === voiceFormHash(def), voice: { enabled: !!deps.voice, kind: deps.voice?.port.kind ?? "off" } };
  };

  // Exactly what would be published, and whether what is published still matches the mission and the employee.
  app.get("/api/missions/:version/voice-form", need("read"), wrap(async (req, res) => res.json(await voiceState(req.ctx.svc, req.principal!.tenant_id, String(req.params.version)))));

  // Creates the form at the provider, or brings it up to date. A person reviews the preview first, so this needs an explicit confirmation.
  app.post("/api/missions/:version/voice-form/publish", need("employee"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    if (req.body?.confirm !== true) throw new DozaiError("CONFIRMATION_REQUIRED", "send {\"confirm\": true} after reviewing the preview", 400);
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const version = String(req.params.version);
    // One publish per mission at a time. Creating a form at ZoLabs is slow, and a second request that starts before the first has
    // saved its form id would create a second form. The lock lasts at most five minutes if a request dies halfway.
    const lock = `voicepub:${t}:${version}:${Math.floor(svc.now().getTime() / 300_000)}`;
    if (!(await svc.store.claim(lock))) throw new DozaiError("PUBLISH_IN_PROGRESS", "This phone form is already being published. Wait for it to finish, then refresh the page. Publishing again now would create a duplicate form at ZoLabs.", 409);
    try {
      const state = await voiceState(svc, t, version); // read after taking the lock, so a finished publish is seen as an existing form
      const { form_id } = await v.port.publishForm(state.definition, { existingFormId: state.link?.form_id, callbackUrl: v.callbackUrl });
      await svc.store.putVoiceForm({ tenant_id: t, mission_version: version, form_id, definition_hash: voiceFormHash(state.definition), published_at: svc.now().toISOString(), published_by: `${req.principal!.role}:${req.principal!.user_id}` });
      res.json(await voiceState(svc, t, version));
    } finally { await svc.store.unclaim(lock); }
  }));

  // The phone channel at a glance: is it connected and allowed to ring, which missions have a published form and whether it is
  // current, and the calls made so far. Transcripts and audio are personal data, so only reviewers and platform staff see them.
  app.get("/api/voice", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const v = deps.voice;
    const seesTranscripts = CAN.review!.includes(req.principal!.role) || CAN.employee!.includes(req.principal!.role);
    const forms = [];
    for (const m of await svc.listMissions(t)) {
      const s = await voiceState(svc, t, m.version);
      forms.push({ mission_version: m.version, name: m.name, form_id: s.link?.form_id ?? null, published_at: s.link?.published_at ?? null, published_by: s.link?.published_by ?? null, state: !s.link ? "not_published" : s.in_sync ? "current" : "out_of_date" });
    }
    const calls = (await svc.store.listCalls(t)).sort((a, b) => b.requested_at.localeCompare(a.requested_at)).slice(0, 100);
    const people = new Map<string, string>();
    for (const k of calls) {
      if (people.has(k.case_id)) continue;
      const c = await svc.store.getCase(t, k.case_id); const p = c && (await svc.store.getParticipant(t, c.participant_id));
      people.set(k.case_id, p?.display_name ?? "—");
    }
    res.json({
      kind: v?.port.kind ?? "off", calls_enabled: v?.cfg.callsEnabled ?? false,
      who_can_be_called: !v || !v.cfg.callsEnabled ? "nobody (calls are switched off)" : "anyone who has consented",
      callback_ready: !!v?.callbackUrl, can_check: CAN.employee!.includes(req.principal!.role), forms,
      calls: calls.map(k => ({ communication_id: k.communication_id, case_id: k.case_id, person: people.get(k.case_id), status: k.status, requested_at: k.requested_at, scheduled_for: k.scheduled_for ?? null, ended_at: k.ended_at ?? null, duration_seconds: k.duration_seconds ?? null, asked: k.asked, reason: k.reason ?? null, has_audio: !!(k.recording || k.audio_url), has_transcript: !!k.transcript, audio_url: seesTranscripts ? (k.recording ? `/calls/${k.communication_id}/recording` : k.audio_url ?? null) : null, transcript: seesTranscripts ? k.transcript ?? null : null })),
    });
  }));

  // A call's recording, streamed from ZoLabs with our own sign-in. Reviewers and platform staff only. Nothing is copied or stored here,
  // and the recording is reachable only while the call record exists, so deleting the case removes our way to it.
  app.get("/api/calls/:id/recording", need("read"), wrap(async (req, res) => {
    const role = req.principal!.role;
    if (!CAN.review!.includes(role) && !CAN.employee!.includes(role)) throw new DozaiError("FORBIDDEN", `${role} cannot listen to recordings`, 403);
    const v = deps.voice; const t = req.principal!.tenant_id;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    const call = await req.ctx.svc.store.getCall(t, String(req.params.id));
    if (!call || !call.recording) throw new DozaiError("NOT_FOUND", "there is no recording for this call", 404);
    const rec = await v.port.fetchRecording(call.communication_id);
    if (!rec) throw new DozaiError("NOT_FOUND", "the provider has no recording for this call", 404);
    res.set({ "content-type": rec.contentType, "content-length": String(rec.data.length), "cache-control": "private, no-store" }).send(rec.data);
  }));

  // Places a queued call now instead of waiting for the next scheduler run, and says what happened. The same safeguards apply:
  // the on/off switch, consent and a claim before ringing, so a call is never placed twice.
  const placeCallNow = async (svc: CaseService, tenant: string, outboxId: string): Promise<{ placed: boolean; status: string; error?: string }> => {
    const v = deps.voice;
    if (!v) return { placed: false, status: "pending", error: "phone calls are not switched on" };
    await dispatchVoice(svc, tenant, v.port, v.cfg);
    const o = (await svc.store.listOutbox(tenant)).find(x => x.outbox_id === outboxId);
    return { placed: o?.status === "sent", status: o?.status ?? "unknown", ...(o?.status === "failed" ? { error: String(o.payload.last_error ?? "the call could not be placed") } : {}) };
  };

  // A person asks for a phone call on a case. It goes through exactly the same door as the agent's request: the same checks
  // (consent, hours, attempts, a published form, something still missing) and the same approval, so staff cannot ring anyone the agent could not.
  app.post("/api/cases/:id/request-call", need("run"), wrap(async (req, res) => {
    if (!deps.voice) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    let c = await svc.getCase(t, id);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    const actor = `${req.principal!.role}:${req.principal!.user_id}`;
    if (c.status === "draft" || c.status === "ready") c = await svc.beginSession(t, id, actor);
    const mission = await svc.getMission(t, c.mission_version);
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim().length >= 5 ? req.body.reason.trim().slice(0, 300) : "Phone call requested by staff";
    const r = await new GatewayTools(svc).call({ session_id: `staff_${req.principal!.user_id}`.replace(/[^A-Za-z0-9_.:-]/g, "_"), tenant_id: t, case_id: id, mission_version: mission.version, employee_version: (await svc.employeeFor(mission)).version, actor }, "voice_call_request", { case_id: id, idempotency_key: `staff-${id}-${svc.now().getTime()}`, expected_version: c.version, reason });
    if (r.error) throw new DozaiError(r.error.code, r.error.message, 422);
    const held = !!(r.data as { held?: boolean } | undefined)?.held;
    // Not held: ring now. Held: it waits for approval, and approving rings.
    const now = held ? undefined : await placeCallNow(svc, t, (r.data as { outbox_id: string }).outbox_id);
    const message = held ? "The call is waiting for approval on the Approvals page. Approving it places the call." : now?.placed ? "Calling now." : `The call could not be placed: ${now?.error ?? "unknown reason"}.`;
    res.json({ requested: true, held, placed: !!now?.placed, message, case: await oneView(req, id) });
  }));

  // Asks the provider about unfinished calls and applies any that have finished, then lets the agent judge the answers. The page calls this
  // while a call is in progress, so results appear without waiting for the scheduler or for the provider's callback.
  app.post("/api/voice/sync", need("run"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) return res.json({ checked: 0, applied: 0, woken: [], errors: [] });
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id;
    const r = await syncCalls(svc, t, v.port);
    const woken: string[] = [];
    if (agent.resumeCase) for (const w of r.wake) {
      if (!(await svc.store.claim(`resume:${w.case_id}:${w.key}`))) continue; // the scheduler may have got there first
      if (!(await svc.agentGate(t, w.case_id)).ok) continue;
      try { await agent.resumeCase(svc, t, w.case_id); woken.push(w.case_id); } catch (e) { console.error("resume after call", (e as Error).message); }
    }
    res.json({ checked: r.checked, applied: r.applied, woken, errors: [...new Set(r.errors)] });
  }));

  // Proves the connection works: asks the provider who we are signed in as. Places no call and costs nothing.
  app.post("/api/voice/check", need("employee"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    try { res.json({ ok: true, kind: v.port.kind, account: await v.port.whoami() }); }
    catch (e) { res.json({ ok: false, kind: v.port.kind, error: (e as Error).message.slice(0, 300) }); }
  }));

  // Simulator only: finish the latest call on a case the way you choose, then apply it exactly as a real result would be.
  app.post("/api/cases/:id/simulate-call", need("run"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v || !(v.port instanceof FakeVoice)) throw new DozaiError("NOT_ALLOWED", "calls are real here: results come from the provider", 400);
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const call = (await svc.store.listCalls(t, id)).filter(k => k.status === "in_progress" || k.status === "scheduled").sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
    if (!call) throw new DozaiError("NO_CALL", "there is no call in progress on this case", 400);
    const outcome = String(req.body?.outcome ?? "answered");
    const base = { answered: {}, no_answer: { status: "no_answer" as const, consent_given: undefined, identity_confirmed: undefined }, refused: { consent_given: false }, wrong_person: { identity_confirmed: false } }[outcome];
    if (!base) throw new DozaiError("INVALID_INPUT", "outcome must be answered, no_answer, refused or wrong_person", 400);
    const answers = outcome === "answered" && req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.slice(0, 5000) : undefined;
    v.port.complete(call.communication_id, { ...base, answers, ...(transcript ? { transcript } : {}) });
    await storeVoiceCallback(svc, v.tenant, { communication_id: call.communication_id });
    const r = await processVoiceInbox(svc, v.tenant, v.port);
    let session = null;
    if (r.wake.some(w => w.case_id === id) && agent.resumeCase) session = await agent.resumeCase(svc, t, id);
    res.json({ applied: r.processed, session, case: await oneView(req, id) });
  }));

  // ---- employees: the reusable AI worker above every mission -----------------------------------------------------------
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
    const c = buildAgentContext(e, m);
    res.json({ employee_version: c.employee_version, mission_version: m.version, estimated_tokens: c.estimated_tokens, layers: c.layers, cached_as: ["platform and employee (shared by every mission)", "mission (shared by every case of this mission)"] });
  }));

  // Saved employees never change. A change is a new version; a mission that does not pin a version follows the newest.
  app.post("/api/employees", need("employee"), wrap(async (req, res) => {
    const e = await req.ctx.svc.createEmployee(req.principal!, req.body);
    res.status(201).json({ employee: employeeSummary(e, true, 0) });
  }));

  // ---- approvals, operating controls and replay -----------------------------------------------------------------------------
  const approvalView = (o: OutboxItem) => ({
    outbox_id: o.outbox_id, case_id: o.case_id, action: actionKindOf(o), label: ACTION_LABELS[actionKindOf(o)], state: o.approval!.state, held_at: o.approval!.held_at,
    decided_by: o.approval!.decided_by ?? null, decided_at: o.approval!.decided_at ?? null, note: o.approval!.note ?? null,
    summary: o.kind === "voice_call" ? `Phone call: ${String(o.payload.reason ?? "")}${Array.isArray(o.payload.asked) ? ` Will ask about: ${(o.payload.asked as string[]).join(", ")}.` : ""}${typeof o.payload.start_at === "string" ? ` For ${o.payload.start_at}.` : ""}`
      : o.kind === "whatsapp_template" ? `WhatsApp template "${String(o.payload.template_key)}"` : `WhatsApp message: ${String(o.payload.text ?? "")}`,
  });

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
    const now = d === "approve" && o.kind === "voice_call" ? await placeCallNow(req.ctx.svc, req.principal!.tenant_id, o.outbox_id) : undefined;
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

  // ---- campaigns --------------------------------------------------------------------------------------------------------
  const campaignList = async (req: Request) => {
    const cs = new CampaignService(req.ctx.svc); const t = req.principal!.tenant_id;
    const list = await cs.list(t);
    const progress = await cs.progress(t, list);
    return list.map(c => ({ ...c, progress: progress.get(c.campaign_id) }));
  };
  // One pass: queue the next batch, send what is queued, and pause a campaign whose sends keep failing.
  const campaignPass = async (req: Request) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const cs = new CampaignService(svc);
    const campaigns = await cs.run(t);
    const channel = deps.interakt?.channel ?? (deps.runtime.whatsapp === "live" ? undefined : new FakeChannels());
    const sent = channel ? await channel.dispatchOutbox(svc, t) : 0;
    return { campaigns, sent, paused: campaigns.length ? await cs.checkHealth(t) : [] };
  };

  app.get("/api/campaigns", need("read"), wrap(async (req, res) => res.json({ campaigns: await campaignList(req) })));

  app.post("/api/campaigns", need("intake"), wrap(async (req, res) => {
    const c = await new CampaignService(req.ctx.svc).create(req.principal!, req.body);
    res.status(201).json({ campaign: c });
  }));

  app.post("/api/campaigns/run-now", need("intake"), wrap(async (req, res) => res.json(await campaignPass(req))));

  app.post("/api/campaigns/:id/:action", need("intake"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const action = String(req.params.action) as CampaignAction;
    if (!["start", "pause", "resume", "stop"].includes(action)) throw new DozaiError("NOT_FOUND", "unknown campaign action", 404);
    const cs = new CampaignService(svc);
    if (action === "start" || action === "resume") {
      // Do not message hundreds of people with a flow that will only hand every reply to a person.
      const camp = await cs.get(t, String(req.params.id));
      const m = await svc.getMission(t, camp.mission_version);
      if (deps.runtime.whatsapp === "live") {
        if (m.instrument.draft && !deps.runtime.draft_instrument_allowed) throw new DozaiError("INSTRUMENT_NOT_APPROVED", "This mission's questions are not approved for live use, so every reply would be handed to a person. Approve the questions first.", 409);
        if (!m.templates.find(x => x.key === m.intro_template)?.provider_name) throw new DozaiError("TEMPLATE_NOT_CONFIGURED", "The intro template has no WhatsApp template name. Add the approved template's name to the mission.", 409);
      }
    }
    const campaign = await cs.act(req.principal!, String(req.params.id), action);
    const pass = action === "start" || action === "resume" ? await campaignPass(req) : null; // first batch now, so nobody waits for the next scheduler run
    res.json({ campaign: (await campaignList(req)).find(c => c.campaign_id === campaign.campaign_id), pass });
  }));

  // ---- cases ----------------------------------------------------------------------------------------------
  app.get("/api/cases", need("read"), wrap(async (req, res) => {
    const cases = (await live(req)).sort((a, b) => (b.last_touch ?? "").localeCompare(a.last_touch ?? ""));
    res.json({ cases: await views(req, cases) });
  }));

  app.get("/api/cases/:id", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const view = await oneView(req, id);
    const c = await svc.getCase(t, id);
    const evidence = await svc.store.listEvidence(id);
    const person = await svc.store.getParticipant(t, c.participant_id);
    const need = evaluateRequirements(await svc.getMission(t, c.mission_version), evidence, person?.recorded_employer);
    // Transcripts are personal data: only people who review cases or manage the platform see them.
    const seesTranscripts = CAN.review!.includes(req.principal!.role) || CAN.employee!.includes(req.principal!.role);
    const calls = (await svc.store.listCalls(t, id)).sort((a, b) => a.requested_at.localeCompare(b.requested_at)).map(k => ({ communication_id: k.communication_id, status: k.status, requested_at: k.requested_at, scheduled_for: k.scheduled_for ?? null, ended_at: k.ended_at ?? null, duration_seconds: k.duration_seconds ?? null, asked: k.asked, reason: k.reason ?? null, audio_url: seesTranscripts ? (k.recording ? `/calls/${k.communication_id}/recording` : k.audio_url ?? null) : null, transcript: seesTranscripts ? k.transcript ?? null : null }));
    res.json({
      calls, case: view, events: (await svc.store.listEvents(t, id)).map(auditView), evidence, decisions: await svc.store.listDecisions(id),
      // What the mission needs to know about this person and how much of it is settled. Labels and states only; answers stay in `evidence`.
      requirements: { complete: need.complete, needed: need.needed, collected: need.collected, verified: need.verified, conflicts: need.conflicts, gaps: need.gaps, items: need.items },
      sessions: (await svc.store.listSessions(t)).filter(s => s.case_id === id).map(s => ({ session_id: s.session_id, started_at: s.started_at, status: s.status, cost_usd: s.cost_usd, simulated: s.simulated, trigger: s.trigger ?? null })),
      // What the agent remembers (fixed facts only), when it is next due to wake, and what is waiting for a person's approval.
      memory: ((await svc.store.getMemory(t, id))?.items ?? []).map(m => ({ key: m.key, label: MEMORY_SPEC[m.key]?.label ?? m.key, value: m.value, at: m.at })),
      wakes: (await svc.store.listWakes(t, id)).filter(w => w.status === "pending").map(w => ({ wake_id: w.wake_id, at: w.at, reason: w.reason, note: w.note ?? null })),
      approvals: (await svc.store.listOutbox(t)).filter(o => o.case_id === id && o.approval).map(approvalView),
    });
  }));

  app.post("/api/cases/:id/review", need("review"), wrap(async (req, res) => {
    await req.ctx.svc.reviewDecide(req.principal!, String(req.params.id), ReviewDecisionInputSchema.parse(req.body));
    res.json({ case: await oneView(req, String(req.params.id)) });
  }));

  app.post("/api/cases/:id/ready", need("run"), wrap(async (req, res) => {
    await req.ctx.svc.markReady(req.principal!.tenant_id, String(req.params.id), `${req.principal!.role}:${req.principal!.user_id}`);
    res.json({ case: await oneView(req, String(req.params.id)) });
  }));

  app.post("/api/cases/:id/run-agent", need("run"), wrap(async (req, res) => {
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const { scenario } = RunAgentInputSchema.parse(req.body ?? {});
    const c = await svc.getCase(t, id);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    if (!["draft", "ready", "waiting", "running"].includes(c.status)) throw new DozaiError("ILLEGAL_STATE", `case is ${c.status}; an agent session cannot start`);
    const session = await agent.runCase(svc, t, id, scenario);
    res.json({ session, case: await oneView(req, id) });
  }));

  app.post("/api/cases/:id/resume-agent", need("run"), wrap(async (req, res) => {
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    if (!agent.resumeCase) throw new DozaiError("NOT_SUPPORTED", "this agent runtime cannot resume from a live reply");
    const session = await agent.resumeCase(svc, t, id);
    res.json({ session, case: await oneView(req, id) });
  }));

  // What was asked and what the participant answered, for reviewers. Approved wording plus recorded answers only.
  app.get("/api/cases/:id/conversation", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    await oneView(req, id); // 404/410 for missing or deleted cases
    const st = await svc.store.getConversation(t, id);
    const instrument = (await svc.getMission(t, (await svc.getCase(t, id)).mission_version)).instrument;
    const questions = instrument.questions;
    const sent = (await svc.store.listOutbox(t)).filter(o => o.case_id === id && o.kind === "whatsapp_text")
      .map(o => ({ at: o.created_at, from: "system" as const, text: String(o.payload.text ?? ""), delivered: o.status }));
    const answered = (st?.answers ?? []).map(a => ({ at: a.at, from: "participant" as const, text: a.label ?? a.value, question: a.question_id }));
    const messages = [...sent, ...answered].sort((a, b) => a.at.localeCompare(b.at));
    res.json({
      status: st?.status ?? "not_started", current: st?.current ? { id: st.current, text: questionById(instrument, st.current)?.text ?? "" } : null,
      escalation_reason: st?.escalation_reason ?? null, reasks: st?.reasks ?? 0, answered: st?.answers.length ?? 0, questions_total: questions.length, messages,
    });
  }));

  // Simulated participant reply, only when WhatsApp is off. It goes through exactly the same conversation runner.
  app.post("/api/cases/:id/simulate-reply", need("run"), wrap(async (req, res) => {
    if (deps.runtime.whatsapp === "live") throw new DozaiError("NOT_ALLOWED", "WhatsApp is live: replies come from the participant", 400);
    const { svc, agent, runner } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    if (!runner) throw new DozaiError("NOT_CONFIGURED", "the conversation runner is not configured", 503);
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 500) : "";
    const result = await runner.handleReply(t, id, text);
    await new FakeChannels().dispatchOutbox(svc, t); // "send" what was queued
    let session = null;
    if (result.finished && agent.resumeCase) session = await agent.resumeCase(svc, t, id);
    res.json({ result, session, case: await oneView(req, id) });
  }));

  app.post("/api/cases/:id/delete", need("admin"), wrap(async (req, res) => {
    const id = String(req.params.id);
    const input = DeleteCaseInputSchema.parse(req.body);
    if (input.confirm !== id) throw new DozaiError("CONFIRMATION_MISMATCH", "type the case id exactly to confirm", 400);
    await req.ctx.svc.deleteCase(req.principal!, id, input.reason_code);
    res.json({ deleted: true, case_id: id });
  }));

  // ---- participants ---------------------------------------------------------------------------------------------
  app.post("/api/participants/import", need("intake"), wrap(async (req, res) => {
    if (!deps.pii) throw new DozaiError("NOT_CONFIGURED", "DOZAI_PII_KEY is not set, so contact numbers cannot be stored safely", 503);
    const input = ImportInputSchema.parse(req.body);
    res.json(await importParticipants(req.ctx.svc, req.principal!, input.rows, { piiKey: deps.pii.key, defaultCountryCode: deps.pii.defaultCountryCode, missionVersion: input.mission_version }));
  }));

  // ---- review, audit, sessions --------------------------------------------------------------------------------
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

  // ---- WhatsApp operations ---------------------------------------------------------------------------------------
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

  // ---- errors ---------------------------------------------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DozaiError) return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: "INVALID_INPUT", message: err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") } });
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL", message: "unexpected error" } });
  });

  return app;
}
