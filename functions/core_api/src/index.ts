// Catalyst Advanced I/O entry. Bundled to ../index.js by scripts/bundle.mjs.
//
// Store:    DOZAI_STORE=catalyst uses the Data Store table `dozai_docs` (docs/DATASTORE.md); otherwise in-memory.
// Auth:     the signed-in Catalyst user is mapped to a role by DOZAI_ROLES, e.g. {"you@edzola.com":"admin"}.
//           Anyone not listed gets 403. Header auth (DOZAI_DEV_AUTH=1) is for local development only.
// WhatsApp: DOZAI_WHATSAPP=interakt plus INTERAKT_API_KEY. Anything else = off (simulated replies).
// Agent:    real Claude when ANTHROPIC_API_KEY is set, unless DOZAI_AGENT=scripted.
// Replies:  rules by default. DOZAI_CLASSIFIER=claude also lets a model read replies the rules cannot place (this sends
//           participant text to the model: a data-policy decision).
// Phone calls: ZOLABS_MCP_URL + ZOLABS_ACCESS_TOKEN switch on the ZoLabs channel. No real call is placed unless ZOLABS_ALLOW_CALLS=1 AND
//          the person has consented and it is inside contact hours. ZOLABS_WEBHOOK_SECRET + DOZAI_PUBLIC_URL build the callback address.
// Draft questionnaire: used on real conversations only when DOZAI_ALLOW_DRAFT_INSTRUMENT=1 (development and testing).
import type { Request } from "express";
import { DEFAULT_POLICY, type ContactPolicy } from "@dozai/domain";
import { CaseService, ConversationRunner, DozaiError, GatewayTools, InMemoryStore, RuleClassifier, normalizeMsisdn, seedDemo, DEMO_TENANT } from "@dozai/core";
import { ClaudeAgentRuntime, ClaudeReplyClassifier, DEFAULT_MODEL, FakeVoice, ClaudeMissionDrafter, InteraktChannels, RefreshingToken, ScriptedAgentRuntime, ZOLABS_API_URL, ZolabsVoice, mcpOverHttp, restOverHttp } from "@dozai/adapters";
import { currentUserEmail, inviteUser, serviceFor } from "@dozai/catalyst";
import { ROLES, type Principal, type Role } from "@dozai/contracts";
import { createApp, type RequestContext } from "./app";

const env = process.env;
const devAuth = env.DOZAI_DEV_AUTH === "1";
const useCatalyst = env.DOZAI_STORE === "catalyst";
const tenant = env.DOZAI_TENANT ?? DEMO_TENANT;

// Contact window. Live default is 09:30-18:00 IST. DOZAI_DEMO_WINDOW=1 opens it 24h for out-of-hours testing only.
const openWindow = env.DOZAI_DEMO_WINDOW === "1" || devAuth;
const policy: ContactPolicy = openWindow ? { ...DEFAULT_POLICY, windowStartHour: 0, windowEndHour: 24 } : DEFAULT_POLICY;
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
const contactWindow = openWindow ? "24 hours (testing override)" : `${hhmm(policy.windowStartHour)}-${hhmm(policy.windowEndHour)} IST`;

let roles: Record<string, Role> = {};
try { roles = JSON.parse(env.DOZAI_ROLES ?? "{}"); } catch { console.error("DOZAI_ROLES is not valid JSON; nobody can sign in"); }

const piiKey = env.DOZAI_PII_KEY;
const defaultCc = env.INTERAKT_DEFAULT_CC ?? "91";
const webhookSecret = env.INTERAKT_WEBHOOK_SECRET;
const jsonOr = <T>(s: string | undefined): T | undefined => { try { return s ? (JSON.parse(s) as T) : undefined; } catch { console.error("a JSON setting is invalid and was ignored"); return undefined; } };

const liveChannel = env.DOZAI_WHATSAPP === "interakt" && env.INTERAKT_API_KEY && piiKey
  ? new InteraktChannels({
      apiKey: env.INTERAKT_API_KEY, piiKey, webhookSecret, defaultCountryCode: defaultCc,
      templateOverrides: jsonOr(env.INTERAKT_TEMPLATE_MAP), programmeName: env.DOZAI_PROGRAMME_NAME,
    })
  : undefined;
