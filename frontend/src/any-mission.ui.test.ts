// @vitest-environment jsdom
// A mission need not be about jobs. Its cases must not be shown with placement fields (employer, programme record) that mean
// nothing for it. The real page and main.js, against the real API in memory. Every person here is made up.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CaseService, DEMO_TENANT, GatewayTools, InMemoryStore, draftMission, PLACEMENT_RETENTION_V1, ScriptedMissionDrafter } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { ScriptedAgentRuntime } from "@dozai/adapters";
import { createApp } from "../../backend/functions/core_api/src/app";

const T = DEMO_TENANT;
let server: Server;
const realFetch = globalThis.fetch;

const wait = async (check: () => boolean, what: string, ms = 4000) => {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`); await new Promise(r => setTimeout(r, 20)); }
};
const view = () => document.getElementById("appView")!;

beforeAll(async () => {
  const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: true, pii: { key: randomBytes(32).toString("base64"), defaultCountryCode: "91" }, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "24 hours (test)" } });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(url.startsWith("/") ? base + url : url, init)) as typeof fetch;

  const d = await draftMission(new ScriptedMissionDrafter(), { name: "Clinic feedback", programme_name: "Health camp", goal: "Find out how the health camp visit went for people.", people: "People who visited the camp.", find_out: "How easy it was to get there\nWhether they would recommend it" }, PLACEMENT_RETENTION_V1, []);
  const m = await svc.createMission({ user_id: "u", tenant_id: T, role: "admin" }, { ...d.definition!, instrument: { ...d.definition!.instrument, draft: false } });
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "DZ-0001", mission_version: m.version, participant: { participant_id: "p1", tenant_id: T, display_name: "Asha Test", first_name: "Asha", phone_masked: "•••• 0301", location: "Jaipur", cohort: "Camp 1", language: "en", consent: "unknown", recorded_employer: "—" } });
  const c = await svc.beginSession(T, "DZ-0001", "t");
  await svc.requestReview(T, "DZ-0001", c.version, "interview_complete", "Every answer is in.", "t");

  const html = readFileSync(resolve(process.cwd(), "frontend/index.html"), "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  (window as unknown as { DOZAI_API_BASE: string }).DOZAI_API_BASE = "/api";
  window.scrollTo = () => undefined;
  await import("./main.js");
});
afterAll(() => { server.close(); globalThis.fetch = realFetch; });

describe("a case in a mission that is not about jobs", () => {
  it("its drawer shows no employer or programme-record fields", async () => {
    (document.querySelector('.nav-item[data-view="cases"]') as HTMLElement).click();
    await wait(() => !!document.querySelector('tr[data-case="DZ-0001"]'), "case row");
    (document.querySelector('tr[data-case="DZ-0001"]') as HTMLElement).click();
    await wait(() => (document.getElementById("caseDrawer")?.textContent ?? "").includes("Case owner"), "drawer");
    expect(document.getElementById("caseDrawer")!.textContent).not.toMatch(/employer/i);
  });

  it("the review screen does not ask a person to compare employers", async () => {
    (document.querySelector('.nav-item[data-view="reviews"]') as HTMLElement).click();
    await wait(() => view().textContent!.includes("Decision required"), "review detail");
    expect(view().textContent).not.toMatch(/employer|Programme record/i);
    expect(view().textContent).toContain("interview_complete");
  });
});
