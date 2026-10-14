// Claude runtime adapter. The ONLY module that talks to Anthropic.
//
// It runs the Verification Employee as a tool-use loop over the same GatewayTools the MCP gateway exposes, so the
// agent has no database access, no credentials and no way to complete a case: every action is a bounded business
// tool that Catalyst validates. The API key comes from the environment (ANTHROPIC_API_KEY), never from a prompt or file.
//
// This uses the Messages API with client-executed tools. Moving to Managed Agents sessions (agent runs on Anthropic's
// side and calls the AppSail gateway over MCP) means replacing this class behind the same AgentRuntimePort.
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOL_NAMES, ToolInputs, type RunAgentInput, type ToolName } from "@dozai/contracts";
import { buildAgentContext, DozaiError, newId, wakeMessage, type AgentSession, type CaseService, type GatewayTools, type ToolSession, type TraceStep, type WakeRequest } from "@dozai/core";
import { FakeChannels, type AgentRuntimePort, type ChannelPort } from "./index";

export const DEFAULT_MODEL = "claude-sonnet-5-5"; // the platform's pinned model; an employee may name another, DOZAI_MODEL overrides both

export interface MessagesClient {
  messages: { create(params: Record<string, unknown>): Promise<Anthropic.Message> };
}

export interface ClaudeRuntimeOptions {
  client?: MessagesClient;          // injected in tests
  model?: string;
  maxTurns?: number;                // hard stop on loop length
  effort?: "low" | "medium" | "high";
  channels?: FakeChannels;          // simulated participant, used when no live channel is set
  live?: ChannelPort;               // real channel (Interakt): requests are sent for real and the session idles until a reply arrives
}

// Indicative per-token rates (USD per million) used only for the budget guard; usage is also stored verbatim.
// Cached input is cheaper to read and a little dearer to write, which is why the stable layers are cached.
const RATES = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