// Phone calls
const hookSecret = env.ZOLABS_WEBHOOK_SECRET && env.ZOLABS_WEBHOOK_SECRET.length >= 24 ? env.ZOLABS_WEBHOOK_SECRET : undefined;
const publicUrl = env.DOZAI_PUBLIC_URL?.replace(/\/$/, "");
const fakeVoice = new FakeVoice(); // local development only: nobody is rung
// Signed in to ZoLabs one of two ways: a fixed token (short-lived, for trying things), or the one-time sign-in from
// scripts/zolabs-login.mjs (ZOLABS_CLIENT_ID + ZOLABS_REFRESH_TOKEN), which the server renews by itself.
const zolabsAuth = piiKey && env.ZOLABS_CLIENT_ID && env.ZOLABS_REFRESH_TOKEN
  ? new RefreshingToken({ clientId: env.ZOLABS_CLIENT_ID, refreshToken: env.ZOLABS_REFRESH_TOKEN, piiKey, tokenUrl: env.ZOLABS_TOKEN_URL })
  : undefined;
const zolabsToken = zolabsAuth ?? env.ZOLABS_ACCESS_TOKEN; // the self-renewing sign-in wins over a fixed token, which would expire
const voice = piiKey && env.ZOLABS_MCP_URL && zolabsToken
  ? {
      port: new ZolabsVoice(mcpOverHttp(env.ZOLABS_MCP_URL, zolabsToken), restOverHttp(env.ZOLABS_API_URL ?? ZOLABS_API_URL, zolabsToken)),
      cfg: { piiKey, callsEnabled: env.ZOLABS_ALLOW_CALLS === "1", defaultProgramme: env.DOZAI_PROGRAMME_NAME },
      tenant, webhookSecret: hookSecret, callbackUrl: publicUrl && hookSecret ? `${publicUrl}/api/webhooks/zolabs/${hookSecret}` : undefined,
    }
  : devAuth ? { port: fakeVoice, cfg: { piiKey: piiKey ?? "", callsEnabled: true }, tenant } : undefined;
const useClaude = !!env.ANTHROPIC_API_KEY && env.DOZAI_AGENT !== "scripted";
const useModelClassifier = useClaude && env.DOZAI_CLASSIFIER === "claude";
const allowDraft = env.DOZAI_ALLOW_DRAFT_INSTRUMENT === "1" || devAuth;

// Local, in-memory mode only: start with a clearly synthetic cohort so the UI has something to show.
const memory = new InMemoryStore();
const memorySvc = new CaseService(memory, () => new Date(), policy);
if (devAuth && !useCatalyst) void seedDemo(memory);

const forRequest = (req: Request): RequestContext => {
  const svc = useCatalyst ? serviceFor(req, policy) : memorySvc;
  svc.voiceEnabled = !!voice;
  zolabsAuth?.attach(svc.store); // a renewed sign-in token is kept in the database, so every copy of the server shares it
  if (openWindow) svc.forceWindow = { windowStartHour: 0, windowEndHour: 24 }; // testing override beats every mission's own window
  const tools = new GatewayTools(svc);
  const rules = new RuleClassifier();
  return {
    svc,
    agent: useClaude ? new ClaudeAgentRuntime(tools, { live: liveChannel }) : new ScriptedAgentRuntime(tools),
    runner: new ConversationRunner(svc, { classifier: useModelClassifier ? new ClaudeReplyClassifier(rules) : rules, allowDraft }),
  };
};

async function resolvePrincipal(req: Request): Promise<Principal | null> {
  const email = await currentUserEmail(req);
  if (!email) return null;
  const role = roles[email];
  if (!role || !ROLES.includes(role)) throw new DozaiError("FORBIDDEN", `${email} has no DozAI role. Ask an admin to add it.`, 403);
  return { user_id: email, tenant_id: tenant, role };
}

export default createApp({
  forRequest, devAuth, resolvePrincipal,
  pii: piiKey ? { key: piiKey, defaultCountryCode: defaultCc } : undefined,
  runtime: { whatsapp: liveChannel ? "live" : "off", agent: useClaude ? "claude" : "scripted", model: useClaude ? env.DOZAI_MODEL ?? DEFAULT_MODEL : null, contact_window: contactWindow, window_forced: openWindow, classifier: useModelClassifier ? "claude" : "rules", draft_instrument_allowed: allowDraft },
  allowPurge: env.DOZAI_ALLOW_PURGE === "1",
  jobToken: env.DOZAI_JOB_TOKEN && env.DOZAI_JOB_TOKEN.length >= 32 ? env.DOZAI_JOB_TOKEN : undefined,
  bootstrap: env.DOZAI_BOOTSTRAP_TOKEN && env.DOZAI_BOOTSTRAP_TOKEN.length >= 32 ? { token: env.DOZAI_BOOTSTRAP_TOKEN, emails: Object.keys(roles), invite: inviteUser } : undefined,
  voice,
  drafter: useClaude ? new ClaudeMissionDrafter() : undefined,
  interakt: piiKey && webhookSecret ? { webhookSecret, piiKey, tenant, channel: liveChannel, defaultCountryCode: defaultCc } : undefined,
});
