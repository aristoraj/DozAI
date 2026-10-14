import { describe, it, expect } from "vitest";
import { draftMission, PLACEMENT_RETENTION_V1 as BASE, ScriptedMissionDrafter } from "@dozai/core";
import type { MissionBrief } from "@dozai/contracts";
import { ClaudeMissionDrafter } from "./index";

const brief: MissionBrief = {
  name: "Six-month placement check", programme_name: "Project Udaan",
  goal: "Find out whether people we placed in jobs are still working there six months on, and whether they want support.",
  people: "Young people who finished a three-month retail training with us last year.",
  find_out: "Whether they still work at the same place\nThe name of their employer\nWhether they want job support",
};

/** A model stand-in: each call answers with the next thing in the list. */
function model(answers: ((req: Record<string, unknown>) => unknown)[]) {
  const requests: Record<string, unknown>[] = [];
  const client = { messages: { async create(req: Record<string, unknown>) { requests.push(req); const a = answers[Math.min(requests.length - 1, answers.length - 1)]!(req); return a as never; } } };
  return { client, requests };
}
const asTool = (input: unknown) => ({ stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "submit_mission_draft", input }] });
const validDraft = async () => await new ScriptedMissionDrafter().draft(brief);

describe("drafting with Claude", () => {
  it("sends the brief and the tool, and returns the structure the model submitted", async () => {
    const d = await validDraft();
    const m = model([() => asTool(d)]);
    const out = await new ClaudeMissionDrafter({ client: m.client as never }).draft(brief, BASE);
    expect(out.evidence_requirements).toHaveLength(d.evidence_requirements.length);
    const req = m.requests[0]!;
    expect(JSON.stringify(req.messages)).toContain("Whether they still work at the same place");
    expect(JSON.stringify(req.messages)).toContain("Project Udaan");
    expect((req.tools as { name: string }[])[0]!.name).toBe("submit_mission_draft");
    expect(String(req.system)).toContain("Do not add questions about consent or identity");
    expect(String(req.system)).toContain("nothing about health, caste, religion");
    // the model is asked to sort the questions into categories by purpose, not by branch
    expect(String(req.system)).toContain("Give every question a \"module\": its category, by purpose");
    expect(String(req.system)).toContain("never use the same name twice with different spellings");
  });

  it("never sends anything about a person: only the brief and facts about the mission", async () => {
    const m = model([async () => asTool(await validDraft())]);
    await new ClaudeMissionDrafter({ client: m.client as never }).draft(brief, BASE);
    const sent = JSON.stringify(m.requests[0]!.messages); // what the model is told about this mission
    expect(sent).not.toMatch(/\d{10}|@/);
    expect(sent).not.toContain("Ravi");
  });

  it("says plainly when the model returns no structure, or one that does not fit", async () => {
    const none = model([() => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Sure!" }] })]);
    await expect(new ClaudeMissionDrafter({ client: none.client as never }).draft(brief, BASE)).rejects.toThrow(/did not return a structure/);
    const bad = model([() => asTool({ objective: "short" })]);
    await expect(new ClaudeMissionDrafter({ client: bad.client as never }).draft(brief, BASE)).rejects.toThrow(/objective|evidence_requirements|questions/);
  });

  it("is given its mistakes on the next attempt and the corrected draft is used", async () => {
    const d = await validDraft();
    const broken = { ...d, evidence_requirements: [...d.evidence_requirements, { key: "orphan", label: "No question asks this", required: true, min_confidence: 0.6 }] };
    const m = model([() => asTool(broken), () => asTool(d)]);
    const r = await draftMission(new ClaudeMissionDrafter({ client: m.client as never }), brief, BASE, []);
    expect(r.attempts).toBe(2);
    expect(r.definition).not.toBeNull();
    expect(JSON.stringify(m.requests[1]!.messages)).toContain('evidence need \\"orphan\\" has no question that can fill it');
    expect(r.definition!.instrument.draft).toBe(true);
  });
});
