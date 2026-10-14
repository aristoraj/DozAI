// CaseService: every business operation. Claude (via tools), the API and workers all go through here.
// Rules enforced: one door for state changes, ledger event per change, policy checks, version checks.
import type { CaseEvent, CaseRecord, Decision, EventType, Evidence, LivelihoodState, Outcome, Participant, Principal, ReviewDecisionInput, Status } from "@dozai/contracts";
import { canAutoConfirm, checkContact, DEFAULT_POLICY, localHour, transitionCase, type ContactCheck, type ContactPolicy } from "@dozai/domain";
import { GENESIS, hashEvent, newId, verifyChain, type ChainCheck } from "./ledger";
import { DEFAULT_EMPLOYEE_ID, parseEmployee, VERIFICATION_EMPLOYEE_V1, type EmployeeDefinition } from "./employee";
import { findingProblem, parseMission, PLACEMENT_RETENTION_V1, type MissionBundle } from "./mission";
import type { OutboxItem, ReviewTask, Store } from "./store";
import { actionKindOf, ControlsPatchSchema, defaultControls, type Controls } from "./controls";
import { memoryProblem, withNote, type CaseMemory, type MemoryKey } from "./memory";
import type { WakeReason, WakeRequest } from "./wake";

export class DozaiError extends Error {
  constructor(public code: string, message: string, public httpStatus = 422) { super(message); }
}

export interface InboundInput {
  provider_event_id: string;
  channel: "whatsapp" | "voice";
  summary: string;
  answers?: { question_id: string; value: string; confidence: number }[];
  consent?: "granted" | "declined";
  opt_out?: boolean;
}

export interface ProposeInput {
  proposed_outcome: Outcome;
  /** One of the mission's own findings (see MissionBundle.outcomes), or null when the evidence does not settle it. */
  livelihood_state: string | null;
  confidence: number; // 0..1
  evidence_refs: string[];
  rationale: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const STOPPED: Status[] = ["review", "complete"];

export class CaseService {
  /** Testing override (DOZAI_DEMO_WINDOW): contact hours that beat every mission's own window. */
  forceWindow?: { windowStartHour: number; windowEndHour: number };
  /** Phone calls are available. Set by the platform when a voice channel (or its simulator) is configured. */
  voiceEnabled = false;
  private missionCache = new Map<string, MissionBundle>();
  private employeeCache = new Map<string, EmployeeDefinition>();

  constructor(
    readonly store: Store,
    readonly now: () => Date = () => new Date(),
    readonly policy: ContactPolicy = DEFAULT_POLICY,
  ) {}

  // ---- missions -------------------------------------------------------------

  /** A mission by version. No version means the built-in mission (cases made before missions existed). Missions never change, so this is cached. */
  async getMission(tenant: string, version?: string): Promise<MissionBundle> {
    if (!version || version === PLACEMENT_RETENTION_V1.version) return PLACEMENT_RETENTION_V1;
    const key = `${tenant}|${version}`;
    const hit = this.missionCache.get(key);
    if (hit) return hit;
    const m = await this.store.getMission(tenant, version);
    if (!m) throw new DozaiError("MISSION_NOT_FOUND", `mission ${version} does not exist`, 404);
    this.missionCache.set(key, m);
    return m;
  }

