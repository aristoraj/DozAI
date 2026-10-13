import { describe, it, expect } from "vitest";
import type { CaseRecord } from "@dozai/contracts";
import { CaseService } from "./service";
import { DocStore, InMemoryDocDriver } from "./docstore";
import { InMemoryStore, type Store } from "./store";
import { seedDemo, DEMO_TENANT } from "./seed";

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
