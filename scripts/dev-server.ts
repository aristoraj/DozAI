// Local development: runs the same wiring as production (functions/core_api/src/index.ts) on an in-memory store seeded
// with the synthetic cohort. Keys come from .env.local (npm run dev:api loads it). Auth is header-based and dev only.
// WhatsApp, Claude and phone calls switch on from the keys in .env.local, exactly as they do when deployed.
process.env.DOZAI_DEV_AUTH = "1";
delete process.env.DOZAI_STORE; // local is always in-memory, never the Catalyst database

async function main() {
  const { default: app, localSvc } = await import("../functions/core_api/src/index");
  const { mountMcp } = await import("../appsail/mcp-gateway/src/server");
  const { GatewayTools } = await import("@dozai/core");
  mountMcp(app, new GatewayTools(localSvc), process.env.DOZAI_GATEWAY_SECRET ?? "dev-only-secret-dev-only-secret-0000");

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`DozAI dev API  http://localhost:${port}/api/health   MCP http://localhost:${port}/mcp`));
}

main().catch(err => { console.error(err); process.exit(1); });
