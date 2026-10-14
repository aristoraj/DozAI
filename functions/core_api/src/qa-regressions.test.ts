// Regressions found in a test-and-fix round. Each test failed before its fix.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { CaseService, GatewayTools, InMemoryStore } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import { FakeVoice, ScriptedAgentRuntime } from "@dozai/adapters";
import { createApp } from "./app";

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; vi.restoreAllMocks(); });

function start(o: { now?: () => Date; voice?: FakeVoice } = {}) {
  const svc = new CaseService(new InMemoryStore(), o.now ?? (() => new Date()), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
  svc.voiceEnabled = !!o.voice;
  const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(new GatewayTools(svc)) }), devAuth: true, ...(o.voice ? { voice: { port: o.voice, cfg: { piiKey: "k", callsEnabled: true }, tenant: "demo" } } : {}), pii: { key: randomBytes(32).toString("base64"), defaultCountryCode: "91" }, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "test" } } as never);
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return async (method: string, path: string, raw?: string, role = "admin") => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-dozai-role": role }, body: raw });
    return { status: res.status, type: res.headers.get("content-type") ?? "", json: (await res.json().catch(() => null)) as any };
  };
}

describe("found in testing: error responses", () => {
  it("a broken JSON body is a 400 in the usual error shape, and the body is not written to the logs", async () => {
    const call = start();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("POST", "/participants/import", '{"rows":[{"name":"Asha Test","phone":"9876500201"');
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: { code: "INVALID_JSON" } });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("9876500201");
  });

  it("a body over the size limit is a 413 in the usual error shape", async () => {
    const call = start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("POST", "/participants/import", JSON.stringify({ rows: [], pad: "x".repeat(120_000) }));
    expect(r.status).toBe(413);
    expect(r.json).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
  });

  it("an unknown API route is a JSON 404, not an HTML page", async () => {
    const call = start();
    const r = await call("GET", "/no-such-route");
    expect(r.status).toBe(404);
    expect(r.type).toContain("application/json");
    expect(r.json).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("found in testing: publishing a phone form", () => {
  it("a second publish that starts just after a two-minute boundary is still refused while the first is running", async () => {
    let t = 1_800_000_000_000 - 50; // 50 ms before a two-minute boundary
    const port = new FakeVoice();
    const slow = port.publishForm.bind(port);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    port.publishForm = async (def, o) => { await gate; return slow(def, o); }; // ZoLabs is slow
    const call = start({ now: () => new Date(t), voice: port });
    const first = call("POST", "/missions/MSN-001-v1.3/voice-form/publish", JSON.stringify({ confirm: true }), "agent_ops");
    await new Promise(r => setTimeout(r, 80)); // the first request has taken the lock and is waiting on ZoLabs
    t += 100; // the clock has crossed into the next two-minute window
    const pending = call("POST", "/missions/MSN-001-v1.3/voice-form/publish", JSON.stringify({ confirm: true }), "agent_ops");
    setTimeout(release, 150);
    const second = await pending;
    expect((await first).status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("PUBLISH_IN_PROGRESS");
    expect(port.forms.size).toBe(1);
  });
});
