// Local development: core API + MCP gateway on one in-memory store, seeded with the synthetic cohort.
// Contact windows are opened 24h so the demo works at any hour. Auth is header-based and dev only.
import { createApp } from "../functions/core_api/src/app";
import { mountMcp } from "../appsail/mcp-gateway/src/server";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, ConversationRunner, GatewayTools, InMemoryStore, RuleClassifier, seedDemo } from "@dozai/core";
import { ScriptedAgentRuntime } from "@dozai/adapters";

const store = new InMemoryStore();
const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
const tools = new GatewayTools(svc);

async function main() {
  await seedDemo(store);
  const app = createApp({ forRequest: () => ({ svc, agent: new ScriptedAgentRuntime(tools), runner: new ConversationRunner(svc, { classifier: new RuleClassifier(), allowDraft: true }) }), devAuth: true, pii: { key: Buffer.alloc(32, 7).toString("base64"), defaultCountryCode: "91" }, runtime: { whatsapp: "off", agent: "scripted", model: null, contact_window: "24 hours (local development)" } });
  mountMcp(app, tools, process.env.DOZAI_GATEWAY_SECRET ?? "dev-only-secret-dev-only-secret-0000");

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`DozAI dev API  http://localhost:${port}/api/health   MCP http://localhost:${port}/mcp`));
}

main().catch(err => { console.error(err); process.exit(1); });