  /**
   * Deletes a mission that nothing uses. A mission that has participants or campaigns is kept, because their history points at it
   * and reports would break: delete those people first, or keep the mission. The built-in mission cannot be deleted.
   */
  async deleteMission(p: Principal, version: string): Promise<void> {
    if (version === PLACEMENT_RETENTION_V1.version) throw new DozaiError("MISSION_BUILTIN", "the built-in mission cannot be deleted", 409);
    await this.getMission(p.tenant_id, version); // 404 when it does not exist
    const cases = (await this.store.listCases(p.tenant_id)).filter(c => (c.mission_version ?? PLACEMENT_RETENTION_V1.version) === version && !c.deleted_at).length;
    const campaigns = (await this.store.listCampaigns(p.tenant_id)).filter(c => c.mission_version === version).length;
    if (cases || campaigns) {
      const parts = [cases ? `${cases} participant${cases === 1 ? "" : "s"}` : "", campaigns ? `${campaigns} campaign${campaigns === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      throw new DozaiError("MISSION_IN_USE", `${parts} use this mission, so it cannot be deleted. Delete those first, or keep the mission.`, 409);
    }
    await this.store.deleteMission(p.tenant_id, version);
    this.missionCache.delete(`${p.tenant_id}|${version}`);
    console.log(`mission ${version} deleted by ${p.role}:${p.user_id}`);
  }

  /** The built-in mission first, then the saved ones, oldest first. */
  async listMissions(tenant: string): Promise<MissionBundle[]> {
    const saved = (await this.store.listMissions(tenant)).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return [PLACEMENT_RETENTION_V1, ...saved];
  }

  /** What new participants join when nothing is chosen: the most recently added mission. */
  async defaultMission(tenant: string): Promise<MissionBundle> { return (await this.listMissions(tenant)).at(-1)!; }

  async createMission(p: Principal, raw: unknown): Promise<MissionBundle> {
    const { bundle, problems } = parseMission(raw, `${p.role}:${p.user_id}`, this.now());
    if (!bundle) throw new DozaiError("INVALID_MISSION", problems.slice(0, 8).join("; "), 400);
    // The employee must exist now, so a mission can never be saved against one that will not be found later.
    try { await this.employeeFor(bundle); } catch (e) { throw new DozaiError("INVALID_MISSION", (e as Error).message, 400); }
    if (!(await this.store.putMission(p.tenant_id, bundle))) throw new DozaiError("MISSION_EXISTS", `version ${bundle.version} already exists. Saved missions never change: use a new version name.`, 409);
    return bundle;
  }

  // ---- employees ------------------------------------------------------------

  /** An employee version. The built-in employee is always available; saved versions never change, so they are cached. */
  async getEmployee(version: string): Promise<EmployeeDefinition> {
    if (version === VERIFICATION_EMPLOYEE_V1.version) return VERIFICATION_EMPLOYEE_V1;
    const hit = this.employeeCache.get(version);
    if (hit) return hit;
    const e = await this.store.getEmployee(version);
    if (!e) throw new DozaiError("EMPLOYEE_NOT_FOUND", `employee version ${version} does not exist`, 404);
    this.employeeCache.set(version, e);
    return e;
  }

  /** The built-in employee first, then the saved ones, oldest first. */
  async listEmployees(): Promise<EmployeeDefinition[]> {
    const saved = (await this.store.listEmployees()).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return [VERIFICATION_EMPLOYEE_V1, ...saved];
  }

  /** The newest version of one employee. */
  async currentEmployee(employeeId: string): Promise<EmployeeDefinition> {
    const mine = (await this.listEmployees()).filter(e => e.employee_id === employeeId);
    if (!mine.length) throw new DozaiError("EMPLOYEE_NOT_FOUND", `no employee called ${employeeId}`, 404);
    return mine.at(-1)!;
  }

  /** Who does this mission: the pinned version, or the current version of the employee it names. */
  async employeeFor(m: { employee_id?: string; employee_version?: string }): Promise<EmployeeDefinition> {
    if (m.employee_version) {
      const e = await this.getEmployee(m.employee_version);
      if (m.employee_id && e.employee_id !== m.employee_id) throw new DozaiError("EMPLOYEE_MISMATCH", `version ${m.employee_version} belongs to ${e.employee_id}, not ${m.employee_id}`, 400);
      return e;
    }
    return this.currentEmployee(m.employee_id ?? DEFAULT_EMPLOYEE_ID);
  }

  async createEmployee(p: Principal, raw: unknown): Promise<EmployeeDefinition> {
    const { employee, problems } = parseEmployee(raw, `${p.role}:${p.user_id}`, this.now());
    if (!employee) throw new DozaiError("INVALID_EMPLOYEE", problems.slice(0, 8).join("; "), 400);
    if (!(await this.store.putEmployee(employee))) throw new DozaiError("EMPLOYEE_EXISTS", `version ${employee.version} already exists. Saved employees never change: use a new version name.`, 409);
    return employee;
  }

  /** The contact rules that apply to a case: platform defaults, then the mission's changes, then the testing override. */
  policyFor(m: MissionBundle): ContactPolicy { return { ...this.policy, ...(m.policy_overrides ?? {}), ...(this.forceWindow ?? {}) }; }

  // ---- ledger ---------------------------------------------------------------

  async emit(c: { tenant_id: string; case_id: string }, type: EventType, actor: string, summary: string, payload: Record<string, unknown> = {}): Promise<CaseEvent> {
    const last = await this.store.lastEvent(c.tenant_id, c.case_id);
    const base = {
      event_id: newId("evt"), tenant_id: c.tenant_id, case_id: c.case_id, seq: (last?.seq ?? 0) + 1,
      type, actor, summary, payload, prev_hash: last?.hash ?? GENESIS, ts: this.now().toISOString(),
    };
    const ev: CaseEvent = { ...base, hash: hashEvent(base) };
    await this.store.appendEvent(ev);
    return ev;
  }

  async verifyLedger(tenant: string): Promise<{ ok: boolean; cases: number; events: number; failures: { case_id: string; at_seq: number; reason: string }[] }> {
    const all = await this.store.listEvents(tenant);
    const byCase = new Map<string, CaseEvent[]>();
    for (const e of all) byCase.set(e.case_id, [...(byCase.get(e.case_id) ?? []), e]);
    const failures: { case_id: string; at_seq: number; reason: string }[] = [];
    for (const [case_id, evs] of byCase) {
      const r: ChainCheck = verifyChain(evs.sort((a, b) => a.seq - b.seq));
      if (!r.ok) failures.push({ case_id, at_seq: r.at_seq, reason: r.reason });
    }
    return { ok: failures.length === 0, cases: byCase.size, events: all.length, failures };
  }

  // ---- cases ----------------------------------------------------------------

  async getCase(tenant: string, caseId: string): Promise<CaseRecord> {
    const c = await this.store.getCase(tenant, caseId);
    if (!c) throw new DozaiError("NOT_FOUND", `case ${caseId} not found`, 404);
    return c;
  }

  async createCase(input: { tenant_id: string; run_id: string; case_id: string; participant: Participant; owner?: string; next_action?: string; actor?: string; meta?: Record<string, unknown>; mission_version?: string }): Promise<CaseRecord> {
    if (input.mission_version) await this.getMission(input.tenant_id, input.mission_version); // refuse a mission that does not exist
    await this.store.putParticipant(input.participant);
    const c: CaseRecord = {
      case_id: input.case_id, tenant_id: input.tenant_id, run_id: input.run_id, participant_id: input.participant.participant_id,
      status: "draft", outcome: null, livelihood_state: null, confidence: 0, version: 1,
      next_action: input.next_action ?? "Mark ready to start outreach", owner: input.owner ?? "Unassigned",
      attempts: 0, last_touch: null, reason: "Case created from programme record.",
      mission_version: input.mission_version, created_at: this.now().toISOString(),
    };
    if (!(await this.store.casCase(c, 0))) throw new DozaiError("CASE_EXISTS", `case ${c.case_id} already exists`, 409);
    await this.emit(c, "case_created", input.actor ?? "system", "Case created from programme record", { run_id: input.run_id, mission_version: input.mission_version ?? PLACEMENT_RETENTION_V1.version, ...input.meta });
    return c;
  }

  /** The only way status changes. Validates, bumps the version atomically, then writes the ledger event. */
  async transition(
    tenant: string, caseId: string, expectedVersion: number, to: Status,
    o: { actor: string; summary: string; outcome?: Outcome; patch?: Partial<Omit<CaseRecord, "status" | "outcome" | "version" | "case_id" | "tenant_id">> },
  ): Promise<CaseRecord> {
    const c = await this.getCase(tenant, caseId);
    const r = transitionCase({ status: c.status, outcome: c.outcome, version: c.version }, { expectedVersion, to, outcome: o.outcome });
    if (!r.ok) throw new DozaiError(r.code, r.message, r.code === "VERSION_CONFLICT" ? 409 : 422);
    const next: CaseRecord = { ...c, ...o.patch, status: r.state.status, outcome: r.state.outcome, version: r.state.version, last_touch: this.now().toISOString() };
    if (!(await this.store.casCase(next, expectedVersion))) throw new DozaiError("VERSION_CONFLICT", "case changed concurrently", 409);
    await this.emit(next, "status_changed", o.actor, o.summary, { from: c.status, to, outcome: o.outcome ?? null, version: next.version });
    return next;
  }

  /** Walk legal steps to `evaluating` (used when a response or proposal arrives). */
  private async toEvaluating(c: CaseRecord, actor: string): Promise<CaseRecord> {
    if (c.status === "evaluating") return c;
    if (c.status === "ready") c = await this.transition(c.tenant_id, c.case_id, c.version, "running", { actor, summary: "Session started" });
    if (["running", "waiting", "calling"].includes(c.status)) return this.transition(c.tenant_id, c.case_id, c.version, "evaluating", { actor, summary: "Evaluating evidence" });
    throw new DozaiError("ILLEGAL_STATE", `cannot evaluate from ${c.status}`);
  }

  async markReady(tenant: string, caseId: string, actor: string): Promise<CaseRecord> {
    const c = await this.getCase(tenant, caseId);
    return this.transition(tenant, caseId, c.version, "ready", { actor, summary: "Case ready for outreach", patch: { next_action: "Scheduler starts first contact in the approved window" } });
  }

  async beginSession(tenant: string, caseId: string, actor: string): Promise<CaseRecord> {
    let c = await this.getCase(tenant, caseId);
    if (c.status === "draft") c = await this.transition(tenant, caseId, c.version, "ready", { actor, summary: "Case ready for outreach" });
    if (c.status === "ready") c = await this.transition(tenant, caseId, c.version, "running", { actor, summary: "Agent session started", patch: { owner: "Meera agent" } });
    return c;
  }

  // ---- contact --------------------------------------------------------------

  async gateContact(c: CaseRecord): Promise<ContactCheck> {
    const p = await this.store.getParticipant(c.tenant_id, c.participant_id);
    const mission = await this.getMission(c.tenant_id, c.mission_version);
    return checkContact(this.policyFor(mission), {
      now: this.now(), attempts: c.attempts, consent: p?.consent ?? "unknown",
      optedOut: p?.consent === "declined", isFirstContact: c.attempts === 0,
    });
  }

  /**
   * Send the first message to a participant without an agent session: check the contact rules, queue the mission's intro
   * template, and wait for the reply. Used by campaigns. The agent is only woken later, when the interview is finished.
   */
  async sendIntro(tenant: string, caseId: string, o: { actor: string; campaignId?: string }): Promise<CaseRecord> {
    let c = await this.getCase(tenant, caseId);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    if (c.status !== "draft" && c.status !== "ready") throw new DozaiError("ILLEGAL_STATE", `case is ${c.status}; the first message was already sent`);
    const gate = await this.gateContact(c);
    if (!gate.allowed) throw new DozaiError(gate.code, gate.message);
    const mission = await this.getMission(tenant, c.mission_version);
    if (c.status === "draft") c = await this.transition(tenant, caseId, c.version, "ready", { actor: o.actor, summary: "Case ready for outreach" });
    c = await this.transition(tenant, caseId, c.version, "running", { actor: o.actor, summary: "First message started", patch: { campaign_id: o.campaignId } });
    const out = await this.queueOutbox(c, "whatsapp_template", { template_key: mission.intro_template }, `intro:${caseId}`);
    await this.emit(c, "message_queued", o.actor, `WhatsApp template ${mission.intro_template} queued`, { outbox_id: out.outbox_id, campaign_id: o.campaignId ?? null });
    return this.transition(tenant, caseId, c.version, "waiting", { actor: o.actor, summary: "Waiting for participant reply", patch: { attempts: c.attempts + 1, owner: "Campaign", next_action: "Wait for the participant's reply. The retry window is protected by policy." } });
  }

  /**
   * Every message and call goes through here. The autonomy dial decides whether it goes out on its own or waits for a
   * person ("held"). Messages also start a silence timer, so the agent is woken if nobody answers.
   */
  async queueOutbox(c: CaseRecord, kind: OutboxItem["kind"], payload: Record<string, unknown>, idempotencyKey: string): Promise<OutboxItem> {
    const now = this.now().toISOString();
    const item: OutboxItem = { outbox_id: newId("out"), tenant_id: c.tenant_id, case_id: c.case_id, kind, payload, idempotency_key: idempotencyKey, status: "pending", attempts: 0, created_at: now };
    const mode = (await this.controls(c.tenant_id)).autonomy[actionKindOf(item)];
    if (mode === "approve_first") {
      item.status = "held";
      item.approval = { state: "held", held_at: now };
    }
    await this.store.putOutbox(item);
    if (item.status === "held") await this.emit(c, "action_held", "policy-engine", `A person must approve this ${kind === "voice_call" ? "phone call" : "message"} before it is sent`, { outbox_id: item.outbox_id, kind });
    if (kind !== "voice_call") await this.startSilenceTimer(c);
    return item;
  }

  // ---- operating controls: autonomy dial, kill switch, spend limits -------------------------------------------------------

  async controls(tenant: string): Promise<Controls> { return (await this.store.getControls(tenant)) ?? defaultControls(tenant); }

  async updateControls(p: Principal, raw: unknown): Promise<Controls> {
    const parsed = ControlsPatchSchema.safeParse(raw);
    if (!parsed.success) throw new DozaiError("INVALID_CONTROLS", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
    const patch = parsed.data, cur = await this.controls(p.tenant_id), actor = `${p.role}:${p.user_id}`, now = this.now().toISOString();
    const next: Controls = { ...cur, autonomy: { ...cur.autonomy, ...(patch.autonomy ?? {}) }, updated_at: now, updated_by: actor };
    if (patch.daily_budget_usd !== undefined) next.daily_budget_usd = patch.daily_budget_usd;
    if (patch.case_budget_usd !== undefined) next.case_budget_usd = patch.case_budget_usd;
    if (patch.max_wakes_per_case !== undefined) next.max_wakes_per_case = patch.max_wakes_per_case;
    if (patch.paused === true) Object.assign(next, { paused: true, paused_reason: patch.reason ?? "", paused_by: actor, paused_at: now });
    if (patch.paused === false) Object.assign(next, { paused: false, paused_reason: undefined, paused_by: undefined, paused_at: undefined });
    await this.store.putControls(next);
    return next;
  }

  /** May the agent run now, on this case? The kill switch and both spend limits are checked here, before any model call. */
  async agentGate(tenant: string, caseId?: string): Promise<{ ok: true } | { ok: false; code: "AGENT_PAUSED" | "DAILY_BUDGET_REACHED" | "CASE_BUDGET_REACHED"; message: string }> {
    const c = await this.controls(tenant);
    if (c.paused) return { ok: false, code: "AGENT_PAUSED", message: `The agent is switched off${c.paused_reason ? `: ${c.paused_reason}` : ""}` };
    const sessions = (await this.store.listSessions(tenant)).filter(s => !s.simulated);
    if (c.daily_budget_usd > 0) {
      const since = this.now().getTime() - 86_400_000;
      const spent = sessions.filter(s => Date.parse(s.started_at) >= since).reduce((n, s) => n + s.cost_usd, 0);
      if (spent >= c.daily_budget_usd) return { ok: false, code: "DAILY_BUDGET_REACHED", message: `The agent has spent about ${spent.toFixed(2)} in the last 24 hours, which reaches the ${c.daily_budget_usd} limit` };
    }
    if (caseId && c.case_budget_usd > 0) {
      const spent = sessions.filter(s => s.case_id === caseId).reduce((n, s) => n + s.cost_usd, 0);
      if (spent >= c.case_budget_usd) return { ok: false, code: "CASE_BUDGET_REACHED", message: `This case has used about ${spent.toFixed(2)} of agent time, which reaches the ${c.case_budget_usd} limit for one case` };
    }
    return { ok: true };
  }

  /** Spent by the agent in the last 24 hours (indicative rates, real sessions only). */
  async spendLast24h(tenant: string): Promise<number> {
    const since = this.now().getTime() - 86_400_000;
    return (await this.store.listSessions(tenant)).filter(s => !s.simulated && Date.parse(s.started_at) >= since).reduce((n, s) => n + s.cost_usd, 0);
  }

  // ---- approvals: a person's say over what the agent proposes ---------------------------------------------------------------

  async decideApproval(p: Principal, outboxId: string, decision: "approve" | "reject", note = ""): Promise<OutboxItem> {
    const item = (await this.store.listOutbox(p.tenant_id)).find(o => o.outbox_id === outboxId);
    if (!item) throw new DozaiError("NOT_FOUND", "no such queued action", 404);
    if (item.status !== "held" || !item.approval) throw new DozaiError("NOT_HELD", `this action is ${item.status}, not waiting for approval`, 409);
    const actor = `${p.role}:${p.user_id}`, now = this.now().toISOString();
    const c = await this.getCase(p.tenant_id, item.case_id);
    const decided = (state: "approved" | "rejected", status: OutboxItem["status"], extra: Record<string, unknown> = {}): OutboxItem => ({ ...item, status, payload: { ...item.payload, ...extra }, approval: { ...item.approval!, state, decided_by: actor, decided_at: now, note: note.slice(0, 300) || undefined } });

    if (decision === "approve") {
      // Things can change while an action waits: check again that this person may still be contacted, now.
      const person = await this.store.getParticipant(c.tenant_id, c.participant_id);
      const closed = c.deleted_at || c.status === "complete" || person?.consent === "declined";
      if (closed) {
        await this.store.putOutbox(decided("rejected", "failed", { last_error: "no contact is allowed for this case any more" }));
        await this.emit(c, "action_rejected", "policy-engine", "The held action was cancelled: contact is no longer allowed", { outbox_id: outboxId });
        throw new DozaiError("CONTACT_NOT_ALLOWED", "contact is no longer allowed for this case, so the action was cancelled", 409);
      }
      const scheduled = item.kind === "voice_call" && typeof item.payload.start_at === "string";
      if (!scheduled) {
        const mission = await this.getMission(c.tenant_id, c.mission_version), pol = this.policyFor(mission), h = localHour(this.now(), pol.utcOffsetMinutes);
        if (h < pol.windowStartHour || h >= pol.windowEndHour) throw new DozaiError("OUTSIDE_WINDOW", "It is outside the approved contact hours. Approve it again inside the window, so the person is not contacted at a bad time.", 409);
      }
      await this.store.putOutbox(decided("approved", "pending"));
      await this.emit(c, "action_approved", actor, `Approved: ${item.kind === "voice_call" ? "phone call" : "message"} released`, { outbox_id: outboxId });
      return { ...item, status: "pending" };
    }

    await this.store.putOutbox(decided("rejected", "failed", { last_error: "declined by a person" }));
    await this.emit(c, "action_rejected", actor, `Declined: ${item.kind === "voice_call" ? "phone call" : "message"} will not be sent`, { outbox_id: outboxId });
    // The agent's plan did not survive, so a person decides what happens next instead of the case waiting for contact that will never come.
    let cur = await this.getCase(c.tenant_id, c.case_id);
    if (cur.status === "call_scheduled") cur = await this.transition(cur.tenant_id, cur.case_id, cur.version, "waiting", { actor, summary: "Proposed contact declined" });
    if (["running", "waiting"].includes(cur.status)) await this.requestReview(cur.tenant_id, cur.case_id, cur.version, "proposal_declined", "A person declined the contact the agent proposed.", actor);
    return { ...item, status: "failed" };
  }

  // ---- the wake service: timers that bring the agent back to a sleeping case -------------------------------------------

  async scheduleWake(c: { tenant_id: string; case_id: string }, o: { at: Date; reason: WakeReason; note?: string; by: string }): Promise<WakeRequest> {
    // One pending timer per reason: a newer one replaces the older.
    await this.cancelWakes(c.tenant_id, c.case_id, [o.reason]);
    const last = await this.store.lastEvent(c.tenant_id, c.case_id);
    const w: WakeRequest = { wake_id: newId("wake"), tenant_id: c.tenant_id, case_id: c.case_id, at: o.at.toISOString(), reason: o.reason, note: o.note?.slice(0, 120), status: "pending", created_at: this.now().toISOString(), created_by: o.by, baseline_seq: last?.seq ?? 0 };
    await this.store.putWake(w);
    if (o.reason !== "silence") await this.emit(c, "wake_scheduled", o.by, `Wake-up set for ${w.at} (${o.reason.replace("_", " ")})`, { wake_id: w.wake_id, reason: o.reason, at: w.at });
    return w;
  }

  async cancelWakes(tenant: string, caseId: string, reasons?: WakeReason[]): Promise<void> {
    for (const w of await this.store.listWakes(tenant, caseId)) if (w.status === "pending" && (!reasons || reasons.includes(w.reason))) await this.store.putWake({ ...w, status: "cancelled", done_at: this.now().toISOString() });
  }

  /** Silence after a message: wake the agent if nobody has answered by the mission's follow-up time. */
  private async startSilenceTimer(c: CaseRecord): Promise<void> {
    const mission = await this.getMission(c.tenant_id, c.mission_version);
    const hours = mission.strategy?.follow_up_after_hours ?? 48;
    await this.scheduleWake(c, { at: new Date(this.now().getTime() + hours * 3_600_000), reason: "silence", by: "policy-engine" });
  }

  async dueWakes(tenant: string): Promise<WakeRequest[]> {
    const now = this.now().toISOString();
    return (await this.store.listWakes(tenant)).filter(w => w.status === "pending" && w.at <= now);
  }

  /** How many times the agent has been woken on a case by timers. */
  async wakesUsed(tenant: string, caseId: string): Promise<number> { return (await this.store.listWakes(tenant, caseId)).filter(w => w.status === "done").length; }

  // ---- memory ------------------------------------------------------------------------------------------------------------

  async rememberNote(c: { tenant_id: string; case_id: string }, key: string, value: string, source: string): Promise<CaseMemory> {
    const problem = memoryProblem(key, value);
    if (problem) throw new DozaiError("INVALID_MEMORY", problem, 422);
    const m = withNote(await this.store.getMemory(c.tenant_id, c.case_id), c, { key: key as MemoryKey, value, source, at: this.now().toISOString() });
    await this.store.putMemory(m);
    await this.emit(c, "memory_noted", source, `Remembered: ${key.replace(/_/g, " ")}`, { key });
    return m;
  }

  // ---- inbound events (written to the ledger BEFORE the agent sees them) -----

  async recordInbound(tenant: string, caseId: string, input: InboundInput): Promise<{ duplicate: boolean; case: CaseRecord }> {
    const key = `inbound:${input.channel}:${input.provider_event_id}`;
    let c = await this.getCase(tenant, caseId);
    if (await this.store.getIdem(key)) return { duplicate: true, case: c };
    await this.store.putIdem(key, { at: this.now().toISOString() });
    const ev = await this.emit(c, "message_received", input.channel, input.summary, { provider_event_id: input.provider_event_id, channel: input.channel });
    const p = await this.store.getParticipant(tenant, c.participant_id);
    if (p && input.consent) await this.store.putParticipant({ ...p, consent: input.consent });
    for (const a of input.answers ?? []) {
      const e: Evidence = { evidence_id: newId("ev"), case_id: caseId, question_id: a.question_id, value: a.value, source: input.channel, confidence: a.confidence, event_id: ev.event_id, at: this.now().toISOString() };
      await this.store.addEvidence(e);
      await this.emit(c, "evidence_added", input.channel, `Evidence captured: ${a.question_id}`, { evidence_id: e.evidence_id, question_id: a.question_id });
    }
    if (input.opt_out) {
      if (p) await this.store.putParticipant({ ...p, consent: "declined" });
      c = await this.getCase(tenant, caseId);
      c = await this.transition(tenant, caseId, c.version, "complete", { actor: input.channel, outcome: "opted_out", summary: "Participant opted out", patch: { next_action: "No further contact. Consent preference is locked.", reason: "Participant declined to continue.", confidence: 100 } });
      await this.cancelOutbox(tenant, caseId);
    } else {
      c = await this.getCase(tenant, caseId);
    }
    return { duplicate: false, case: c };
  }

  private async cancelOutbox(tenant: string, caseId: string) {
    for (const o of await this.store.listOutbox(tenant)) if (o.case_id === caseId && (o.status === "pending" || o.status === "held")) await this.store.putOutbox({ ...o, status: "failed" });
    await this.cancelWakes(tenant, caseId);
  }

  // ---- agent proposals and review -------------------------------------------

  async detectConflict(c: CaseRecord, state: string | null): Promise<{ has: boolean; reason: string }> {
    const p = await this.store.getParticipant(c.tenant_id, c.participant_id);
    const ev = await this.store.listEvidence(c.case_id);
    const employer = ev.find(e => e.question_id === "employer_name")?.value;
    if (state === "same_job" && employer && p?.recorded_employer && norm(employer) !== norm(p.recorded_employer)) {
      return { has: true, reason: `Reported employer "${employer}" differs from the programme record "${p.recorded_employer}".` };
    }
    return { has: false, reason: "" };
  }

  /** Claude proposes; this commits. Never completes a case unless policy allows. */
  async proposeDecision(tenant: string, caseId: string, expectedVersion: number, input: ProposeInput, actor: string): Promise<{ case: CaseRecord; auto: boolean; decision: Decision }> {
    let c = await this.getCase(tenant, caseId);
    if (c.version !== expectedVersion) throw new DozaiError("VERSION_CONFLICT", `expected v${expectedVersion}, case is v${c.version}`, 409);
    if (["review", "complete", "draft"].includes(c.status)) throw new DozaiError("ILLEGAL_STATE", `cannot propose from ${c.status}`);
    const known = new Set((await this.store.listEvidence(caseId)).map(e => e.evidence_id));
    const missing = input.evidence_refs.filter(r => !known.has(r));
    if (missing.length) throw new DozaiError("UNKNOWN_EVIDENCE", `unknown evidence: ${missing.join(", ")}`);
    // The finding must be one this mission defines, so a feedback mission cannot end with "same job". The agent is told which are allowed.
    const bad = findingProblem(await this.getMission(tenant, c.mission_version), input.livelihood_state);
    if (bad) throw new DozaiError("UNKNOWN_FINDING", bad, 422);
    if (input.proposed_outcome === "opted_out" || input.proposed_outcome === "cancelled") throw new DozaiError("OUTCOME_NOT_PROPOSABLE", "opt-out and cancel come from participant events or humans, not proposals");

    const decision: Decision = { decision_id: newId("dec"), case_id: caseId, kind: "proposal", proposed_outcome: input.proposed_outcome, livelihood_state: input.livelihood_state, confidence: input.confidence, evidence_refs: input.evidence_refs, rationale: input.rationale, actor, ts: this.now().toISOString() };
    await this.store.addDecision(decision);
    await this.emit(c, "decision_proposed", actor, `Proposed ${input.proposed_outcome} (${Math.round(input.confidence * 100)}%)`, { decision_id: decision.decision_id, evidence_refs: input.evidence_refs });

    c = await this.toEvaluating(c, actor);
    const conflict = await this.detectConflict(c, input.livelihood_state);
    const auto = (input.proposed_outcome === "confirmed" || input.proposed_outcome === "not_confirmed") && canAutoConfirm(this.policy, input.confidence, conflict.has);
    const pct = Math.round(input.confidence * 100);
    if (auto) {
      c = await this.transition(tenant, caseId, c.version, "complete", { actor: "policy-engine", outcome: input.proposed_outcome, summary: `Auto-completed at ${pct}% with no conflict`, patch: { livelihood_state: input.livelihood_state, confidence: pct, reason: input.rationale, next_action: "No action needed. Case is ready for mission reporting." } });
    } else {
      const reason = conflict.has ? conflict.reason : `Confidence ${pct}% is below the ${Math.round(this.policy.autoConfirmAt * 100)}% auto-confirm threshold.`;
      c = await this.transition(tenant, caseId, c.version, "review", { actor: "policy-engine", summary: "Sent to human review", patch: { livelihood_state: input.livelihood_state, confidence: pct, reason, next_action: "Compare the participant response with the programme record and decide." } });
      await this.openReviewTask(c, reason);
    }
    return { case: c, auto, decision };
  }

  private async openReviewTask(c: CaseRecord, reason: string): Promise<ReviewTask> {
    const t: ReviewTask = { task_id: newId("rev"), tenant_id: c.tenant_id, case_id: c.case_id, reason, status: "open", assignee: null, created_at: this.now().toISOString() };
    await this.store.putReviewTask(t);
    await this.emit(c, "review_requested", "policy-engine", `Review task created: ${reason}`, { task_id: t.task_id });
    return t;
  }

  /** Agent-initiated escalation (e.g. identity mismatch). */
  async requestReview(tenant: string, caseId: string, expectedVersion: number, reasonCode: string, note: string, actor: string): Promise<CaseRecord> {
    let c = await this.getCase(tenant, caseId);
    if (c.version !== expectedVersion) throw new DozaiError("VERSION_CONFLICT", `expected v${expectedVersion}, case is v${c.version}`, 409);
    if (STOPPED.includes(c.status)) throw new DozaiError("ILLEGAL_STATE", `case is already ${c.status}`);
    c = await this.toEvaluating(c, actor);
    const reason = note ? `${reasonCode}: ${note}` : reasonCode;
    c = await this.transition(tenant, caseId, c.version, "review", { actor, summary: "Agent requested human review", patch: { reason, next_action: "Human decision required." } });
    await this.openReviewTask(c, reason);
    return c;
  }

  async reviewDecide(p: Principal, caseId: string, input: ReviewDecisionInput): Promise<CaseRecord> {
    const c = await this.getCase(p.tenant_id, caseId);
    if (c.status !== "review") throw new DozaiError("ILLEGAL_STATE", "case is not waiting for review");
    const actor = `${p.role}:${p.user_id}`;
    const outcomes: Record<string, Outcome | undefined> = { confirm: "confirmed", not_confirm: "not_confirmed", inconclusive: "inconclusive", followup: undefined };
    const outcome = outcomes[input.decision];
    const final: Decision = { decision_id: newId("dec"), case_id: caseId, kind: "final", proposed_outcome: outcome ?? null, livelihood_state: c.livelihood_state, confidence: 1, evidence_refs: [], rationale: input.note || `Reviewer chose ${input.decision}`, actor, ts: this.now().toISOString() };
    await this.store.addDecision(final);

    let next: CaseRecord;
    if (outcome) {
      const nextAction = outcome === "confirmed" ? "No action needed. Human-reviewed outcome is final." : outcome === "inconclusive" ? "No further automation. Reporting keeps the inconclusive outcome." : "Create an opportunity-support referral per partner policy.";
      next = await this.transition(p.tenant_id, caseId, input.expected_version, "complete", { actor, outcome, summary: `Reviewer decided: ${outcome}`, patch: { confidence: outcome === "confirmed" ? Math.max(c.confidence, 90) : c.confidence, next_action: nextAction } });
    } else {
      next = await this.transition(p.tenant_id, caseId, input.expected_version, "waiting", { actor, summary: "Reviewer requested follow-up", patch: { next_action: "Send one targeted clarification using the approved template." } });
    }
    for (const t of await this.store.listReviewTasks(p.tenant_id)) if (t.case_id === caseId && t.status === "open") await this.store.putReviewTask({ ...t, status: "resolved", assignee: p.user_id });
    // The reviewer's note can contain personal details, so it lives in the (erasable) decision row, never in the ledger.
    await this.emit(next, "review_decided", actor, `Review decision: ${input.decision}`, { decision_id: final.decision_id, decision: input.decision });
    return next;
  }

  /**
   * Delete a case: stop all contact, erase every piece of personal data, and leave an anonymous stub.
   * The ledger is never edited: it already holds no personal data, and gains a `case_deleted` event.
   * Safe to repeat after a partial failure.
   */
  async deleteCase(p: Principal, caseId: string, reason: string): Promise<CaseRecord> {
    let c = await this.getCase(p.tenant_id, caseId);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was already deleted", 410);
    const actor = `${p.role}:${p.user_id}`;
    const person = await this.store.getParticipant(c.tenant_id, c.participant_id);

    await this.emit(c, "case_deleted", actor, `Case deleted: personal data erased (${reason})`, { reason });
    for (const o of await this.store.listOutbox(c.tenant_id)) if (o.case_id === caseId && (o.status === "pending" || o.status === "held")) await this.store.putOutbox({ ...o, status: "failed", payload: { ...o.payload, last_error: "case deleted" } });
    await this.cancelWakes(c.tenant_id, caseId);
    if (c.status !== "complete") c = await this.transition(c.tenant_id, caseId, c.version, "complete", { actor, outcome: "cancelled", summary: "Cancelled because the case was deleted" });

    const tombstone: Participant = { participant_id: c.participant_id, tenant_id: c.tenant_id, display_name: "Deleted participant", phone_masked: "—", location: "—", cohort: person?.cohort ?? "—", language: "en", consent: "declined", recorded_employer: "—" };
    await this.store.eraseCase({ tenant: c.tenant_id, caseId, participantId: c.participant_id, tombstone, phoneHash: person?.phone_hash });

    const next: CaseRecord = { ...c, livelihood_state: null, reason: "Personal data erased.", next_action: "None. This case was deleted.", owner: "—", version: c.version + 1, deleted_at: this.now().toISOString(), deleted_by: actor, last_touch: this.now().toISOString() };
    if (!(await this.store.casCase(next, c.version))) throw new DozaiError("VERSION_CONFLICT", "case changed while deleting; try again", 409);
    return next;
  }
}
