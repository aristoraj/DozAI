import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { CaseService, GatewayTools, InMemoryStore, DEMO_TENANT } from "@dozai/core";
import { DEFAULT_POLICY } from "@dozai/domain";
import type { Participant } from "@dozai/contracts";
import { BASE_PROMPT, VERIFICATION_EMPLOYEE_V1 } from "@dozai/core";
import { ClaudeAgentRuntime, DEFAULT_MODEL, type MessagesClient } from "./claude";

const OPEN = { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 };
type Msg = Anthropic.MessageParam;

/** A stand-in "model" that behaves like a well-instructed agent, driven only by what it has read in the conversation. */
function fakeModel(opts: { propose?: boolean; refuseAt?: number; badTool?: boolean; usage?: Record<string, number> } = {}) {
  const calls: Record<string, unknown>[] = [];
  let n = 0;
  const lastResult = (messages: Msg[]) => {
    const last = messages[messages.length - 1]!;
    const block = Array.isArray(last.content) ? (last.content.find(b => b.type === "tool_result") as Anthropic.ToolResultBlockParam | undefined) : undefined;
    return block ? JSON.parse(String(block.content)) : undefined;
  };
  const msg = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"] = "tool_use"): Anthropic.Message =>
    ({ id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: opts.usage ?? { input_tokens: 900, output_tokens: 150 } } as unknown as Anthropic.Message);
  const use = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock => ({ type: "tool_use", id: `tu_${++n}`, name, input } as Anthropic.ToolUseBlock);
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        const messages = params.messages as Msg[];
        const r = lastResult(messages);
        const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;
        if (opts.refuseAt === calls.length) return { ...msg([], "refusal"), stop_details: { type: "refusal", category: "general_harms" } } as Anthropic.Message;
        if (calls.length === 1) return msg([use("case_get_context", { case_id: "C-1" })]);
        if (calls.length === 2) return msg([use(opts.badTool ? "drop_table" : "mission_get_bundle", { mission_version_id: "MSN-001-v1.3" })]);
        if (calls.length === 3) return msg([use("whatsapp_send_template", { case_id: "C-1", template_key: "placement_intro_v1", idempotency_key: "key-send-0001", expected_version: r.case_version })]);
        if (calls.length === 4) return msg([text("Intro sent. Waiting for the reply.")], "end_turn");
        // resumed after the reply
        if (calls.length === 5) return msg([use("case_get_context", { case_id: "C-1" })]);
        if (calls.length === 6 && opts.propose !== false) {
          const refs = (r.data.evidence as { evidence_ref: string }[]).map(e => e.evidence_ref);
          return msg([use("decision_propose", { case_id: "C-1", idempotency_key: "key-decide-01", expected_version: r.case_version, proposed_outcome: "confirmed", livelihood_state: "same_job", confidence: 0.93, evidence_refs: refs, rationale: "Employer and status match the programme record." })]);
        }
        return msg([text("Done.")], "end_turn");
      },
    },
  };
  return { client, calls };
}

const admin = { user_id: "ops@x.org", tenant_id: DEMO_TENANT, role: "agent_ops" } as const;
const employee = (version: string) => ({
  employee_id: "verification-employee", version, name: "Meera", purpose: "Verify what happened to each participant after a programme.",
  persona: "Warm, respectful and brief. Plain words, short sentences.", instructions: "You verify one participant's outcome for one case at a time. Read the case with case_get_context first.",
  allowed_tools: [...VERIFICATION_EMPLOYEE_V1.allowed_tools],
});

async function setup() {
  const store = new InMemoryStore();
  const svc = new CaseService(store, () => new Date(), OPEN);
  const participant: Participant = { participant_id: "p1", tenant_id: DEMO_TENANT, display_name: "Test Person", phone_masked: "•••• 1111", location: "Jaipur", cohort: "T", language: "en", consent: "unknown", recorded_employer: "Acme Retail" };
  await svc.createCase({ tenant_id: DEMO_TENANT, run_id: "r", case_id: "C-1", participant });
  return { svc, tools: new GatewayTools(svc) };
}

