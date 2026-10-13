// Storage port. The Catalyst Data Store implementation must satisfy the same contract;
// casCase MUST be atomic on `version` (see ARCHITECTURE.md, spike 1).
import type { Campaign, CaseEvent, CaseRecord, ConversationState, Decision, Evidence, Participant } from "@dozai/contracts";
import type { EmployeeDefinition } from "./employee";
import type { MissionBundle } from "./mission";
import type { CallRecord, VoiceFormLink } from "./voice";
import type { Controls } from "./controls";
import type { CaseMemory } from "./memory";
import type { WakeRequest } from "./wake";

export interface ReviewTask { task_id: string; tenant_id: string; case_id: string; reason: string; status: "open" | "resolved"; assignee: string | null; created_at: string }
/** A person's say over one action the agent proposed. "held" items are not sent until someone approves them. */
export interface Approval { state: "held" | "approved" | "rejected"; held_at: string; decided_by?: string; decided_at?: string; note?: string }
export interface OutboxItem { outbox_id: string; tenant_id: string; case_id: string; kind: "whatsapp_template" | "whatsapp_text" | "voice_call"; payload: Record<string, unknown>; idempotency_key: string; status: "pending" | "held" | "sent" | "failed"; attempts: number; created_at: string; approval?: Approval }
export interface InboxEvent { inbox_id: string; tenant_id: string; source: "interakt" | "zolabs"; event: Record<string, unknown>; status: "pending" | "done" | "error"; received_at: string; error?: string }
export interface EraseArgs { tenant: string; caseId: string; participantId: string; tombstone: Participant; phoneHash?: string }
/** One step of an agent session. For a tool call, `outcome` says what the platform did with it and `case_version` which version of the case the agent was looking at. */
export interface TraceStep { label: string; type: string; detail: string; tool?: string; input?: unknown; result?: unknown; ts: string; outcome?: "executed" | "held" | "refused"; case_version?: number }
export interface AgentSession { session_id: string; tenant_id: string; case_id: string; employee_version: string; mission_version: string; status: "running" | "idle" | "completed" | "budget_reached"; tokens_in: number; tokens_out: number; cost_usd: number; budget_usd: number; simulated: boolean; trace: TraceStep[]; started_at: string; /** What woke the agent: the first run, a reply, a call result or a timer. */ trigger?: string }

