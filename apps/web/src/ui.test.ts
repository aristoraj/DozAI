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
const voiceCfg = { piiKey: PII_KEY, allowAll: true, callsEnabled: true };
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
    expect(document.getElementById("modal")!.innerHTML).toBe(""); // closed

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
    expect(state_status("Kiran Test")).toContain("In progress");
    expect(state_status("Mohan Test")).toContain("Not started"); // not in the campaign
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
  });

  it("shows the questionnaire wording and signs it off from the Mission page", async () => {
    click(q(".nav-item[data-view=\"missions\"]"));
    await wait(() => !!q("[data-action=\"read-wording\"]"), "the wording card");
    expect(text()).toContain("Draft: not signed off");
    expect(text()).toContain("every reply is handed to a person");
    click(q("[data-action=\"read-wording\"]"));
    await wait(() => text().includes("Fixed messages"), "the wording");
    expect(text()).toContain("Answers to common questions");
    click(q("[data-action=\"sign-off\"]"));
    await wait(() => !!document.getElementById("okConfirm"), "the confirmation");
    expect(document.getElementById("modal")!.textContent).toContain("has read every question and message");
    click(document.getElementById("okConfirm"));
    await wait(() => text().includes("Signed off by admin:dev-user"), "signed off", 6000);
    expect(q("[data-action=\"sign-off\"]")).toBeNull(); // nothing left to sign
    expect(text()).toContain("-signed");
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
    await wait(() => document.getElementById("modal")!.textContent!.includes("Read the draft"), "the draft", 6000);
    const m = document.getElementById("modal")!.textContent!;
    expect(m).toContain("What the employee will find out");
    expect(m).toContain("Whether they still work at the same place");
    expect(m).toContain("Nothing is saved yet");
    click(document.getElementById("saveS"));
    await wait(() => text().includes("Draft: not signed off") && text().includes("studio-check-v1.0"), "saved as a draft", 6000);
  });
});

/** The status text on a case row. */
function state_status(name: string): string {
  const row = [...document.querySelectorAll("tr[data-case]")].find(r => r.textContent!.includes(name));
  return row?.textContent ?? "";
}
