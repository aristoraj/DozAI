// DozAI MCP gateway. Exposes business capabilities as MCP tools over Streamable HTTP.
// Auth: Bearer session token minted by the runtime adapter; it pins the session to one tenant + case.
import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolInputs, TOOL_NAMES, type ToolName } from "@dozai/contracts";
import { verifySessionToken, type GatewayTools, type ToolSession } from "@dozai/core";

const DESCRIPTIONS: Record<ToolName, string> = {
  case_get_context: "Read the authorised facts and evidence references for this case. Returns no names or phone numbers.",
  mission_get_bundle: "Read the mission questions, contact policy, approved templates and judgement rubric for the pinned version.",
  case_get_timeline: "Read recent ledger events for this case.",
  whatsapp_send_template: "Request an approved WhatsApp template. Checks consent, contact window, attempt cap and opt-out.",
  callback_schedule: "Set your own wake-up: you are woken after this many hours to look at the case again.",
  memory_note: "Remember one fixed fact about this person (best time to call, preferred channel, preferred language, short-contact preference). Nothing else can be stored.",
  voice_call_request: "Request a phone call, now or at a time inside the contact hours, with a short reason. The call asks only for what is still missing.",
  decision_propose: "Propose an outcome with confidence and evidence references. Catalyst decides the final transition.",
  review_request: "Create a human review task with a reason code.",
};

function buildServer(tools: GatewayTools, session: ToolSession): McpServer {
  const server = new McpServer({ name: "dozai-mcp-gateway", version: "0.1.0" });
  for (const name of TOOL_NAMES) {
    const schema = ToolInputs[name];
    server.registerTool(name, { description: DESCRIPTIONS[name], inputSchema: schema.shape }, async (args: Record<string, unknown>) => {
      const result = await tools.call(session, name, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !!result.error };
    });
  }
  return server;
}

export function mountMcp(app: Express, toolsOrFactory: GatewayTools | ((req: Request) => GatewayTools), secret: string, path = "/mcp") {
  const handle = async (req: Request, res: Response) => {
    const token = /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1];
    const session = token ? verifySessionToken(secret, token) : null;
    if (!session) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "invalid or expired session token" }, id: null });
    // Stateless: a fresh server + transport per request, bound to this session's case.
    const tools = typeof toolsOrFactory === "function" ? toolsOrFactory(req) : toolsOrFactory;
    const server = buildServer(tools, session);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post(path, express.json({ limit: "200kb" }), (req, res) => { handle(req, res).catch(err => { console.error(err); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }); }); });
  const notAllowed = (_req: Request, res: Response) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null });
  app.get(path, notAllowed);
  app.delete(path, notAllowed);
}