export interface Store {
  getCase(tenant: string, caseId: string): Promise<CaseRecord | undefined>;
  listCases(tenant: string): Promise<CaseRecord[]>;
  /** Atomic compare-and-set. expectedVersion 0 means "create". Returns false on conflict. */
  casCase(next: CaseRecord, expectedVersion: number): Promise<boolean>;
  getParticipant(tenant: string, id: string): Promise<Participant | undefined>;
  listParticipants(tenant: string): Promise<Participant[]>;
  putParticipant(p: Participant): Promise<void>;
  appendEvent(ev: CaseEvent): Promise<void>;
  lastEvent(tenant: string, caseId: string): Promise<CaseEvent | undefined>;
  listEvents(tenant: string, caseId?: string): Promise<CaseEvent[]>;
  addEvidence(e: Evidence): Promise<void>;
  listEvidence(caseId: string): Promise<Evidence[]>;
  /** All evidence in one read (list screens); avoids one query per case. */
  listAllEvidence(): Promise<Evidence[]>;
  addDecision(d: Decision): Promise<void>;
  listDecisions(caseId: string): Promise<Decision[]>;
  putReviewTask(t: ReviewTask): Promise<void>;
  listReviewTasks(tenant: string): Promise<ReviewTask[]>;
  putOutbox(o: OutboxItem): Promise<void>;
  listOutbox(tenant: string): Promise<OutboxItem[]>;
  getConversation(tenant: string, caseId: string): Promise<ConversationState | undefined>;
  putConversation(c: ConversationState): Promise<void>;
  putInbox(e: InboxEvent): Promise<void>;
  getInbox(tenant: string, id: string): Promise<InboxEvent | undefined>;
  listInbox(tenant: string): Promise<InboxEvent[]>;
  /** Irreversibly removes personal data for one case: participant, evidence values, decision text, agent traces, queued inbound events. */
  eraseCase(a: EraseArgs): Promise<void>;
  /** Deletes every row. Development only; guarded at the API. */
  purgeAll(): Promise<void>;
  getIdem(key: string): Promise<unknown | undefined>;
  putIdem(key: string, value: unknown): Promise<void>;
  /** Atomically take a key. Returns true only for the single caller that got it. */
  claim(key: string): Promise<boolean>;
  putSession(s: AgentSession): Promise<void>;
  getSession(id: string): Promise<AgentSession | undefined>;
  listSessions(tenant: string): Promise<AgentSession[]>;
  /** Missions are immutable. Returns false when this version already exists. */
  putMission(tenant: string, m: MissionBundle): Promise<boolean>;
  getMission(tenant: string, version: string): Promise<MissionBundle | undefined>;
  listMissions(tenant: string): Promise<MissionBundle[]>;
  /** Employees belong to the platform, are immutable, and are shared by every client. Returns false when this version already exists. */
  putEmployee(e: EmployeeDefinition): Promise<boolean>;
  getEmployee(version: string): Promise<EmployeeDefinition | undefined>;
  listEmployees(): Promise<EmployeeDefinition[]>;
  /** Which phone form a mission was published as. Changes when the form is re-published. */
  putVoiceForm(l: VoiceFormLink): Promise<void>;
  getVoiceForm(tenant: string, missionVersion: string): Promise<VoiceFormLink | undefined>;
  /** Phone calls on cases. They hold audio references and transcripts, so they are erased with the case. */
  putCall(c: CallRecord): Promise<void>;
  getCall(tenant: string, communicationId: string): Promise<CallRecord | undefined>;
  listCalls(tenant: string, caseId?: string): Promise<CallRecord[]>;
  /** Campaigns change status and counters, so this keeps only the latest version. */
  putCampaign(c: Campaign): Promise<void>;
  getCampaign(tenant: string, id: string): Promise<Campaign | undefined>;
  listCampaigns(tenant: string): Promise<Campaign[]>;
  /** Operating controls: autonomy, kill switch, spend limits. One current document per client; every change is kept. */
  getControls(tenant: string): Promise<Controls | undefined>;
  putControls(c: Controls): Promise<void>;
  /** Timers that wake the agent. Latest state only. */
  putWake(w: WakeRequest): Promise<void>;
  listWakes(tenant: string, caseId?: string): Promise<WakeRequest[]>;
  /** What the agent remembers about one person. Erased with the case. */
  getMemory(tenant: string, caseId: string): Promise<CaseMemory | undefined>;
  putMemory(m: CaseMemory): Promise<void>;
}

export class InMemoryStore implements Store {
  private cases = new Map<string, CaseRecord>();
  private participants = new Map<string, Participant>();
  private events: CaseEvent[] = [];
  private evidence: Evidence[] = [];
  private decisions: Decision[] = [];
  private tasks = new Map<string, ReviewTask>();
  private outbox = new Map<string, OutboxItem>();
  private idem = new Map<string, unknown>();
  private sessions = new Map<string, AgentSession>();
  private inbox = new Map<string, InboxEvent>();
  private convs = new Map<string, ConversationState>();
  private missions = new Map<string, MissionBundle>();
  private employees = new Map<string, EmployeeDefinition>();
  private voiceForms = new Map<string, VoiceFormLink>();
  private calls = new Map<string, CallRecord>();
  private campaigns = new Map<string, Campaign>();
  private controls = new Map<string, Controls>();
  private wakes = new Map<string, WakeRequest>();
  private memories = new Map<string, CaseMemory>();
  private k = (t: string, id: string) => `${t}:${id}`;

  reset() {
    this.cases.clear(); this.participants.clear(); this.events = []; this.evidence = []; this.decisions = [];
    this.tasks.clear(); this.outbox.clear(); this.inbox.clear(); this.convs.clear(); this.idem.clear(); this.sessions.clear();
    this.campaigns.clear(); this.controls.clear(); this.wakes.clear(); this.memories.clear(); this.missions.clear(); this.employees.clear(); this.voiceForms.clear(); this.calls.clear();
  }

