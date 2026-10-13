import { describe, it, expect } from "vitest";
import type { MissionInput, Participant, Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CampaignService } from "./campaign";
import { CaseService } from "./service";
import { InMemoryStore } from "./store";
import { PLACEMENT_RETENTION_V1 } from "./mission";
import { DRAFT_INSTRUMENT } from "./instrument";

const T = "t1";
const admin: Principal = { user_id: "ops@x.org", tenant_id: T, role: "operator" };

/** A clock the test controls. 05:00 UTC is 10:30 IST, inside the default 09:30 to 18:00 window. */
function clock(start = "2026-10-12T05:00:00Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (minutes: number) => { t += minutes * 60_000; }, set: (iso: string) => { t = new Date(iso).getTime(); } };
}

async function world(over: { start?: string; shared?: InMemoryStore } = {}) {
  const c = clock(over.start);
  const store = over.shared ?? new InMemoryStore();
  const svc = new CaseService(store, c.now, DEFAULT_POLICY);
  return { c, store, svc, camps: new CampaignService(svc) };
}
type World = Awaited<ReturnType<typeof world>>;

const person = (id: string, cohort: string): Participant => ({ participant_id: id, tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", location: "J", cohort, language: "en", consent: "unknown", recorded_employer: "Acme" });

async function load(w: World, n: number, o: { cohort?: string; mission?: string; from?: number } = {}) {
  const from = o.from ?? 1;
  for (let i = from; i < from + n; i++) await w.svc.createCase({ tenant_id: T, run_id: "r", case_id: `DZ-${String(i).padStart(4, "0")}`, participant: person(`p${i}`, o.cohort ?? "B1"), mission_version: o.mission });
}
const statuses = async (w: World) => (await w.store.listCases(T)).reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
const outboxCount = async (w: World) => (await w.store.listOutbox(T)).filter(o => o.kind === "whatsapp_template").length;
const make = async (w: World, over: Record<string, unknown> = {}) => w.camps.create(admin, { name: "Cohort 1", ...over });
const start = (w: World, id: string) => w.camps.act(admin, id, "start");

const loan = (): MissionInput => ({
  mission_id: "MSN-LOAN", version: "MSN-LOAN-v1", name: "Loan", intro_template: "loan_intro_v1",
  templates: [{ key: "loan_intro_v1", language: "en", purpose: "Opens contact", provider_name: "loan_intro_v1" }],
  instrument: { ...DRAFT_INSTRUMENT, draft: false, version: "L1" },
});

describe("campaign pacing", () => {
  it("sends one batch per minute, however often it is triggered", async () => {
    const w = await world();
    await load(w, 40);
    const camp = await make(w, { per_tick: 10 });
    await start(w, camp.campaign_id);

    expect((await w.camps.run(T))[0]).toMatchObject({ sent: 10 });
    for (let i = 0; i < 5; i++) expect((await w.camps.run(T))[0]).toMatchObject({ sent: 0, note: "Already ran this minute." }); // webhook, cron and a button all firing
    expect(await outboxCount(w)).toBe(10);

    w.c.advance(1);
    expect((await w.camps.run(T))[0]).toMatchObject({ sent: 10 });
    expect(await outboxCount(w)).toBe(20);
  });

  it("stops exactly at the daily cap and carries on the next day", async () => {
    const w = await world();
    await load(w, 12);
    const camp = await make(w, { per_tick: 3, daily_cap: 5 });
    await start(w, camp.campaign_id);
    const sent: number[] = [];
    for (let i = 0; i < 4; i++) { sent.push((await w.camps.run(T))[0]!.sent); w.c.advance(1); }
    expect(sent).toEqual([3, 2, 0, 0]);
    expect((await w.camps.get(T, camp.campaign_id)).last_note).toContain("Daily limit of 5 reached");

    w.c.set("2026-10-13T05:00:00Z"); // tomorrow, 10:30 IST
    expect((await w.camps.run(T))[0]!.sent).toBe(3);
    expect((await w.camps.get(T, camp.campaign_id)).sent_total).toBe(8);
  });

  it("the cap holds even when several schedulers run at the same moment", async () => {
    const w = await world();
    await load(w, 30);
    const camp = await make(w, { per_tick: 20, daily_cap: 7 });
    await start(w, camp.campaign_id);
    // Separate service instances over the same store, like separate function invocations.
    const runners = Array.from({ length: 4 }, () => new CampaignService(new CaseService(w.store, w.c.now, DEFAULT_POLICY)));
    await Promise.all(runners.map(r => r.run(T)));
    expect(await outboxCount(w)).toBeLessThanOrEqual(7);
    w.c.advance(1);
    await Promise.all(runners.map(r => r.run(T)));
    expect(await outboxCount(w)).toBe(7);
  });

  it("never messages the same participant twice, even with overlapping runs", async () => {
    const w = await world();
    await load(w, 25);
    const camp = await make(w, { per_tick: 25, daily_cap: 100 });
    await start(w, camp.campaign_id);
    const runners = Array.from({ length: 5 }, () => new CampaignService(new CaseService(w.store, w.c.now, DEFAULT_POLICY)));
    for (let minute = 0; minute < 3; minute++) { await Promise.all(runners.map(r => r.run(T))); w.c.advance(1); }
    const out = (await w.store.listOutbox(T)).filter(o => o.kind === "whatsapp_template");
    expect(new Set(out.map(o => o.case_id)).size).toBe(out.length); // one message per person
    expect(out).toHaveLength(25);
    expect((await w.store.listCases(T)).every(c => c.attempts === 1)).toBe(true);
  });
});

describe("campaign rules", () => {
  it("waits outside the contact window and starts when it opens", async () => {
    const w = await world({ start: "2026-10-12T13:00:00Z" }); // 18:30 IST: closed
    await load(w, 5);
    const camp = await make(w);
    await start(w, camp.campaign_id);
    const r = (await w.camps.run(T))[0]!;
    expect(r.sent).toBe(0);
    expect(r.note).toContain("Waiting for the contact window (09:30 to 18:00 IST)");
    expect(await outboxCount(w)).toBe(0);
    w.c.set("2026-10-13T04:30:00Z"); // 10:00 IST next day
    expect((await w.camps.run(T))[0]!.sent).toBe(5);
  });

  it("a mission's own window is used for its campaign", async () => {
    const w = await world({ start: "2026-10-12T05:00:00Z" }); // 10:30 IST
    await w.svc.createMission(admin, { ...loan(), policy: { windowStartHour: 12, windowEndHour: 16 } });
    await load(w, 3, { mission: "MSN-LOAN-v1" });
    const camp = await make(w, { mission_version: "MSN-LOAN-v1" });
    await start(w, camp.campaign_id);
    expect((await w.camps.run(T))[0]!.note).toContain("12:00 to 16:00 IST");
    w.c.advance(120); // 12:30 IST
    expect((await w.camps.run(T))[0]!.sent).toBe(3);
  });

  it("sends the campaign's mission's own intro template, and pins the case under that mission", async () => {
    const w = await world();
    await w.svc.createMission(admin, loan());
    await load(w, 2, { mission: "MSN-LOAN-v1" });
    const camp = await make(w, { mission_version: "MSN-LOAN-v1" });
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    expect((await w.store.listOutbox(T)).map(o => o.payload.template_key)).toEqual(["loan_intro_v1", "loan_intro_v1"]);
  });

  it("only includes the chosen mission and cohort", async () => {
    const w = await world();
    await w.svc.createMission(admin, loan());
    await load(w, 3, { cohort: "Jaipur", mission: PLACEMENT_RETENTION_V1.version });
    await load(w, 3, { cohort: "Ajmer", mission: PLACEMENT_RETENTION_V1.version, from: 4 });
    await load(w, 3, { cohort: "Jaipur", mission: "MSN-LOAN-v1", from: 7 });
    const camp = await make(w, { cohort: "Jaipur", mission_version: PLACEMENT_RETENTION_V1.version });
    expect((await w.camps.progress(T, [camp])).get(camp.campaign_id)!.queued).toBe(3); // the preview before starting
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    const sentCases = (await w.store.listOutbox(T)).map(o => o.case_id).sort();
    expect(sentCases).toEqual(["DZ-0001", "DZ-0002", "DZ-0003"]);
  });

  it("does not contact people loaded after the campaign started", async () => {
    const w = await world();
    await load(w, 3);
    const camp = await make(w, { per_tick: 2 });
    await start(w, camp.campaign_id);
    w.c.advance(1);
    await load(w, 2, { from: 4 }); // a later import
    await w.camps.run(T);
    w.c.advance(1);
    await w.camps.run(T);
    expect((await w.store.listOutbox(T)).map(o => o.case_id).sort()).toEqual(["DZ-0001", "DZ-0002", "DZ-0003"]);
    expect((await w.camps.get(T, camp.campaign_id)).status).toBe("completed");
    expect((await statuses(w)).draft).toBe(2); // the late arrivals wait for their own campaign
  });

  it("skips deleted cases and cases that already started", async () => {
    const w = await world();
    await load(w, 3);
    await w.svc.beginSession(T, "DZ-0001", "agent"); // an operator already ran an agent on this one
    await w.svc.deleteCase({ user_id: "a", tenant_id: T, role: "admin" }, "DZ-0002", "test_data");
    const camp = await make(w);
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    expect((await w.store.listOutbox(T)).map(o => o.case_id)).toEqual(["DZ-0003"]);
  });

  it("a sent case is waiting for a reply, marked with its campaign, and recorded in the case history", async () => {
    const w = await world();
    await load(w, 1);
    const camp = await make(w);
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    const c = await w.svc.getCase(T, "DZ-0001");
    expect(c).toMatchObject({ status: "waiting", attempts: 1, campaign_id: camp.campaign_id, owner: "Campaign" });
    const events = (await w.store.listEvents(T, "DZ-0001")).map(e => `${e.type}:${e.actor}`);
    expect(events).toContain(`message_queued:campaign:${camp.campaign_id}`);
    expect(JSON.stringify(await w.store.listEvents(T, "DZ-0001"))).not.toContain("Asha");
  });
});

describe("campaign control", () => {
  it("a draft sends nothing until it is started; pause stops sending; resume continues; stop is final", async () => {
    const w = await world();
    await load(w, 30);
    const camp = await make(w, { per_tick: 5 });
    expect(await w.camps.run(T)).toEqual([]); // draft: not running
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    await w.camps.act(admin, camp.campaign_id, "pause");
    w.c.advance(1);
    expect(await w.camps.run(T)).toEqual([]);
    expect(await outboxCount(w)).toBe(5);
    await w.camps.act(admin, camp.campaign_id, "resume");
    expect((await w.camps.run(T))[0]!.sent).toBe(5);
    await w.camps.act(admin, camp.campaign_id, "stop");
    w.c.advance(1);
    expect(await w.camps.run(T)).toEqual([]);
    await expect(w.camps.act(admin, camp.campaign_id, "resume")).rejects.toMatchObject({ code: "ILLEGAL_STATE" });
    await expect(w.camps.act(admin, camp.campaign_id, "start")).rejects.toMatchObject({ code: "ILLEGAL_STATE" });
  });

  it("a pause pressed during a run is not undone by that run's bookkeeping", async () => {
    const w = await world();
    await load(w, 10);
    const camp = await make(w);
    await start(w, camp.campaign_id);
    // The operator pauses while the run is in progress: simulate by pausing from inside a send.
    const original = w.svc.sendIntro.bind(w.svc);
    let paused = false;
    w.svc.sendIntro = async (...a: Parameters<typeof original>) => { if (!paused) { paused = true; await w.camps.act(admin, camp.campaign_id, "pause"); } return original(...a); };
    await w.camps.run(T);
    expect((await w.camps.get(T, camp.campaign_id)).status).toBe("paused");
  });

  it("completes when everyone has been messaged", async () => {
    const w = await world();
    await load(w, 4);
    const camp = await make(w, { per_tick: 10 });
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    expect((await w.camps.get(T, camp.campaign_id))).toMatchObject({ status: "completed", sent_total: 4 });
  });

  it("progress is read from the cases themselves", async () => {
    const w = await world();
    await load(w, 6);
    const camp = await make(w, { per_tick: 4 });
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    const p = (await w.camps.progress(T, [await w.camps.get(T, camp.campaign_id)])).get(camp.campaign_id)!;
    expect(p).toMatchObject({ queued: 2, contacted: 4, waiting: 4, needs_review: 0, complete: 0, send_failed: 0 });
  });

  it("rejects bad settings and unknown missions", async () => {
    const w = await world();
    await expect(w.camps.create(admin, { name: "x", daily_cap: 0 })).rejects.toThrow();
    await expect(w.camps.create(admin, { name: "Good name", per_tick: 500 })).rejects.toThrow();
    await expect(w.camps.create(admin, { name: "Good name", mission_version: "MSN-NONE-v1" })).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  });
});

describe("automatic pause when sends keep failing", () => {
  const settle = async (w: World, status: "sent" | "failed", n: number) => {
    // Resolve the next `n` pending first messages the way the channel would.
    let done = 0;
    for (const o of await w.store.listOutbox(T)) {
      if (o.status !== "pending" || done >= n) continue;
      await w.store.putOutbox({ ...o, status, payload: status === "failed" ? { ...o.payload, last_error: "WhatsApp rejected the number" } : o.payload });
      done++;
    }
  };

  it("pauses when the latest five first messages all failed, and says why", async () => {
    const w = await world();
    await load(w, 20);
    const camp = await make(w, { per_tick: 5 });
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    await settle(w, "failed", 5);
    const paused = await w.camps.checkHealth(T);
    expect(paused).toHaveLength(1);
    expect(paused[0]!.reason).toContain("last 5 first messages all failed (WhatsApp rejected the number)");
    expect(await w.camps.get(T, camp.campaign_id)).toMatchObject({ status: "paused", pause_reason: expect.stringContaining("Fix the cause, then resume") });
    w.c.advance(1);
    expect(await w.camps.run(T)).toEqual([]); // nothing more is sent while paused
    await w.camps.act(admin, camp.campaign_id, "resume");
    expect((await w.camps.run(T))[0]!.sent).toBe(5); // an operator can fix the cause and resume
  });

  it("does not pause on a mix of failures and successes, or while sends are still pending", async () => {
    const w = await world();
    await load(w, 20);
    const camp = await make(w, { per_tick: 5 });
    await start(w, camp.campaign_id);
    await w.camps.run(T);
    expect(await w.camps.checkHealth(T)).toEqual([]);   // all still pending
    await settle(w, "failed", 4);
    await settle(w, "sent", 1);
    expect(await w.camps.checkHealth(T)).toEqual([]);   // four failed, one went through
    expect((await w.camps.get(T, camp.campaign_id)).status).toBe("running");
  });
});

describe("one participant is never started twice", () => {
  it("two writers racing to send the same participant's first message: exactly one wins", async () => {
    const w = await world();
    await load(w, 1);
    const other = new CaseService(w.store, w.c.now, DEFAULT_POLICY);
    const results = await Promise.allSettled([w.svc.sendIntro(T, "DZ-0001", { actor: "campaign:a" }), other.sendIntro(T, "DZ-0001", { actor: "campaign:b" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await outboxCount(w)).toBe(1);
    expect((await w.svc.getCase(T, "DZ-0001")).attempts).toBe(1);
  });

  it("refuses to start a case that already began or is not allowed to be contacted", async () => {
    const w = await world();
    await load(w, 2);
    await w.svc.sendIntro(T, "DZ-0001", { actor: "campaign:a" });
    await expect(w.svc.sendIntro(T, "DZ-0001", { actor: "campaign:a" })).rejects.toMatchObject({ code: "ILLEGAL_STATE" });
    const p = (await w.store.getParticipant(T, "p2"))!;
    await w.store.putParticipant({ ...p, consent: "declined" });
    await expect(w.svc.sendIntro(T, "DZ-0002", { actor: "campaign:a" })).rejects.toMatchObject({ code: "OPTED_OUT" });
    expect(await outboxCount(w)).toBe(1);
  });
});
