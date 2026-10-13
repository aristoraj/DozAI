import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, DozaiError } from "./service";
import { DocStore, InMemoryDocDriver } from "./docstore";
import { InMemoryStore, type Store } from "./store";
import { importParticipants, nextCaseId } from "./intake";
import { verifyChain } from "./ledger";
import { decryptPhone } from "./pii";

const KEY = randomBytes(32).toString("base64");
const admin: Principal = { user_id: "boss@example.org", tenant_id: "t1", role: "admin" };
const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };

const NAME = "Zorbaxia Quillington";
const PHONE_DIGITS = "919812345670";
const EMPLOYER = "Quillbright Textiles";
const REPLY = "I now work at Marigold Exports in Pune";

async function loaded(store: Store) {
  const svc = new CaseService(store, () => new Date(), OPEN);
  const r = await importParticipants(svc, admin, [{ name: NAME, phone: "+91 98123 45670", employer: EMPLOYER, location: "Pune", cohort: "Batch 9" }], { piiKey: KEY, defaultCountryCode: "91" });
  const case_id = r.created[0]!.case_id;
  // some activity that carries personal data: a reply, an agent decision, a review
  await svc.beginSession("t1", case_id, "test");
  await svc.recordInbound("t1", case_id, { provider_event_id: "e1", channel: "whatsapp", summary: "Participant replied", answers: [{ question_id: "reply_text", value: REPLY, confidence: 0.6 }], consent: "granted" });
  const refs = (await store.listEvidence(case_id)).map(e => e.evidence_id);
  const c = await svc.getCase("t1", case_id);
  await svc.proposeDecision("t1", case_id, c.version, { proposed_outcome: "confirmed", livelihood_state: "changed_job", confidence: 0.6, evidence_refs: refs, rationale: `Works at Marigold Exports, employer was ${EMPLOYER}` }, "agent:test");
  return { svc, case_id };
}

describe("participant import", () => {
  it("encrypts the number, masks it, and keeps names out of the ledger", async () => {
    const store = new InMemoryStore();
    const { svc, case_id } = await loaded(store);
    const p = (await store.listParticipants("t1"))[0]!;
    expect(p.phone_masked).toBe("•••• 5670");
    expect(p.phone_enc).not.toContain("9812345670");
    expect(decryptPhone(KEY, p.phone_enc!)).toBe(PHONE_DIGITS);
    const ledger = JSON.stringify(await store.listEvents("t1", case_id));
    expect(ledger).not.toContain("Zorbaxia");
    expect(ledger).not.toContain("9812345670");
    expect((await svc.verifyLedger("t1")).ok).toBe(true);
  });

  it("skips bad rows and duplicates, and reports why", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), OPEN);
    const r = await importParticipants(svc, admin, [
      { name: "A One", phone: "9876500001" },
      { name: "A One again", phone: "+91 98765 00001" },  // same number
      { name: "", phone: "9876500002" },                  // no name
      { name: "B Two", phone: "12" },                     // bad number
      { name: "C Three", phone: "9876500003", language: "fr" }, // unsupported language
      { name: "D Four", phone: "9876500004" },
    ], { piiKey: KEY, defaultCountryCode: "91" });
    expect(r.created.map(x => x.row)).toEqual([1, 6]);
    expect(r.skipped.map(x => x.row)).toEqual([2, 3, 4, 5]);
    expect(r.skipped[0]!.reason).toContain("already loaded");
  });

  it("refuses an oversized batch and never reuses a case id", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), OPEN);
    await expect(importParticipants(svc, admin, Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, phone: `98765${String(i).padStart(5, "0")}` })), { piiKey: KEY, defaultCountryCode: "91" })).rejects.toBeInstanceOf(DozaiError);
    const a = await nextCaseId(svc, "t1");
    const b = await nextCaseId(svc, "t1");
    expect(a).not.toBe(b);
  });
});

const stores: [string, () => { store: Store; rows?: () => string }][] = [
  ["InMemoryStore", () => ({ store: new InMemoryStore() })],
  ["DocStore", () => { const d = new InMemoryDocDriver(); return { store: new DocStore(d), rows: () => JSON.stringify(d.rows) }; }],
];

