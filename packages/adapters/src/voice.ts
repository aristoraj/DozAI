// Voice calls: the port, a simulator twin, the ZoLabs adapter, call dispatch and result handling.
//
// The agent never talks to the voice provider. It asks the gateway for a call; the gateway checks the rules and queues
// it; dispatchVoice (run by the scheduler) places it through this port. Phone numbers are decrypted here, at the last
// moment, and are never given to the agent or put in the call context.
//
// The provider's callback is only a doorbell: it carries a communication id and nothing is trusted from its body.
// processVoiceInbox rings back and fetches the call's data itself, so a forged callback can do no more than make us
// look at a call that really exists.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildCallContext, decryptPhone, describeNeed, ingestVoiceResult, type CallStatus, type CaseService, type VoiceFormDefinition, type VoiceResult } from "@dozai/core";

// ---- the port -------------------------------------------------------------------------------------------------------

export interface VoicePort {
  readonly kind: "zolabs" | "simulated";
  /** Create the form, or bring an existing one up to date. Returns the form id. */
  publishForm(def: VoiceFormDefinition, o: { existingFormId?: number; callbackUrl?: string }): Promise<{ form_id: number }>;
  startCall(i: { form_id: number; phone: string; context: string; source_id: string }): Promise<{ communication_id: string }>;
  scheduleCall(i: { form_id: number; phone: string; context: string; source_id: string; at: string }): Promise<{ communication_id: string }>;
  endCall(communicationId: string): Promise<void>;
  /** The call's data as the provider holds it now, or null when it cannot be found. */
  fetchResult(communicationId: string): Promise<VoiceResult | null>;
  /** Who the connection is signed in as. A cheap way to prove the connection works. */
  whoami(): Promise<Record<string, unknown> | string>;
  /** The call's recording, streamed from the provider on demand, or null when there is none. Nothing is stored on our side. */
  fetchRecording(communicationId: string): Promise<{ data: Buffer; contentType: string } | null>;
}

// ---- the simulator twin ------------------------------------------------------------------------------------------------

/** Behaves like a provider without ringing anyone. Tests and demos script the outcome with complete(). */
export class FakeVoice implements VoicePort {
  readonly kind = "simulated" as const;
  forms = new Map<number, VoiceFormDefinition & { callbackUrl?: string }>();
  calls: { communication_id: string; form_id: number; phone: string; context: string; source_id: string; at?: string; ended?: boolean }[] = [];
  private results = new Map<string, VoiceResult>();
  private formSeq = 900;
  private callSeq = 0;

  async publishForm(def: VoiceFormDefinition, o: { existingFormId?: number; callbackUrl?: string }) {
    const id = o.existingFormId ?? ++this.formSeq;
    this.forms.set(id, { ...def, callbackUrl: o.callbackUrl });
    return { form_id: id };
  }
  async startCall(i: { form_id: number; phone: string; context: string; source_id: string }) {
    const communication_id = `sim_call_${++this.callSeq}`;
    this.calls.push({ communication_id, ...i });
    return { communication_id };
  }
  async scheduleCall(i: { form_id: number; phone: string; context: string; source_id: string; at: string }) {
    const communication_id = `sim_call_${++this.callSeq}`;
    this.calls.push({ communication_id, ...i });
    return { communication_id };
  }
  /** Recordings a test has put there, by communication id. */
  recordings = new Map<string, Buffer>();
  async fetchRecording(id: string) { const data = this.recordings.get(id); return data ? { data, contentType: "audio/mpeg" } : null; }
  async whoami() { return { account: "simulator" }; }
  async endCall(id: string) { const c = this.calls.find(x => x.communication_id === id); if (c) c.ended = true; }
  async fetchResult(id: string) { return this.results.get(id) ?? null; }

  /** Script how a call ended. Defaults to a person who agreed, confirmed who they are, and answered nothing yet. */
  complete(communicationId: string, over: Partial<VoiceResult> = {}): VoiceResult {
    const r: VoiceResult = { communication_id: communicationId, status: "completed", answers: {}, consent_given: true, identity_confirmed: true, language: "en", has_recording: true, transcript: "Simulated call.", duration_seconds: 120, ...over };
    if (r.has_recording && !this.recordings.has(communicationId)) this.recordings.set(communicationId, Buffer.from("ID3 simulated recording")); // a stand-in for audio
    this.results.set(communicationId, r);
    return r;
  }
}

