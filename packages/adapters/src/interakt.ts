// Interakt WhatsApp adapter: outbound template sends and inbound webhooks.
//
// Outbound: POST https://api.interakt.ai/v1/public/message/  with  Authorization: Basic <API key>.
// Inbound:  Interakt POSTs events to our webhook with  Interakt-Signature: sha256=<hex HMAC-SHA256 of the raw body>.
// Interakt does not retry a failed webhook and disables it after repeated failures, so the handler only verifies,
// stores the parsed event in the inbox and returns 200. Processing happens after (and can be re-driven).
//
// Safety: a real number is only messaged if it is on INTERAKT_ALLOWLIST (comma-separated digits), unless
// INTERAKT_ALLOW_ALL=1 is set deliberately. Missing allowlist means NOTHING is sent.
import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptPhone, phoneDigits, phoneHash, type CaseService, type InboxEvent, type OutboxItem } from "@dozai/core";
import type { ChannelPort } from "./index";

export interface InteraktConfig {
  apiKey: string;                // Interakt "Developer Settings" API key (already base64; sent as `Basic <key>`)
  piiKey: string;                // DOZAI_PII_KEY
  webhookSecret?: string;
  baseUrl?: string;
  defaultCountryCode?: string;   // digits, e.g. "91"
  allowlist?: string[];          // digits only
  allowAll?: boolean;
  /** Our template key -> an existing approved Interakt template (testing only). */
  templateOverrides?: Record<string, { provider_name: string; language?: string; body_fields?: ("first_name" | "programme")[] }>;
  programmeName?: string;
  fetch?: typeof fetch;
}

export class InteraktError extends Error {
  constructor(message: string, public status: number | null, public retryable: boolean) { super(message); }
}

// ---- signature ---------------------------------------------------------------------

export function verifyInteraktSignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

// Some senders (notably Python) sign a re-serialised copy of the JSON rather than the bytes they transmit, so the
// raw bytes differ from what was signed ("{"a": 1}" vs "{"a":1}"). The signature still needs the secret, so accepting
// a deterministic re-serialisation of the same parsed JSON is no weaker. Returns which form matched, or null.
export type SignatureVariant = "raw" | "compact" | "python" | "sorted-compact" | "sorted-python";

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

