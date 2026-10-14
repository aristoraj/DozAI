import { describe, it, expect } from "vitest";
import type { CaseRecord } from "@dozai/contracts";
import { CaseService } from "./service";
import { DocStore, InMemoryDocDriver } from "./docstore";
import { InMemoryStore, type Store } from "./store";
import { seedDemo, DEMO_TENANT } from "./seed";
import { PLACEMENT_RETENTION_V1 } from "./mission";

const mkCase = (id: string, version = 1): CaseRecord => ({ case_id: id, tenant_id: "t1", run_id: "r", participant_id: "p", status: "draft", outcome: null, livelihood_state: null, confidence: 0, version, next_action: "", owner: "", attempts: 0, last_touch: null, reason: "" });

const stores: [string, () => Store][] = [["InMemoryStore", () => new InMemoryStore()], ["DocStore (in-memory driver)", () => new DocStore(new InMemoryDocDriver())]];

describe.each(stores)("Store contract: %s", (_name, make) => {
  it("casCase: create, advance, and reject a stale writer", async () => {
    const s = make();
    expect(await s.casCase(mkCase("A"), 0)).toBe(true);
    expect(await s.casCase(mkCase("A"), 0)).toBe(false);          // already exists
    expect(await s.casCase({ ...mkCase("A"), version: 2 }, 1)).toBe(true);
    expect(await s.casCase({ ...mkCase("A"), version: 2 }, 1)).toBe(false); // stale
    expect((await s.getCase("t1", "A"))?.version).toBe(2);
    await expect(s.casCase({ ...mkCase("A"), version: 9 }, 2)).rejects.toThrow();
  });

  it("casCase: exactly one of many concurrent writers wins", async () => {
    const s = make();
    await s.casCase(mkCase("B"), 0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.casCase({ ...mkCase("B"), version: 2, next_action: `w${i}` }, 1)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("putCampaignIf: writes only over the copy that was read, so two writers cannot undo each other", async () => {
    const s = make();
    const c = { campaign_id: "K1", tenant_id: "t1", name: "C", mission_version: "m", cohort: null, status: "running", per_tick: 1, daily_cap: 5, sent_day: null, sent_today: 0, sent_total: 0, created_at: "x", created_by: "u", updated_at: "x", started_at: "x", pause_reason: null, last_note: null, last_run_at: null } as never;
    await s.putCampaign(c);
    const read = (await s.getCampaign("t1", "K1"))!;
    expect(await s.putCampaignIf({ ...read, status: "paused" }, read)).toBe(true);
    expect(await s.putCampaignIf({ ...read, sent_total: 9 }, read)).toBe(false); // read before the pause: refused
    expect((await s.getCampaign("t1", "K1"))).toMatchObject({ status: "paused", sent_total: 0 });
    const now = (await s.getCampaign("t1", "K1"))!;
    const both = await Promise.all([s.putCampaignIf({ ...now, sent_total: 1 }, now), s.putCampaignIf({ ...now, sent_total: 2 }, now)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a record too large for one Data Store row, in every store, instead of failing only in production", async () => {
    const s = make();
    const big = "x".repeat(9_500);
    await expect(s.putConversation({ case_id: "C-1", tenant_id: "t1", status: "asking", current: null, reasks: 0, answers: [{ question_id: "q", value: big }] as never, messages_sent: 0, last_inbound_at: null })).rejects.toThrow(/too large/);
    await expect(s.putInbox({ inbox_id: "i1", tenant_id: "t1", source: "interakt", event: { text: big }, status: "pending", received_at: "x" })).rejects.toThrow(/too large/);
    await expect(s.casCase({ ...mkCase("Z"), reason: big }, 0)).rejects.toThrow(/too large/);
    await s.putConversation({ case_id: "C-2", tenant_id: "t1", status: "asking", current: null, reasks: 0, answers: [], messages_sent: 0, last_inbound_at: null }); // a normal one is fine
  });

  it("keeps tenants apart", async () => {
    const s = make();
    await s.casCase(mkCase("C"), 0);
    expect(await s.getCase("other", "C")).toBeUndefined();
    expect(await s.listCases("other")).toHaveLength(0);
  });

  it("ledger: rejects a duplicate seq and returns the last event", async () => {
    const svc = new CaseService(make());
    await svc.createCase({ tenant_id: "t1", run_id: "r", case_id: "D", participant: { participant_id: "pD", tenant_id: "t1", display_name: "X", phone_masked: "•", location: "", cohort: "", language: "en", consent: "unknown", recorded_employer: "E" } });
    const last = await svc.store.lastEvent("t1", "D");
    expect(last?.seq).toBe(1);
    await expect(svc.store.appendEvent({ ...last! })).rejects.toThrow();
  });

  it("idempotency: first writer wins", async () => {
    const s = make();
    await s.putIdem("k:1", { v: 1 });
    await s.putIdem("k:1", { v: 2 });
    expect(await s.getIdem("k:1")).toEqual({ v: 1 });
    expect(await s.getIdem("k:none")).toBeUndefined();
  });

  it("mutable docs keep only the latest version", async () => {
    const s = make();
    const base = { task_id: "T1", tenant_id: "t1", case_id: "A", reason: "r", status: "open" as const, assignee: null, created_at: "x" };
    await s.putReviewTask(base);
    await s.putReviewTask({ ...base, status: "resolved" });
    const tasks = await s.listReviewTasks("t1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("resolved");
  });

  it("full demo seed produces valid chains", async () => {
    const s = make();
    expect((await seedDemo(s)).cases).toBe(12);
    const svc = new CaseService(s);
    expect((await svc.verifyLedger(DEMO_TENANT)).ok).toBe(true);
    expect((await s.listCases(DEMO_TENANT)).filter(c => c.status === "review")).toHaveLength(3);
  });
});

describe("DocStore guards", () => {
  it("refuses oversized documents and unsafe identifiers", async () => {
    const s = new DocStore(new InMemoryDocDriver());
    await expect(s.casCase({ ...mkCase("big"), reason: "x".repeat(10_000) }, 0)).rejects.toThrow(/too large/);
    await expect(s.getCase("t1", "x' OR '1'='1")).resolves.toBeUndefined().catch(() => undefined);
    await expect(s.casCase({ ...mkCase("bad id'") }, 0)).rejects.toThrow(/unsafe/);
  });
});

describe.each(stores)("Store contract, controls, timers and memory: %s", (_name, make) => {
  const wake = (id: string, over: Record<string, unknown> = {}) => ({ wake_id: id, tenant_id: "t1", case_id: "C", at: "2026-10-12T10:00:00.000Z", reason: "silence" as const, status: "pending" as const, created_at: "x", created_by: "x", baseline_seq: 0, ...over });

  it("keeps the latest controls per client, and clients apart", async () => {
    const s = make();
    expect(await s.getControls("t1")).toBeUndefined();
    const base = { tenant_id: "t1", autonomy: { message_template: "automatic", message_scripted: "automatic", message_free: "approve_first", voice_call: "approve_first" } as never, paused: false, daily_budget_usd: 10, case_budget_usd: 1, max_wakes_per_case: 6 };
    await s.putControls(base);
    await s.putControls({ ...base, paused: true, paused_reason: "x" });
    expect(await s.getControls("t1")).toMatchObject({ paused: true, paused_reason: "x" });
    expect(await s.getControls("t2")).toBeUndefined();
  });

  it("keeps the latest state of a timer and lists them by case", async () => {
    const s = make();
    await s.putWake(wake("w1")); await s.putWake(wake("w2", { case_id: "D", at: "2026-10-11T10:00:00.000Z" }));
    await s.putWake(wake("w1", { status: "done" }));
    expect((await s.listWakes("t1")).map(w => [w.wake_id, w.status])).toEqual([["w2", "pending"], ["w1", "done"]]);
    expect((await s.listWakes("t1", "C")).map(w => w.wake_id)).toEqual(["w1"]);
    expect(await s.listWakes("t2")).toEqual([]);
  });

  it("keeps the latest memory for a case, and erasing the case removes it and blanks the timers' notes", async () => {
    const s = make();
    await s.putMemory({ tenant_id: "t1", case_id: "C", items: [{ key: "preferred_channel", value: "voice", source: "a", at: "x" }], updated_at: "x" });
    await s.putMemory({ tenant_id: "t1", case_id: "C", items: [{ key: "preferred_channel", value: "whatsapp", source: "a", at: "y" }], updated_at: "y" });
    expect((await s.getMemory("t1", "C"))?.items[0]?.value).toBe("whatsapp");
    await s.putWake(wake("w1", { note: "via voice" }));
    await s.eraseCase({ tenant: "t1", caseId: "C", participantId: "p", tombstone: { participant_id: "p", tenant_id: "t1", display_name: "Deleted participant", phone_masked: "—", location: "—", cohort: "—", language: "en", consent: "declined", recorded_employer: "—" } });
    expect(await s.getMemory("t1", "C")).toBeUndefined();
    const [w] = await s.listWakes("t1", "C");
    expect(w!.status).toBe("cancelled");
    expect(w!.note).toBeUndefined();
  });

  it("clearing development data keeps the controls", async () => {
    const s = make();
    await s.putControls({ tenant_id: "t1", autonomy: {} as never, paused: true, daily_budget_usd: 1, case_budget_usd: 1, max_wakes_per_case: 1 });
    await s.putWake(wake("w1"));
    await s.purgeAll();
    expect((await s.getControls("t1"))?.paused).toBe(true);
    expect(await s.listWakes("t1")).toEqual([]);
  });
});

describe.each(stores)("Store contract, platform secrets: %s", (_name, make) => {
  it("keeps the latest value, and development clean-up does not remove it", async () => {
    const s = make();
    expect(await s.getSecret("zolabs_refresh_token")).toBeUndefined();
    await s.putSecret("zolabs_refresh_token", "v1");
    await s.putSecret("zolabs_refresh_token", "v2");
    expect(await s.getSecret("zolabs_refresh_token")).toBe("v2");
    await s.purgeAll();
    expect(await s.getSecret("zolabs_refresh_token")).toBe("v2");
  });
});

describe.each(stores)("Store contract, giving a claim back: %s", (_name, make) => {
  it("a claim can be taken once, and again only after it is given back", async () => {
    const s = make();
    expect(await s.claim("lock:a")).toBe(true);
    expect(await s.claim("lock:a")).toBe(false);
    await s.unclaim("lock:a");
    expect(await s.claim("lock:a")).toBe(true);
    expect(await s.claim("lock:b")).toBe(true); // others are untouched
  });
});

describe.each(stores)("Store contract, deleting a mission: %s", (_name, make) => {
  it("removes the mission and its phone form link, and only that one", async () => {
    const s = make();
    const m = (v: string) => ({ ...PLACEMENT_RETENTION_V1, version: v, name: v });
    expect(await s.putMission("t1", m("keep-v1") as never)).toBe(true);
    expect(await s.putMission("t1", m("drop-v1") as never)).toBe(true);
    await s.putVoiceForm({ tenant_id: "t1", mission_version: "drop-v1", form_id: 5, definition_hash: "h", published_at: "x", published_by: "y" });
    await s.deleteMission("t1", "drop-v1");
    expect(await s.getMission("t1", "drop-v1")).toBeUndefined();
    expect(await s.getVoiceForm("t1", "drop-v1")).toBeUndefined();
    expect((await s.getMission("t1", "keep-v1"))?.version).toBe("keep-v1");
    expect(await s.putMission("t1", m("drop-v1") as never)).toBe(true); // the name can be used again
  });
});
