// Document-style Store on top of ONE table (default name: dozai_docs).
//
// Why one append-only table: Catalyst Data Store gives us a UNIQUE column constraint that is enforced
// atomically, but no multi-row transactions or reliable conditional UPDATE. So every write is an INSERT of a
// new immutable row whose `uniq_key` encodes (collection, tenant, id, version). Two writers racing for the same
// version collide on the unique key and exactly one wins. That is the compare-and-set `casCase` needs, and it
// also gives the ledger its "no duplicate seq" guarantee. Reads take the highest version per doc.
//
// Table columns (see docs/DATASTORE.md):
//   uniq_key varchar(255) UNIQUE mandatory | tenant_id varchar(100) | collection varchar(40) |
//   doc_id varchar(120) | parent_id varchar(120) | version int | body text
import { createHash } from "node:crypto";
import type { Campaign, CaseEvent, CaseRecord, ConversationState, Decision, Evidence, Participant } from "@dozai/contracts";
import { PLATFORM_TENANT, type EmployeeDefinition } from "./employee";
import type { MissionBundle } from "./mission";
import type { CallRecord, VoiceFormLink } from "./voice";
import type { Controls } from "./controls";
import type { CaseMemory } from "./memory";
import type { WakeRequest } from "./wake";
import type { AgentSession, EraseArgs, InboxEvent, OutboxItem, ReviewTask, Store, TraceStep } from "./store";

export interface DocRow {
  uniq_key: string;
  tenant_id: string;
  collection: string;
  doc_id: string;
  parent_id: string;
  version: number;
  body: string;
}

export interface DocQuery {
  tenant_id?: string;
  collection: string;
  doc_id?: string;
  parent_id?: string;
  /** Only the single highest-version row (ORDER BY version DESC LIMIT 1). */
  latestOnly?: boolean;
}

/** The only thing a backend has to provide. insert() MUST be atomic on uniq_key and return false on a duplicate. */
export interface DocDriver {
  insert(row: DocRow): Promise<boolean>;
  select(q: DocQuery): Promise<DocRow[]>;
  /** Removes every row matching the query (no tenant given = all tenants). Returns how many. */
  deleteWhere(q: Omit<DocQuery, "latestOnly">): Promise<number>;
}

const MAX_BODY = 9000; // Data Store text columns are size-limited; fail loudly instead of truncating.
const SAFE = /^[A-Za-z0-9_.:\-]+$/;
const safe = (s: string): string => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

export class InMemoryDocDriver implements DocDriver {
  rows: DocRow[] = [];
  async insert(row: DocRow) {
    if (this.rows.some(r => r.uniq_key === row.uniq_key)) return false;
    this.rows.push({ ...row });
    return true;
  }
  async deleteWhere(q: Omit<DocQuery, "latestOnly">) {
    const hit = (r: DocRow) => r.collection === q.collection && (!q.tenant_id || r.tenant_id === q.tenant_id) && (!q.doc_id || r.doc_id === q.doc_id) && (!q.parent_id || r.parent_id === q.parent_id);
    const before = this.rows.length;
    this.rows = this.rows.filter(r => !hit(r));
    return before - this.rows.length;
  }
  async select(q: DocQuery) {
    let out = this.rows.filter(r => r.collection === q.collection && (!q.tenant_id || r.tenant_id === q.tenant_id) && (!q.doc_id || r.doc_id === q.doc_id) && (!q.parent_id || r.parent_id === q.parent_id));
    out = out.sort((a, b) => b.version - a.version).map(r => ({ ...r }));
    return q.latestOnly ? out.slice(0, 1) : out;
  }
}

// Missions and employees ("mission", "mpart", "employee", "epart") are configuration, not records about people, so purgeAll leaves them.
const ALL_COLLECTIONS = ["conv", "case", "participant", "event", "evidence", "decision", "task", "outbox", "idem", "session", "trace", "inbox", "campaign", "call", "wake", "memory"];

/** A full mission (a 34-question flow with Hindi) is bigger than one row, so it is stored in pieces. */
const MISSION_PART = 4000;

export class DocStore implements Store {
  constructor(private d: DocDriver) {}

