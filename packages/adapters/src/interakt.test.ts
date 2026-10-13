import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CaseService, GatewayTools, InMemoryStore, DEMO_TENANT, encryptPhone, decryptPhone, phoneHash, phoneDigits, verifyChain } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { InteraktChannels, InteraktClient, classifyReply, parseInteraktWebhook, processInbox, storeInteraktEvent, verifyInteraktSignature, ScriptedAgentRuntime } from "./index";
import { createApp } from "../../../functions/core_api/src/app";

const KEY = randomBytes(32).toString("base64");
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
const PHONE = "919876543210";

const sign = (body: string, secret: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

async function world() {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const participant: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Asha Kumari", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "Jaipur", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", participant });
  return { store, svc };
}

describe("phone encryption", () => {
  it("round-trips, hashes stably, and rejects tampering or a wrong key", () => {
    const blob = encryptPhone(KEY, PHONE);
    expect(blob).not.toContain(PHONE);
    expect(decryptPhone(KEY, blob)).toBe(PHONE);
    expect(phoneHash(KEY, PHONE)).toBe(phoneHash(KEY, phoneDigits("+91 98765-43210")));
    expect(() => decryptPhone(KEY, blob.slice(0, -2) + "xx")).toThrow();
    expect(() => decryptPhone(randomBytes(32).toString("base64"), blob)).toThrow();
  });
});

describe("webhook signature and parsing", () => {
  it("accepts the right signature and rejects anything else", () => {
    const body = JSON.stringify({ type: "message_received" });
    expect(verifyInteraktSignature(body, sign(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifyInteraktSignature(body, sign(body, "other"), "s3cret")).toBe(false);
    expect(verifyInteraktSignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifyInteraktSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyInteraktSignature(body, sign(body, "s3cret"), "")).toBe(false);
  });

  it("parses status and inbound events", () => {
    const st = parseInteraktWebhook({ type: "message_api_delivered", data: { message: { id: "m1", meta_data: { source_data: { callback_data: "t|C-1|out_1" } } } } });
    expect(st).toMatchObject({ kind: "status", status: "delivered", callbackData: "t|C-1|out_1" });
    const inb = parseInteraktWebhook({ type: "message_received", data: { customer: { channel_phone_number: "919876543210" }, message: { id: "m2", message: "Yes, continue" } } });
    expect(inb).toMatchObject({ kind: "inbound", phone: "919876543210", text: "Yes, continue" });
    expect(parseInteraktWebhook({ type: "something_else", data: {} }).kind).toBe("ignored");
  });

  it("classifies replies", () => {
    expect(classifyReply("STOP")).toEqual({ optOut: true, consent: false });
    expect(classifyReply("No, stop")).toEqual({ optOut: true, consent: false });
    expect(classifyReply("Yes, continue")).toEqual({ optOut: false, consent: true });
    expect(classifyReply("I work at Nova now")).toEqual({ optOut: false, consent: false });
  });
});

describe("InteraktClient", () => {
  it("sends the documented request", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = new InteraktClient({ apiKey: "KEY123", piiKey: KEY, fetch: (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ result: true, id: "msg-1" }), { status: 201 }); }) as never });
    const id = await client.sendTemplate({ digits: PHONE, templateName: "placement_intro_v1", languageCode: "en", bodyValues: ["Asha", "Project Udaan"], callbackData: "t|C-1|out_1" });
    expect(id).toBe("msg-1");
    expect(seen!.url).toBe("https://api.interakt.ai/v1/public/message/");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Basic KEY123");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ countryCode: "+91", phoneNumber: "9876543210", type: "Template", callbackData: "t|C-1|out_1", template: { name: "placement_intro_v1", languageCode: "en", bodyValues: ["Asha", "Project Udaan"] } });
  });

  it("marks rate limits and server errors retryable, and bad requests not", async () => {
    const mk = (status: number) => new InteraktClient({ apiKey: "k", piiKey: KEY, fetch: (async () => new Response(JSON.stringify({ result: false, message: "nope" }), { status })) as never });
    const args = { digits: PHONE, templateName: "t", languageCode: "en", bodyValues: [], callbackData: "x" };
    await expect(mk(429).sendTemplate(args)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(mk(503).sendTemplate(args)).rejects.toMatchObject({ retryable: true });
    await expect(mk(400).sendTemplate(args)).rejects.toMatchObject({ retryable: false });
  });
});

