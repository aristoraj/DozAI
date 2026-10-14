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

// ---- categories (the "module" of each question) and the fixed phone wording ----------------------------------------------------------------
import { categoryFor, tidyCategories } from "./studio";
import { categoryKey, categoryProblems, categoryTitle, phoneWordingProblems } from "./questions";
import { DRAFT_INSTRUMENT } from "./instrument";

describe("categories of generated questions", () => {
  const sampleBrief: MissionBrief = { ...brief };   // the same brief the other tests use
  const modulesOf = (d: { instrument: { questions: { module: string }[] } }) => d.instrument.questions.map(q => q.module);

  it("categoryKey makes one tidy key, so spelling variants are one category", () => {
    expect(["Same Job", "same job", "same_job", " SAME-JOB! "].map(categoryKey)).toEqual(["same_job", "same_job", "same_job", "same_job"]);
    expect(categoryTitle("same_job")).toBe("Same job");
  });

  it("the plain draft sorts each line into a category by what it is about, and support wins over job", async () => {
    const d = (await draftMission(new ScriptedMissionDrafter(), sampleBrief, BASE, [])).definition!;
    expect(modulesOf(d)).toEqual(["work", "work", "work", "support"]);                 // the three work lines, then "job support"
  });

  it("categoryFor", () => {
    expect(categoryFor("Whether they want job support")).toBe("support");
    expect(categoryFor("Their job title")).toBe("work");
    expect(categoryFor("The name of their employer")).toBe("work");
    expect(categoryFor("Which village do they live in")).toBe("about_you");
    expect(categoryFor("Anything else they would like to say")).toBe("general");
  });

  it("every question ends up in a category, with the name tidied and spelling variants merged", async () => {
    const base = await new ScriptedMissionDrafter().draft(sampleBrief);
    const messy = tidyCategories({ ...base, questions: base.questions.map((q, n) => ({ ...q, module: ["Same Job", "same job", "  ", "Support!"][n]! })) });
    expect(messy.questions.map(q => q.module)).toEqual(["same_job", "same_job", "general", "support"]);
  });

  it("a draft from a model that puts many questions in one category is sent back to be grouped", async () => {
    const seen: (string[] | undefined)[] = [];
    const drafter: MissionDrafter = {
      kind: "claude",
      async draft(_b, _base, fix) {
        seen.push(fix);
        const d = await new ScriptedMissionDrafter().draft(sampleBrief);
        return seen.length === 1 ? { ...d, questions: d.questions.map(q => ({ ...q, module: "questions" })) } : d;
      },
    };
    const r = await draftMission(drafter, sampleBrief, BASE, []);
    expect(r.attempts).toBe(2);
    expect(seen[1]!.join(" ")).toContain("are in one category");
    expect(modulesOf(r.definition!)).toEqual(["work", "work", "work", "support"]);
  });

  it("but a plain draft is not held to that: it groups by rules and may honestly have one group", async () => {
    const odd: MissionBrief = { ...sampleBrief, find_out: "How they heard about us\nWhat they enjoyed most\nWhat they would change\nAnything else to say" };
    const r = await draftMission(new ScriptedMissionDrafter(), odd, BASE, []);
    expect(r.problems).toEqual([]);
    expect(new Set(modulesOf(r.definition!))).toEqual(new Set(["general"]));
  });

  it("categoryProblems: one category only matters when there are four or more questions", () => {
    const q = (n: number, module: string) => ({ id: `q${n}`, module, type: "text" as const, evidence_key: `k${n}`, text: `Question ${n}?` });
    expect(categoryProblems({ ...DRAFT_INSTRUMENT, questions: [q(1, "a"), q(2, "a"), q(3, "a")] })).toEqual([]);
    expect(categoryProblems({ ...DRAFT_INSTRUMENT, questions: [q(1, "a"), q(2, "a"), q(3, "a"), q(4, "a")] })[0]).toContain("All 4 questions are in one category");
    expect(categoryProblems({ ...DRAFT_INSTRUMENT, questions: [q(1, "a"), q(2, "a"), q(3, "b"), q(4, "b")] })).toEqual([]);
  });
});

describe("the phone wording is fixed", () => {
  const q = (over: object = {}) => ({ id: "q1", module: "work", type: "text" as const, evidence_key: "k1", text: "Please type the name of your employer.", ...over });
  const ins = (...questions: ReturnType<typeof q>[]) => ({ ...DRAFT_INSTRUMENT, questions });

  it("no problem when nothing changes, when a question is removed, or when a new one has no phone wording of its own", () => {
    expect(phoneWordingProblems(ins(q()), ins(q()))).toEqual([]);
    expect(phoneWordingProblems(ins(q(), q({ id: "q2", evidence_key: "k2" })), ins(q()))).toEqual([]);
    expect(phoneWordingProblems(ins(q()), ins(q(), q({ id: "q3", evidence_key: "k3", text: "How much do you earn?" })))).toEqual([]);
  });

  it("a changed written question changes what is said on a call, so it is refused unless the phone wording was pinned", () => {
    const before = ins(q());
    expect(phoneWordingProblems(before, ins(q({ text: "Where do you work?" })))[0]).toBe("The phone wording of question 1 is fixed and cannot be changed.");
    const pinned = q({ text: "Where do you work?", spoken: "Please tell me the name of your employer." });
    expect(phoneWordingProblems(before, ins(pinned))).toEqual([]);                                   // the call still says what it said
  });

  it("phone wording written over an existing question, or typed into a new one, is refused", () => {
    expect(phoneWordingProblems(ins(q()), ins(q({ spoken: "Say it my way." })))[0]).toContain("question 1 is fixed");
    expect(phoneWordingProblems(ins(q()), ins(q(), q({ id: "q4", evidence_key: "k4", spoken: "By hand." })))[0]).toContain("Question 2 is new");
  });

  it("changing an answer choice changes what a call reads out, so it counts too", () => {
    const c = (label: string, over: object = {}) => ({ id: "q1", module: "work", type: "choice" as const, evidence_key: "k1", text: "Are you working?", options: [{ key: "1", label, value: "yes" }, { key: "2", label: "No", value: "no" }], ...over });
    expect(phoneWordingProblems(ins(c("Yes") as never), ins(c("Yes, I am") as never)).length).toBe(1);
    expect(phoneWordingProblems(ins(c("Yes") as never), ins(c("Yes, I am", { spoken: "Are you working? Say yes or no." }) as never)).length).toBe(1);   // pinned to something other than what it was
  });
});
