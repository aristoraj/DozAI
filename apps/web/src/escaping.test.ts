// @vitest-environment jsdom
// Names, employers, cohorts, campaign names and review reasons are typed by people (or by a participant). Each page must show
// them as text: markup in them must never become part of the page. The real page and main.js, against the real API in memory.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CampaignService, CaseService, DEMO_TENANT, GatewayTools, InMemoryStore } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { ScriptedAgentRuntime } from "@dozai/adapters";
import { createApp } from "../../../functions/core_api/src/app";

const T = DEMO_TENANT;
const BAD = `<img src=x onerror="window.__xss=1">`;
const BAD2 = `"><script>window.__xss=2</script><b class="pwn">`;
let server: Server;
const realFetch = globalThis.fetch;

const wait = async (check: () => boolean, what: string, ms = 4000) => {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`); await new Promise(r => setTimeout(r, 20)); }
};
const view = () => document.getElementById("appView")!;
const injected = () => document.querySelectorAll('img[src="x"], .pwn, #appView script, #caseDrawer script, #modal script').length;

beforeAll(async () => {
  const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: true, pii: { key: randomBytes(32).toString("base64"), defaultCountryCode: "91" }, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "24 hours (test)" } });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(url.startsWith("/") ? base + url : url, init)) as typeof fetch;

  // A participant whose every typed field carries markup, a case waiting for review with a reason that does too, and a campaign.
  await svc.createCase({ tenant_id: T, run_id: "r", case_id: "DZ-0001", participant: { participant_id: "p1", tenant_id: T, display_name: `Asha ${BAD}`, first_name: "Asha", phone_masked: "•••• 0201", location: BAD2, cohort: `B1${BAD}`, language: "en", consent: "unknown", recorded_employer: BAD2 } });
  const c = await svc.beginSession(T, "DZ-0001", "t");
  await svc.requestReview(T, "DZ-0001", c.version, "agent_unsure", `They said ${BAD2}`, "t");
  await new CampaignService(svc).create({ user_id: "ops", tenant_id: T, role: "admin" }, { name: `Cohort ${BAD}` });

  const html = readFileSync(resolve(process.cwd(), "apps/web/index.html"), "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  (window as unknown as { DOZAI_API_BASE: string }).DOZAI_API_BASE = "/api";
  window.scrollTo = () => undefined;
  await import("./main.js");
});
afterAll(() => { server.close(); globalThis.fetch = realFetch; });

describe("typed text is shown as text on every page", () => {
  it.each(["overview", "cases", "campaigns", "reviews", "audit", "approvals", "calls", "missions", "agent"])("%s", async page => {
    (document.querySelector(`.nav-item[data-view="${page}"]`) as HTMLElement).click();
    await wait(() => view().textContent!.trim().length > 0 && !view().querySelector(".loading, .spinner"), `${page} page`);
    await new Promise(r => setTimeout(r, 150)); // let any follow-up fetch draw
    expect(injected()).toBe(0);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("the case drawer shows the name, employer and reason as written, without running them", async () => {
    (document.querySelector('.nav-item[data-view="cases"]') as HTMLElement).click();
    await wait(() => !!document.querySelector('tr[data-case="DZ-0001"]'), "case row");
    (document.querySelector('tr[data-case="DZ-0001"]') as HTMLElement).click();
    await wait(() => (document.getElementById("caseDrawer")?.textContent ?? "").includes("Programme record employer"), "drawer");
    const drawer = document.getElementById("caseDrawer")!.textContent!;
    expect(drawer).toContain(`Asha ${BAD}`);
    expect(drawer).toContain(BAD2);
    expect(injected()).toBe(0);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("the campaign's name in a confirmation dialog is text too", async () => {
    (document.querySelector('.nav-item[data-view="campaigns"]') as HTMLElement).click();
    await wait(() => view().textContent!.includes("Cohort "), "campaign card");
    const del = Array.from(view().querySelectorAll("button")).find(b => /Delete|Discard/.test(b.textContent ?? ""));
    expect(del).toBeTruthy();
    del!.click();
    await wait(() => !(document.getElementById("modalBackdrop") as HTMLElement).hidden, "dialog");
    expect(document.getElementById("modal")!.textContent).toContain(`Cohort ${BAD}`);
    expect(injected()).toBe(0);
  });
});
