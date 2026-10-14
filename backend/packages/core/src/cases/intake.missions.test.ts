// The same person can be in several missions, once in each. Every number here is made up.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { Principal } from "@dozai/contracts";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService } from "./service";
import { InMemoryStore } from "../storage/store";
import { importParticipants } from "./intake";
import { draftMission, ScriptedMissionDrafter } from "../missions/studio";
import { PLACEMENT_RETENTION_V1 } from "../missions/mission";

const T = "t1";
const admin: Principal = { user_id: "u", tenant_id: T, role: "admin" };
const KEY = randomBytes(32).toString("base64");
const opts = (missionVersion?: string) => ({ piiKey: KEY, defaultCountryCode: "91", missionVersion });
const row = (name: string, phone: string) => ({ name, phone });

async function world() {
  const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const def = (await draftMission(new ScriptedMissionDrafter(), { name: "Feedback check", programme_name: "Project X", goal: "Find out how the experience was for people.", people: "People who used the service.", find_out: "How smooth it was\nWhether they would recommend it" }, PLACEMENT_RETENTION_V1, [])).definition!;
  const other = await svc.createMission(admin, def);
  return { svc, a: PLACEMENT_RETENTION_V1.version, b: other.version };
}

describe("the same number in different missions", () => {
  it("is allowed: one person, one case in each mission", async () => {
    const { svc, a, b } = await world();
    const first = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(a));
    const second = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(b));
    expect(first.created).toHaveLength(1);
    expect(second).toMatchObject({ created: [{ row: 1 }], skipped: [] });
    const cases = await svc.store.listCases(T);
    expect(cases.map(c => c.mission_version).sort()).toEqual([a, b].sort());
    // two separate participant records for the same number, one per case
    const people = await svc.store.listParticipants(T);
    expect(people).toHaveLength(2);
    expect(people[0]!.phone_hash).toBe(people[1]!.phone_hash);
    expect(new Set(people.map(p => p.participant_id)).size).toBe(2);
  });

  it("is refused inside the same mission, and the message says which case already has it and that another mission is fine", async () => {
    const { svc, a } = await world();
    const first = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(a));
    const again = await importParticipants(svc, admin, [row("Asha Again", "+91 98765 43210"), row("Ravi Test", "9123456780")], opts(a)); // the same number, written differently
    expect(again.created).toHaveLength(1);                                                   // the other row is fine
    expect(again.skipped).toHaveLength(1);
    expect(again.skipped[0]!.reason).toContain(`already in this mission (${first.created[0]!.case_id})`);
    expect(again.skipped[0]!.reason).toContain("different mission");
  });

  it("the same number twice in one file is caught too, for the same mission", async () => {
    const { svc, a } = await world();
    const r = await importParticipants(svc, admin, [row("Asha Test", "9876543210"), row("Asha Copy", "9876543210")], opts(a));
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([{ row: 2, reason: expect.stringContaining("already in this mission") }]);
  });

  it("can be added again to a mission once its case was deleted, because that number was erased", async () => {
    const { svc, a } = await world();
    const first = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(a));
    await svc.deleteCase(admin, first.created[0]!.case_id, "participant_request");
    const again = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(a));
    expect(again.created).toHaveLength(1);
  });

  it("a deleted case in one mission does not touch the same person's case in another", async () => {
    const { svc, a, b } = await world();
    const inA = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(a));
    const inB = await importParticipants(svc, admin, [row("Asha Test", "9876543210")], opts(b));
    await svc.deleteCase(admin, inA.created[0]!.case_id, "participant_request");
    const keep = await svc.getCase(T, inB.created[0]!.case_id);
    expect(keep.deleted_at).toBeUndefined();
    expect((await svc.store.getParticipant(T, keep.participant_id))?.display_name).toBe("Asha Test");
  });
});
