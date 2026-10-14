// @vitest-environment jsdom
// Tests the Command centre filter: the counting rules and the motion, with fake data. No server.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL, MOTION_MS, OUTCOMES, slotsFor, legendHtml, animateNumber, animateOutcomes, casesFor, dashboardFor, donutGradient, missionOf, paintDashboard, summarize, swapContent } from "./dashboard.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const caseOf = (over: Json = {}): Json => ({ id: "DZ-1", status: "progress", workflow_status: "open", final_outcome: null, livelihood_state: null, confidence: 0, attempts: 0, mission_version: "M1", ...over });
const missions = [{ version: "M1" }, { version: "M2" }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean, what: string, ms = MOTION_MS + 1500) => { const t0 = Date.now(); while (!check()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting for: " + what); await sleep(20); } };

describe("the counting rules (the same as GET /api/summary)", () => {
  it("counts nothing for no cases", () => {
    expect(summarize([])).toEqual({ total: 0, review: 0, confirmed: 0, reached: 0, responded: 0, complete: 0, mix: { same_job: 0, changed_job: 0, not_employed: 0, other: 0 } });
  });

  it("needs a person: cases waiting for review", () => {
    expect(summarize([caseOf({ workflow_status: "review" }), caseOf(), caseOf({ workflow_status: "complete" })]).review).toBe(1);
  });

  it("confirmed comes from the final outcome, not the status", () => {
    expect(summarize([caseOf({ final_outcome: "confirmed" }), caseOf({ final_outcome: "inconclusive" }), caseOf({ workflow_status: "complete" })]).confirmed).toBe(1);
  });

  it("contacted: a message was attempted, or the case is complete", () => {
    expect(summarize([caseOf({ attempts: 1 }), caseOf({ attempts: 0 }), caseOf({ workflow_status: "complete" })]).reached).toBe(2);
  });

  it("responded: more than 25% sure, or complete, or in review", () => {
    const s = summarize([caseOf({ confidence: 25 }), caseOf({ confidence: 26 }), caseOf({ workflow_status: "complete" }), caseOf({ workflow_status: "review" }), caseOf()]);
    expect(s.responded).toBe(3);                                          // 26, complete, review. Not 25 and not 0.
  });

  it("the outcome mix: each state counts, and 'other' is only for completed cases with no clear state", () => {
    const s = summarize([
      caseOf({ livelihood_state: "same_job" }), caseOf({ livelihood_state: "changed_job", workflow_status: "complete" }), caseOf({ livelihood_state: "not_employed" }),
      caseOf({ workflow_status: "complete" }), caseOf({ workflow_status: "complete", livelihood_state: "unclear" }), caseOf(),
    ]);
    expect(s.mix).toEqual({ same_job: 1, changed_job: 1, not_employed: 1, other: 2 });
    expect(s.complete).toBe(3);
  });
});

describe("which cases a mission keeps", () => {
  const cases = [caseOf({ id: "A", mission_version: "M1" }), caseOf({ id: "B", mission_version: "M2" }), caseOf({ id: "C", mission_version: null })];

  it("a case from before missions existed belongs to the first mission", () => {
    expect(missionOf(cases[2], missions)).toBe("M1");
    expect(casesFor(cases, missions, "M1").map(c => c.id)).toEqual(["A", "C"]);
    expect(casesFor(cases, missions, "M2").map(c => c.id)).toEqual(["B"]);
  });

  it("all missions keeps everything, and an unknown mission keeps nothing", () => {
    expect(casesFor(cases, missions, ALL)).toHaveLength(3);
    expect(casesFor(cases, missions, "gone")).toEqual([]);
  });

  it("the waiting count, paused campaigns and recent activity follow the mission too", () => {
    const list = [caseOf({ id: "A", mission_version: "M1", status: "progress" }), caseOf({ id: "B", mission_version: "M2", status: "progress" }), caseOf({ id: "C", mission_version: "M2", status: "review", workflow_status: "review" })];
    const campaigns = [{ status: "paused", mission_version: "M1" }, { status: "paused", mission_version: null }, { status: "running", mission_version: "M1" }, { status: "paused", mission_version: "M2" }];
    const audits = [{ case_id: "A" }, { case_id: "B" }, { case_id: "C" }, { case_id: "GONE" }];
    const all = dashboardFor({ cases: list, missions, campaigns, audits, key: ALL });
    expect([all.waiting, all.paused.length, all.activity.length]).toEqual([2, 3, 4]);
    const m1 = dashboardFor({ cases: list, missions, campaigns, audits, key: "M1" });
    expect([m1.summary.total, m1.waiting, m1.paused.length, m1.activity.map(a => a.case_id)]).toEqual([1, 1, 2, ["A"]]);   // the campaign with no mission is the first mission's
    const m2 = dashboardFor({ cases: list, missions, campaigns, audits, key: "M2" });
    expect([m2.summary.total, m2.summary.review, m2.paused.length, m2.activity.map(a => a.case_id)]).toEqual([2, 1, 1, ["B", "C"]]);
  });
});

describe("the donut", () => {
  it("is plain when nothing is classified, and splits the circle by share otherwise", () => {
    expect(donutGradient([0, 0, 0, 0])).toBe("var(--line)");
    const g = donutGradient([1, 1, 0, 0]);
    expect(g).toContain(`${OUTCOMES[0][2]} 0deg 180deg`);
    expect(g).toContain(`${OUTCOMES[1][2]} 180deg 360deg`);
  });
});

describe("motion", () => {
  let realMatchMedia: typeof window.matchMedia | undefined;
  beforeEach(() => { document.body.innerHTML = ""; realMatchMedia = window.matchMedia; });
  afterEach(() => { window.matchMedia = realMatchMedia as typeof window.matchMedia; });
  const number = (shown: number) => { const el = document.createElement("div"); el.dataset.shown = String(shown); el.textContent = String(shown); document.body.append(el); return el; };

  it("a number that does not change is set at once", () => {
    const el = number(5);
    animateNumber(el, 5);
    expect(el.textContent).toBe("5");
  });

  it("a number counts to its new value and ends exactly on it, in the right format", async () => {
    const el = number(0);
    animateNumber(el, 92, v => `${v}%`);
    await sleep(120);
    const mid = Number(el.textContent!.replace("%", ""));
    expect(mid).toBeGreaterThan(0);                                       // it is moving
    expect(mid).toBeLessThan(92);                                         // and has not arrived
    await until(() => el.textContent === "92%", "the number to arrive");
  });

  it("changing again part-way continues from where it is, and never jumps", async () => {
    const el = number(0);
    animateNumber(el, 100);
    await sleep(200);
    const at = el._shown as number;
    expect(at).toBeGreaterThan(0);
    animateNumber(el, 0);
    await sleep(40);
    expect(el._shown as number).toBeLessThanOrEqual(at);                  // heading back down from where it was, not from 100
    await until(() => el.textContent === "0", "the number to settle at 0");
  });

  it("people who ask for less motion get the final value at once", () => {
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    const el = number(0);
    animateNumber(el, 40);
    expect(el.textContent).toBe("40");
    const list = document.createElement("div"); document.body.append(list);
    swapContent(list, "<p>new</p>");
    expect(list.innerHTML).toBe("<p>new</p>");                            // no fade, no waiting
  });

  const donutMarkup = (values: number[]) => `<div data-donut data-values="${JSON.stringify(values)}"></div><strong data-donut-centre>${values.reduce((a, b) => a + b, 0)}</strong>${OUTCOMES.map(([k], i) => `<b data-mix="${k}">${values[i]}</b>`).join("")}`;

  it("the donut slides to the new shares and the legend and centre follow", async () => {
    document.body.innerHTML = donutMarkup([3, 3, 1, 2]);
    animateOutcomes(document.body, { same_job: 0, changed_job: 5, not_employed: 0, other: 0 });
    await until(() => document.querySelector("[data-donut-centre]")!.textContent === "5" && document.querySelector('[data-mix="changed_job"]')!.textContent === "5", "the donut to settle");
    expect(document.querySelector('[data-mix="same_job"]')!.textContent).toBe("0");
    expect((document.querySelector("[data-donut]") as HTMLElement).style.background).not.toBe("");
  });

  it("a list fades out, changes, and fades back in, and the last change wins", async () => {
    const list = document.createElement("div"); list.innerHTML = "<p>old</p>"; document.body.append(list);
    const seen: string[] = [];
    swapContent(list, "<p>first</p>", el => seen.push(el.innerHTML));
    expect(list.classList.contains("is-swapping")).toBe(true);
    swapContent(list, "<p>second</p>", el => seen.push(el.innerHTML)); // a quick second change
    await until(() => list.innerHTML === "<p>second</p>" && !list.classList.contains("is-swapping"), "the list to change");
    expect(seen).toEqual(["<p>second</p>"]);                              // the first change never showed
  });

  it("paints the whole Command centre in place: numbers, bars, donut, lists", async () => {
    const stage = (k: string, n: number) => `<div data-stage="${k}"><div class="progress-fill" style="width:100%"></div><span data-stage-count data-shown="${n}">${n}</span></div>`;
    document.body.innerHTML = `<div id="root">
      <div data-kpi="total" data-shown="12">12</div><span data-kpi-foot="total">loaded</span>
      <div data-kpi="reached" data-shown="92">92%</div><span data-kpi-foot="reached">11 of 12</span>
      <div data-kpi="confirmed" data-shown="3">3</div><span data-kpi-foot="confirmed">6 completed</span>
      <div data-kpi="review" data-shown="3">3</div><span class="delta amber" data-kpi-foot="review">waiting for review</span>
      ${["total", "reached", "responded", "complete", "confirmed"].map(k => stage(k, 12)).join("")}
      ${donutMarkup([3, 3, 1, 2])}
      <div data-dash="attention"><p>old attention</p></div><div data-dash="activity"><p>old activity</p></div></div>`;
    const root = document.getElementById("root")!;
    let after = 0;
    paintDashboard(root, {
      kpis: { total: 4, reached: 50, confirmed: 1, review: 0 },
      foots: { total: "loaded", reached: "2 of 4", confirmed: "1 completed", review: "all clear", reviewTone: false },
      stages: { total: 4, reached: 2, responded: 2, complete: 1, confirmed: 1 }, stagePct: { total: 100, reached: 50, responded: 50, complete: 25, confirmed: 25 },
      mix: { same_job: 1, changed_job: 0, not_employed: 0, other: 0 }, attentionHtml: "<p>new attention</p>", activityHtml: "<p>new activity</p>",
    }, { after: () => { after++; } });
    expect((root.querySelectorAll(".progress-fill")[1] as HTMLElement).style.width).toBe("50%");   // bars are set at once; CSS eases them
    expect(root.querySelector('[data-kpi-foot="review"]')!.classList.contains("amber")).toBe(false);
    expect(root.querySelector('[data-kpi-foot="reached"]')!.textContent).toBe("2 of 4");
    await until(() => root.querySelector('[data-kpi="total"]')!.textContent === "4" && root.querySelector('[data-kpi="reached"]')!.textContent === "50%" && root.querySelector('[data-kpi="review"]')!.textContent === "0", "the numbers to arrive");
    await until(() => root.querySelector('[data-dash="attention"]')!.innerHTML === "<p>new attention</p>" && root.querySelector('[data-dash="activity"]')!.innerHTML === "<p>new activity</p>", "the lists to change");
    expect(root.querySelectorAll("[data-stage-count]")[3]!.textContent).toBe("1");
    await until(() => root.querySelector("[data-donut-centre]")!.textContent === "1", "the donut centre");
    expect(after).toBe(2);
  });
});

describe("the filter bar style", () => {
  it("the dropdown inside the filter box has a fixed width limit, never a percentage (a percentage once made the box wider than the dropdown)", () => {
    const css = readFileSync(resolve(process.cwd(), "frontend/src/styles/pages/command-centre.css"), "utf8"); // run from the repo root (npm test)
    const rule = css.match(/\.dash-filter \.cs \{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/max-width:\s*\d+px/);
    expect(rule).not.toContain("%");
  });
});

describe("the outcomes breakdown follows the mission, not job words", () => {
  const feedback = { version: "M2", outcomes: [{ key: "satisfied", label: "Satisfied" }, { key: "mixed", label: "Mixed feelings" }, { key: "unhappy", label: "Unhappy" }, { key: "no_view", label: "No view" }] };
  const keys = (slots: Json) => slots.map(([k]: [string]) => k);

  it("one mission shows its own first three findings and 'other'; a mission with none keeps the original job ones", () => {
    expect(keys(slotsFor(feedback, false))).toEqual(["satisfied", "mixed", "unhappy", "other"]);
    expect(slotsFor(feedback, false)[1][1]).toBe("Mixed feelings");
    expect(slotsFor({ version: "M1" }, false)).toBe(OUTCOMES);
    expect(slotsFor(undefined, false)).toBe(OUTCOMES);
  });

  it("several missions together show the general results, because a job finding means nothing for a feedback mission", () => {
    expect(keys(slotsFor(null, true))).toEqual(["confirmed", "not_confirmed", "inconclusive", "other"]);
  });

  it("counts each finding, and puts every other finished case under 'other'", () => {
    const slots = slotsFor(feedback, false);
    const cs = [caseOf({ livelihood_state: "satisfied", workflow_status: "complete" }), caseOf({ livelihood_state: "satisfied", workflow_status: "complete" }), caseOf({ livelihood_state: "unhappy", workflow_status: "complete" }), caseOf({ livelihood_state: "no_view", workflow_status: "complete" }), caseOf({ workflow_status: "complete" }), caseOf()];
    expect(summarize(cs, slots).mix).toEqual({ satisfied: 2, mixed: 0, unhappy: 1, other: 2 });   // "no view" is the fourth finding, so it is "other" here; the unfinished case is not counted
  });

  it("counts the general results when slices are by result", () => {
    const slots = slotsFor(null, true);
    const cs = [caseOf({ final_outcome: "confirmed", workflow_status: "complete" }), caseOf({ final_outcome: "not_confirmed", workflow_status: "complete" }), caseOf({ final_outcome: "opted_out", workflow_status: "complete" }), caseOf()];
    expect(summarize(cs, slots).mix).toEqual({ confirmed: 1, not_confirmed: 1, inconclusive: 0, other: 1 });
  });

  it("the original job breakdown is unchanged when no slices are given", () => {
    expect(summarize([caseOf({ livelihood_state: "same_job" })]).mix).toEqual({ same_job: 1, changed_job: 0, not_employed: 0, other: 0 });
  });

  it("dashboardFor picks the slices from the chosen mission, and uses the general results across missions", () => {
    const ms = [{ version: "M1" }, feedback];
    const cs = [caseOf({ mission_version: "M1", livelihood_state: "same_job", workflow_status: "complete", final_outcome: "confirmed" }), caseOf({ mission_version: "M2", livelihood_state: "satisfied", workflow_status: "complete", final_outcome: "confirmed" })];
    expect(keys(dashboardFor({ cases: cs, missions: ms, campaigns: [], audits: [], key: "M2" }).slots)).toEqual(["satisfied", "mixed", "unhappy", "other"]);
    expect(dashboardFor({ cases: cs, missions: ms, campaigns: [], audits: [], key: "M1" }).slots).toBe(OUTCOMES);
    expect(keys(dashboardFor({ cases: cs, missions: ms, campaigns: [], audits: [], key: ALL }).slots)).toEqual(["confirmed", "not_confirmed", "inconclusive", "other"]);
    expect(keys(dashboardFor({ cases: cs, missions: [feedback], campaigns: [], audits: [], key: ALL }).slots)).toEqual(["satisfied", "mixed", "unhappy", "other"]); // one mission: its own
  });

  it("changing mission redraws the legend with the new labels, and the donut grows from nothing", () => {
    document.body.innerHTML = `<div data-donut data-values="[3,3,1,2]"></div><strong data-donut-centre>9</strong><div class="legend">${legendHtml(OUTCOMES, { same_job: 3, changed_job: 3, not_employed: 1, other: 2 })}</div>`;
    const slots = slotsFor(feedback, false);
    animateOutcomes(document.body, { satisfied: 4, mixed: 0, unhappy: 0, other: 0 }, slots);
    const legend = document.querySelector(".legend")!;
    expect(legend.textContent).toContain("Satisfied");
    expect(legend.textContent).toContain("Mixed feelings");
    expect(legend.textContent).not.toContain("Same job");
    expect(JSON.parse((document.querySelector("[data-donut]") as HTMLElement).dataset.values!)).toHaveLength(4);
  });

  it("a finding label cannot inject markup into the legend", () => {
    expect(legendHtml([["x", "<img src=x onerror=alert(1)>", "#000"]], { x: 1 })).not.toContain("<img");
  });
});
