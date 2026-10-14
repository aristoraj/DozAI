// DozAI is not only a placement tracker: a mission can be about anything. These run a mission with no job, no employer and no
// "work status" through the whole platform, and check that nothing assumes the placement mission. Every person here is made up.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { CaseService, ConversationRunner, DEMO_TENANT, draftMission, encryptPhone, GatewayTools, InMemoryStore, phoneHash, PLACEMENT_RETENTION_V1, RuleClassifier, ScriptedMissionDrafter, type MissionBundle } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { FakeChannels, ScriptedAgentRuntime, storeInteraktEvent, tick } from "./index";

const T = DEMO_TENANT;
const KEY = randomBytes(32).toString("base64");
const PHONE = "919876500301";

export async function clinicMission(svc: CaseService): Promise<MissionBundle> {
  const d = await draftMission(new ScriptedMissionDrafter(), { name: "Clinic feedback", programme_name: "Health camp", goal: "Find out how the health camp visit went for people.", people: "People who visited the camp.", find_out: "How easy it was to get there\nWhether they would recommend it\nAnything they want to tell us" }, PLACEMENT_RETENTION_V1, []);
  const def = d.definition!;
  return svc.createMission({ user_id: "u", tenant_id: T, role: "admin" }, { ...def, instrument: { ...def.instrument, draft: false } });
}

async function world() {
  const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const m = await clinicMission(svc);
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "DZ-0001", mission_version: m.version, participant: { participant_id: "p1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "—" } });
  await svc.sendIntro(T, "DZ-0001", { actor: "t" });
  const agent = new ScriptedAgentRuntime(new GatewayTools(svc));
  const runner = new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: false });
  let n = 0;
  const reply = async (text: string) => {
    await storeInteraktEvent(svc, T, { type: "message_received", data: { customer: { channel_phone_number: PHONE }, message: { id: `w${++n}`, message: text } } }, KEY);
    return tick(svc, T, { piiKey: KEY, agent, runner, channel: new FakeChannels() });
  };
  return { svc, m, reply };
}

describe("a mission that is not about jobs", () => {
  it("a finished interview is handed to a person with its answers, not left waiting because the stand-in agent only knows the placement mission", async () => {
    const { svc, reply } = await world();
    await reply("yes");
    await reply("The bus took an hour but it was easy enough");
    await reply("Yes I would tell my neighbours to go");
    const last = await reply("The doctors were kind, thank you");
    expect(last.resumed).toEqual(["DZ-0001"]);
    expect((await svc.store.listEvidence("DZ-0001")).length).toBe(3);
    const c = await svc.getCase(T, "DZ-0001");
    expect(c.status).toBe("review");
    expect(c.reason).toContain("interview_complete");
  });

  it("an interview that is not finished yet is left to the follow-up timer, not handed over early", async () => {
    const { svc, reply } = await world();
    await reply("yes");
    await reply("The bus took an hour but it was easy enough");
    const c = await svc.getCase(T, "DZ-0001");
    expect(c.status).toBe("waiting");
  });
});

describe("the local simulator on a mission that is not about jobs", () => {
  async function run(scenario: "same_job" | "no_response" | "opt_out") {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    const m = await clinicMission(svc);
    await svc.createCase({ tenant_id: T, run_id: "r", case_id: "DZ-0001", mission_version: m.version, participant: { participant_id: "p1", tenant_id: T, display_name: "Asha Test", phone_masked: "•", location: "J", cohort: "C", language: "en", consent: "unknown", recorded_employer: "—" } });
    const s = await new ScriptedAgentRuntime(new GatewayTools(svc)).runCase(svc, T, "DZ-0001", scenario);
    return { svc, m, s, c: await svc.getCase(T, "DZ-0001"), keys: (await svc.store.listEvidence("DZ-0001")).map(e => e.question_id).sort() };
  }

  it("a simulated reply answers this mission's own questions, never the placement ones, and the case goes to a person", async () => {
    const { m, c, keys, s } = await run("same_job");
    expect(keys).toEqual((m.evidence_requirements ?? []).filter(r => r.required).map(r => r.key).sort());
    expect(keys).not.toContain("work_status");
    expect(c.status).toBe("review");
    expect(s.trace.some(t => t.outcome === "refused")).toBe(false);
  });

  it("no reply and opting out behave as on any mission", async () => {
    expect((await run("no_response")).c.status).toBe("waiting");
    expect((await run("opt_out")).c).toMatchObject({ status: "complete", outcome: "opted_out" });
  });
});
