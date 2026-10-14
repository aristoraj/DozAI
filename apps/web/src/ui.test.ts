// @vitest-environment jsdom
// Loads the real page and the real main.js against the real API (in memory), and clicks through the main flows.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CaseService, ConversationRunner, DEMO_TENANT, GatewayTools, InMemoryStore, RuleClassifier } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { dispatchVoice, FakeVoice, ScriptedAgentRuntime } from "@dozai/adapters";
import { createApp } from "../../../functions/core_api/src/app";

let server: Server;
let base = "";
const PII_KEY = randomBytes(32).toString("base64");
const voicePort = new FakeVoice();
const voiceCfg = { piiKey: PII_KEY, callsEnabled: true };
let theSvc: CaseService;
const realFetch = globalThis.fetch;

const wait = async (check: () => boolean, what: string, ms = 4000) => {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}\n${document.getElementById("appView")?.textContent?.slice(0, 300)}`); await new Promise(r => setTimeout(r, 20)); }
};
const text = () => document.getElementById("appView")!.textContent || "";
const click = (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); };
const q = (sel: string) => document.querySelector(sel);

beforeAll(async () => {
  const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  svc.voiceEnabled = true;
  theSvc = svc;
  const app = createApp({
    voice: { port: voicePort, cfg: voiceCfg, tenant: DEMO_TENANT },
    forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)), runner: new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true }) }), devAuth: true,
    pii: { key: PII_KEY, defaultCountryCode: "91" },
    runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "24 hours (test)" },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(url.startsWith("/") ? base + url : url, init)) as typeof fetch;

  const html = readFileSync(resolve(process.cwd(), "apps/web/index.html"), "utf8"); // run from the repo root (npm test)
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  (window as unknown as { DOZAI_API_BASE: string }).DOZAI_API_BASE = "/api";
  window.scrollTo = () => undefined;
  await import("./main.js");
});
afterAll(() => { server.close(); globalThis.fetch = realFetch; });

describe("the live app", () => {
  it("starts empty: no sample data, no hardcoded names", async () => {
    await wait(() => text().includes("No participants yet"), "empty state");
    expect(document.body.textContent).not.toMatch(/Parthiban|Asha Kumari|Prototype|sample data|Jaipur cohort/i);
    expect(document.getElementById("caseCount")!.textContent).toBe("0");
    expect(document.getElementById("missionName")!.textContent).toContain("placement and retention");
  });

  it("explains a wrong file instead of silently disabling the button", async () => {
    click(q('[data-action="import"]'));
    // the mission is always shown, even when there is only one, so it is clear which mission people will join
    expect((document.getElementById("impMission") as HTMLSelectElement).value).toBe("MSN-001-v1.3");
    expect(document.getElementById("modal")!.textContent).toContain("Only one mission exists at the moment.");
    const ta = document.getElementById("csvText") as HTMLTextAreaElement;
    ta.value = "handle,title,body,vendor\ngolden-globe,Golden Globe,Fancy pack,Shammah";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => document.getElementById("modal")!.textContent!.includes("does not look like a participant list"), "wrong-file message");
    expect(document.getElementById("modal")!.textContent).toContain("handle, title, body, vendor");
    click(document.getElementById("csvExample"));
    await wait(() => document.getElementById("modal")!.textContent!.includes("1 participant ready"), "example accepted");
    click(document.getElementById("cancelImport"));
  });

  it("imports participants from CSV, only after the consent box is ticked", async () => {
    click(q('[data-action="import"]'));
    const ta = document.getElementById("csvText") as HTMLTextAreaElement;
    ta.value = "name,phone,employer,location,cohort\nRavi Test,9876543210,Acme,Jaipur,Batch 1\nBad Row,12,Acme,Jaipur,Batch 1\n";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => document.getElementById("modal")!.textContent!.includes("2 participants ready"), "preview");
    expect((document.getElementById("runImport") as HTMLButtonElement).disabled).toBe(true); // not attested yet
    const att = document.getElementById("attest") as HTMLInputElement;
    att.checked = true; att.dispatchEvent(new Event("change", { bubbles: true }));
    expect((document.getElementById("runImport") as HTMLButtonElement).disabled).toBe(false);
    click(document.getElementById("runImport"));
    await wait(() => document.getElementById("modal")!.textContent!.includes("1 participant added"), "import result");
    expect(document.getElementById("modal")!.textContent).toContain("1 row skipped");
    expect(document.getElementById("modal")!.textContent).toContain("not a valid number");
    click(document.getElementById("doneImport"));
    await wait(() => document.getElementById("caseCount")!.textContent === "1", "case count");
  });

  it("shows the case without exposing the phone number, and runs the agent", async () => {
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => text().includes("Ravi Test"), "case row");
    expect(document.body.textContent).not.toContain("9876543210");
    click(q("tr[data-case]"));
    await wait(() => !!document.getElementById("runAgent"), "drawer");
    expect(document.getElementById("caseDrawer")!.textContent).toContain("•••• 3210");
    (document.getElementById("scenarioSelect") as HTMLSelectElement).value = "same_job";
    click(document.getElementById("runAgent"));
    await wait(() => document.getElementById("caseDrawer")!.textContent!.includes("Agent session idled") || document.getElementById("caseDrawer")!.textContent!.includes("Agent session"), "agent history", 8000);
  });

  it("deletes the case only after typing its id, and leaves an anonymous trail", async () => {
    click(document.getElementById("deleteCase"));
    const confirm = document.getElementById("delConfirm") as HTMLInputElement;
    const btn = document.getElementById("confirmDelete") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    confirm.value = "wrong"; confirm.dispatchEvent(new Event("input", { bubbles: true }));
    expect(btn.disabled).toBe(true);
    confirm.value = "DZ-0001"; confirm.dispatchEvent(new Event("input", { bubbles: true }));
    expect(btn.disabled).toBe(false);
    click(btn);
    await wait(() => document.getElementById("caseCount")!.textContent === "0", "case removed");
    click(q('.nav-item[data-view="audit"]'));
    await wait(() => text().includes("Case deleted"), "audit entry");
    expect(document.body.textContent).not.toContain("Ravi");
  });

  it("runs a conversation: yes, a wrong reply, then an answer, shown as a transcript", async () => {
    await fetch(base + "/api/participants/import", { method: "POST", headers: { "content-type": "application/json", "x-dozai-role": "admin" }, body: JSON.stringify({ rows: [{ name: "Meena Test", phone: "9876500099" }], consent_attested: true }) });
    click(document.getElementById("refresh"));
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => text().includes("Meena Test"), "second participant");
    click(q("tr[data-case]"));
    await wait(() => !!document.getElementById("runAgent"), "drawer");
    (document.getElementById("scenarioSelect") as HTMLSelectElement).value = "no_response";
    click(document.getElementById("runAgent"));
    await wait(() => document.getElementById("caseDrawer")!.textContent!.includes("Waiting"), "waiting after intro", 8000);
    const send = async (msg: string, expect_: string) => {
      const box = document.getElementById("simText") as HTMLInputElement;
      box.value = msg;
      click(document.getElementById("simSend"));
      await wait(() => document.getElementById("convBox")!.textContent!.includes(expect_), `conversation shows: ${expect_}`, 6000);
    };
    await send("yes", "Which of these describes you best");
    await send("lol what", "could not understand");
    await send("1", "name of the place where you work");
    const conv = document.getElementById("convBox")!.textContent!;
    await wait(() => document.getElementById("reqBox")!.textContent!.includes("needed answers collected"), "evidence checklist");
    expect(document.getElementById("reqBox")!.textContent).toContain("Current work status");
    expect(document.getElementById("reqBox")!.textContent).toContain("Still needed");
    expect(conv).toContain("1 answered");
    expect(conv).toContain("I work at the same place as before"); // the participant's answer, shown as its label
  });

  it("the case panel has a header, a summary, a next step and four tabs with counts, and keeps you on your tab", async () => {
    click(document.getElementById("closeDrawer"));
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => text().includes("Meena Test"), "the case list");
    click([...document.querySelectorAll("tr[data-case]")].find(r => r.textContent!.includes("Meena Test")) as Element);
    await wait(() => !!document.getElementById("runAgent"), "the case panel");
    const drawer = document.getElementById("caseDrawer")!;
    const tab = (k: string) => drawer.querySelector(`[data-tab="${k}"]`) as HTMLElement;
    const panel = (k: string) => drawer.querySelector(`[data-panel="${k}"]`) as HTMLElement;

    // the top: who, where the case stands, what is next. The tabs come after it.
    expect(drawer.querySelector(".drawer-avatar")!.textContent).toBe("MT");
    expect(drawer.querySelector(".drawer-head .status")).not.toBeNull();
    expect(drawer.querySelector(".next-action")!.compareDocumentPosition(drawer.querySelector(".drawer-tabs")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(drawer.querySelector(".next-action .sim-row #scenarioSelect")).not.toBeNull();    // the simulated reply sits with the buttons it belongs to
    expect(drawer.querySelector(".next-buttons #runAgent")).not.toBeNull();

    // four tabs, overview first. The others are on the page but hidden, so they keep loading.
    expect([...drawer.querySelectorAll(".drawer-tab")].map(b => b.getAttribute("data-tab"))).toEqual(["overview", "conversation", "calls", "activity"]);
    expect(tab("overview").getAttribute("aria-selected")).toBe("true");
    expect(panel("overview").hidden).toBe(false);
    for (const k of ["conversation", "calls", "activity"]) expect(panel(k).hidden).toBe(true);
    expect(panel("overview").textContent).toContain("What we need to know");
    expect(panel("overview").textContent).toContain("•••• 0099");                            // the participant's details are a plain list
    expect(panel("overview").querySelectorAll(".kv-row")).toHaveLength(5);
    expect(panel("overview").querySelector("#deleteCase")).not.toBeNull();                     // administrators only
    expect(panel("conversation").querySelector("#convBox")).not.toBeNull();
    expect(panel("activity").querySelector("#caseHistory")).not.toBeNull();

    // counts appear once the data has loaded, and only when there is something to count
    await wait(() => !tab("conversation").querySelector<HTMLElement>(".tab-count")!.hidden && !tab("activity").querySelector<HTMLElement>(".tab-count")!.hidden, "the counts");
    expect(Number(tab("conversation").querySelector(".tab-count")!.textContent)).toBeGreaterThan(0);
    expect(tab("calls").querySelector<HTMLElement>(".tab-count")!.hidden).toBe(true);        // no calls yet, so no number

    // clicking and the keyboard
    click(tab("conversation"));
    expect(panel("conversation").hidden).toBe(false);
    expect(panel("overview").hidden).toBe(true);
    expect(tab("conversation").getAttribute("aria-selected")).toBe("true");
    const key = (k: string) => tab("conversation").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    key("ArrowRight"); expect(tab("calls").getAttribute("aria-selected")).toBe("true");
    key("ArrowRight"); key("ArrowRight");                                                    // activity, then round to overview
    expect(tab("overview").getAttribute("aria-selected")).toBe("true");
    key("End"); expect(tab("activity").getAttribute("aria-selected")).toBe("true");
    key("Home"); expect(tab("overview").getAttribute("aria-selected")).toBe("true");
    expect([...drawer.querySelectorAll(".drawer-tab")].filter(b => (b as HTMLElement).tabIndex === 0)).toHaveLength(1);   // one tab stop

    // an action that refreshes the panel keeps you where you were
    click(tab("conversation"));
    (document.getElementById("simText") as HTMLInputElement).value = "lol what";
    click(document.getElementById("simSend"));
    await wait(() => document.getElementById("convBox")!.textContent!.includes("could not understand"), "the reply to be handled", 6000);
    expect(tab("conversation").getAttribute("aria-selected")).toBe("true");
    expect(panel("conversation").hidden).toBe(false);
    expect(panel("overview").hidden).toBe(true);

    click(document.getElementById("closeDrawer"));
    await wait(() => !document.getElementById("caseDrawer")!.classList.contains("open"), "the panel to close");
  });

  it("the audit search filters, and nothing is a fake control", async () => {
    click(q('.nav-item[data-view="audit"]'));
    await wait(() => !!document.getElementById("auditSearch"), "audit page");
    const box = document.getElementById("auditSearch") as HTMLInputElement;
    box.value = "zzz-no-such-event"; box.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => text().includes("Nothing matches the search"), "filtered empty");
    click(q('.nav-item[data-view="missions"]'));
    await wait(() => text().includes("Readiness"), "mission page");
    expect(text()).toContain("not approved yet");
    expect(text()).not.toMatch(/184|1\.4|MSN-002/);
  });

  it("adds a second mission from the first one, and new participants can join it", async () => {
    click(q('.nav-item[data-view="missions"]'));
    await wait(() => !!q('[data-action="add-mission"]'), "add mission button");
    click(q('[data-action="add-mission"]'));
    click(document.getElementById("mLoad"));
    await wait(() => (document.getElementById("mText") as HTMLTextAreaElement).value.includes("MSN-001"), "definition copied");
    const ta = document.getElementById("mText") as HTMLTextAreaElement;
    const def = JSON.parse(ta.value);
    ta.value = JSON.stringify({ ...def, mission_id: "MSN-002", version: "MSN-002-v1", name: "Second client check-in" });
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("saveM"));
    await wait(() => text().includes("Second client check-in"), "new mission shown as the default");
    await wait(() => document.getElementById("modal")!.innerHTML === "", "the dialog closes"); // closed (it closes just after the page redraws)

    // A bad mission explains itself and keeps the form open.
    click(q('[data-action="add-mission"]'));
    const ta2 = document.getElementById("mText") as HTMLTextAreaElement;
    ta2.value = "{ not json"; ta2.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("saveM"));
    await wait(() => document.getElementById("modal")!.textContent!.includes("not valid JSON"), "bad json message");
    click(document.getElementById("cancelM"));

    // The import dialog now offers the mission choice.
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => !!q('[data-action="import"]'), "cases page");
    click(q('[data-action="import"]'));
    expect(document.getElementById("impMission")).not.toBeNull();
    expect((document.getElementById("impMission") as HTMLSelectElement).value).toBe("MSN-002-v1");
    expect(document.getElementById("modal")!.textContent).not.toContain("Only one mission exists"); // with several missions the extra sentence goes
    click(document.getElementById("cancelImport"));
  });

  it("creates a campaign, shows who is in it, starts it after a confirmation, and shows progress", async () => {
    const rows = [{ name: "Kiran Test", phone: "9876500201", cohort: "Udaan" }, { name: "Lata Test", phone: "9876500202", cohort: "Udaan" }, { name: "Mohan Test", phone: "9876500203", cohort: "Other" }];
    await fetch(base + "/api/participants/import", { method: "POST", headers: { "content-type": "application/json", "x-dozai-role": "admin" }, body: JSON.stringify({ rows, consent_attested: true, mission_version: "MSN-002-v1" }) });
    click(document.getElementById("refresh"));
    click(q('.nav-item[data-view="campaigns"]'));
    await wait(() => text().includes("No campaigns yet"), "empty campaigns");

    click(q('[data-action="new-campaign"]'));
    const name = document.getElementById("cmpName") as HTMLInputElement;
    expect((document.getElementById("saveCmp") as HTMLButtonElement).disabled).toBe(true); // needs a name
    name.value = "Udaan first message"; name.dispatchEvent(new Event("input", { bubbles: true }));
    const cohort = document.getElementById("cmpCohort") as HTMLSelectElement;
    expect([...cohort.options].map(o => o.textContent)).toEqual(expect.arrayContaining(["Cohort Udaan (2)", "Cohort Other (1)"]));
    cohort.value = "Udaan"; cohort.dispatchEvent(new Event("change", { bubbles: true }));
    click(document.getElementById("saveCmp"));
    await wait(() => text().includes("Udaan first message") && text().includes("Draft"), "draft campaign card");
    expect(text()).toContain("0 of 2 messaged");
    expect(document.body.textContent).not.toContain("9876500201");

    click(q('[data-act="start"]'));
    await wait(() => !!document.getElementById("okConfirm"), "confirmation");
    expect(document.getElementById("modal")!.textContent).toContain("2 people will be messaged");
    expect(document.getElementById("modal")!.textContent).toContain("WhatsApp is off, so messages are simulated");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("2 of 2 messaged"), "progress after start", 6000);
    expect(text()).toContain("Finished");        // everyone in it has been messaged
    expect(text()).toContain("Waiting for reply");
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => text().includes("Kiran Test"), "cases list");
    await wait(() => state_status("Kiran Test").includes("Waiting for a reply"), "Kiran Test waiting for a reply"); // the first message is queued just after the campaign starts
    expect(state_status("Mohan Test")).toContain("Not started"); // not in the campaign
  });

  it("filters the Command centre by mission: the numbers follow, and they match the server's own", async () => {
    const admin = { "x-dozai-role": "admin" };
    const { summarize } = await import("./dashboard.js");
    const serverCases = async () => (await (await fetch(base + "/api/cases", { headers: admin })).json()).cases as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const kpi = (k: string) => document.querySelector(`[data-kpi="${k}"]`)?.textContent;
    const stageCount = (k: string) => document.querySelector(`[data-stage="${k}"] [data-stage-count]`)?.textContent;
    const pickMission = (v: string) => { const s = document.getElementById("dashMission") as HTMLSelectElement; s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); };
    const expectPage = async (want: ReturnType<typeof summarize>, what: string) => {
      await wait(() => kpi("total") === String(want.total) && kpi("reached") === `${Math.round((want.reached / want.total) * 100)}%` && kpi("confirmed") === String(want.confirmed) && kpi("review") === String(want.review), `${what}: the four numbers`);
      await wait(() => stageCount("reached") === String(want.reached) && stageCount("responded") === String(want.responded) && stageCount("complete") === String(want.complete), `${what}: the progress counts`);
      await wait(() => document.querySelector("[data-donut-centre]")?.textContent === String(Object.values(want.mix).reduce((a, b) => a + b, 0)), `${what}: the outcomes`);
    };

    click(q('.nav-item[data-view="overview"]'));
    await wait(() => !!document.getElementById("dashMission"), "the mission filter");
    const options = [...(document.getElementById("dashMission") as HTMLSelectElement).options].map(o => o.value);
    expect(options[0]).toBe("all");
    expect(options).toEqual(expect.arrayContaining(["MSN-001-v1.3", "MSN-002-v1"]));

    // The counting rules, run over the cases the page loaded, give exactly what the server's own summary says.
    const cases = await serverCases();
    const server = await (await fetch(base + "/api/summary", { headers: admin })).json();
    expect(summarize(cases)).toEqual(server);
    await expectPage(server, "all missions");

    // The filter is its own bar under the greeting, above the numbers. The header keeps only the main action.
    const bar = () => document.querySelector(".dash-bar")!;
    expect(document.querySelector(".page-actions #dashMission")).toBeNull();
    expect(bar().compareDocumentPosition(document.querySelector("[data-overview]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.getElementById("dashCount")!.textContent).toBe(`Showing all ${server.total} participants`);
    expect(bar().querySelector(".dash-filter")!.classList.contains("is-active")).toBe(false);
    expect((bar().querySelector("[data-dash-clear]") as HTMLElement).hidden).toBe(true);

    // One mission: every number is that mission's, and the page does not have to be redrawn.
    const page = document.querySelector("[data-overview]");
    const mineOf = (v: string) => cases.filter(c => (c.mission_version ?? "MSN-001-v1.3") === v);
    const second = summarize(mineOf("MSN-002-v1"));
    expect(second.total).toBeGreaterThan(0);
    expect(second.total).toBeLessThan(server.total);
    pickMission("MSN-002-v1");
    await expectPage(second, "MSN-002-v1");
    expect(document.querySelector("[data-overview]")).toBe(page);          // updated in place, so it could animate
    expect(document.getElementById("dashLive")!.textContent).toContain("Second client check-in");
    expect(bar().querySelector(".dash-filter")!.classList.contains("is-active")).toBe(true);          // the bar shows that the page is filtered
    expect((bar().querySelector("[data-dash-clear]") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("dashCount")!.textContent).toBe(`Showing ${second.total} of ${server.total} participants`);
    expect(bar().querySelector(".cs-trigger .cs-value")!.textContent).toBe("Second client check-in"); // the name only: no version, no count

    // Recent activity only shows events on that mission's cases.
    const ids = mineOf("MSN-002-v1").map(c => c.id as string);
    await wait(() => !document.querySelector('[data-dash="activity"]')!.classList.contains("is-swapping"), "the activity list to settle");
    const lines = [...document.querySelectorAll('[data-dash="activity"] .event-copy small')].map(e => e.textContent || "");
    expect(lines.every(l => ids.some(id => l.startsWith(id)))).toBe(true);

    // "Clear" goes back to everyone
    click(bar().querySelector("[data-dash-clear]"));
    await expectPage(server, "after Clear");
    expect((document.getElementById("dashMission") as HTMLSelectElement).value).toBe("all");
    expect(bar().querySelector(".dash-filter")!.classList.contains("is-active")).toBe(false);
    expect((bar().querySelector("[data-dash-clear]") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("dashCount")!.textContent).toBe(`Showing all ${server.total} participants`);
    expect(bar().querySelector(".cs-trigger .cs-value")!.textContent).toBe("All missions");

    // The other mission, and back to all.
    const first = summarize(mineOf("MSN-001-v1.3"));
    pickMission("MSN-001-v1.3");
    await expectPage(first, "MSN-001-v1.3");
    expect(first.total + second.total).toBe(server.total);                 // between them, nobody is lost or counted twice
    pickMission("all");
    await expectPage(server, "all missions again");

    // A mission nobody has been added to yet: a friendly empty page, with the filter still there to switch back.
    const def = (await (await fetch(base + "/api/missions/MSN-002-v1/definition", { headers: admin })).json()).definition;
    expect((await fetch(base + "/api/missions", { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ ...def, mission_id: "MSN-003", version: "MSN-003-v1", name: "Third client check-in" }) })).status).toBe(201);
    click(document.getElementById("refresh"));
    await wait(() => [...((document.getElementById("dashMission") as HTMLSelectElement | null)?.options ?? [])].some(o => o.value === "MSN-003-v1"), "the new mission in the filter");
    pickMission("MSN-003-v1");
    await wait(() => text().includes("No participants in this mission yet"), "the empty page");
    expect(document.getElementById("dashMission")).not.toBeNull();
    expect((document.getElementById("dashMission") as HTMLSelectElement).value).toBe("MSN-003-v1");
    pickMission("all");
    await expectPage(server, "all missions after the empty page");
  });

  it("shows the employee, what the agent is told, and lets platform staff add a version", async () => {
    click(q('.nav-item[data-view="agent"]'));
    await wait(() => !!q('[data-agent-tab="employee"]'), "agent page");
    click(q('[data-agent-tab="employee"]'));
    await wait(() => text().includes("Standing instructions"), "employee tab");
    expect(text()).toContain("Meera");
    expect(text()).toContain("VE-1.0.0");
    expect(text()).toContain("Tools this employee may use");
    expect(text()).toContain("What the agent is told");
    // the exact text, layer by layer
    click(q('[data-agent-tab="employee"]'));
    const pick = document.getElementById("ctxMission") as HTMLSelectElement;
    pick.value = "MSN-001-v1.3"; pick.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(() => text().includes("Platform rules (every employee)"), "layers");
    expect(text()).toContain("Nothing about a person is ever in here");

    // add a version by copying the current one
    click(q('[data-action="add-employee"]'));
    click(document.getElementById("eLoad"));
    await wait(() => (document.getElementById("eText") as HTMLTextAreaElement).value.includes("VE-1.0.0"), "definition copied");
    const ta = document.getElementById("eText") as HTMLTextAreaElement;
    const def = JSON.parse(ta.value);
    ta.value = JSON.stringify({ ...def, version: "VE-1.1.0", persona: "Calm and unhurried. Always thanks people for their time." });
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("saveE"));
    await wait(() => text().includes("VE-1.1.0") && text().includes("Calm and unhurried"), "new version shown");
    expect(text()).toContain("Current");
    expect(text()).toContain("older");

    // a bad one explains itself and stays open
    click(q('[data-action="add-employee"]'));
    const t2 = document.getElementById("eText") as HTMLTextAreaElement;
    t2.value = JSON.stringify({ ...def, version: "VE-1.2.0", allowed_tools: ["mission_get_bundle"] });
    t2.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("saveE"));
    await wait(() => document.getElementById("modal")!.textContent!.includes("must be allowed case_get_context"), "plain error");
    click(document.getElementById("cancelE"));
  });

  it("publishes the phone form from the mission page, then finishes a simulated call from the case page", async () => {
    click(q('.nav-item[data-view="missions"]'));
    await wait(() => !!q('[data-action="voice-preview"]'), "phone card");
    expect(text()).toContain("Phone calls (ZoLabs)");
    click(q('[data-action="voice-preview"]'));
    await wait(() => text().includes("Not published"), "preview");
    expect(text()).toContain("What the voice agent is told");
    expect(text()).toContain("so the agent cannot ask for a phone call on this mission");
    click(q('[data-action="voice-publish"]'));
    await wait(() => !!document.getElementById("okConfirm"), "confirmation");
    expect(document.getElementById("modal")!.textContent).toContain("No call is placed by this");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Published and current"), "published", 6000);
    expect(voicePort.forms.size).toBe(1);
    expect(q("[data-action=\"voice-publish\"]")).toBeNull(); // nothing left to publish: the button is gone, so it cannot be pressed twice

    // a participant on this mission, a call asked for by the agent, and placed by the scheduler
    const version = (await (await fetch(base + "/api/mission", { headers: { "x-dozai-role": "admin" } })).json()).version as string;
    const imp = await (await fetch(base + "/api/participants/import", { method: "POST", headers: { "content-type": "application/json", "x-dozai-role": "admin" }, body: JSON.stringify({ rows: [{ name: "Nisha Test", phone: "9876500301" }], consent_attested: true, mission_version: version }) })).json();
    const id = imp.created[0].case_id as string;
    await theSvc.beginSession(DEMO_TENANT, id, "t");
    const v = (await theSvc.getCase(DEMO_TENANT, id)).version;
    const asked = await new GatewayTools(theSvc).call({ session_id: "s", tenant_id: DEMO_TENANT, case_id: id, mission_version: version, employee_version: "x" }, "voice_call_request", { case_id: id, idempotency_key: "key-ui-voice-1", expected_version: v, reason: "No reply for two days." });
    expect(asked.error).toBeUndefined();
    expect(asked.data).toMatchObject({ held: true });
    expect(await dispatchVoice(theSvc, DEMO_TENANT, voicePort, voiceCfg)).toBe(0); // held until a person approves it

    // the person approves it from the Approvals page, and only then is the call placed
    click(document.getElementById("refresh"));
    click(q(".nav-item[data-view=\"approvals\"]"));
    await wait(() => !!q("[data-approve]"), "the approval");
    expect(text()).toContain("Nisha Test");
    expect(text()).toContain("No reply for two days.");
    click(q("[data-approve]"));
    await wait(() => text().includes("Nothing is waiting"), "approved", 6000);
    expect(voicePort.calls).toHaveLength(1); // approving rang straight away
    expect(await dispatchVoice(theSvc, DEMO_TENANT, voicePort, voiceCfg)).toBe(0); // so the scheduler has nothing left to place

    click(document.getElementById("refresh"));
    click(q('.nav-item[data-view="cases"]'));
    await wait(() => text().includes("Nisha Test"), "the case");
    click([...document.querySelectorAll("tr[data-case]")].find(r => r.textContent!.includes("Nisha Test")) as Element);
    await wait(() => document.getElementById("callBox")!.textContent!.includes("In progress"), "call in progress");
    expect(document.getElementById("callBox")!.textContent).toContain("Why: No reply for two days.");
    click(q('[data-simcall="answered"]'));
    await wait(() => document.getElementById("callBox")!.textContent!.includes("Completed"), "call completed", 6000);
    expect(document.getElementById("callBox")!.textContent).toContain("Transcript");
    expect(document.getElementById("callBox")!.querySelector("audio")?.getAttribute("src")).toMatch(new RegExp("\/calls\/.+\/recording$"));
    await wait(() => document.getElementById("reqBox")!.textContent!.includes("Employer"), "evidence checklist");
    expect(document.getElementById("reqBox")!.textContent).toContain("Said by the participant");
  });

  it("moves the autonomy dial and uses the kill switch from the Controls tab", async () => {
    click(q(".nav-item[data-view=\"agent\"]"));
    click(q("[data-agent-tab=\"controls\"]"));
    await wait(() => !!q("[data-dial=\"voice_call\"]"), "the dial");
    expect(text()).toContain("Autonomy dial");
    expect(text()).toContain("Phone call");
    const sel = q("[data-dial=\"voice_call\"]") as HTMLSelectElement;
    expect(sel.value).toBe("approve_first");
    sel.value = "automatic"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    let saved = "";
    for (let i = 0; i < 100 && saved !== "automatic"; i++) { saved = (await (await fetch(base + "/api/controls", { headers: { "x-dozai-role": "admin" } })).json()).controls.autonomy.voice_call; if (saved !== "automatic") await new Promise(r => setTimeout(r, 20)); }
    expect(saved).toBe("automatic"); // saved on the server, not just shown in the page

    click(q("[data-action=\"pause-platform\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "confirmation");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Nothing is being sent or placed"), "switched off");
    expect(text()).toContain("Switch back on");
    click(q("[data-action=\"resume-platform\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "confirmation to resume");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Running normally"), "back on");
  });

  it("shows the phone connection, the form for each mission and the calls made, and checks the connection", async () => {
    click(q(".nav-item[data-view=\"calls\"]"));
    await wait(() => text().includes("Phone forms"), "the phone calls page");
    expect(text()).toContain("Simulator: nobody is rung");
    expect(text()).toContain("Published and current");
    expect(text()).toContain("Nisha Test"); // the call placed in the earlier test
    expect(text()).toContain("No reply for two days.");
    click(q("[data-action=\"voice-check\"]"));
    await wait(() => text().includes("Signed in as simulator"), "connection checked");

    // the layout: a status strip first, then the calls as rows, then the forms as rows (no wide tables)
    expect([...document.querySelectorAll(".pc-tile .pc-label")].map(e => e.textContent)).toEqual(["Connection", "Calls", "Who can be called", "Finished calls"]);
    const order = [...document.querySelectorAll("#appView .pc-strip, #appView .pc-section h2")].map(e => (e.matches(".pc-strip") ? "strip" : e.textContent));
    expect(order).toEqual(["strip", "Calls", "Phone forms"]);
    expect(document.querySelectorAll(".pc-call").length).toBeGreaterThan(0);
    expect(document.querySelector("#appView table")).toBeNull();
    expect(q(".pc-call .pc-person")!.textContent).toBe("Nisha Test");

    // a form's button opens that mission on the Mission page
    click(q("[data-open-mission]"));
    await wait(() => text().includes("Phone calls (ZoLabs)"), "the Mission page for that form");
  });

  it("the left panel follows the workflow: home, set up, reach people, follow up, record", () => {
    const nav = document.getElementById("primaryNav")!;
    const sections = [...nav.querySelectorAll(".nav-group")].map(g => [g.getAttribute("aria-label"), [...g.querySelectorAll(".nav-item")].map(b => (b as HTMLElement).dataset.view)]);
    expect((nav.firstElementChild as HTMLElement).dataset.view).toBe("overview");   // Command centre stays on top, with no section label
    expect(sections).toEqual([
      ["Set up", ["missions", "agent"]],
      ["Reach people", ["cases", "campaigns"]],
      ["Follow up", ["approvals", "calls", "reviews"]],
      ["Record", ["audit"]],
    ]);
    expect(nav.querySelectorAll(".nav-item")).toHaveLength(9);                       // nothing lost
    for (const id of ["caseCount", "reviewCount", "approvalCount"]) expect(document.getElementById(id)).not.toBeNull(); // the counts are still there
    expect([...nav.querySelectorAll(".nav-item")].filter(b => b.classList.contains("active"))).toHaveLength(1);
    expect(nav.querySelector(".nav-group-label")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the questionnaire wording and signs it off from the Mission page", async () => {
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => !!q("#qEditorMount .q-card"), "the questions open by themselves", 6000);   // no click needed to read an unsigned mission
    expect(text()).toContain("Draft: not signed off");
    expect(text()).toContain("every reply is handed to a person");
    expect(text()).toContain("Fixed messages");
    expect(text()).toContain("Answers to common questions");
    await wait(() => { const b = q("[data-action=\"sign-off\"]") as HTMLButtonElement | null; return !!b && !b.disabled; }, "the sign-off button, once the questions are checked", 6000);
    expect(q("[data-action=\"sign-off\"]")!.textContent).toBe("Sign off this wording");     // nothing was changed
    click(q("[data-action=\"sign-off\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "the confirmation");
    expect(document.getElementById("modal")!.textContent).toContain("has read every question and message");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Signed off by admin:dev-user"), "signed off", 6000);
    expect(q("[data-action=\"sign-off\"]")).toBeNull(); // nothing left to sign
    const list = ((await (await fetch("/api/missions")).json()).missions as { version: string; instrument_signed_off: boolean }[]);
    expect(list.map(m => m.version).filter(v => v.startsWith("MSN-001-v1.3"))).toEqual(["MSN-001-v1.3"]);   // the same mission, approved: no second one
    expect(list.find(m => m.version === "MSN-001-v1.3")!.instrument_signed_off).toBe(true);
    expect(text()).not.toContain("-signed");
  });

  it("creates a mission from a plain brief: draft it, read it, save it as a draft", async () => {
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => !!q("[data-action=\"new-mission\"]"), "the create button");
    click(q("[data-action=\"new-mission\"]"));
    await wait(() => !!document.getElementById("draftS"), "the brief form");
    const set = (id: string, v: string) => { const el = document.getElementById(id) as HTMLInputElement; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("sName", "Studio check"); set("sProg", "Project Studio");
    set("sGoal", "Find out whether people are still working where we placed them.");
    set("sPeople", "People who finished our retail training last year.");
    set("sFind", "Whether they still work at the same place\nThe name of their employer");
    click(document.getElementById("draftS"));
    await wait(() => document.getElementById("modal")!.textContent!.includes("Review the questions"), "the draft", 6000);
    const m = document.getElementById("modal")!.textContent!;
    expect(m).toContain("What the employee will find out");
    expect(m).toContain("Results it can end with");                      // the findings and what the general results mean, so they are read before sign-off
    expect(m).toContain("Confirmed: Answers collected");
    expect(m).toContain("Whether they still work at the same place");
    expect(m).toContain("Nothing is saved yet");
    expect(document.getElementById("jsonS")).toBeNull();                                      // no JSON editing in the create flow
    expect(m).not.toContain("Edit as JSON");
    await wait(() => !(document.getElementById("saveS") as HTMLButtonElement).disabled, "save, once the questions are checked", 6000);
    click(document.getElementById("saveS"));
    await wait(() => text().includes("Draft: not signed off") && text().includes("studio-check-v1.0"), "saved as a draft", 6000);
  });

  it("deletes a mission nothing uses, after its version is typed", async () => {
    // the mission saved as a draft in the test above is shown on the Mission page
    await wait(() => !!q("[data-action=\"delete-mission\"]"), "the delete button");
    expect(q("[data-action=\"delete-mission\"]")!.textContent).toContain("Delete this mission");
    click(q("[data-action=\"delete-mission\"]"));
    await wait(() => !!document.getElementById("delMConfirm"), "the delete dialog");
    expect((document.getElementById("confirmDelM") as HTMLButtonElement).disabled).toBe(true);
    const box = document.getElementById("delMConfirm") as HTMLInputElement;
    box.value = "studio-check-v1.0"; box.dispatchEvent(new Event("input", { bubbles: true }));
    expect((document.getElementById("confirmDelM") as HTMLButtonElement).disabled).toBe(false);
    click(document.getElementById("confirmDelM"));
    await wait(() => !text().includes("studio-check-v1.0"), "the mission is gone", 6000);
  });

  it("edit, remove and add questions before saving, then edit again at sign-off: one mission, approved in place", async () => {
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => !!q("[data-action=\"new-mission\"]"), "the create button");
    click(q("[data-action=\"new-mission\"]"));
    await wait(() => !!document.getElementById("draftS"), "the brief form");
    const set = (id: string, v: string) => { const el = document.getElementById(id) as HTMLInputElement; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("sName", "Editor check"); set("sProg", "Project Studio");
    set("sGoal", "Find out whether people are still working where we placed them.");
    set("sPeople", "People who finished our retail training last year.");
    set("sFind", "Whether they still work at the same place\nThe name of their employer");
    click(document.getElementById("draftS"));
    const modal = document.getElementById("modal")!;
    await wait(() => modal.textContent!.includes("Review the questions"), "the draft", 6000);
    const cards = () => [...modal.querySelectorAll(".q-card:not(.q-add)")] as HTMLElement[];
    const saveBtn = () => document.getElementById("saveS") as HTMLButtonElement;
    await wait(() => !saveBtn().disabled, "the first check", 6000);

    // each question shows both channels side by side, and has Edit and Remove
    expect(cards()).toHaveLength(2);
    for (const c of cards()) { expect(c.textContent).toContain("WhatsApp"); expect(c.textContent).toContain("Phone call"); expect(c.querySelector("[data-q-edit]")).not.toBeNull(); expect(c.querySelector("[data-q-remove]")).not.toBeNull(); }
    expect(modal.textContent).toContain("No problems found");

    // edit the first question, in both channels
    const phoneOf = (c: HTMLElement) => (c.querySelectorAll(".q-channel")[1]!.querySelector("p")!.textContent || "").trim();
    // the questions are grouped under categories, and the phone column is read only
    expect([...modal.querySelectorAll(".q-group-title")].map(h => h.firstChild!.textContent)).toEqual(["Work"]);
    expect(cards()[0]!.querySelector(".q-channel:nth-child(2) em")!.textContent).toBe("read only");
    const phoneBefore = phoneOf(cards()[0]!);
    click(cards()[0]!.querySelector("[data-q-edit]"));
    expect(saveBtn().disabled).toBe(true);                                   // not while a question is open for editing
    expect(document.getElementById("qeSpoken")).toBeNull();                  // there is no box for the phone wording
    expect(modal.querySelector(".q-card.editing .q-fixed")!.textContent).toBe(phoneBefore);
    set("qeText", "Are you still working at the same place?");
    click(modal.querySelector("[data-q-save]"));
    expect(cards()[0]!.textContent).toContain("Are you still working at the same place?");
    await wait(() => !saveBtn().disabled, "a fresh check", 6000);
    expect(phoneOf(cards()[0]!)).toBe(phoneBefore);                          // editing the written question did not change what the phone says

    // a repeat is refused, with the question it repeats named, while typing and on save
    click(cards()[1]!.querySelector("[data-q-edit]"));
    set("qeText", "are you STILL working at the same place");
    const warn = document.getElementById("qeWarn")!;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain("same as question 1");
    click(modal.querySelector("[data-q-save]"));
    expect(modal.querySelector(".q-card.editing")).not.toBeNull();            // still open
    click(modal.querySelector("[data-q-cancel]"));
    expect(cards()[1]!.textContent).toContain("The name of their employer");   // unchanged

    // add a question: asked at the end, in both channels
    click(modal.querySelector("[data-q-add]"));
    expect(document.getElementById("qaSpoken")).toBeNull();                  // no phone wording box here either
    expect((document.getElementById("qaCategory") as HTMLSelectElement).value).toBe("work");   // it starts in the category of the question before
    set("qaText", "What is your monthly income?");
    click(modal.querySelector("[data-q-add-save]"));
    await wait(() => cards().length === 3, "the new question");
    expect(cards()[2]!.textContent).toContain("What is your monthly income?");
    expect(cards()[2]!.textContent).toContain("Asked of everyone");
    await wait(() => !saveBtn().disabled && cards()[2]!.textContent!.includes("monthly income"), "the check after adding", 6000);
    // the same question again is refused
    click(modal.querySelector("[data-q-add]"));
    set("qaText", "What is your monthly income");
    click(modal.querySelector("[data-q-add-save]"));
    expect(document.getElementById("qaWarn")!.textContent).toContain("same as question 3");
    click(modal.querySelector("[data-q-add-cancel]"));
    // a choice needs at least two answers
    click(modal.querySelector("[data-q-add]"));
    set("qaText", "How do you travel to work?");
    const type = document.getElementById("qaType") as HTMLSelectElement; type.value = "choice"; type.dispatchEvent(new Event("change", { bubbles: true }));
    set("qaOpts", "Bus");
    click(modal.querySelector("[data-q-add-save]"));
    expect(document.getElementById("qaWarn")!.textContent).toContain("between 2 and 10");
    set("qaOpts", "Bus\nTrain\nOn foot");
    const cat = document.getElementById("qaCategory") as HTMLSelectElement; cat.value = "__new"; cat.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("qaNewCategory")).not.toBeNull();         // a box for the new category's name
    click(modal.querySelector("[data-q-add-save]"));
    expect(document.getElementById("qaWarn")!.textContent).toContain("Give the category a name");
    set("qaNewCategory", "Travel");
    click(modal.querySelector("[data-q-add-save]"));
    await wait(() => cards().length === 4, "the choice question");
    expect([...modal.querySelectorAll(".q-group-title")].map(h => h.firstChild!.textContent)).toEqual(["Work", "Travel"]);   // the new category has its own heading
    expect(cards()[3]!.textContent).toContain("1Bus");
    expect(cards()[3]!.textContent).toContain("Choose one");

    // remove it again (asks first), and the last remaining question can never be removed
    click(cards()[3]!.querySelector("[data-q-remove]"));
    expect(cards()[3]!.textContent).toContain("Remove this question?");
    click(cards()[3]!.querySelector("[data-q-keep]"));
    expect(cards()).toHaveLength(4);
    click(cards()[3]!.querySelector("[data-q-remove]")); click(cards()[3]!.querySelector("[data-q-remove-yes]"));
    await wait(() => cards().length === 3, "the removal");
    click(cards()[2]!.querySelector("[data-q-remove]")); click(cards()[2]!.querySelector("[data-q-remove-yes]"));
    await wait(() => cards().length === 2, "the second removal");

    // save: the saved draft has exactly these two questions
    await wait(() => !saveBtn().disabled, "the final check", 6000);
    click(saveBtn());
    await wait(() => text().includes("Draft: not signed off") && text().includes("editor-check-v1.0"), "saved as a draft", 6000);
    const def = async (v: string) => (await (await fetch(`/api/missions/${v}/definition`)).json()).definition;
    const draft = await def("editor-check-v1.0");
    expect(draft.instrument.questions.map((x: { text: string }) => x.text)).toEqual(["Are you still working at the same place?", "The name of their employer?"]);
    expect(draft.instrument.questions[0].spoken).toBeTruthy();                // the phone wording was pinned when the written wording changed
    expect(draft.evidence_requirements).toHaveLength(2);                      // the extra "what to find out" entries went with their questions

    // at sign-off the same editor is there: change a question and sign off with the change
    await wait(() => !!q("#qEditorMount .q-card"), "the questions on the mission page", 6000);
    const mcards = () => [...document.querySelectorAll("#qEditorMount .q-card")] as HTMLElement[];
    await wait(() => { const b = q("[data-action=\"sign-off\"]") as HTMLButtonElement | null; return !!b && !b.disabled; }, "sign-off ready", 6000);
    click(mcards()[1]!.querySelector("[data-q-edit]"));
    expect((q("[data-action=\"sign-off\"]") as HTMLButtonElement).disabled).toBe(true);
    set("qeText", "What is the name of the place where you work?");
    click(q("#qEditorMount [data-q-save]"));
    await wait(() => (q("[data-action=\"sign-off\"]") as HTMLButtonElement).textContent === "Sign off with my changes" && !(q("[data-action=\"sign-off\"]") as HTMLButtonElement).disabled, "sign off with changes", 6000);
    click(q("[data-action=\"sign-off\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "the confirmation");
    expect(document.getElementById("modal")!.textContent).toContain("Your changes to the questions are included");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Signed off by admin:dev-user"), "signed off", 6000);
    const signed = await def("editor-check-v1.0");
    expect(signed.instrument.draft).toBe(false);                                  // the same mission is now approved...
    expect(signed.instrument.questions.map((x: { text: string }) => x.text)).toEqual(["Are you still working at the same place?", "What is the name of the place where you work?"]);   // ...with the questions as edited
    const names = ((await (await fetch("/api/missions")).json()).missions as { version: string }[]).map(m => m.version).filter(v => v.startsWith("editor-check"));
    expect(names).toEqual(["editor-check-v1.0"]);                                 // one mission: nothing extra, no "-signed" copy
    expect(text()).not.toContain("editor-check-v1.0-signed");
    // a signed mission is read only
    expect(document.querySelectorAll("#qEditorMount [data-q-edit]").length).toBe(0);
  }, 40000);

  // Slow the named request down, count how often it is sent, and optionally make it fail.
  const slowRequest = (part: string, ms: number, fail = false, method = "") => {
    const real = globalThis.fetch; const seen = { calls: 0 };
    globalThis.fetch = ((u: string, i?: RequestInit) => {
      if (!String(u).includes(part) || (method && (i?.method ?? "GET") !== method)) return real(u, i);   // only the one kind of request, not the reload that follows it
      seen.calls += 1;
      return new Promise(r => setTimeout(() => r(fail ? new Response(JSON.stringify({ error: { message: "The server is busy, try again." } }), { status: 500, headers: { "content-type": "application/json" } }) : real(u, i)), ms));
    }) as typeof fetch;
    return { seen, restore: () => { globalThis.fetch = real; } };
  };
  const topBar = () => document.querySelector(".top-progress") as HTMLElement;

  it("a slow action holds its button with a spinner, shows the top bar, cannot be sent twice, and lets go when it works", async () => {
    click(q(".nav-item[data-view=\"cases\"]"));
    await wait(() => !!q("[data-action=\"check-replies\"]"), "the check button");
    const btn = () => q("[data-action=\"check-replies\"]") as HTMLButtonElement;
    const first = btn(), label = first.textContent;
    const slow = slowRequest("/admin/tick", 800);
    try {
      first.click(); first.click(); first.click();                         // three quick presses
      expect(first.classList.contains("is-busy")).toBe(true);              // guarded at once
      expect(first.disabled).toBe(true);
      expect(first.getAttribute("aria-busy")).toBe("true");
      expect(first.textContent).toBe("Checking…");
      await wait(() => !topBar().hidden, "the top bar", 3000);             // slow work shows the bar
      expect(slow.seen.calls).toBe(1);                                     // and only one request went out
      await wait(() => !btn().classList.contains("is-busy") && topBar().hidden, "the work to finish", 6000);
      expect(btn().disabled).toBe(false);
      expect(btn().textContent).toBe(label);                               // the original words are back
      expect(slow.seen.calls).toBe(1);
    } finally { slow.restore(); }
  });

  it("when the work fails the button is released and the reason is shown", async () => {
    await wait(() => !!q("[data-action=\"check-replies\"]"), "the check button");
    const btn = () => q("[data-action=\"check-replies\"]") as HTMLButtonElement;
    const slow = slowRequest("/admin/tick", 500, true);
    try {
      btn().click();
      expect(btn().classList.contains("is-busy")).toBe(true);
      await wait(() => (document.getElementById("toastRegion")?.textContent ?? "").includes("The server is busy"), "the error", 3000);
      await wait(() => !btn().classList.contains("is-busy") && topBar().hidden, "the button to be released", 3000);
      expect(btn().disabled).toBe(false);
      expect(btn().textContent).toBe("Check for replies");
    } finally { slow.restore(); }
  });

  it("a confirm dialog stays open with a working button until the work is done, takes one press only, then closes", async () => {
    click(q(".nav-item[data-view=\"agent\"]"));
    await wait(() => !!q("[data-agent-tab=\"controls\"]"), "the Controls tab");
    click(q("[data-agent-tab=\"controls\"]"));
    await wait(() => !!q("[data-action=\"pause-platform\"]"), "the kill switch");
    click(q("[data-action=\"pause-platform\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "the confirmation");
    const ok = document.getElementById("okConfirm") as HTMLButtonElement, dialog = document.getElementById("modal")!;
    const slow = slowRequest("/controls", 700, false, "POST");
    try {
      ok.click(); ok.click();
      expect(dialog.contains(ok)).toBe(true);                              // still open
      expect(ok.classList.contains("is-busy")).toBe(true);
      expect(ok.textContent).toBe("Switching off…");
      expect((document.getElementById("cancelConfirm") as HTMLButtonElement).disabled).toBe(true);
      await wait(() => dialog.innerHTML === "", "the dialog to close", 6000);   // closed when done
      expect(slow.seen.calls).toBe(1);                                     // one press, one request
    } finally { slow.restore(); }
    await wait(() => !!q("[data-action=\"resume-platform\"]"), "the switched-off state");
    click(q("[data-action=\"resume-platform\"]"));                           // put it back for the tests that follow
    await wait(() => !!document.getElementById("okConfirm"), "the second confirmation");
    click(document.getElementById("okConfirm"));
    await wait(() => !!q("[data-action=\"pause-platform\"]"), "running again", 6000);
  }, 30000);

  it("the area that waits for data shows a spinner and its words", async () => {
    const real = globalThis.fetch; let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    globalThis.fetch = ((u: string, i?: RequestInit) => (String(u).includes("/cases/") && String(u).split("/").length === 5 && !String(u).includes("conversation") ? gate.then(() => real(u, i)) : real(u, i))) as typeof fetch;
    try {
      click(q(".nav-item[data-view=\"cases\"]"));
      await wait(() => !!q("tr[data-case]"), "a case row");
      click(q("tr[data-case]"));
      await wait(() => !!document.querySelector("#caseDrawer .loading-line .spinner"), "the spinner in the drawer");
      expect(document.getElementById("caseDrawer")!.textContent).toContain("Loading…");
    } finally { release(); globalThis.fetch = real; }
    await wait(() => !document.querySelector("#caseDrawer .loading-line"), "the drawer to fill", 4000);
    click(document.getElementById("closeDrawer"));
  });

  const openStudioForm = async () => {
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => !!q("[data-action=\"new-mission\"]"), "the create button");
    click(q("[data-action=\"new-mission\"]"));
    await wait(() => !!document.getElementById("draftS"), "the form");
  };
  const setField = (id: string, v: string) => { const el = document.getElementById(id) as HTMLInputElement; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const pickList = (id: string, v: string) => { const el = document.getElementById(id) as HTMLSelectElement; el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); };
  const fillStudioForm = (name: string) => {
    setField("sName", name); setField("sProg", "Project Studio");
    setField("sGoal", "Find out whether people are still working where we placed them.");
    setField("sPeople", "People who finished our retail training last year.");
    setField("sFind", "Whether they still work at the same place\nThe name of their employer");
  };

  it("the create form shows the steps, a visible privacy note, folded-away settings, a live count, and plain problems before anything is sent", async () => {
    await openStudioForm();
    const dialog = document.getElementById("modal")!;
    expect([...dialog.querySelectorAll(".stepper-item")].map(e => e.textContent!.replace(/^\d/, ""))).toEqual(["Describe", "Draft", "Review", "Save"]);
    expect(dialog.querySelector(".stepper-item.active")!.textContent).toContain("Describe");
    expect(dialog.querySelector(".studio-note")!.textContent).toContain("Do not write any person's name or phone number");
    expect([...dialog.querySelectorAll(".form-section > h3")].map(h => h.textContent!.replace("(optional)", "").trim())).toEqual(["About the mission", "What it is for", "Tone and style"]);
    expect(dialog.classList.contains("modal-sticky")).toBe(true);           // only the middle scrolls, so the buttons stay in view

    // the optional settings are folded away, with a one-line summary that follows them
    expect(document.getElementById("sAtt")).toBeNull();
    expect(document.getElementById("sSummary")!.textContent).toContain("usual attempts");
    click(document.getElementById("sToggle"));
    expect(document.getElementById("sAtt")).not.toBeNull();
    pickList("sWs", "10"); pickList("sWe", "17"); setField("sAtt", "4");
    const summary = document.getElementById("sSummary")!.textContent!;
    expect(summary).toContain("4 attempts at most");
    expect(summary).toContain("10:00 am");
    expect(summary).toContain("5:00 pm");

    // a live count, amber while the text is too short
    setField("sGoal", "Too short");
    expect(document.getElementById("sGoalCount")!.textContent).toBe("9 / 1500");
    expect(document.getElementById("sGoalCount")!.classList.contains("is-short")).toBe(true);
    setField("sGoal", "Find out whether people are still working where we placed them.");
    expect(document.getElementById("sGoalCount")!.classList.contains("is-short")).toBe(false);

    // empty or too-short fields are named in plain words, and nothing is sent
    setField("sGoal", "");
    click(document.getElementById("draftS"));
    const problems = dialog.querySelector(".studio-problems")!.textContent!;
    for (const w of ["Give the mission a name", "Say what the programme is called", "at least 20 characters", "who the people are", "what you need to find out"]) expect(problems).toContain(w);
    expect(dialog.textContent).not.toContain("Review the questions");
    expect((document.getElementById("sAtt") as HTMLInputElement).value).toBe("4"); // what was typed is kept

    // contact hours that end before they start
    fillStudioForm("Hours check");
    pickList("sWs", "18"); pickList("sWe", "9");
    click(document.getElementById("draftS"));
    expect(dialog.querySelector(".studio-problems")!.textContent).toContain("Contact hours must end after they start.");
    click(document.getElementById("cancelS"));
    expect(dialog.classList.contains("modal-sticky")).toBe(false);
  });

  it("while drafting, the form is locked and shows progress; the next screen keeps its normal layout; going back loses nothing", async () => {
    await openStudioForm();
    const dialog = document.getElementById("modal")!;
    fillStudioForm("Locked check");
    const realFetchHere = globalThis.fetch;
    globalThis.fetch = ((u: string, i?: RequestInit) => (String(u).includes("/missions/draft") ? new Promise(r => setTimeout(() => r(realFetchHere(u, i)), 400)) : realFetchHere(u, i))) as typeof fetch;
    try {
      click(document.getElementById("draftS"));
      expect((dialog.querySelector("fieldset.studio-fields") as HTMLFieldSetElement).disabled).toBe(true);
      expect(dialog.querySelector(".studio-progress")).not.toBeNull();
      expect(document.getElementById("draftS")!.textContent).toBe("Drafting…");
      expect((document.getElementById("draftS") as HTMLButtonElement).disabled).toBe(true);
      await wait(() => dialog.textContent!.includes("Review the questions"), "the draft", 6000);
    } finally { globalThis.fetch = realFetchHere; }
    expect(dialog.classList.contains("modal-sticky")).toBe(false);          // the draft screen is unchanged
    click(document.getElementById("backS"));
    expect(dialog.classList.contains("modal-sticky")).toBe(true);
    expect((document.getElementById("sName") as HTMLInputElement).value).toBe("Locked check");
    expect((document.getElementById("sFind") as HTMLTextAreaElement).value).toContain("The name of their employer");
    click(document.getElementById("cancelS"));
    expect(dialog.classList.contains("modal-sticky")).toBe(false);
    expect(dialog.innerHTML).toBe("");
  });

  it("the cases list has a plain Status and a separate Result, and the Mission page lists the results the mission can end with", async () => {
    click(q(".nav-item[data-view=\"cases\"]"));
    await wait(() => !!q("table.data-table"), "the cases table");
    const heads = [...document.querySelectorAll("table.data-table thead th")].map(h => h.textContent);
    expect(heads).toContain("Status");
    expect(heads).toContain("Result");
    expect(heads).not.toContain("Outcome");
    const row = [...document.querySelectorAll("tr[data-case]")][0] as HTMLElement;
    expect(row.textContent).toMatch(/Not started|Waiting for a reply|In conversation|Checking the answers|Needs a person|Complete/);
    expect(row.textContent).not.toContain("Awaiting response");
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => text().includes("Results this mission can end with"), "the results card");
  });
});

/** The status text on a case row. */
function state_status(name: string): string {
  const row = [...document.querySelectorAll("tr[data-case]")].find(r => r.textContent!.includes(name));
  return row?.textContent ?? "";
}