describe.each(stores)("deleteCase on %s", (_n, make) => {
  it("erases personal data everywhere, keeps an anonymous stub, and leaves the ledger valid", async () => {
    const { store, rows } = make();
    const { svc, case_id } = await loaded(store);
    await svc.deleteCase(admin, case_id, "participant_request");

    const c = await svc.getCase("t1", case_id);
    expect(c).toMatchObject({ status: "complete", outcome: "cancelled", deleted_by: "admin:boss@example.org" });
    expect(c.deleted_at).toBeTruthy();

    const p = (await store.listParticipants("t1"))[0]!;
    expect(p).toMatchObject({ display_name: "Deleted participant", phone_masked: "—", consent: "declined" });
    expect(p.phone_enc).toBeUndefined();
    expect(p.phone_hash).toBeUndefined();
    expect((await store.listEvidence(case_id)).every(e => e.value === "[erased]")).toBe(true);
    expect((await store.listDecisions(case_id)).every(d => d.rationale === "[erased]")).toBe(true);

    const events = await store.listEvents("t1", case_id);
    expect(events.at(-2)?.type === "case_deleted" || events.some(e => e.type === "case_deleted")).toBe(true);
    expect(verifyChain(events).ok).toBe(true);

    // The strongest check: nothing stored anywhere still contains the personal data.
    if (rows) {
      const all = rows();
      for (const secret of [NAME, "Zorbaxia", "9812345670", EMPLOYER, "Marigold Exports"]) expect(all, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("erases agent session traces and queued inbound messages that carry the reply", async () => {
    const { store, rows } = make();
    const { svc, case_id } = await loaded(store);
    const ts = new Date().toISOString();
    await store.putSession({ session_id: "sesn_x", tenant_id: "t1", case_id, employee_version: "1", mission_version: "m", status: "idle", tokens_in: 1, tokens_out: 1, cost_usd: 0, budget_usd: 1, simulated: false, started_at: ts, trace: [{ label: "case_get_context", type: "MCP tool", detail: "ok", ts, result: { evidence: [{ value: REPLY }] } }] });
    const hash = (await store.listParticipants("t1"))[0]!.phone_hash!;
    await store.putInbox({ inbox_id: "in_1", tenant_id: "t1", source: "interakt", status: "pending", received_at: ts, event: { kind: "inbound", phone_hash: hash, text: REPLY } });
    await svc.deleteCase(admin, case_id, "participant_request");
    expect((await store.getSession("sesn_x"))?.trace).toEqual([]);
    expect(await store.getInbox("t1", "in_1")).toBeUndefined();
    if (rows) expect(rows()).not.toContain("Marigold");
  });

  it("cannot be deleted twice, and the deleted participant cannot be messaged", async () => {
    const { store } = make();
    const { svc, case_id } = await loaded(store);
    await svc.deleteCase(admin, case_id, "test_data");
    await expect(svc.deleteCase(admin, case_id, "test_data")).rejects.toMatchObject({ code: "CASE_DELETED" });
    expect((await store.getParticipant("t1", (await svc.getCase("t1", case_id)).participant_id))?.consent).toBe("declined");
  });

  it("stops queued messages for the case", async () => {
    const { store } = make();
    const { svc, case_id } = await loaded(store);
    const c = await svc.getCase("t1", case_id);
    await svc.queueOutbox(c, "whatsapp_template", { template_key: "x" }, "k-00000001");
    await svc.deleteCase(admin, case_id, "participant_request");
    expect((await store.listOutbox("t1")).every(o => o.status !== "pending")).toBe(true);
  });
});

describe("reviewer notes", () => {
  it("are kept out of the ledger", async () => {
    const store = new InMemoryStore();
    const { svc, case_id } = await loaded(store);
    const reviewer: Principal = { user_id: "rev@example.org", tenant_id: "t1", role: "reviewer" };
    const c = await svc.getCase("t1", case_id);
    expect(c.status).toBe("review");
    await svc.reviewDecide(reviewer, case_id, { decision: "confirm", note: "Spoke to Zorbaxia on the phone, number 98123", expected_version: c.version });
    expect(JSON.stringify(await store.listEvents("t1", case_id))).not.toContain("Spoke to");
  });
});
