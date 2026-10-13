import { describe, it, expect } from "vitest";
import { MissionInputSchema, type MissionBrief, type MissionDraft } from "@dozai/contracts";
import { assembleMission, draftMission, newVersionName, ScriptedMissionDrafter, type MissionDrafter } from "./studio";
import { missionProblems, PLACEMENT_RETENTION_V1 as BASE } from "./mission";

const brief: MissionBrief = {
  name: "Six-month placement check", programme_name: "Project Udaan",
  goal: "Find out whether people we placed in jobs are still working there six months on, and whether they want support.",
  people: "Young people who finished a three-month retail training with us last year.",
  find_out: "Whether they still work at the same place\n- The name of their employer\n- Their job title\nWhether they want job support",
};

describe("drafting a mission from a plain brief", () => {
  it("makes a valid draft that copies the approved template, the contact rules and the employee, and is never signed off", async () => {
    const r = await draftMission(new ScriptedMissionDrafter(), { ...brief, max_attempts: 2, window_start_hour: 10, window_end_hour: 17 }, BASE, []);
    expect(r.problems).toEqual([]);
    const d = r.definition!;
    expect(MissionInputSchema.safeParse(d).success).toBe(true);
    expect(missionProblems(d)).toEqual([]);
    expect(d.instrument.draft).toBe(true);                              // only a person signs wording off
    expect(d.instrument).not.toHaveProperty("signed_off");
    expect(d.intro_template).toBe(BASE.intro_template);                 // the first message is an approved template, not drafted
    expect(d.templates.map(t => t.key)).toEqual(BASE.templates.map(t => t.key));
    expect(d.policy).toMatchObject({ maxAttempts: 2, windowStartHour: 10, windowEndHour: 17 });
    expect(d).toMatchObject({ name: "Six-month placement check", programme_name: "Project Udaan" });
    expect(r.source).toBe("scripted");
    expect(r.notes[0]).toContain("plain draft");
  });

  it("the scripted draft makes one need and one question for each line of the brief", async () => {
    const d = (await draftMission(new ScriptedMissionDrafter(), brief, BASE, [])).definition!;
    expect(d.evidence_requirements).toHaveLength(4);
    expect(d.instrument.questions).toHaveLength(4);
    for (const r of d.evidence_requirements!) expect(d.instrument.questions.some(q => q.evidence_key === r.key)).toBe(true);
  });

  it("names the new version so nothing already saved is overwritten", () => {
    expect(newVersionName("Six-month placement check", [])).toEqual({ mission_id: "MSN-SIX-MONTH-PLACEMENT-CH", version: "six-month-placement-ch-v1.0" });
    expect(newVersionName("Six-month placement check", ["six-month-placement-ch-v1.0", "six-month-placement-ch-v1.1"]).version).toBe("six-month-placement-ch-v1.2");
    expect(newVersionName("!!!", []).version).toBe("mission-v1.0");
  });

  const good = async (): Promise<MissionDraft> => (await new ScriptedMissionDrafter().draft(brief));

  it("gives the drafter its own mistakes to correct, and uses the corrected attempt", async () => {
    const seen: (string[] | undefined)[] = [];
    const drafter: MissionDrafter = {
      kind: "claude",
      async draft(_b, _base, fix) {
        seen.push(fix);
        const d = await good();
        return seen.length === 1 ? { ...d, evidence_requirements: [...d.evidence_requirements, { key: "nothing_asks_this", label: "Unaskable", required: true, min_confidence: 0.6 }] } : d;
      },
    };
    const r = await draftMission(drafter, brief, BASE, []);
    expect(r.attempts).toBe(2);
    expect(r.definition).not.toBeNull();
    expect(seen[0]).toBeUndefined();
    expect(seen[1]!.join(" ")).toContain('evidence need "nothing_asks_this" has no question that can fill it');
    expect(r.source).toBe("claude");
  });

  it("gives up after three attempts and says what was wrong, instead of saving something broken", async () => {
    const drafter: MissionDrafter = { kind: "claude", async draft() { const d = await good(); return { ...d, questions: [...d.questions, { ...d.questions[0]!, text: "A repeated id" }] }; } };
    const r = await draftMission(drafter, brief, BASE, []);
    expect(r.definition).toBeNull();
    expect(r.attempts).toBe(3);
    expect(r.problems.join(" ")).toContain("is used twice");
  });

  it("an attempt that throws is retried, and the reason is kept if every attempt fails", async () => {
    let n = 0;
    const flaky: MissionDrafter = { kind: "claude", async draft() { if (++n < 3) throw new Error("The drafter did not return a structure."); return good(); } };
    expect((await draftMission(flaky, brief, BASE, [])).definition).not.toBeNull();
    const dead: MissionDrafter = { kind: "claude", async draft() { throw new Error("model unavailable"); } };
    expect(await draftMission(dead, brief, BASE, [])).toMatchObject({ definition: null, problems: ["model unavailable"], attempts: 3 });
  });

  it("assembling never lets a draft carry its own approval", async () => {
    const d = { ...(await good()), signed_off: { by: "x", at: "y" }, draft: false } as unknown as MissionDraft;
    const m = assembleMission(brief, d, BASE, { mission_id: "MSN-X", version: "x-v1.0" });
    expect(m.instrument.draft).toBe(true);
    expect(m.instrument).not.toHaveProperty("signed_off");
  });
});
