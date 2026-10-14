import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CampaignService, CaseService, GatewayTools, InMemoryStore, DEMO_TENANT, encryptPhone, phoneHash } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { storeInteraktEvent, tick, ScriptedAgentRuntime, type AgentRuntimePort, type ChannelPort } from "./index";
import { createApp } from "../../../functions/core_api/src/app";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

async function world() {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const participant: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Asha", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" };
  await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", participant });
  await svc.beginSession(DEMO_TENANT, "C-1", "t");
  return { store, svc };
}

const reply = (id: string, text: string) => ({ type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id, message: text } } });

function agentSpy() {
  const resumed: string[] = [];
  const agent: AgentRuntimePort = {
    async runCase() { throw new Error("not used"); },
    async resumeCase(_svc, _t, caseId) { resumed.push(caseId); return {} as never; },
  };
  return { agent, resumed };
}

describe("tick", () => {
  it("applies a reply and resumes the agent once, even if run again or concurrently", async () => {
    const { svc } = await world();
    const { agent, resumed } = agentSpy();
    await storeInteraktEvent(svc, DEMO_TENANT, reply("t1", "I work at Nova now"), KEY);
    const results = await Promise.all([tick(svc, DEMO_TENANT, { piiKey: KEY, agent }), tick(svc, DEMO_TENANT, { piiKey: KEY, agent })]);
    expect(resumed).toEqual(["C-1"]);
    expect(results.flatMap(r => r.resumed)).toEqual(["C-1"]);
    const again = await tick(svc, DEMO_TENANT, { piiKey: KEY, agent });
    expect(again.resumed).toEqual([]);
    expect(resumed).toHaveLength(1);
  });

  it("does not wake the agent for an opt-out, an unknown sender or a delivery receipt", async () => {
    const { svc } = await world();
    const { agent, resumed } = agentSpy();
    await storeInteraktEvent(svc, DEMO_TENANT, reply("t2", "STOP"), KEY);
    await storeInteraktEvent(svc, DEMO_TENANT, { ...reply("t3", "hi"), data: { customer: { channel_phone_number: "910000000000" }, message: { id: "t3", message: "hi" } } }, KEY);
    await storeInteraktEvent(svc, DEMO_TENANT, { type: "message_api_read", data: { message: { id: "m1", meta_data: { source_data: { callback_data: `${DEMO_TENANT}|C-1|o1` } } } } }, KEY);
    const r = await tick(svc, DEMO_TENANT, { piiKey: KEY, agent });
    expect(r.resumed).toEqual([]);
    expect(resumed).toEqual([]);
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "complete", outcome: "opted_out" });
  });

  it("records a failed resume on the case instead of throwing, and dispatches pending sends", async () => {
    const { svc } = await world();
    const channel: ChannelPort = { async dispatchOutbox() { return 2; } };
    const agent: AgentRuntimePort = { async runCase() { throw new Error("x"); }, async resumeCase() { throw new Error("model unavailable"); } };
    await storeInteraktEvent(svc, DEMO_TENANT, reply("t4", "hello"), KEY);
    const r = await tick(svc, DEMO_TENANT, { piiKey: KEY, channel, agent });
    expect(r.sent).toBe(2);
    expect(r.resume_errors).toEqual([{ case_id: "C-1", error: "model unavailable" }]);
    const events = await svc.store.listEvents(DEMO_TENANT, "C-1");
    expect(events.at(-1)?.summary).toContain("Automatic resume failed");
  });
});