describe("ClaudeAgentRuntime (mocked model)", () => {
  it("drives a case to an auto-completed outcome using only tools, and idles while waiting", async () => {
    const { svc, tools } = await setup();
    const { client, calls } = fakeModel();
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    expect(await svc.getCase(DEMO_TENANT, "C-1")).toMatchObject({ status: "complete", outcome: "confirmed" });
    expect(s.simulated).toBe(false);
    expect(s.trace.map(t => t.label)).toContain("Waiting for reply");
    expect(s.trace.filter(t => t.tool).map(t => t.tool)).toEqual(["case_get_context", "mission_get_bundle", "whatsapp_send_template", "case_get_context", "decision_propose"]);
    // request shape: pinned model, system prompt, auto tool choice, 8 tools, effort set
    const first = calls[0]!;
    expect(first.model).toBe(DEFAULT_MODEL);
    expect(Array.isArray(first.system)).toBe(true);
    expect(first.tool_choice).toEqual({ type: "auto" });
    expect((first.tools as unknown[]).length).toBe(9);
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(s.tokens_in).toBeGreaterThan(0);
  });

  it("gives the agent the platform, employee and mission layers, and caches the parts that do not change", async () => {
    const { svc, tools } = await setup();
    const { client, calls } = fakeModel();
    await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    const blocks = calls[0]!.system as { text: string; cache_control?: { type: string } }[];
    expect(blocks).toHaveLength(2);
    expect(blocks.every(b => b.cache_control?.type === "ephemeral")).toBe(true);
    expect(blocks[0]!.text).toContain(BASE_PROMPT);                       // platform layer
    expect(blocks[0]!.text).toContain(`You are ${VERIFICATION_EMPLOYEE_V1.name}`); // employee layer
    expect(blocks[0]!.text).not.toContain("Your mission:");                // nothing mission-specific in the part shared by all missions
    expect(blocks[1]!.text).toContain("Your mission: Post-program placement and retention tracer");
    expect(blocks[1]!.text).toContain("employer_name: Employer");          // what must be known, preloaded: no extra call to read it
    const everything = JSON.stringify(calls.map(c => c.system));
    expect(everything).not.toContain("Test Person");
  });

  it("records which employee version ran, and takes its run limits from the employee", async () => {
    const { svc, tools } = await setup();
    await svc.createEmployee(admin, { ...employee("VE-2.0.0"), model: { effort: "high", max_turns: 2, budget_usd: 0.3 } });
    const { client, calls } = fakeModel();
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    expect(s.employee_version).toBe("VE-2.0.0");
    expect(s.budget_usd).toBe(0.3);
    expect(calls).toHaveLength(2);                                         // max_turns: 2
    expect(calls[0]!.output_config).toEqual({ effort: "high" });
    expect(s.trace.at(-1)?.detail).toBe("Stopped after too many turns.");
  });

  it("offers only the tools its employee is allowed, and the gateway refuses any other even if the model asks", async () => {
    const { svc, tools } = await setup();
    await svc.createEmployee(admin, { ...employee("VE-3.0.0"), allowed_tools: ["case_get_context", "mission_get_bundle", "decision_propose", "review_request"] });
    const { client, calls } = fakeModel();
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    expect((calls[0]!.tools as { name: string }[]).map(t => t.name)).toEqual(["case_get_context", "mission_get_bundle", "decision_propose", "review_request"]);
    const refused = s.trace.find(t => t.tool === "whatsapp_send_template");
    expect(refused?.detail).toContain("TOOL_NOT_ALLOWED_FOR_EMPLOYEE");
    expect((await svc.getCase(DEMO_TENANT, "C-1")).attempts).toBe(0);     // nothing was sent
  });

  it("counts cached input at its cheaper rate toward the budget", async () => {
    const { svc, tools } = await setup();
    const usage = { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 100_000 };
    const { client, calls } = fakeModel({ usage });
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    const perCall = (100 * 2 + 100_000 * 0.2 + 100 * 10) / 1_000_000;
    expect(s.cost_usd).toBeCloseTo(calls.length * perCall, 3);
    expect(s.tokens_in).toBe(calls.length * 100_100);
  });

  it("sends only identifiers in the first message (no personal data)", async () => {
    const { svc, tools } = await setup();
    const { client, calls } = fakeModel();
    await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    const everything = JSON.stringify(calls.map(c => c.messages));
    expect(everything).not.toContain("Test Person");
    expect(everything).not.toContain("•••• 1111"); // the masked number (random ids can contain "1111" by chance)
  });

  it("employer conflict: the agent proposes but policy sends it to review", async () => {
    const { svc, tools } = await setup();
    const { client } = fakeModel();
    await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "employer_conflict");
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("review");
  });

  it("an unknown tool is returned as an error result, not executed", async () => {
    const { svc, tools } = await setup();
    const { client } = fakeModel({ badTool: true });
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    const bad = s.trace.find(t => t.tool === "drop_table");
    expect(bad?.detail).toContain("UNKNOWN_TOOL");
  });

  it("stops cleanly when the model declines, and leaves the case for a human", async () => {
    const { svc, tools } = await setup();
    const { client } = fakeModel({ refuseAt: 1 });
    const s = await new ClaudeAgentRuntime(tools, { client }).runCase(svc, DEMO_TENANT, "C-1", "same_job");
    expect(s.trace.map(t => t.type)).toContain("refusal");
    expect((await svc.getCase(DEMO_TENANT, "C-1")).status).toBe("running");
  });

  it("enforces the session budget", async () => {
    const { svc, tools } = await setup();
    const { client } = fakeModel();
    const rt = new ClaudeAgentRuntime(tools, { client });
    // make every turn expensive
    const orig = client.messages.create.bind(client.messages);
    client.messages.create = async p => { const r = await orig(p); (r.usage as { input_tokens: number }).input_tokens = 300_000; return r; };
    const s = await rt.runCase(svc, DEMO_TENANT, "C-1", "same_job");
    expect(s.status).toBe("budget_reached");
  });
});
