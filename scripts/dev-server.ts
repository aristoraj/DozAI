// Local development: core API + MCP gateway on one in-memory store. Auth is header-based and dev only.
//
// By default NOTHING here can reach a real person: the store holds a made-up cohort, WhatsApp is simulated (type a reply on the case
// page) and phone calls go to a simulator. The default agent is a script, so there is no key and no cost.
//
// Two env files, both gitignored. .env.local holds the keys and is also what deploy reads. .env.dev-local holds settings that exist only
// for this computer and is never read by deploy; it overrides .env.local. The two switches below are read ONLY from .env.dev-local (or
// the shell), never from .env.local, so a deploy file can never turn real sending on for a local run by accident. Keys come from either
// file. Both are read once, at startup: restart the API after changing them.
//   USE_CLAUDE=1               the real agent and Mission Studio drafting (a few cents a run; still messages nobody)
//   DOZAI_LOCAL_WHATSAPP=1     REAL WhatsApp from this computer through Interakt. Messages go to the numbers you import. The made-up
//                              cohort is NOT loaded, so no made-up number can ever be messaged. Needs INTERAKT_API_KEY,
//                              INTERAKT_WEBHOOK_SECRET and ANTHROPIC_API_KEY. Replies only arrive if Interakt's webhook points at this
//                              computer (see README, "Real WhatsApp from your computer").
import { readFileSync, existsSync } from "node:fs";
import { createApp } from "../functions/core_api/src/app";
import { mountMcp } from "../appsail/mcp-gateway/src/server";
import { DEFAULT_POLICY } from "@dozai/domain";
import { CaseService, ConversationRunner, DEMO_TENANT, GatewayTools, InMemoryStore, RuleClassifier, seedDemo } from "@dozai/core";
import { ClaudeAgentRuntime, ClaudeMissionDrafter, ClaudeReplyClassifier, FakeVoice, InteraktChannels, ScriptedAgentRuntime } from "@dozai/adapters";

const PII_KEY = Buffer.alloc(32, 7).toString("base64"); // a fixed key: local numbers live in memory only and are lost on restart

const readEnvFile = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const l of readFileSync(path, "utf8").split(/\r?\n/)) { const t = l.trim(); const i = t.indexOf("="); if (t && !t.startsWith("#") && i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim(); }
  return out;
};
const keysFile = readEnvFile(".env.local"), devLocal = readEnvFile(".env.dev-local");
/** A key or other setting: the shell, then .env.dev-local, then .env.local. */
const setting = (name: string): string | undefined => process.env[name] ?? (devLocal[name] || keysFile[name] || undefined);
/** A switch that changes what this computer is allowed to do: the shell or .env.dev-local only, never the file deploy reads. */
const flag = (name: string): string | undefined => process.env[name] ?? (devLocal[name] || undefined);

const store = new InMemoryStore();
const svc = new CaseService(store, () => new Date(), { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 });
svc.voiceEnabled = true;
const tools = new GatewayTools(svc);
const voice = new FakeVoice();

// Real WhatsApp from this computer: only when asked for, and only when everything it needs is present.
let channel: InteraktChannels | undefined;
const wantWhatsApp = flag("DOZAI_LOCAL_WHATSAPP") === "1";
if (wantWhatsApp) {
  const missing = ["INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"].filter(k => !setting(k));
  if (missing.length) console.log(`DOZAI_LOCAL_WHATSAPP=1 was set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing: WhatsApp stays simulated.`);
  else {
    process.env.ANTHROPIC_API_KEY = setting("ANTHROPIC_API_KEY");
    let overrides: ConstructorParameters<typeof InteraktChannels>[0]["templateOverrides"];
    try { overrides = setting("INTERAKT_TEMPLATE_MAP") ? JSON.parse(setting("INTERAKT_TEMPLATE_MAP")!) : undefined; } catch { console.log("INTERAKT_TEMPLATE_MAP is not valid JSON and was ignored."); }
    channel = new InteraktChannels({ apiKey: setting("INTERAKT_API_KEY")!, piiKey: PII_KEY, webhookSecret: setting("INTERAKT_WEBHOOK_SECRET"), defaultCountryCode: setting("INTERAKT_DEFAULT_CC") ?? "91", templateOverrides: overrides, programmeName: setting("DOZAI_PROGRAMME_NAME") });
  }
}

// The real agent: when asked for, and always when WhatsApp is live (a script cannot take part in a real conversation).
let useClaude = false;
if (flag("USE_CLAUDE") === "1" || channel) {
  if (!process.env.ANTHROPIC_API_KEY && setting("ANTHROPIC_API_KEY")) process.env.ANTHROPIC_API_KEY = setting("ANTHROPIC_API_KEY");
  useClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!useClaude) console.log("USE_CLAUDE=1 was set but no ANTHROPIC_API_KEY was found: using the scripted agent.");
}

async function main() {
  if (!channel) await seedDemo(store); // with real WhatsApp, no made-up number may ever be messaged: start empty
  const app = createApp({
    forRequest: () => ({ svc, agent: useClaude ? new ClaudeAgentRuntime(tools, { live: channel }) : new ScriptedAgentRuntime(tools), runner: new ConversationRunner(svc, { classifier: useClaude ? new ClaudeReplyClassifier(new RuleClassifier()) : new RuleClassifier(), allowDraft: true }) }),
    devAuth: true,
    pii: { key: PII_KEY, defaultCountryCode: "91" },
    voice: { port: voice, cfg: { piiKey: PII_KEY, callsEnabled: true }, tenant: DEMO_TENANT },
    drafter: useClaude ? new ClaudeMissionDrafter() : undefined,
    interakt: channel ? { webhookSecret: setting("INTERAKT_WEBHOOK_SECRET")!, piiKey: PII_KEY, tenant: DEMO_TENANT, channel, defaultCountryCode: setting("INTERAKT_DEFAULT_CC") ?? "91" } : undefined,
    runtime: { whatsapp: channel ? "live" : "off", agent: useClaude ? "claude" : "scripted", model: useClaude ? (process.env.DOZAI_MODEL ?? "claude-sonnet-5-5") : null, contact_window: "24 hours (local development)" },
  });
  mountMcp(app, tools, process.env.DOZAI_GATEWAY_SECRET ?? "dev-only-secret-dev-only-secret-0000");

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    console.log(`DozAI dev API  http://localhost:${port}/api/health   MCP http://localhost:${port}/mcp   agent: ${useClaude ? "Claude" : "scripted"}   calls: simulator   WhatsApp: ${channel ? "LIVE" : "simulated"}`);
    if (channel) console.log(`\n  !! WhatsApp is LIVE from this computer. Messages go to real numbers you import (the made-up cohort was not loaded).\n  !! The store is in memory: restarting forgets every case and every conversation.\n  !! Replies arrive only if Interakt's webhook points at this computer: http://localhost:${port}/api/webhooks/interakt through a tunnel.\n  !! That webhook is the same one the deployed app uses. Point it back when you finish.\n`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
