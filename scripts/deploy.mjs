// Deploy to Catalyst. Secrets come from .env.local (gitignored) and are injected into the config files
// only for the duration of the deploy, then the files are restored. Usage: node scripts/deploy.mjs [--only functions,client,appsail]
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ENV = ".env.local";
const env = Object.fromEntries((existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
if (!env.DOZAI_GATEWAY_SECRET) {
  env.DOZAI_GATEWAY_SECRET = randomBytes(32).toString("hex");
  writeFileSync(ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`Generated DOZAI_GATEWAY_SECRET and saved it to ${ENV} (gitignored).`);
}

// Generated once and kept in .env.local. Back up DOZAI_PII_KEY: without it stored phone numbers cannot be decrypted.
for (const [k, bytes] of [["DOZAI_PII_KEY", 32], ["INTERAKT_WEBHOOK_SECRET", 24], ["DOZAI_JOB_TOKEN", 24], ["ZOLABS_WEBHOOK_SECRET", 24]]) {
  if (!env[k]) {
    env[k] = k === "DOZAI_PII_KEY" ? randomBytes(bytes).toString("base64") : randomBytes(bytes).toString("hex"); // 24 bytes -> 48 hex chars
    writeFileSync(ENV, Object.entries(env).map(([a, b]) => `${a}=${b}`).join("\n") + "\n");
    console.log(`Generated ${k} and saved it to ${ENV} (gitignored).`);
  }
}

// Per-target environment, taken from .env.local. Nothing risky is switched on by default: to test outside the contact
// window set DOZAI_DEMO_WINDOW=1, and to wipe a development project set DOZAI_ALLOW_PURGE=1, both only in .env.local.
// The one-time user-invite route stays off because DOZAI_BOOTSTRAP_TOKEN is not deployed.
const targets = [
  { file: "app-config.json", secrets: ["DOZAI_GATEWAY_SECRET", "DOZAI_DEMO_WINDOW"], fixed: { DOZAI_STORE: "catalyst" } },
  { file: "functions/cron_tick/catalyst-config.json", nest: "deployment", fixed: {}, secrets: ["DOZAI_JOB_TOKEN", "DOZAI_TICK_URL"] },
  { file: "functions/core_api/catalyst-config.json", nest: "deployment", fixed: { DOZAI_STORE: "catalyst" }, secrets: ["DOZAI_ROLES", "ANTHROPIC_API_KEY", "DOZAI_MODEL", "DOZAI_PII_KEY", "INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET", "DOZAI_WHATSAPP", "DOZAI_PROGRAMME_NAME", "DOZAI_JOB_TOKEN", "INTERAKT_TEMPLATE_MAP", "DOZAI_DEMO_WINDOW", "DOZAI_ALLOW_PURGE", "DOZAI_ALLOW_DRAFT_INSTRUMENT", "DOZAI_CLASSIFIER", "DOZAI_CLASSIFIER_MODEL", "ZOLABS_MCP_URL", "ZOLABS_ACCESS_TOKEN", "ZOLABS_CLIENT_ID", "ZOLABS_REFRESH_TOKEN", "ZOLABS_TOKEN_URL", "ZOLABS_API_URL", "ZOLABS_ALLOW_CALLS", "ZOLABS_WEBHOOK_SECRET", "DOZAI_PUBLIC_URL"] },
];
const originals = new Map();
try {
  for (const t of targets) {
    const raw = readFileSync(t.file, "utf8");
    originals.set(t.file, raw);
    const json = JSON.parse(raw);
    const holder = t.nest ? json[t.nest] : json;
    holder.env_variables = { ...holder.env_variables, ...t.fixed, ...Object.fromEntries(t.secrets.filter(v => env[v]).map(v => [v, env[v]])) };
    writeFileSync(t.file, JSON.stringify(json, null, 2) + "\n");
  }
  execSync("npm run build && npm run build:cloud", { stdio: "inherit" });
  // Refuse to deploy a bundle that cannot even load (this caught the SDK/esbuild strict-mode problem).
  execSync(`node -e "require('./functions/core_api/index.js')"`, { stdio: "inherit" });
  const extra = process.argv.slice(2).join(" ");
  execSync(`catalyst deploy ${extra}`, { stdio: "inherit", env: { ...process.env, ZCATALYST_NON_INTERACTIVE: "1" } });
} finally {
  for (const [file, raw] of originals) writeFileSync(file, raw);
}
