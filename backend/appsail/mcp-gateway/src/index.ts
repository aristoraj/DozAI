// AppSail entry. Reads the port from the platform (X_ZOHO_CATALYST_LISTEN_PORT on Catalyst) and the secret from env.
// DOZAI_STORE=catalyst reads and writes the Data Store (table dozai_docs); otherwise an in-memory store is used.
import express from "express";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, GatewayTools, InMemoryStore } from "@dozai/core";
import { serviceFor } from "@dozai/catalyst";
import { mountMcp } from "./server";

const secret = process.env.DOZAI_GATEWAY_SECRET;
if (!secret || secret.length < 32) {
  console.error("DOZAI_GATEWAY_SECRET (32+ chars) is required");
  process.exit(1);
}
const policy = process.env.DOZAI_DEMO_WINDOW === "1" ? { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 } : DEFAULT_POLICY;
const memory = new GatewayTools(new CaseService(new InMemoryStore(), () => new Date(), policy));
const useCatalyst = process.env.DOZAI_STORE === "catalyst";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, service: "dozai-mcp-gateway", store: useCatalyst ? "catalyst" : "memory" }));
mountMcp(app, useCatalyst ? req => new GatewayTools(serviceFor(req, policy)) : memory, secret);

const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT ?? process.env.PORT ?? 9000);
app.listen(port, () => console.log(`dozai-mcp-gateway listening on ${port}`));
