import { describe, it, expect } from "vitest";
import { CaseService } from "../cases/service";
import { GatewayTools } from "./tools";
import { InMemoryStore } from "../storage/store";
import { DEFAULT_POLICY } from "@dozai/domain";

describe("read tools are available in every case state", () => {
  it("mission_get_bundle works while the case is waiting for a reply", async () => {
    const svc = new CaseService(new InMemoryStore(), () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
    await svc.createCase({ tenant_id: "t", run_id: "r", case_id: "C", participant: { participant_id: "p", tenant_id: "t", display_name: "X", phone_masked: "•", location: "", cohort: "", language: "en", consent: "unknown", recorded_employer: "E" } });
    await svc.beginSession("t", "C", "test");
    const tools = new GatewayTools(svc);
    const s = { session_id: "s", tenant_id: "t", case_id: "C", mission_version: "MSN-001-v1.3", employee_version: "1" };
    const c = await svc.getCase("t", "C");
    const send = await tools.call(s, "whatsapp_send_template", { case_id: "C", template_key: "placement_intro_v1", idempotency_key: "key-12345678", expected_version: c.version });
    expect(send.error).toBeUndefined();
    expect((await svc.getCase("t", "C")).status).toBe("waiting");
    const again = await tools.call(s, "whatsapp_send_template", { case_id: "C", template_key: "placement_intro_v1", idempotency_key: "key-87654321", expected_version: (await svc.getCase("t", "C")).version });
    expect(again.error?.code).toBe("ALREADY_WAITING");
    expect((await svc.getCase("t", "C")).attempts).toBe(1);
    const bundle = await tools.call(s, "mission_get_bundle", { mission_version_id: "MSN-001-v1.3" });
    expect(bundle.error).toBeUndefined();
    expect(bundle.next_allowed_actions).toContain("mission_get_bundle");
  });
});