  async getCase(t: string, id: string) { const c = this.cases.get(this.k(t, id)); return c && structuredClone(c); }
  async listCases(t: string) { return [...this.cases.values()].filter(c => c.tenant_id === t).map(c => structuredClone(c)); }
  async casCase(next: CaseRecord, expectedVersion: number) {
    const key = this.k(next.tenant_id, next.case_id);
    const cur = this.cases.get(key);
    if (next.version !== expectedVersion + 1) throw new Error("casCase: version must advance by exactly one");
    if ((cur?.version ?? 0) !== expectedVersion) return false;
    this.cases.set(key, structuredClone(next));
    return true;
  }
  async getParticipant(t: string, id: string) { const p = this.participants.get(this.k(t, id)); return p && structuredClone(p); }
  async listParticipants(t: string) { return [...this.participants.values()].filter(p => p.tenant_id === t).map(p => structuredClone(p)); }
  async putParticipant(p: Participant) { this.participants.set(this.k(p.tenant_id, p.participant_id), structuredClone(p)); }
  async appendEvent(ev: CaseEvent) {
    if (this.events.some(e => e.tenant_id === ev.tenant_id && e.case_id === ev.case_id && e.seq === ev.seq)) throw new Error("ledger: duplicate seq");
    this.events.push(structuredClone(ev));
  }
  async lastEvent(t: string, caseId: string) {
    let last: CaseEvent | undefined;
    for (const e of this.events) if (e.tenant_id === t && e.case_id === caseId && (!last || e.seq > last.seq)) last = e;
    return last && structuredClone(last);
  }
  async listEvents(t: string, caseId?: string) {
    const rows = this.events.filter(e => e.tenant_id === t && (!caseId || e.case_id === caseId));
    return rows
      .sort((a, b) => (a.case_id === b.case_id ? a.seq - b.seq : a.ts.localeCompare(b.ts)))
      .map(e => structuredClone(e));
  }
  async addEvidence(e: Evidence) { this.evidence.push(structuredClone(e)); }
  async listEvidence(caseId: string) { return this.evidence.filter(e => e.case_id === caseId).map(e => structuredClone(e)); }
  async listAllEvidence() { return this.evidence.map(e => structuredClone(e)); }
  async addDecision(d: Decision) { this.decisions.push(structuredClone(d)); }
  async listDecisions(caseId: string) { return this.decisions.filter(d => d.case_id === caseId).map(d => structuredClone(d)); }
  async putReviewTask(t: ReviewTask) { this.tasks.set(t.task_id, structuredClone(t)); }
  async listReviewTasks(t: string) { return [...this.tasks.values()].filter(x => x.tenant_id === t).map(x => structuredClone(x)); }
  async putOutbox(o: OutboxItem) { this.outbox.set(o.outbox_id, structuredClone(o)); }
  async listOutbox(t: string) { return [...this.outbox.values()].filter(x => x.tenant_id === t).map(x => structuredClone(x)); }
  async getConversation(t: string, id: string) { const c = this.convs.get(this.k(t, id)); return c && structuredClone(c); }
  async putConversation(c: ConversationState) { this.convs.set(this.k(c.tenant_id, c.case_id), structuredClone(c)); }
  async putInbox(e: InboxEvent) { this.inbox.set(this.k(e.tenant_id, e.inbox_id), structuredClone(e)); }
  async getInbox(t: string, id: string) { const e = this.inbox.get(this.k(t, id)); return e && structuredClone(e); }
  async listInbox(t: string) { return [...this.inbox.values()].filter(e => e.tenant_id === t).sort((a, b) => a.received_at.localeCompare(b.received_at)).map(e => structuredClone(e)); }
  async eraseCase(a: EraseArgs) {
    this.participants.set(this.k(a.tenant, a.participantId), structuredClone(a.tombstone));
    this.convs.delete(this.k(a.tenant, a.caseId));
    this.memories.delete(this.k(a.tenant, a.caseId));
    for (const [k, w] of this.wakes) if (w.case_id === a.caseId) this.wakes.set(k, { ...w, note: undefined, detail: undefined, status: w.status === "pending" ? "cancelled" : w.status });
    for (const [k, c] of this.calls) if (c.case_id === a.caseId) this.calls.delete(k); // audio references and transcripts
    this.evidence = this.evidence.map(e => (e.case_id === a.caseId ? { ...e, value: "[erased]" } : e));
    this.decisions = this.decisions.map(d => (d.case_id === a.caseId ? { ...d, rationale: "[erased]" } : d));
    for (const s of this.sessions.values()) if (s.case_id === a.caseId) s.trace = [];
    if (a.phoneHash) for (const [k, e] of this.inbox) if ((e.event as { phone_hash?: string }).phone_hash === a.phoneHash) this.inbox.delete(k);
  }
  /** Deletes records about people. Missions and employees are configuration, not personal data, so they stay. */
  async purgeAll() { const m = new Map(this.missions), e = new Map(this.employees), f = new Map(this.voiceForms), c = new Map(this.controls); this.reset(); this.missions = m; this.employees = e; this.voiceForms = f; this.controls = c; }
  async getIdem(key: string) { const v = this.idem.get(key); return v === undefined ? undefined : structuredClone(v); }
  async claim(key: string) { if (this.idem.has(key)) return false; this.idem.set(key, { claimed: true }); return true; }
  async putIdem(key: string, value: unknown) { if (!this.idem.has(key)) this.idem.set(key, structuredClone(value)); }
  async putSession(s: AgentSession) { this.sessions.set(s.session_id, structuredClone(s)); }
  async getSession(id: string) { const s = this.sessions.get(id); return s && structuredClone(s); }
  async listSessions(t: string) { return [...this.sessions.values()].filter(s => s.tenant_id === t).map(s => structuredClone(s)); }
  async putMission(t: string, m: MissionBundle) { const key = this.k(t, m.version); if (this.missions.has(key)) return false; this.missions.set(key, structuredClone(m)); return true; }
  async getMission(t: string, v: string) { const m = this.missions.get(this.k(t, v)); return m && structuredClone(m); }
  async listMissions(t: string) { return [...this.missions.entries()].filter(([k]) => k.startsWith(`${t}:`)).map(([, m]) => structuredClone(m)); }
  async putEmployee(e: EmployeeDefinition) { if (this.employees.has(e.version)) return false; this.employees.set(e.version, structuredClone(e)); return true; }
  async getEmployee(v: string) { const e = this.employees.get(v); return e && structuredClone(e); }
  async listEmployees() { return [...this.employees.values()].map(e => structuredClone(e)); }
  async putVoiceForm(l: VoiceFormLink) { this.voiceForms.set(this.k(l.tenant_id, l.mission_version), structuredClone(l)); }
  async getVoiceForm(t: string, v: string) { const l = this.voiceForms.get(this.k(t, v)); return l && structuredClone(l); }
  async putCall(c: CallRecord) { this.calls.set(this.k(c.tenant_id, c.communication_id), structuredClone(c)); }
  async getCall(t: string, id: string) { const c = this.calls.get(this.k(t, id)); return c && structuredClone(c); }
  async listCalls(t: string, caseId?: string) { return [...this.calls.values()].filter(c => c.tenant_id === t && (!caseId || c.case_id === caseId)).map(c => structuredClone(c)); }
  async putCampaign(c: Campaign) { this.campaigns.set(this.k(c.tenant_id, c.campaign_id), structuredClone(c)); }
  async getCampaign(t: string, id: string) { const c = this.campaigns.get(this.k(t, id)); return c && structuredClone(c); }
  async listCampaigns(t: string) { return [...this.campaigns.values()].filter(c => c.tenant_id === t).map(c => structuredClone(c)); }
  async getControls(t: string) { const c = this.controls.get(t); return c && structuredClone(c); }
  async putControls(c: Controls) { this.controls.set(c.tenant_id, structuredClone(c)); }
  async putWake(w: WakeRequest) { this.wakes.set(this.k(w.tenant_id, w.wake_id), structuredClone(w)); }
  async listWakes(t: string, caseId?: string) { return [...this.wakes.values()].filter(w => w.tenant_id === t && (!caseId || w.case_id === caseId)).sort((a, b) => a.at.localeCompare(b.at)).map(w => structuredClone(w)); }
  async getMemory(t: string, caseId: string) { const m = this.memories.get(this.k(t, caseId)); return m && structuredClone(m); }
  async putMemory(m: CaseMemory) { this.memories.set(this.k(m.tenant_id, m.case_id), structuredClone(m)); }
}