  private row(collection: string, tenant: string, docId: string, parent: string, version: number, value: unknown, uniq?: string): DocRow {
    const body = JSON.stringify(value);
    if (body.length > MAX_BODY) throw new Error(`document too large for ${collection}/${docId}: ${body.length} chars`);
    return { uniq_key: uniq ?? `${collection}|${tenant}|${docId}|${version}`, tenant_id: safe(tenant), collection, doc_id: safe(docId), parent_id: parent ? safe(parent) : "-", version, body };
  }
  private parse<T>(r: DocRow | undefined): T | undefined { return r ? (JSON.parse(r.body) as T) : undefined; }

  /** Latest version of every doc in a collection. */
  private async latestByDoc(q: DocQuery): Promise<DocRow[]> {
    const best = new Map<string, DocRow>();
    for (const r of await this.d.select(q)) { const cur = best.get(r.doc_id); if (!cur || r.version > cur.version) best.set(r.doc_id, r); }
    return [...best.values()];
  }

  /** Versioned upsert for mutable docs (participant, task, outbox, session): retry on a lost race. */
  private async putVersioned(collection: string, tenant: string, docId: string, parent: string, value: unknown) {
    for (let i = 0; i < 6; i++) {
      const cur = (await this.d.select({ tenant_id: tenant, collection, doc_id: docId, latestOnly: true }))[0];
      if (await this.d.insert(this.row(collection, tenant, docId, parent, (cur?.version ?? 0) + 1, value))) return;
    }
    throw new Error(`could not write ${collection}/${docId}: too much contention`);
  }