/** Python's json.dumps defaults: separators ", " and ": ", non-ASCII escaped as \uXXXX. */
export function pythonDumps(v: unknown): string {
  if (v === null || typeof v !== "object") {
    return typeof v === "string" ? JSON.stringify(v).replace(/[^\x00-\x7f]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(pythonDumps).join(", ")}]`;
  return `{${Object.keys(v as object).map(k => `${pythonDumps(k)}: ${pythonDumps((v as Record<string, unknown>)[k])}`).join(", ")}}`;
}

export function matchSignatureVariant(rawBody: Buffer | string, header: string | undefined, secret: string): SignatureVariant | null {
  if (!header || !secret) return null;
  const got = header.trim().toLowerCase().replace(/^sha256=/, "");
  const ok = (payload: string | Buffer) => {
    const exp = createHmac("sha256", secret).update(payload).digest("hex");
    return exp.length === got.length && timingSafeEqual(Buffer.from(exp), Buffer.from(got));
  };
  if (ok(rawBody)) return "raw";
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(rawBody).toString("utf8")); } catch { return null; }
  if (ok(JSON.stringify(parsed))) return "compact";
  if (ok(pythonDumps(parsed))) return "python";
  const sorted = sortKeys(parsed);
  if (ok(JSON.stringify(sorted))) return "sorted-compact";
  if (ok(pythonDumps(sorted))) return "sorted-python";
  return null;
}

// ---- parsing -----------------------------------------------------------------------

export type InteraktEvent =
  | { kind: "status"; id: string; status: "sent" | "delivered" | "read" | "failed"; messageId: string; callbackData: string | null; failure: string | null; ts: string }
  | { kind: "inbound"; id: string; messageId: string; phone: string; phone_hash?: string; text: string; ts: string }
  | { kind: "ignored"; id: string; type: string };

const STATUS: Record<string, "sent" | "delivered" | "read" | "failed"> = { message_api_sent: "sent", message_api_delivered: "delivered", message_api_read: "read", message_api_failed: "failed" };

/**
 * The reply text. Plain messages arrive as a string; button taps and list choices may arrive as JSON in several
 * shapes ({"text":..}, {"button":{"text":..}}, {"interactive":{"button_reply":{"title":..}}}). Search for the first
 * human-readable field instead of assuming one layout.
 */
export function extractReplyText(raw: unknown, depth = 0): string {
  if (raw == null || depth > 4) return "";
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("{") || s.startsWith("[")) { try { return extractReplyText(JSON.parse(s), depth + 1); } catch { return s; } }
    return s;
  }
  if (typeof raw !== "object") return String(raw);
  const o = raw as Record<string, unknown>;
  for (const k of ["text", "title", "body", "payload", "message"]) { const v = o[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  for (const k of ["button", "button_reply", "list_reply", "interactive", "reply", "quick_reply", "data"]) { const v = extractReplyText(o[k], depth + 1); if (v) return v; }
  return "";
}

export function parseInteraktWebhook(body: any): InteraktEvent {
  const type = String(body?.type ?? "");
  const msg = body?.data?.message ?? {};
  const messageId = String(msg.id ?? "");
  const ts = String(msg.received_at_utc ?? body?.timestamp ?? new Date().toISOString());
  if (STATUS[type]) {
    return { kind: "status", id: `${messageId}:${STATUS[type]}`, status: STATUS[type]!, messageId, callbackData: msg.meta_data?.source_data?.callback_data ?? null, failure: msg.channel_failure_reason ?? null, ts };
  }
  if (type === "message_received") {
    const phone = String(body?.data?.customer?.channel_phone_number ?? "").replace(/\D/g, "");
    return { kind: "inbound", id: `in:${messageId}`, messageId, phone, text: extractReplyText(msg.message).slice(0, 300), ts };
  }
  return { kind: "ignored", id: `ig:${messageId || type}`, type };
}

/** Deterministic reply classification. Anything it cannot place stays as raw evidence for the agent or a human. */
export function classifyReply(text: string, opts: { bareNoIsStop?: boolean } = {}): { optOut: boolean; consent: boolean } {
  const t = text.trim().toLowerCase();
  // A bare "No" means stop only while we are asking for consent; later it is a legitimate answer.
  const bareNo = opts.bareNoIsStop !== false && /^no[\s,.!]*$/.test(t);
  if (/\b(stop|unsubscribe|opt[- ]?out|do not contact|don'?t contact)\b/.test(t) || bareNo) return { optOut: true, consent: false };
  if (/^(yes|y|ok|okay|sure|haan|ha|continue)\b/.test(t)) return { optOut: false, consent: true };
  return { optOut: false, consent: false };
}

// ---- outbound client -----------------------------------------------------------------

export class InteraktClient {
  constructor(private cfg: InteraktConfig) {}
  private get base() { return this.cfg.baseUrl ?? "https://api.interakt.ai"; }

  /** digits include the country code. Returns the provider message id. */
  async sendTemplate(input: { digits: string; templateName: string; languageCode: string; bodyValues: string[]; callbackData: string }): Promise<string> {
    const cc = this.cfg.defaultCountryCode ?? "91";
    const national = input.digits.length > 10 ? input.digits.slice(-10) : input.digits;
    const code = input.digits.length > 10 ? input.digits.slice(0, input.digits.length - 10) : cc;
    const res = await (this.cfg.fetch ?? fetch)(`${this.base}/v1/public/message/`, {
      method: "POST",
      headers: { Authorization: `Basic ${this.cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        countryCode: `+${code}`, phoneNumber: national, type: "Template", callbackData: input.callbackData.slice(0, 512),
        template: { name: input.templateName, languageCode: input.languageCode, bodyValues: input.bodyValues },
      }),
    }).catch(e => { throw new InteraktError(`network error: ${(e as Error).message}`, null, true); });
    const json = (await res.json().catch(() => ({}))) as { result?: boolean; message?: string; id?: string };
    if (res.ok && json.result !== false && json.id) return json.id;
    throw new InteraktError(json.message ?? `Interakt returned ${res.status}`, res.status, res.status === 429 || res.status >= 500);
  }

  /**
   * A free-form (non-template) message. WhatsApp only allows these within 24 hours of the participant's last message.
   * NOTE: Interakt's public documentation does not describe this call; the body below ("type": "Text", "data.message")
   * is the documented-by-convention shape and must be confirmed against a real send.
   */
  async sendText(input: { digits: string; text: string; callbackData: string }): Promise<string> {
    const cc = this.cfg.defaultCountryCode ?? "91";
    const national = input.digits.length > 10 ? input.digits.slice(-10) : input.digits;
    const code = input.digits.length > 10 ? input.digits.slice(0, input.digits.length - 10) : cc;
    const res = await (this.cfg.fetch ?? fetch)(`${this.base}/v1/public/message/`, {
      method: "POST",
      headers: { Authorization: `Basic ${this.cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ countryCode: `+${code}`, phoneNumber: national, type: "Text", callbackData: input.callbackData.slice(0, 512), data: { message: input.text } }),
    }).catch(e => { throw new InteraktError(`network error: ${(e as Error).message}`, null, true); });
    const json = (await res.json().catch(() => ({}))) as { result?: boolean; message?: string; id?: string };
    if (res.ok && json.result !== false && json.id) return json.id;
    throw new InteraktError(json.message ?? `Interakt returned ${res.status}`, res.status, res.status === 429 || res.status >= 500);
  }
}

// ---- channel: outbox dispatch ------------------------------------------------------------

export class InteraktChannels implements ChannelPort {
  private client: InteraktClient;
  constructor(private cfg: InteraktConfig) { this.client = new InteraktClient(cfg); }

  private allowed(digits: string): boolean {
    if (this.cfg.allowAll) return true;
    return (this.cfg.allowlist ?? []).includes(digits);
  }

  /** Sends pending WhatsApp outbox items. Returns the number actually sent. */
  async dispatchOutbox(svc: CaseService, tenant: string): Promise<number> {
    if ((await svc.controls(tenant)).paused) return 0; // the kill switch: nothing is sent while it is on
    let sent = 0;
    for (const o of await svc.store.listOutbox(tenant)) {
      if (o.status !== "pending" || (o.kind !== "whatsapp_template" && o.kind !== "whatsapp_text")) continue;
      sent += (await (o.kind === "whatsapp_text" ? this.sendTextItem(svc, tenant, o) : this.sendOne(svc, tenant, o))) ? 1 : 0;
    }
    return sent;
  }

  private async fail(svc: CaseService, o: OutboxItem, reason: string, final: boolean) {
    await svc.store.putOutbox({ ...o, status: final ? "failed" : "pending", attempts: o.attempts + 1, payload: { ...o.payload, last_error: reason } });
    const c = await svc.store.getCase(o.tenant_id, o.case_id);
    if (c) await svc.emit(c, "message_status", "interakt", `Send ${final ? "failed" : "will retry"}: ${reason}`, { outbox_id: o.outbox_id });
  }

  /** A free-form reply queued by the conversation runner (already checked against the 24-hour window and message cap). */
  private async sendTextItem(svc: CaseService, tenant: string, o: OutboxItem): Promise<boolean> {
    const c = await svc.store.getCase(tenant, o.case_id);
    const p = c && (await svc.store.getParticipant(tenant, c.participant_id));
    if (!c || !p?.phone_enc || p.consent === "declined") { await this.fail(svc, o, "no contact allowed for this case", true); return false; }
    const digits = decryptPhone(this.cfg.piiKey, p.phone_enc);
    if (!this.allowed(digits)) { await this.fail(svc, o, "number is not on the send allowlist", true); return false; }
    try {
      const id = await this.client.sendText({ digits, text: String(o.payload.text ?? ""), callbackData: `${tenant}|${c.case_id}|${o.outbox_id}` });
      await svc.store.putOutbox({ ...o, status: "sent", attempts: o.attempts + 1, payload: { ...o.payload, provider_message_id: id } });
      await svc.emit(c, "message_sent", "interakt", `WhatsApp ${String(o.payload.kind ?? "message")} sent (Interakt id ${id.slice(0, 8)})`, { outbox_id: o.outbox_id, provider_message_id: id });
      return true;
    } catch (e) {
      const err = e as InteraktError;
      await this.fail(svc, o, err.message, !(err.retryable && o.attempts + 1 < 3));
      return false;
    }
  }

  private async sendOne(svc: CaseService, tenant: string, o: OutboxItem): Promise<boolean> {
    const c = await svc.store.getCase(tenant, o.case_id);
    const p = c && (await svc.store.getParticipant(tenant, c.participant_id));
    if (!c || !p?.phone_enc) { await this.fail(svc, o, "no contact number on file", true); return false; }
    const digits = decryptPhone(this.cfg.piiKey, p.phone_enc);
    if (!this.allowed(digits)) { await this.fail(svc, o, "number is not on the send allowlist", true); return false; }

    const bundle = await svc.getMission(tenant, c.mission_version); // the mission this participant belongs to
    const base = bundle.templates.find(t => t.key === o.payload.template_key);
    // Testing aid: send a different, already approved Interakt template under our template key.
    const ov = base && this.cfg.templateOverrides?.[base.key];
    const tpl = base && ov ? { ...base, provider_name: ov.provider_name, language: ov.language ?? base.language, body_fields: ov.body_fields ?? [] } : base;
    if (!tpl?.provider_name) { await this.fail(svc, o, "template has no provider name", true); return false; }
    const fields: Record<string, string> = { first_name: p.first_name ?? p.display_name.split(" ")[0] ?? "there", programme: bundle.programme_name ?? this.cfg.programmeName ?? "Project Udaan" };
    try {
      const id = await this.client.sendTemplate({
        digits, templateName: tpl.provider_name, languageCode: tpl.language,
        bodyValues: (tpl.body_fields ?? []).map(f => fields[f] ?? ""),
        callbackData: `${tenant}|${c.case_id}|${o.outbox_id}`,
      });
      await svc.store.putOutbox({ ...o, status: "sent", attempts: o.attempts + 1, payload: { ...o.payload, provider_message_id: id } });
      await svc.emit(c, "message_sent", "interakt", `WhatsApp template ${tpl.key} sent${tpl.provider_name !== tpl.key ? ` as "${tpl.provider_name}"` : ""} (Interakt id ${id.slice(0, 8)})`, { outbox_id: o.outbox_id, provider_message_id: id });
      return true;
    } catch (e) {
      const err = e as InteraktError;
      await this.fail(svc, o, err.message, !(err.retryable && o.attempts + 1 < 3));
      return false;
    }
  }
}

// ---- inbound: verify, store, process ---------------------------------------------------------

/** Called by the webhook route after the signature check. One write, then return 200. */
/** Remember that a webhook call failed its signature check (at most one record a minute, so junk cannot flood the table). */
export async function recordRejected(svc: CaseService, tenant: string, info: { had_signature_header: boolean; bytes: number; user_agent?: string; content_type?: string }): Promise<void> {
  const minute = svc.now().toISOString().slice(0, 16);
  if (!(await svc.store.claim(`badsig:${tenant}:${minute}`))) return;
  await svc.store.putInbox({ inbox_id: `rejected_${minute.replace(/[^0-9]/g, "")}`, tenant_id: tenant, source: "interakt", event: { kind: "rejected", ...info, user_agent: info.user_agent?.slice(0, 80) }, status: "error", received_at: svc.now().toISOString(), error: "signature mismatch" });
}

export async function storeInteraktEvent(svc: CaseService, tenant: string, body: unknown, piiKey: string): Promise<{ stored: boolean; event: InteraktEvent }> {
  const event = parseInteraktWebhook(body);
  if (event.kind === "ignored") return { stored: false, event };
  // The phone number is replaced by a keyed hash before anything is stored.
  const safeEvent = event.kind === "inbound" ? { ...event, phone: "", phone_hash: phoneHash(piiKey, phoneDigits(event.phone)) } : event;
  const item: InboxEvent = { inbox_id: event.id.replace(/[^A-Za-z0-9_.:\-]/g, "_"), tenant_id: tenant, source: "interakt", event: safeEvent as unknown as Record<string, unknown>, status: "pending", received_at: svc.now().toISOString() };
  if (await svc.store.getInbox(tenant, item.inbox_id)) return { stored: false, event }; // duplicate delivery
  await svc.store.putInbox(item);
  return { stored: true, event };
}

/** Applies pending inbox events to cases. Safe to call repeatedly; each event is applied once. */
export interface AppliedReply { case_id: string; inbox_id: string; /** In memory only: never stored once processing ends. */ text: string }

export async function processInbox(svc: CaseService, tenant: string, piiKey: string, opts: { captureReplyText?: boolean } = {}): Promise<{ processed: number; errors: number; replies: AppliedReply[] }> {
  let processed = 0, errors = 0;
  const replies: AppliedReply[] = [];
  for (const item of await svc.store.listInbox(tenant)) {
    if (item.status !== "pending" || item.source !== "interakt") continue; // phone callbacks are handled by processVoiceInbox
    try {
      const applied = await applyEvent(svc, tenant, piiKey, item.event as unknown as InteraktEvent, opts.captureReplyText !== false);
      if (applied) replies.push({ case_id: applied.caseId, inbox_id: item.inbox_id, text: applied.text });
      const ev = item.event as { text?: string };
      await svc.store.putInbox({ ...item, status: "done", event: { ...item.event, ...(ev.text !== undefined ? { text: "" } : {}) } });
      processed++;
    } catch (e) {
      await svc.store.putInbox({ ...item, status: "error", error: (e as Error).message.slice(0, 200) });
      errors++;
    }
  }
  return { processed, errors, replies };
}

/** Returns the case id when a reply the agent should read was applied. */
async function applyEvent(svc: CaseService, tenant: string, piiKey: string, ev: InteraktEvent, captureReplyText: boolean): Promise<{ caseId: string; text: string } | undefined> {
  if (ev.kind === "status") {
    const [t, caseId] = (ev.callbackData ?? "").split("|");
    if (t !== tenant || !caseId) return; // not ours
    const c = await svc.store.getCase(tenant, caseId);
    if (!c) return;
    await svc.emit(c, "message_status", "interakt", `WhatsApp message ${ev.status}${ev.failure ? `: ${ev.failure}` : ""}`, { provider_message_id: ev.messageId, status: ev.status });
    return;
  }
  if (ev.kind !== "inbound") return;
  const hash = ev.phone_hash ?? phoneHash(piiKey, phoneDigits(ev.phone));
  const people = (await svc.store.listParticipants(tenant)).filter(p => p.phone_hash === hash);
  if (!people.length) return undefined; // unknown sender: ignore, never create cases from inbound messages
  const ids = new Set(people.map(p => p.participant_id));
  const cases = (await svc.store.listCases(tenant)).filter(c => ids.has(c.participant_id));
  const target = cases.filter(c => c.status !== "complete").sort((a, b) => (b.last_touch ?? "").localeCompare(a.last_touch ?? ""))[0];
  if (!target) return undefined; // already finished: nothing to update
  const conv = await svc.store.getConversation(tenant, target.case_id);
  const cls = classifyReply(ev.text, { bareNoIsStop: conv?.status !== "asking" });
  const applied = await svc.recordInbound(tenant, target.case_id, {
    provider_event_id: ev.messageId, channel: "whatsapp",
    summary: cls.optOut ? "Participant asked to stop" : cls.consent ? "Participant agreed to continue" : `Participant replied (${ev.text.length} characters)`,
    consent: cls.consent ? "granted" : undefined, opt_out: cls.optOut,
    // The reply text is stored as evidence only when no conversation runner is handling it.
    answers: cls.optOut || !captureReplyText ? [] : [{ question_id: "reply_text", value: ev.text, confidence: 0.6 }],
  });
  // An opt-out is already final; only real replies on an open case go on to the runner or the agent.
  return cls.optOut || applied.duplicate ? undefined : { caseId: target.case_id, text: ev.text };
}