describe("outbound dispatch", () => {
  const cfg = (over: object = {}) => ({ apiKey: "k", piiKey: KEY, allowlist: [PHONE], fetch: (async () => new Response(JSON.stringify({ result: true, id: "prov-1" }), { status: 201 })) as never, ...over });

  async function queued() {
    const w = await world();
    await w.svc.beginSession(DEMO_TENANT, "C-1", "test");
    const tools = new GatewayTools(w.svc);
    const c = await w.svc.getCase(DEMO_TENANT, "C-1");
    const r = await tools.call({ session_id: "s1", tenant_id: DEMO_TENANT, case_id: "C-1", mission_version: "MSN-001-v1.3", employee_version: "1.0.0" }, "whatsapp_send_template", { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-12345678", expected_version: c.version });
    expect(r.error).toBeUndefined();
    return w;
  }

  it("sends to an allowlisted number, records the provider id, and keeps the number out of the ledger", async () => {
    const { svc, store } = await queued();
    expect(await new InteraktChannels(cfg()).dispatchOutbox(svc, DEMO_TENANT)).toBe(1);
    const [o] = await store.listOutbox(DEMO_TENANT);
    expect(o).toMatchObject({ status: "sent", payload: { provider_message_id: "prov-1" } });
    const events = await store.listEvents(DEMO_TENANT, "C-1");
    expect(events.some(e => e.type === "message_sent")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("9876543210");
    expect(verifyChain(events).ok).toBe(true);
  });

  it("refuses a number that is not on the allowlist, and sends nothing when no allowlist is set", async () => {
    for (const over of [{ allowlist: ["910000000000"] }, { allowlist: [] }]) {
      const { svc, store } = await queued();
      let called = 0;
      const sent = await new InteraktChannels(cfg({ ...over, fetch: (async () => { called++; return new Response("{}"); }) as never })).dispatchOutbox(svc, DEMO_TENANT);
      expect(sent).toBe(0);
      expect(called).toBe(0);
      expect((await store.listOutbox(DEMO_TENANT))[0]!.status).toBe("failed");
    }
  });

  it("retries a transient failure, then gives up after three attempts", async () => {
    const { svc, store } = await queued();
    const ch = new InteraktChannels(cfg({ fetch: (async () => new Response(JSON.stringify({ result: false, message: "busy" }), { status: 503 })) as never }));
    await ch.dispatchOutbox(svc, DEMO_TENANT);
    expect((await store.listOutbox(DEMO_TENANT))[0]).toMatchObject({ status: "pending", attempts: 1 });
    await ch.dispatchOutbox(svc, DEMO_TENANT);
    await ch.dispatchOutbox(svc, DEMO_TENANT);
    expect((await store.listOutbox(DEMO_TENANT))[0]).toMatchObject({ status: "failed", attempts: 3 });
  });
});

describe("inbound replies", () => {
  const inbound = (id: string, text: string, phone = PHONE) => ({ type: "message_received", data: { customer: { channel_phone_number: phone }, message: { id, message: text } } });

  it("is stored once, applied once, and attached to the right case", async () => {
    const { svc, store } = await world();
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    const a = await storeInteraktEvent(svc, DEMO_TENANT, inbound("w1", "Yes, continue"), KEY);
    const dup = await storeInteraktEvent(svc, DEMO_TENANT, inbound("w1", "Yes, continue"), KEY);
    expect(a.stored).toBe(true);
    expect(dup.stored).toBe(false);
    expect(await processInbox(svc, DEMO_TENANT, KEY)).toMatchObject({ processed: 1, errors: 0 });
    expect(await processInbox(svc, DEMO_TENANT, KEY)).toMatchObject({ processed: 0, errors: 0 });
    expect((await store.getParticipant(DEMO_TENANT, "p1"))?.consent).toBe("granted");
    expect((await store.listEvidence("C-1")).map(e => e.question_id)).toEqual(["reply_text"]);
  });

  it("never stores the phone number or leaves the reply text in the inbox", async () => {
    const { svc, store } = await world();
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    await storeInteraktEvent(svc, DEMO_TENANT, inbound("w9", "I work at Marigold Exports"), KEY);
    expect(JSON.stringify(await store.listInbox(DEMO_TENANT))).not.toContain(PHONE);
    await processInbox(svc, DEMO_TENANT, KEY);
    const after = JSON.stringify(await store.listInbox(DEMO_TENANT));
    expect(after).not.toContain(PHONE);
    expect(after).not.toContain("Marigold");
  });

  it("STOP completes the case as opted out", async () => {
    const { svc } = await world();
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    await storeInteraktEvent(svc, DEMO_TENANT, inbound("w2", "STOP"), KEY);
    await processInbox(svc, DEMO_TENANT, KEY);
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "complete", outcome: "opted_out" });
  });

  it("ignores unknown senders and unrecognised event types", async () => {
    const { svc } = await world();
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    await storeInteraktEvent(svc, DEMO_TENANT, inbound("w3", "hello", "910000000001"), KEY);
    expect(await processInbox(svc, DEMO_TENANT, KEY)).toMatchObject({ processed: 1, errors: 0 });
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("running");
    expect((await storeInteraktEvent(svc, DEMO_TENANT, { type: "x" }, KEY)).stored).toBe(false);
  });

  it("delivery status updates become ledger events", async () => {
    const { svc, store } = await world();
    await storeInteraktEvent(svc, DEMO_TENANT, { type: "message_api_delivered", data: { message: { id: "m9", meta_data: { source_data: { callback_data: `${DEMO_TENANT}|C-1|out_1` } } } } }, KEY);
    await processInbox(svc, DEMO_TENANT, KEY);
    expect((await store.listEvents(DEMO_TENANT, "C-1")).some(e => e.type === "message_status" && e.summary.includes("delivered"))).toBe(true);
  });
});

describe("webhook route", () => {
  it("rejects a bad signature, accepts a good one, and needs no user session", async () => {
    const { svc } = await world();
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: false, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "test" }, interakt: { webhookSecret: "whsec", piiKey: KEY, tenant: DEMO_TENANT } });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: "wh1", message: "Yes" } } });
      const bad = await fetch(`${base}/api/webhooks/interakt`, { method: "POST", headers: { "content-type": "application/json", "interakt-signature": sign(body, "wrong") }, body });
      expect(bad.status).toBe(401);
      const good = await fetch(`${base}/api/webhooks/interakt`, { method: "POST", headers: { "content-type": "application/json", "interakt-signature": sign(body, "whsec") }, body });
      expect(good.status).toBe(200);
      expect(await good.json()).toMatchObject({ ok: true, stored: true });
      expect((await fetch(`${base}/api/cases`)).status).toBe(401); // the rest of the API still needs sign-in
    } finally { server.close(); }
  });
});