// ---- ZoLabs over MCP ---------------------------------------------------------------------------------------------------

/** Anything that can call an MCP tool and return its JSON. A real connection, or a stand-in in tests. */
export interface McpCaller { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }

/**
 * A fresh connection per call, so nothing is held between invocations of a serverless function. The access token is a
 * secret and is only ever sent as a Bearer header.
 */
export function mcpOverHttp(url: string, token: string | { token(): Promise<string> }): McpCaller {
  return {
    async callTool(name, args) {
      const client = new Client({ name: "dozai", version: "0.1.0" });
      const bearer = typeof token === "string" ? token : await token.token(); // a renewing token is asked for fresh on every call
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
      try {
        await client.connect(transport);
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[] };
        const text = (res.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
        if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 200)}`);
        try { return JSON.parse(text); } catch { return text; }
      } finally { await client.close().catch(() => undefined); }
    },
  };
}

const pick = (o: unknown, ...paths: string[]): unknown => {
  for (const p of paths) {
    let v: unknown = o;
    for (const k of p.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
/** The service writes these for fields that did not apply to this call. They are not answers. */
const isNotApplicable = (v: unknown) => typeof v === "string" && /^\s*(<\s*n\/?a\s*>|n\/?a|null)\s*$/i.test(v);
const asId = (v: unknown): string | undefined => (typeof v === "number" || (typeof v === "string" && v.trim()) ? String(v) : undefined);

const STATUS: [RegExp, CallStatus][] = [
  [/^(completed|complete|ended|done|finished|success)/i, "completed"],
  [/(no[-_ ]?answer|not[-_ ]?answered|missed|unanswered|unreachable)/i, "no_answer"],
  [/busy/i, "busy"],
  [/(declined|rejected|refused)/i, "declined"],
  [/(failed|error)/i, "failed"],
  [/(cancel)/i, "cancelled"],
  [/(schedul|queued|pending)/i, "scheduled"],
  [/(progress|ringing|live|active|ongoing|calling)/i, "in_progress"],
];

/**
 * Turn a provider record into a VoiceResult. This is the ONE place that knows the provider's format. It was first written as
 * an assumption and then checked against one real finished call (12 Oct 2026). What the real service returns: a numeric
 * communication_id; communication_status and normalised_status ("Completed" / "completed"); field_parsed_answers as an object
 * keyed by field id, with "<N/A>" for fields that did not apply; collected_answers, which is the transcript as text once the
 * call has finished and an empty object before; conversation_start_time and conversation_end_time with no time zone (UTC); and
 * confidence and emotion, which we deliberately ignore. No recording link appeared in the record.
 */
export function parseZolabsCommunication(raw: unknown): VoiceResult | null {
  const id = asId(pick(raw, "communication_id", "id", "communication.id"));
  if (!id) return null;
  const statusText = String(pick(raw, "normalised_status", "communication_status", "status", "call_status", "state") ?? "");
  const status = STATUS.find(([re]) => re.test(statusText))?.[1] ?? "in_progress";

  // Answers: an object keyed by field id, or a list of { field_id, value }.
  const rawAnswers = pick(raw, "field_parsed_answers", ...(typeof (raw as { collected_answers?: unknown } | null)?.collected_answers === "object" ? ["collected_answers"] : []), "form_data", "responses", "response", "extracted_data", "structured_data", "fields", "answers", "result");
  const answers: Record<string, unknown> = {};
  if (Array.isArray(rawAnswers)) for (const a of rawAnswers) { const k = asId(pick(a, "field_id", "id", "key", "name")); const v = pick(a, "value", "answer", "response"); if (k && v !== undefined) answers[k] = v; }
  else if (rawAnswers && typeof rawAnswers === "object") for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) if (v !== undefined && !isNotApplicable(v)) answers[k] = v;

  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "string" ? (/^(true|yes|y|1)$/i.test(v.trim()) ? true : /^(false|no|n|0)$/i.test(v.trim()) ? false : undefined) : undefined);
  const consent = bool(answers.consent_given), identity = bool(answers.identity_confirmed);
  const startedAt = asId(pick(raw, "conversation_start_time")), endedAt = asId(pick(raw, "conversation_end_time"));
  const fromTimes = startedAt && endedAt ? (Date.parse(`${endedAt}Z`) - Date.parse(`${startedAt}Z`)) / 1000 : NaN; // the times carry no zone: UTC
  const duration = Number(pick(raw, "duration_seconds", "duration", "call_duration") ?? fromTimes);
  return {
    communication_id: id, status, answers,
    ...(consent !== undefined ? { consent_given: consent } : {}), ...(identity !== undefined ? { identity_confirmed: identity } : {}),
    language: typeof answers.language === "string" ? answers.language : undefined,
    audio_url: (pick(raw, "audio_url", "recording_url", "audio") as string | undefined) ?? null,
    // The service keeps the recording of a finished call and serves it from /communications/<id>/recording.
    ...(status === "completed" && /^\d+$/.test(id) ? { has_recording: true } : {}),
    transcript: (pick(raw, "transcript", "transcript_text", "text") as string | undefined) ?? (typeof (raw as { collected_answers?: unknown } | null)?.collected_answers === "string" ? ((raw as { collected_answers: string }).collected_answers || null) : null),
    duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    ended_at: endedAt ? `${endedAt}Z` : asId(pick(raw, "ended_at", "completed_at", "end_time")),
  };
}

/** Plain GET requests to the provider's own web address (recordings are fetched this way, not through the tool connection). */
export type RestGet = (path: string) => Promise<Response>;
export function restOverHttp(baseUrl: string, token: string | { token(): Promise<string> }): RestGet {
  return async path => {
    const bearer = typeof token === "string" ? token : await token.token();
    return fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(60_000) });
  };
}

export class ZolabsVoice implements VoicePort {
  readonly kind = "zolabs" as const;
  constructor(private mcp: McpCaller, private rest?: RestGet) {}

  async fetchRecording(id: string) {
    if (!this.rest || !/^\d+$/.test(id)) return null;
    const res = await this.rest(`/communications/${id}/recording`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the provider answered ${res.status} for the recording`);
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "audio/mpeg" };
  }

  async publishForm(def: VoiceFormDefinition, o: { existingFormId?: number; callbackUrl?: string }) {
    let id = o.existingFormId;
    if (!id) {
      // The provider generates a first draft from a description. We overwrite it straight away with our exact definition.
      const made = await this.mcp.callTool("create_form", { form_field_name: def.form_field_name, user_query: `A short follow-up phone interview: ${def.form_fields.map(f => f.field_name).join(", ")}.`, form_context: "", confirmed: true });
      // Seen on the real service: create_form answers { form_fields, form_fields_id, form_link }.
      const n = Number(asId(pick(made, "form_fields_id", "id", "form_id", "form.id", "result.id")));
      if (!Number.isInteger(n) || n <= 0) throw new Error("the provider did not return a form id");
      id = n;
    }
    await this.mcp.callTool("update_form", { form_id: id, form_field_name: def.form_field_name, form_context: def.form_context, start_message: def.start_message, form_fields: def.form_fields, is_active: true, ...(o.callbackUrl ? { callback_url: o.callbackUrl } : {}) });
    return { form_id: id };
  }

  private callId(res: unknown): string {
    // Seen on the real service: start_phone_call answers { call_id, call_sid }.
    const id = asId(pick(res, "call_id", "communication_id", "id", "communication.id", "result.id", "result.communication_id"));
    if (!id) throw new Error("the provider did not return a call id");
    // "1013117_1791817779.061913" is the communication id, an underscore, and a timestamp. Records are listed by the number.
    return /^\d+_/.test(id) ? id.split("_")[0]! : id;
  }
  async startCall(i: { form_id: number; phone: string; context: string; source_id: string }) {
    return { communication_id: this.callId(await this.mcp.callTool("start_phone_call", { phone_number: i.phone, form_id: i.form_id, communication_context: i.context, source_id: i.source_id, confirmed: true })) };
  }
  async scheduleCall(i: { form_id: number; phone: string; context: string; source_id: string; at: string }) {
    // Retries are decided by our own rules, so the provider is asked for exactly one attempt.
    return { communication_id: this.callId(await this.mcp.callTool("schedule_phone_call", { phone_number: i.phone, form_id: i.form_id, communication_context: i.context, schedule_date_time: i.at, attempts: 1, interval_minutes: 1440, confirmed: true })) };
  }
  async whoami() { return (await this.mcp.callTool("whoami", {})) as Record<string, unknown> | string; }
  async endCall(id: string) { await this.mcp.callTool("end_phone_call", { communication_id: Number(id), confirmed: true }); }

  async fetchResult(id: string): Promise<VoiceResult | null> {
    const list = await this.mcp.callTool("list_communications", { search: id, per_page: 10 });
    const items = (Array.isArray(list) ? list : (pick(list, "result", "communications", "items", "data") as unknown[] | undefined)) ?? [];
    const hit = (Array.isArray(items) ? items : []).find(x => asId(pick(x, "communication_id", "id")) === id);
    const parsed = hit ? parseZolabsCommunication(hit) : null;
    if (!parsed) return null;
    if (parsed.status === "completed" && !parsed.transcript) {
      const t = await this.mcp.callTool("get_call_transcript", { communication_id: Number(id) }).catch(() => null);
      const text = typeof t === "string" ? t : (pick(t, "transcript", "text", "result") as string | undefined);
      if (text) parsed.transcript = String(text);
    }
    return parsed;
  }
}