describe("tick and campaigns", () => {
  const op = { user_id: "ops@x.org", tenant_id: DEMO_TENANT, role: "operator" } as const;
  async function campaignWorld(n: number) {
    const store = new InMemoryStore();
    const svc = new CaseService(store, () => new Date(), OPEN);
    for (let i = 1; i <= n; i++) {
      const p: Participant = { participant_id: `p${i}`, tenant_id: DEMO_TENANT, display_name: "Asha", first_name: "Asha", phone_masked: "•", location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" };
      await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: `C-${i}`, participant: p });
    }
    const camps = new CampaignService(svc);
    const camp = await camps.create(op, { name: "First batch", per_tick: 5 });
    await camps.act(op, camp.campaign_id, "start");
    return { store, svc, camps, camp };
  }

  it("queues the next batch of first messages, then sends them, all in one run", async () => {
    const { svc } = await campaignWorld(8);
    const dispatched: string[] = [];
    const channel: ChannelPort = { async dispatchOutbox(s, t) { const items = (await s.store.listOutbox(t)).filter(o => o.status === "pending"); for (const o of items) { await s.store.putOutbox({ ...o, status: "sent" }); dispatched.push(o.case_id); } return items.length; } };
    const r = await tick(svc, DEMO_TENANT, { piiKey: KEY, channel, agent: agentSpy().agent });
    expect(r.campaigns).toMatchObject([{ sent: 5 }]);
    expect(r.sent).toBe(5);
    expect(dispatched).toHaveLength(5);
    expect(r.campaigns_paused).toEqual([]);
  });

  it("a campaign whose first messages keep failing is paused by the run itself", async () => {
    const { svc, camp } = await campaignWorld(8);
    const channel: ChannelPort = { async dispatchOutbox(s, t) { for (const o of (await s.store.listOutbox(t)).filter(x => x.status === "pending")) await s.store.putOutbox({ ...o, status: "failed", payload: { ...o.payload, last_error: "invalid API key" } }); return 0; } };
    const r = await tick(svc, DEMO_TENANT, { piiKey: KEY, channel, agent: agentSpy().agent });
    expect(r.campaigns_paused).toHaveLength(1);
    expect(r.campaigns_paused[0]!.reason).toContain("invalid API key");
    expect((await svc.store.getCampaign(DEMO_TENANT, camp.campaign_id))?.status).toBe("paused");
  });

  it("replies are still handled when no campaign exists, and a broken campaign step does not stop them", async () => {
    const { svc } = await world();
    svc.store.listCampaigns = async () => { throw new Error("store hiccup"); };
    const { agent, resumed } = agentSpy();
    await storeInteraktEvent(svc, DEMO_TENANT, reply("t9", "I work at Nova now"), KEY);
    const r = await tick(svc, DEMO_TENANT, { piiKey: KEY, agent });
    expect(r.campaigns).toEqual([]);
    expect(resumed).toEqual(["C-1"]);
  });
});

describe("job route", () => {
  it("needs the job token", async () => {
    const { svc } = await world();
    const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: false, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "test" }, jobToken: "j".repeat(40), interakt: { webhookSecret: "w", piiKey: KEY, tenant: DEMO_TENANT } });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/jobs/tick`, { method: "POST" })).status).toBe(401);
      expect((await fetch(`${base}/api/jobs/tick`, { method: "POST", headers: { "x-job-token": "nope" } })).status).toBe(401);
      const ok = await fetch(`${base}/api/jobs/tick`, { method: "POST", headers: { "x-job-token": "j".repeat(40) } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ sent: 0, resumed: [] });
    } finally { server.close(); }
  });

  it("the case support view needs the token and shows no names, numbers or answer text", async () => {
    const { svc } = await world();
    const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: false, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "test" }, jobToken: "j".repeat(40), interakt: { webhookSecret: "w", piiKey: KEY, tenant: DEMO_TENANT } });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/jobs/case/C-1`)).status).toBe(401);
      expect((await fetch(`${base}/api/jobs/case/NOPE`, { headers: { "x-job-token": "j".repeat(40) } })).status).toBe(404);
      const r = await fetch(`${base}/api/jobs/case/C-1`, { headers: { "x-job-token": "j".repeat(40) } });
      const body = JSON.stringify(await r.json());
      expect(r.status).toBe(200);
      expect(body).toContain("Case created");
      expect(body).not.toMatch(/Asha|9876543210|•••/);
    } finally { server.close(); }
  });
});