  // ---- cases (atomic CAS via unique key) ------------------------------------------
  async getCase(t: string, id: string) { return this.parse<CaseRecord>((await this.d.select({ tenant_id: t, collection: "case", doc_id: id, latestOnly: true }))[0]); }
  async listCases(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "case" })).map(r => JSON.parse(r.body) as CaseRecord); }
  async casCase(next: CaseRecord, expectedVersion: number) {
    if (next.version !== expectedVersion + 1) throw new Error("casCase: version must advance by exactly one");
    return this.d.insert(this.row("case", next.tenant_id, next.case_id, next.participant_id, next.version, next));
  }

  // ---- participants ---------------------------------------------------------------
  async getParticipant(t: string, id: string) { return this.parse<Participant>((await this.d.select({ tenant_id: t, collection: "participant", doc_id: id, latestOnly: true }))[0]); }
  async listParticipants(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "participant" })).map(r => JSON.parse(r.body) as Participant); }
  async putParticipant(p: Participant) { await this.putVersioned("participant", p.tenant_id, p.participant_id, "", p); }

  // ---- ledger ---------------------------------------------------------------------
  async appendEvent(ev: CaseEvent) {
    const ok = await this.d.insert(this.row("event", ev.tenant_id, ev.event_id, ev.case_id, ev.seq, ev, `event|${ev.tenant_id}|${ev.case_id}|${ev.seq}`));
    if (!ok) throw new Error("ledger: duplicate seq");
  }
  async lastEvent(t: string, caseId: string) { return this.parse<CaseEvent>((await this.d.select({ tenant_id: t, collection: "event", parent_id: caseId, latestOnly: true }))[0]); }
  async listEvents(t: string, caseId?: string) {
    const rows = await this.d.select({ tenant_id: t, collection: "event", parent_id: caseId });
    return rows.map(r => JSON.parse(r.body) as CaseEvent).sort((a, b) => (a.case_id === b.case_id ? a.seq - b.seq : a.ts.localeCompare(b.ts)));
  }

  // ---- evidence and decisions (append-only) ------------------------------------------
  async addEvidence(e: Evidence) { await this.d.insert(this.row("evidence", "all", e.evidence_id, e.case_id, 1, e)); }
  async listEvidence(caseId: string) { return (await this.d.select({ tenant_id: "all", collection: "evidence", parent_id: caseId })).sort((a, b) => a.uniq_key.localeCompare(b.uniq_key)).map(r => JSON.parse(r.body) as Evidence); }
  async listAllEvidence() { return (await this.d.select({ tenant_id: "all", collection: "evidence" })).map(r => JSON.parse(r.body) as Evidence); }
  async addDecision(x: Decision) { await this.d.insert(this.row("decision", "all", x.decision_id, x.case_id, 1, x)); }
  async listDecisions(caseId: string) { return (await this.d.select({ tenant_id: "all", collection: "decision", parent_id: caseId })).map(r => JSON.parse(r.body) as Decision); }

  // ---- mutable small docs -------------------------------------------------------------
  async putReviewTask(t: ReviewTask) { await this.putVersioned("task", t.tenant_id, t.task_id, t.case_id, t); }
  async listReviewTasks(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "task" })).map(r => JSON.parse(r.body) as ReviewTask); }
  async putOutbox(o: OutboxItem) { await this.putVersioned("outbox", o.tenant_id, o.outbox_id, o.case_id, o); }
  async listOutbox(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "outbox" })).map(r => JSON.parse(r.body) as OutboxItem); }

  // ---- conversation state (one doc per case; holds the participant answers) --------------------
  async getConversation(t: string, id: string) { return this.parse<ConversationState>((await this.d.select({ tenant_id: t, collection: "conv", doc_id: id, latestOnly: true }))[0]); }
  async putConversation(c: ConversationState) { await this.putVersioned("conv", c.tenant_id, c.case_id, c.case_id, c); }

  // ---- inbound event inbox ----------------------------------------------------------------
  async putInbox(e: InboxEvent) { await this.putVersioned("inbox", e.tenant_id, e.inbox_id, "-", e); }
  async getInbox(t: string, id: string) { return this.parse<InboxEvent>((await this.d.select({ tenant_id: t, collection: "inbox", doc_id: id, latestOnly: true }))[0]); }
  async listInbox(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "inbox" })).map(r => JSON.parse(r.body) as InboxEvent).sort((a, b) => a.received_at.localeCompare(b.received_at)); }

  // ---- erasure --------------------------------------------------------------------------
  async eraseCase(a: EraseArgs) {
    // Old versions of a participant row hold the personal data, so drop them all and leave one tombstone.
    await this.d.deleteWhere({ tenant_id: a.tenant, collection: "participant", doc_id: a.participantId });
    await this.d.insert(this.row("participant", a.tenant, a.participantId, "", 1, a.tombstone));
    await this.d.deleteWhere({ tenant_id: a.tenant, collection: "conv", doc_id: a.caseId }); // answers are personal data
    await this.d.deleteWhere({ tenant_id: a.tenant, collection: "call", parent_id: a.caseId }); // audio references and transcripts
    await this.d.deleteWhere({ tenant_id: a.tenant, collection: "memory", doc_id: a.caseId }); // what the agent remembered about the person
    for (const r of await this.latestByDoc({ tenant_id: a.tenant, collection: "wake", parent_id: a.caseId })) {
      const w = JSON.parse(r.body) as WakeRequest;
      await this.putVersioned("wake", a.tenant, w.wake_id, a.caseId, { ...w, note: undefined, detail: undefined, status: w.status === "pending" ? "cancelled" : w.status });
    }
    for (const r of await this.d.select({ tenant_id: "all", collection: "evidence", parent_id: a.caseId })) {
      const e = JSON.parse(r.body) as Evidence;
      await this.d.deleteWhere({ tenant_id: "all", collection: "evidence", doc_id: r.doc_id });
      await this.d.insert(this.row("evidence", "all", r.doc_id, a.caseId, 1, { ...e, value: "[erased]" }));
    }
    for (const r of await this.d.select({ tenant_id: "all", collection: "decision", parent_id: a.caseId })) {
      const x = JSON.parse(r.body) as Decision;
      await this.d.deleteWhere({ tenant_id: "all", collection: "decision", doc_id: r.doc_id });
      await this.d.insert(this.row("decision", "all", r.doc_id, a.caseId, 1, { ...x, rationale: "[erased]" }));
    }
    for (const h of await this.latestByDoc({ tenant_id: a.tenant, collection: "session" })) {
      if (h.parent_id === a.caseId) await this.d.deleteWhere({ tenant_id: a.tenant, collection: "trace", parent_id: h.doc_id });
    }
    if (a.phoneHash) {
      for (const r of await this.d.select({ tenant_id: a.tenant, collection: "inbox" })) {
        if ((JSON.parse(r.body) as InboxEvent).event.phone_hash === a.phoneHash) await this.d.deleteWhere({ tenant_id: a.tenant, collection: "inbox", doc_id: r.doc_id });
      }
    }
  }
  async purgeAll() { for (const collection of ALL_COLLECTIONS) await this.d.deleteWhere({ collection }); }

  // ---- idempotency (first writer wins) --------------------------------------------------
  private idemId = (key: string) => key.replace(/[^A-Za-z0-9_.:\-]/g, "_").slice(0, 110);
  async getIdem(key: string) { const r = (await this.d.select({ tenant_id: "all", collection: "idem", doc_id: this.idemId(key), latestOnly: true }))[0]; return r ? JSON.parse(r.body) : undefined; }
  async claim(key: string) { return this.d.insert(this.row("idem", "all", this.idemId(key), "", 1, { claimed: true })); }
  async putIdem(key: string, value: unknown) { await this.d.insert(this.row("idem", "all", this.idemId(key), "", 1, value)); }

  // ---- agent sessions: header doc + one row per trace step -----------------------------------
  async putSession(s: AgentSession) {
    const { trace, ...head } = s;
    await this.putVersioned("session", s.tenant_id, s.session_id, s.case_id, head);
    for (let i = 0; i < trace.length; i++) {
      const step = trace[i]!;
      const slim: TraceStep = { ...step, input: clip(step.input), result: clip(step.result) };
      await this.d.insert(this.row("trace", s.tenant_id, `${s.session_id}`, s.session_id, i + 1, slim, `trace|${s.session_id}|${i + 1}`));
    }
  }
  private async withTrace(h: Omit<AgentSession, "trace">): Promise<AgentSession> {
    const rows = await this.d.select({ tenant_id: h.tenant_id, collection: "trace", parent_id: h.session_id });
    return { ...h, trace: rows.sort((a, b) => a.version - b.version).map(r => JSON.parse(r.body) as TraceStep) };
  }
  async getSession(id: string) {
    // sessions are tenant-scoped; the caller re-checks tenant on the returned doc
    const r = (await this.d.select({ collection: "session", doc_id: id, latestOnly: true }))[0];
    return r ? this.withTrace(JSON.parse(r.body)) : undefined;
  }
  async listSessions(t: string) {
    const heads = await this.latestByDoc({ tenant_id: t, collection: "session" });
    return heads.map(r => ({ ...(JSON.parse(r.body) as Omit<AgentSession, "trace">), trace: [] as TraceStep[] }));
  }

  // ---- documents bigger than one row (missions, employees): pieces first, then one header row ------------------------------
  // The header is the commit, and only one writer can create it, so two people saving the same version at once cannot
  // produce a half-and-half document.
  private async putBlob(head: string, part: string, tenant: string, id: string, value: unknown, summary: Record<string, unknown>): Promise<boolean> {
    if ((await this.d.select({ tenant_id: tenant, collection: head, doc_id: id, latestOnly: true }))[0]) return false;
    const text = JSON.stringify(value);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += MISSION_PART) parts.push(text.slice(i, i + MISSION_PART));
    for (let i = 0; i < parts.length; i++) await this.d.insert(this.row(part, tenant, id, hash, i + 1, { s: parts[i] }, `${part}|${tenant}|${id}|${hash}|${i + 1}`));
    return this.d.insert(this.row(head, tenant, id, hash, 1, { ...summary, parts: parts.length, hash }));
  }
  private async getBlob<T>(head: string, part: string, tenant: string, id: string): Promise<T | undefined> {
    const h = (await this.d.select({ tenant_id: tenant, collection: head, doc_id: id, latestOnly: true }))[0];
    if (!h) return undefined;
    const meta = JSON.parse(h.body) as { parts: number; hash: string };
    const rows = (await this.d.select({ tenant_id: tenant, collection: part, doc_id: id, parent_id: meta.hash })).sort((x, y) => x.version - y.version);
    if (rows.length !== meta.parts) throw new Error(`${head} ${id} is incomplete in the data store`);
    return JSON.parse(rows.map(r => (JSON.parse(r.body) as { s: string }).s).join("")) as T;
  }
  private async listBlobs<T>(head: string, part: string, tenant: string): Promise<T[]> {
    const out: T[] = [];
    for (const h of await this.latestByDoc({ tenant_id: tenant, collection: head })) { const v = await this.getBlob<T>(head, part, tenant, h.doc_id); if (v) out.push(v); }
    return out;
  }

  // ---- missions ---------------------------------------------------------------------------------------------------------
  putMission(t: string, m: MissionBundle) { return this.putBlob("mission", "mpart", t, m.version, m, { version: m.version, name: m.name }); }
  getMission(t: string, version: string) { return this.getBlob<MissionBundle>("mission", "mpart", t, version); }
  listMissions(t: string) { return this.listBlobs<MissionBundle>("mission", "mpart", t); }

  // ---- employees (platform-owned, shared by every client) ---------------------------------------------------------------
  putEmployee(e: EmployeeDefinition) { return this.putBlob("employee", "epart", PLATFORM_TENANT, e.version, e, { version: e.version, name: e.name }); }
  getEmployee(version: string) { return this.getBlob<EmployeeDefinition>("employee", "epart", PLATFORM_TENANT, version); }
  listEmployees() { return this.listBlobs<EmployeeDefinition>("employee", "epart", PLATFORM_TENANT); }

  // ---- phone calls: the form each mission was published as (configuration), and the calls themselves (personal data) ---------
  async putVoiceForm(l: VoiceFormLink) { await this.putVersioned("voiceform", l.tenant_id, l.mission_version, "-", l); }
  async getVoiceForm(t: string, v: string) { return this.parse<VoiceFormLink>((await this.d.select({ tenant_id: t, collection: "voiceform", doc_id: v, latestOnly: true }))[0]); }
  async putCall(c: CallRecord) { await this.putVersioned("call", c.tenant_id, c.communication_id, c.case_id, c); }
  async getCall(t: string, id: string) { return this.parse<CallRecord>((await this.d.select({ tenant_id: t, collection: "call", doc_id: id, latestOnly: true }))[0]); }
  async listCalls(t: string, caseId?: string) { return (await this.latestByDoc({ tenant_id: t, collection: "call", parent_id: caseId })).map(r => JSON.parse(r.body) as CallRecord); }

  // ---- campaigns -------------------------------------------------------------------------------------------------------
  async putCampaign(c: Campaign) { await this.putVersioned("campaign", c.tenant_id, c.campaign_id, "-", c); }
  async getCampaign(t: string, id: string) { return this.parse<Campaign>((await this.d.select({ tenant_id: t, collection: "campaign", doc_id: id, latestOnly: true }))[0]); }
  async listCampaigns(t: string) { return (await this.latestByDoc({ tenant_id: t, collection: "campaign" })).map(r => JSON.parse(r.body) as Campaign); }

  // ---- operating controls, wake timers, and per-case memory -----------------------------------------------------------------
  async getControls(t: string) { return this.parse<Controls>((await this.d.select({ tenant_id: t, collection: "controls", doc_id: "main", latestOnly: true }))[0]); }
  async putControls(c: Controls) { await this.putVersioned("controls", c.tenant_id, "main", "-", c); } // older versions stay: the table is the change history
  async putWake(w: WakeRequest) { await this.putVersioned("wake", w.tenant_id, w.wake_id, w.case_id, w); }
  async listWakes(t: string, caseId?: string) { return (await this.latestByDoc({ tenant_id: t, collection: "wake", parent_id: caseId })).map(r => JSON.parse(r.body) as WakeRequest).sort((a, b) => a.at.localeCompare(b.at)); }
  async getMemory(t: string, caseId: string) { return this.parse<CaseMemory>((await this.d.select({ tenant_id: t, collection: "memory", doc_id: caseId, latestOnly: true }))[0]); }
  async putMemory(m: CaseMemory) { await this.putVersioned("memory", m.tenant_id, m.case_id, "-", m); }
  // Secrets belong to the platform, are never cleared with development data, and are stored already encrypted.
  async getSecret(name: string) { return this.parse<{ v: string }>((await this.d.select({ tenant_id: PLATFORM_TENANT, collection: "secret", doc_id: name, latestOnly: true }))[0])?.v; }
  async putSecret(name: string, value: string) { await this.putVersioned("secret", PLATFORM_TENANT, name, "-", { v: value }); }
}

/** Keep trace payloads small enough for one row. */
function clip(v: unknown): unknown {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length <= 1500 ? v : { truncated: true, preview: s.slice(0, 1400) };
}
