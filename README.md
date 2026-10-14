# DozAI Core

Reusable mission platform on Zoho Catalyst. First mission: post-program placement and retention tracer.
Design: [ARCHITECTURE.md](ARCHITECTURE.md). Product baseline: the Core Team Walkthrough PDF.

## Run locally

```bash
npm install
npm run dev        # API + MCP on :3001, web on :5173 (open http://localhost:5173)
npm test           # every test: state machine, policy, tool gateway, ledger, agent flow, the web app
npm run typecheck
npm run build:cloud   # bundles backend/functions/core_api and backend/appsail/mcp-gateway for Catalyst
```

Everything runs on **synthetic data** (12 sample cases). Do not load real participant data in development.

**What works locally, with nothing reaching a real person:** the whole app on an in-memory store (restarting the API resets it). WhatsApp is simulated: open a case and type a participant reply, or pick a scenario. Phone calls go to a simulator: publish the phone form on the Mission page, press **Request a phone call** on a case, approve it on the Approvals page, then use the case page's simulator buttons to finish the call as a person who answered, did not answer, refused, or was the wrong person. Create a mission, sign off its wording, use the Controls tab and the kill switch, and delete an unused mission, all against the local store.

**The agent:** by default a script, so no key and no cost. To try the real agent and Mission Studio drafting, start the API with `USE_CLAUDE=1 npm run dev:api` (or put `USE_CLAUDE=1` in `.env.dev-local`). It reads `ANTHROPIC_API_KEY` from `.env.local` and costs a few cents a run. It still never messages or calls anyone.

**Real WhatsApp from your computer** (receiving real replies through ngrok) is covered step by step in [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md). In short: keys go in `.env.local` (deploy also reads it), local-only settings go in `.env.dev-local` (deploy never reads it), and the one switch that turns real sending on, `DOZAI_LOCAL_WHATSAPP=1`, is read only from `.env.dev-local`. Real WhatsApp starts with no made-up cohort, and Interakt's webhook is account-wide, so read the warning there first.

**Before every push:** `npm run typecheck && npm test`. What cannot be tested locally is the real WhatsApp provider, the real ZoLabs calls, the Catalyst database and the cron schedule: check those on DozAI-Dev after a deploy.

## Layout

The project has two halves, **frontend** (what people see) and **backend** (what runs on the server), plus the files that tie them together.

| Path | What it is |
|---|---|
| `frontend/` | The operator web app (plain JavaScript + Vite). Map of its folders: [frontend/README.md](frontend/README.md) |
| `backend/functions/core_api` | Catalyst Advanced I/O function (Express): the API. One file per area under `src/routes/` |
| `backend/functions/cron_tick` | Catalyst Cron function that calls the scheduler route |
| `backend/appsail/mcp-gateway` | Catalyst AppSail: MCP server over Streamable HTTP, Bearer session tokens |
| `backend/packages/contracts` | zod schemas: enums, ledger events, MCP tool inputs, API shapes |
| `backend/packages/domain` | pure case state machine and contact policy |
| `backend/packages/core` | the business rules, grouped by subject (missions, conversation, agent, storage, cases) |
| `backend/packages/adapters` | the outside world: Interakt WhatsApp, ZoLabs calls, Claude, and the fake versions used in tests |
| `backend/packages/catalyst` | Catalyst-specific pieces: the data store, sign-in |
| `scripts/` | local dev server, deploy and bundle scripts |
| `docs/` | decisions, challenges, runbooks and the project plan |

More detail on the backend folders: [backend/README.md](backend/README.md).

Where things go: a new screen goes in `frontend/src/pages/`, a reusable piece of UI in `frontend/src/components/`, a new API route in `backend/functions/core_api/src/routes/`, and a new business rule in the matching folder of `backend/packages/core/src/`. The folder names `core_api`, `cron_tick` and `mcp-gateway` are part of the public web addresses, so do not rename them.

## Status

Live-application pass done (see [docs/AUDIT.md](docs/AUDIT.md) for every finding and what is still open).

Working and tested (106 tests, including a browser-style test of the real UI):
- No demo data in the cloud app. Real participants are loaded from CSV; numbers are encrypted and matched by keyed hash.
- Delete case erases personal data and keeps an anonymous audit stub.
- Case status and outcome are separate; every status change goes through `transitionCase`; hash-chained audit ledger with verification.
- 8 tools for the agent with case binding, idempotency, version checks, approved-template list, contact window, attempt cap, opt-out.
- Conversation after consent: approved question flow, reply handling, escalation (docs/CONVERSATION.md).
- Real Claude agent (`DOZAI_MODEL`, default `claude-sonnet-5-5`) or a scripted stand-in when no key is set.
- Interakt WhatsApp: send, signed webhook, reply handling, opt-out. Off by default (`DOZAI_WHATSAPP`).
- Catalyst sign-in mapped to roles by `DOZAI_ROLES`.

Not done: see "Still open" in docs/AUDIT.md. The big ones: the real 34 questions, the scheduler, the Interakt template approval, voice.

## Deploy

```bash
node scripts/deploy.mjs          # builds, injects secrets from .env.local, deploys, restores the config files
```

`.env.local` (gitignored) holds the keys and switches. Nothing risky is on by default: `DOZAI_DEMO_WINDOW=1` opens the contact window 24h for out-of-hours testing, `DOZAI_ALLOW_PURGE=1` shows a guarded "Delete ALL data" button (development projects only), `DOZAI_WHATSAPP=interakt` turns real sending on.

## Catalyst

Project `DozAI-Dev` (id 36235000000024365), US data centre, Development environment, created from IaC so the `dozai_docs` table and hosted login exist already.
URLs: web https://dozai-dev-893409434.development.catalystserverless.com/app/index.html, API `/server/core_api/api/*` on the same host, gateway https://dozai-mcp-gateway-10135585515.development.catalystappsail.com.
The earlier empty project `Project-Rainfall` (and a project named `Test`, not created by this repo) can be deleted in the console.

WhatsApp: see [docs/WHATSAPP.md](docs/WHATSAPP.md). Data Store: [docs/DATASTORE.md](docs/DATASTORE.md) (now created by the IaC import).
