import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { CaseService, GatewayTools, InMemoryStore, DEMO_TENANT, encryptPhone, phoneHash } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { InteraktChannels } from "./index";

const KEY = randomBytes(32).toString("base64");
const PHONE = "919876543210";

describe("template override (testing aid)", () => {
  it("sends the substitute template with its own language and variables, still only to the allowlist", async () => {
    const store = new InMemoryStore();
    const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    const participant: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Asha", first_name: "Asha", phone_masked: "•••• 3210", phone_enc: encryptPhone(KEY, PHONE), phone_hash: phoneHash(KEY, PHONE), location: "J", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme" };
    await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", participant });
    await svc.beginSession(DEMO_TENANT, "C-1", "t");
    const c = await svc.getCase(DEMO_TENANT, "C-1");
    const r = await new GatewayTools(svc).call({ session_id: "s", tenant_id: DEMO_TENANT, case_id: "C-1", mission_version: "MSN-001-v1.3", employee_version: "1" }, "whatsapp_send_template", { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-12345678", expected_version: c.version });
    expect(r.error).toBeUndefined();

    let body: any;
    const ch = new InteraktChannels({
      apiKey: "k", piiKey: KEY, allowlist: [PHONE],
      templateOverrides: { placement_intro_v1: { provider_name: "other_approved_template", language: "en_US", body_fields: [] } },
      fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ result: true, id: "m1" }), { status: 201 }); }) as never,
    });
    expect(await ch.dispatchOutbox(svc, DEMO_TENANT)).toBe(1);
    expect(body.template).toEqual({ name: "other_approved_template", languageCode: "en_US", bodyValues: [] });
    expect(body.phoneNumber).toBe("9876543210");
  });
});
