// One number can be in several missions, each with its own case. A reply must reach the case the person was last written to in.
// Every number and message here is made up.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Participant } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, InMemoryStore, encryptPhone, phoneHash, DEMO_TENANT as T } from "@dozai/core";
import { processInbox } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";

async function world() {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const person = (id: string): Participant => ({ participant_id: `p-${id}`, tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "C", language: "en", consent: "granted", recorded_employer: "Acme" });
  for (const id of ["C-A", "C-B"]) { await svc.createCase({ tenant_id: T, run_id: "r", case_id: id, participant: person(id) }); await svc.beginSession(T, id, "t"); }
  let n = 0;
  const sentTo = (caseId: string, at: string) => store.putOutbox({ outbox_id: `out_${++n}`, tenant_id: T, case_id: caseId, kind: "whatsapp_text", payload: { text: "q" }, idempotency_key: `k${n}`, status: "sent", attempts: 1, created_at: at });
  const touch = async (caseId: string) => { await new Promise(r => setTimeout(r, 15)); const c = await svc.getCase(T, caseId); await svc.transition(T, caseId, c.version, "waiting", { actor: "t", summary: "touch" }); };
  const reply = async (text: string) => {
    await store.putInbox({ inbox_id: `in_${++n}`, tenant_id: T, source: "interakt", status: "pending", received_at: new Date().toISOString(), event: { kind: "inbound", id: `ev${n}`, messageId: `m${n}`, phone: "", phone_hash: phoneHash(KEY, PHONE), text, ts: new Date().toISOString() } });
    return processInbox(svc, T, KEY);
  };
  return { svc, store, sentTo, touch, reply };
}

describe("a reply from a number that is in two missions", () => {
  it("goes to the case the person was last written to in, even if the other case was touched more recently", async () => {
    const w = await world();
    await w.sentTo("C-B", "2026-10-14T09:00:00.000Z");
    await w.sentTo("C-A", "2026-10-14T10:00:00.000Z");   // the latest message was for C-A: the person is answering that question
    await w.touch("C-B");                                   // C-B changed state afterwards, so it is the most recently "touched"
    const r = await w.reply("yes");
    expect(r.replies.map(x => x.case_id)).toEqual(["C-A"]);
    expect((await w.store.listEvents(T, "C-A")).some(e => e.type === "message_received")).toBe(true);
    expect((await w.store.listEvents(T, "C-B")).some(e => e.type === "message_received")).toBe(false);
  });

  it("follows the conversation: when the other case is written to later, the next reply goes there", async () => {
    const w = await world();
    await w.sentTo("C-A", "2026-10-14T09:00:00.000Z");
    expect((await w.reply("yes")).replies[0]!.case_id).toBe("C-A");
    await w.sentTo("C-B", "2026-10-14T11:00:00.000Z");
    expect((await w.reply("hello")).replies[0]!.case_id).toBe("C-B");
  });

  it("only counts messages that were actually sent, not ones still waiting or that failed", async () => {
    const w = await world();
    await w.sentTo("C-A", "2026-10-14T09:00:00.000Z");
    await w.store.putOutbox({ outbox_id: "out_x", tenant_id: T, case_id: "C-B", kind: "whatsapp_text", payload: { text: "q" }, idempotency_key: "kx", status: "failed", attempts: 3, created_at: "2026-10-14T12:00:00.000Z" });
    expect((await w.reply("yes")).replies[0]!.case_id).toBe("C-A");
  });

  it("falls back to the most recently touched case when nothing was sent to either, and never picks a finished case", async () => {
    const w = await world();
    await w.touch("C-B");
    expect((await w.reply("yes")).replies[0]!.case_id).toBe("C-B");
    const a = await w.svc.getCase(T, "C-A");
    await w.svc.transition(T, "C-A", a.version, "complete", { actor: "t", summary: "done", outcome: "cancelled" });
    await w.sentTo("C-A", "2026-10-14T15:00:00.000Z");        // the finished case was written to last, but it is closed
    expect((await w.reply("again")).replies.map(x => x.case_id)).toEqual(["C-B"]);
  });
});
