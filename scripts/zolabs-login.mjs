// One-time sign-in to ZoLabs, so the deployed server can stay signed in by itself.
//
//   node scripts/zolabs-login.mjs
//
// It opens ZoLabs in your browser. Sign in with the ZoLabs account the calls should be made as, and approve. The script
// then saves ZOLABS_CLIENT_ID and ZOLABS_REFRESH_TOKEN into .env.local (which is not in git) and prints nothing secret.
// Afterwards run: node scripts/deploy.mjs --only functions
// Calls will be made as the account that signs in here, so use the account the programme should be billed to.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";

const ENV = ".env.local";
const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const MCP_URL = process.env.ZOLABS_MCP_URL || readEnv().ZOLABS_MCP_URL || "https://qurateai-mcp-edzola.onrender.com/mcp";

function readEnv() {
  return Object.fromEntries((existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
function saveEnv(values) {
  const env = readEnv();
  Object.assign(env, values);
  writeFileSync(ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}
const b64url = b => Buffer.from(b).toString("base64url");
const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} answered ${r.status}`); return r.json(); };

// 1. Find out where ZoLabs signs people in (the server publishes this).
const origin = new URL(MCP_URL).origin;
const resource = await getJson(`${origin}/.well-known/oauth-protected-resource${new URL(MCP_URL).pathname}`);
const issuer = String(resource.authorization_servers?.[0] ?? "").replace(/\/$/, "");
if (!issuer) throw new Error("ZoLabs did not say where to sign in");
const meta = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
if (!meta.registration_endpoint || !meta.authorization_endpoint || !meta.token_endpoint) throw new Error("ZoLabs sign-in is not set up the way this script expects");

// 2. Register this program once. It is a public client: no secret, protected by a one-time code challenge instead.
const reg = await fetch(meta.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "DozAI", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "qurate:access" }),
});
const client = await reg.json().catch(() => ({}));
if (!reg.ok || !client.client_id) throw new Error(`Registration was refused (${reg.status}): ${JSON.stringify(client).slice(0, 200)}`);

// 3. Ask the person to sign in.
const verifier = b64url(randomBytes(32));
const state = b64url(randomBytes(16));
const url = new URL(meta.authorization_endpoint);
url.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: "qurate:access", state, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: MCP_URL }).toString();

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { server.close(); reject(new Error("Timed out after 5 minutes without a sign-in")); }, 5 * 60_000);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", REDIRECT);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const fail = msg => { res.writeHead(400, { "content-type": "text/plain" }).end(msg); clearTimeout(timer); server.close(); reject(new Error(msg)); };
    if (u.searchParams.get("error")) return fail(`ZoLabs said: ${u.searchParams.get("error")}`);
    if (u.searchParams.get("state") !== state) return fail("The sign-in answer did not match this request. Try again.");
    res.writeHead(200, { "content-type": "text/html" }).end("<h2>Signed in to ZoLabs.</h2><p>You can close this tab and go back to the terminal.</p>");
    clearTimeout(timer); server.close(); resolve(u.searchParams.get("code"));
  }).listen(PORT, "127.0.0.1", () => {
    console.log("Opening ZoLabs in your browser. If nothing opens, paste this address into a browser:\n\n" + url.toString() + "\n");
    exec(process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`);
  });
});

// 4. Trade the one-time code for tokens.
const tok = await fetch(meta.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }).toString(),
});
const t = await tok.json().catch(() => ({}));
if (!tok.ok || !t.access_token) throw new Error(`ZoLabs would not give a token (${t.error ?? tok.status})`);
if (!t.refresh_token) throw new Error("ZoLabs gave no long-lived token, so the server could not renew its own sign-in. Tell the team: this needs ZoLabs to allow refresh tokens for this client.");

// ZOLABS_PROBE_TOKEN is the short-lived access token, for read-only experiments from this machine. It is not deployed. Never
// experiment with ZOLABS_REFRESH_TOKEN itself: ZoLabs lets each refresh token be used once, so using it up here would lock the server out.
saveEnv({ ZOLABS_MCP_URL: MCP_URL, ZOLABS_CLIENT_ID: client.client_id, ZOLABS_REFRESH_TOKEN: t.refresh_token, ZOLABS_PROBE_TOKEN: t.access_token });
console.log(`Signed in. Saved ZOLABS_CLIENT_ID and ZOLABS_REFRESH_TOKEN to ${ENV} (not in git).\nNext: node scripts/deploy.mjs --only functions, then open Phone calls in DozAI and press "Check connection".`);