// ---- placing queued calls ----------------------------------------------------------------------------------------------

export interface VoiceDispatchConfig {
  piiKey: string;
  /** Digits with country code. No real call goes to a number that is not here, unless allowAll is set. */
  allowlist?: string[];
  allowAll?: boolean;
  /** Master switch for real calls. Off: queued calls fail with a clear reason and nobody is rung. */
  callsEnabled: boolean;
  /** Said to the voice agent when a mission has no programme name. */
  defaultProgramme?: string;
}

/** Place the calls the agent asked for. Returns how many were started or scheduled. */
export async function dispatchVoice(svc: CaseService, tenant: string, voice: VoicePort, cfg: VoiceDispatchConfig): Promise<number> {
  if ((await svc.controls(tenant)).paused) return 0; // the kill switch: no call is placed while it is on
  let placed = 0;
  for (const o of await svc.store.listOutbox(tenant)) {
    if (o.status !== "pending" || o.kind !== "voice_call") continue;
    const failCall = async (reason: string) => {
      await svc.store.putOutbox({ ...o, status: "failed", attempts: o.attempts + 1, payload: { ...o.payload, last_error: reason } });
      const c = await svc.store.getCase(tenant, o.case_id);
      if (!c || c.deleted_at) return;
      await svc.emit(c, "call_result", "zolabs", `The phone call could not be placed: ${reason}`, { outbox_id: o.outbox_id });
      if (c.status === "call_scheduled") await svc.transition(tenant, c.case_id, c.version, "waiting", { actor: "zolabs", summary: "Phone call could not be placed", patch: { next_action: "The call was not placed. Another attempt is allowed inside the contact rules." } });
    };

    const c = await svc.store.getCase(tenant, o.case_id);
    const p = c && (await svc.store.getParticipant(tenant, c.participant_id));
    if (!c || !p?.phone_enc || p.consent === "declined") { await failCall("no contact allowed for this case"); continue; }
    if (!cfg.callsEnabled) { await failCall("phone calls are not switched on"); continue; }
    const digits = decryptPhone(cfg.piiKey, p.phone_enc);
    if (!cfg.allowAll && !(cfg.allowlist ?? []).includes(digits)) { await failCall("number is not on the call allowlist"); continue; }

    // Claim before ringing: if anything fails after this point the call is NOT repeated, because ringing a person twice is worse than missing a call.
    if (!(await svc.store.claim(`voicecall:${o.outbox_id}`))) continue;

    const mission = await svc.getMission(tenant, c.mission_version);
    const asked = Array.isArray(o.payload.asked) ? (o.payload.asked as string[]) : null;
    const context = buildCallContext({ first_name: p.first_name ?? p.display_name.split(" ")[0] ?? "there", programme: mission.programme_name ?? cfg.defaultProgramme, language: p.language, missing: asked ? asked.map(k => describeNeed(mission, k)) : null });
    const formId = Number(o.payload.form_id), at = typeof o.payload.start_at === "string" ? o.payload.start_at : undefined;
    try {
      const base = { form_id: formId, phone: `+${digits}`, context, source_id: c.case_id };
      const { communication_id } = at ? await voice.scheduleCall({ ...base, at }) : await voice.startCall(base);
      const now = svc.now().toISOString();
      await svc.store.putCall({ communication_id, tenant_id: tenant, case_id: c.case_id, form_id: formId, status: at ? "scheduled" : "in_progress", requested_at: o.created_at, scheduled_for: at, started_at: at ? undefined : now, asked: asked ?? [], reason: typeof o.payload.reason === "string" ? o.payload.reason : undefined });
      await svc.store.putOutbox({ ...o, status: "sent", attempts: o.attempts + 1, payload: { ...o.payload, provider_call_id: communication_id } });
      await svc.emit(c, "call_started", "zolabs", at ? `Phone call scheduled (id ${communication_id.slice(0, 8)})` : `Phone call started (id ${communication_id.slice(0, 8)})`, { outbox_id: o.outbox_id, communication_id });
      if (!at && c.status === "call_scheduled") await svc.transition(tenant, c.case_id, c.version, "calling", { actor: "zolabs", summary: "Phone call started" });
      placed++;
    } catch (e) {
      await failCall((e as Error).message.slice(0, 160));
    }
  }
  return placed;
}