const toolDefs = (allowed: readonly ToolName[]): Anthropic.Tool[] =>
  TOOL_NAMES.filter(name => allowed.includes(name)).map(name => {
    const schema = zodToJsonSchema(ToolInputs[name], { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: TOOL_HELP[name], input_schema: schema as Anthropic.Tool.InputSchema };
  });

const TOOL_HELP: Record<ToolName, string> = {
  case_get_context: "Read the authorised facts and evidence references for this case. Returns no names or phone numbers.",
  mission_get_bundle: "Read the mission modules, approved templates, contact policy and judgement rubric for the pinned version.",
  case_get_timeline: "Read recent ledger events for this case.",
  whatsapp_send_template: "Request an approved WhatsApp template. Checks consent, contact window, attempt cap and opt-out.",
  callback_schedule: "Set your own reminder: you are woken after this many hours to look at the case again. It contacts nobody. Not needed right after sending a message, because the platform already sets a follow-up timer; use it only for a different time than that.",
  memory_note: "Remember one fixed fact about this person for later runs. Keys: best_time_to_call (morning, afternoon, evening, weekend), preferred_channel (whatsapp, voice), preferred_language (a two-letter code), prefers_short_contact (yes, no). Nothing else can be stored.",
  voice_call_request: "Request a phone call, now or at a time inside the contact hours, with a short reason. The call asks only for what is still missing. Only available when case_get_context says phone_call_available.",
  decision_propose: "Propose a result: proposed_outcome (confirmed, not_confirmed or inconclusive), livelihood_state set to exactly one of the findings listed in your mission brief (or null when the evidence does not settle it), your confidence, and evidence references. The platform rejects a finding the mission does not list, and decides the final transition.",
  review_request: "Create a human review task with a reason code and a short note.",
};

interface RunSettings { model: string; effort: "low" | "medium" | "high"; maxTurns: number }

export class ClaudeAgentRuntime implements AgentRuntimePort {
  private client: MessagesClient;
  /** Set only when the platform or a test forces it. Otherwise the employee's own settings apply. */
  private modelOverride?: string;
  private maxTurnsOverride?: number;
  private effortOverride?: "low" | "medium" | "high";
  private channels: FakeChannels;
  private live?: ChannelPort;

  constructor(private tools: GatewayTools, opts: ClaudeRuntimeOptions = {}) {
    this.client = opts.client ?? (new Anthropic() as unknown as MessagesClient); // reads ANTHROPIC_API_KEY
    this.modelOverride = opts.model ?? process.env.DOZAI_MODEL;
    this.maxTurnsOverride = opts.maxTurns;
    this.effortOverride = opts.effort;
    this.channels = opts.channels ?? new FakeChannels();
    this.live = opts.live;
  }

  async runCase(svc: CaseService, tenant: string, caseId: string, scenario: RunAgentInput["scenario"]): Promise<AgentSession> {
    return this.run(svc, tenant, caseId, { kind: "start", scenario });
  }

  /** A real reply has been recorded: open a fresh session that reads the case from the ledger and decides. */
  async resumeCase(svc: CaseService, tenant: string, caseId: string, wake?: WakeRequest): Promise<AgentSession> {
    return this.run(svc, tenant, caseId, wake ? { kind: "wake", wake } : { kind: "resume" });
  }

  private async run(svc: CaseService, tenant: string, caseId: string, mode: { kind: "start"; scenario: RunAgentInput["scenario"] } | { kind: "resume" } | { kind: "wake"; wake: WakeRequest }): Promise<AgentSession> {
    // The kill switch and the spend limits are checked before any model is called.
    const gate = await svc.agentGate(tenant, caseId);
    if (!gate.ok) throw new DozaiError(gate.code, gate.message, 429);
    const mission = await svc.getMission(tenant, (await svc.getCase(tenant, caseId)).mission_version);
    const employee = await svc.employeeFor(mission);
    const pack = buildAgentContext(employee, mission);
    const run: RunSettings = { model: this.modelOverride ?? employee.model?.name ?? DEFAULT_MODEL, effort: this.effortOverride ?? employee.model?.effort ?? "medium", maxTurns: this.maxTurnsOverride ?? employee.model?.max_turns ?? 12 };
    // The platform and employee layers are the same for every mission and the mission layer is the same for every case, so both are cached.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: pack.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: pack.mission, cache_control: { type: "ephemeral" } },
    ];
    const ctx: ToolSession = { session_id: newId("sesn"), tenant_id: tenant, case_id: caseId, mission_version: mission.version, employee_version: employee.version, allowed_tools: employee.allowed_tools };
    const session: AgentSession = { session_id: ctx.session_id, tenant_id: tenant, case_id: caseId, employee_version: employee.version, mission_version: ctx.mission_version, status: "running", tokens_in: 0, tokens_out: 0, cost_usd: 0, budget_usd: employee.model?.budget_usd ?? 0.5, simulated: false, trace: [], started_at: svc.now().toISOString(), trigger: mode.kind === "wake" ? `wake:${mode.wake.reason}` : mode.kind };
    const step = (label: string, type: string, detail: string, extra: Partial<TraceStep> = {}) => session.trace.push({ label, type, detail, ts: svc.now().toISOString(), ...extra });
    const messages: Anthropic.MessageParam[] = [];
    const tools = toolDefs(employee.allowed_tools);

    await svc.store.putSession(session);
    step("Session created", "session.created", `Pinned ${run.model} + ${employee.name} ${employee.version} + mission ${ctx.mission_version} (${pack.estimated_tokens} tokens of instructions)`);
    if (mode.kind === "start") await svc.beginSession(tenant, caseId, `agent:${ctx.session_id}`);
    await svc.emit({ tenant_id: tenant, case_id: caseId }, "agent_session_started", `agent:${ctx.session_id}`, "Agent session started", { session_id: ctx.session_id, model: run.model, employee_version: employee.version, simulated: false });

    // Only identifiers go in. Everything else is read through the tools.
    messages.push({ role: "user", content: mode.kind === "start"
      ? `Verify case ${caseId} under mission ${ctx.mission_version}. Read the case context first.`
      : mode.kind === "wake" ? wakeMessage(mode.wake, caseId, ctx.mission_version)
      : `System event: the participant has replied on case ${caseId} (mission ${ctx.mission_version}) and the reply is recorded as evidence. Read the context and decide.` });
    step("Objective received", "user.message", "Case and mission IDs only");

    let outcome = await this.loop(svc, ctx, session, messages, tools, step, system, run);
    const after = await svc.getCase(tenant, caseId);
    if (mode.kind === "start" && outcome === "ok" && after.status === "waiting") {
      step("Waiting for reply", "session.status_idle", "Catalyst owns the wait");
      if (this.live) {
        const sent = await this.live.dispatchOutbox(svc, tenant);
        step("Message sent", "channel", `${sent} message(s) handed to the WhatsApp provider`);
      } else {
        const scenario = mode.scenario;
        await this.channels.dispatchOutbox(svc, tenant);
        await this.channels.scenarioReply(svc, tenant, caseId, scenario);
        const resumed = await svc.getCase(tenant, caseId);
        if (scenario !== "no_response" && resumed.status !== "complete") {
          messages.push({ role: "user", content: "System event: the participant has replied and the response is recorded as evidence. Read the case context again and decide." });
          step("Participant event", "system.message", "Normalised inbound response");
          outcome = await this.loop(svc, ctx, session, messages, tools, step, system, run);
        }
      }
    }

    session.status = outcome === "budget" ? "budget_reached" : "idle";
    const refused = session.trace.find(t => t.result && typeof t.result === "object" && "code" in (t.result as object));
    const endDetail = outcome === "refusal" ? "Model declined; escalate to a human."
      : outcome === "budget" ? "Session budget reached."
      : outcome === "turns" ? "Stopped after too many turns."
      : refused && (refused.result as { code: string }).code !== "ALREADY_WAITING" ? `Stopped: ${refused.tool} was refused (${(refused.result as { code: string }).code}).`
      : (await svc.getCase(tenant, caseId)).status === "waiting" ? "Waiting for the participant's reply."
      : "Handed off.";
    step("Session idled", "session.status_idle", endDetail);
    await svc.store.putSession(session);
    await svc.emit({ tenant_id: tenant, case_id: caseId }, "agent_session_ended", `agent:${ctx.session_id}`, `Agent session ${session.status}: ${endDetail}`, { session_id: ctx.session_id, cost_usd: session.cost_usd });
    return session;
  }

  /** One turn-taking loop: model -> tool calls -> results -> model, until it stops calling tools. */
  private async loop(svc: CaseService, ctx: ToolSession, session: AgentSession, messages: Anthropic.MessageParam[], tools: Anthropic.Tool[], step: (l: string, t: string, d: string, e?: Partial<TraceStep>) => number, system: Anthropic.TextBlockParam[], run: RunSettings): Promise<"ok" | "refusal" | "budget" | "turns"> {
    let spent = session.cost_usd * 1_000_000; // carried across the loops of one session
    for (let turn = 0; turn < run.maxTurns; turn++) {
      if (session.cost_usd >= session.budget_usd) return "budget";
      const res = await this.client.messages.create({
        model: run.model,
        max_tokens: 8000,
        system,
        tools,
        tool_choice: { type: "auto" }, // forced tool use is not supported on this model family
        output_config: { effort: run.effort },
        messages,
      });
      const u = res.usage as { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
      const written = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0;
      session.tokens_in += u.input_tokens + written + read;
      session.tokens_out += u.output_tokens;
      spent += u.input_tokens * RATES.input + written * RATES.cacheWrite + read * RATES.cacheRead + u.output_tokens * RATES.output;
      session.cost_usd = Math.round((spent / 1_000_000) * 10_000) / 10_000;

      if (res.stop_reason === "refusal") { step("Model declined", "refusal", String((res as { stop_details?: { category?: string } }).stop_details?.category ?? "refusal")); return "refusal"; }
      // Echo the full content back unchanged (keeps thinking blocks valid for the next turn).
      messages.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!calls.length) return "ok";

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const known = (TOOL_NAMES as string[]).includes(call.name);
        const r = known ? await this.tools.call(ctx, call.name as ToolName, call.input) : { operation_id: "none", case_version: 0, next_allowed_actions: [], error: { code: "UNKNOWN_TOOL", message: `unknown tool ${call.name}` } };
        const held = !r.error && !!(r.data as { held?: boolean } | undefined)?.held;
        step(call.name, "MCP tool", r.error ? `${r.error.code}: ${r.error.message}` : held ? "ok (held for approval)" : "ok", { tool: call.name, input: call.input, result: r.error ?? r.data, outcome: r.error ? "refused" : held ? "held" : "executed", case_version: r.case_version });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(r), is_error: !!r.error });
      }
      messages.push({ role: "user", content: results }); // all results in ONE user message
      if (res.stop_reason === "max_tokens") return "turns";
    }
    return "turns";
  }
}