// ---- results ------------------------------------------------------------------------------------------------------------------

/** The callback body is never trusted or stored: only the call id it names is kept, then we fetch the call ourselves. */
export async function storeVoiceCallback(svc: CaseService, tenant: string, body: unknown): Promise<{ stored: boolean; communication_id?: string }> {
  const id = asId(pick(body, "communication_id", "id", "communication.id", "data.id", "data.communication_id"));
  if (!id || !/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) return { stored: false };
  const inbox_id = `zl_${id}`;
  if (await svc.store.getInbox(tenant, inbox_id)) return { stored: false, communication_id: id }; // a repeat delivery
  await svc.store.putInbox({ inbox_id, tenant_id: tenant, source: "zolabs", event: { kind: "voice_done", communication_id: id }, status: "pending", received_at: svc.now().toISOString() });
  return { stored: true, communication_id: id };
}

const GIVE_UP_AFTER_MS = 24 * 3_600_000;

/** Fetch and apply the results of calls the provider has told us about. Returns the cases whose answers the agent should now judge. */
export async function processVoiceInbox(svc: CaseService, tenant: string, voice: VoicePort): Promise<{ processed: number; errors: number; wake: { case_id: string; key: string }[] }> {
  let processed = 0, errors = 0;
  const wake: { case_id: string; key: string }[] = [];
  for (const item of await svc.store.listInbox(tenant)) {
    if (item.source !== "zolabs" || item.status !== "pending") continue;
    const id = String((item.event as { communication_id?: string }).communication_id ?? "");
    try {
      const call = await svc.store.getCall(tenant, id);
      if (!call) { await svc.store.putInbox({ ...item, status: "error", error: "no call with this id was placed by us" }); errors++; continue; }
      const result = await voice.fetchResult(id);
      if (!result || !["completed", "no_answer", "busy", "declined", "failed", "cancelled"].includes(result.status)) {
        // Not ready yet: leave it for the next run, but not for ever.
        if (svc.now().getTime() - new Date(item.received_at).getTime() > GIVE_UP_AFTER_MS) { await svc.store.putInbox({ ...item, status: "error", error: "the call never finished" }); errors++; }
        continue;
      }
      const r = await ingestVoiceResult(svc, tenant, call.case_id, result);
      await svc.store.putInbox({ ...item, status: "done" });
      processed++;
      if (r.finished) wake.push({ case_id: call.case_id, key: `voice:${id}` });
    } catch (e) {
      await svc.store.putInbox({ ...item, status: "error", error: (e as Error).message.slice(0, 200) });
      errors++;
    }
  }
  return { processed, errors, wake };
}
