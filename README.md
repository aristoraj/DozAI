# DozAI Core

Reusable mission platform on Zoho Catalyst. First mission: post-program placement and retention tracer.
Design: [ARCHITECTURE.md](ARCHITECTURE.md). Product baseline: the Core Team Walkthrough PDF.

## Run locally

```bash
npm install
npm run dev        # API + MCP on :3001, web on :5173 (open http://localhost:5173)
npm test           # 26 tests: state machine, policy, tool gateway, ledger, agent flow
npm run typecheck
npm run build:cloud   # bundles functions/core_api and appsail/mcp-gateway for Catalyst
```

Everything runs on **synthetic data** (12 sample cases). Do not load real participant data in development.

## Layout

| Path | What it is |
|---|---|
| `packages/contracts` | zod schemas: enums, ledger events, MCP tool inputs, API shapes |
| `packages/domain` | pure case state machine and contact policy |
| `packages/core` | store port (+ in-memory), hash-chained ledger, `CaseService`, `GatewayTools`, session tokens, seed |
| `packages/adapters` | fake WhatsApp channel and scripted agent (stands in for Claude in Sprint 1A) |
| `functions/core_api` | Catalyst Advanced I/O function (Express): cases, review, audit, sessions |
| `appsail/mcp-gateway` | Catalyst AppSail: MCP server over Streamable HTTP, Bearer session tokens |
| `apps/web` | operator UI (ported prototype, now API-backed) |
| `scripts/dev-server.ts` | local API + gateway on one in-memory store |

### Web app files (`apps/web`)

| File | What it does |
|---|---|
| `index.html` | The page shell: sidebar, top bar, and empty containers the app fills in |
| `src/main.js` | All screens and actions. Draws HTML from API data and handles clicks |
| `src/select.js` | Custom dropdowns. Styles every `<select>` automatically, keeping the real one hidden inside (why: [docs/decisions.md](docs/decisions.md)) |
| `src/number.js` | Custom number fields. Hides the browser's arrows and adds "−" and "+" buttons around the real input |
| `src/file.js` | Custom file picker. A styled button and the file name, with the real input hidden inside |
| `src/dashboard.js` | The Command centre's mission filter: which cases a mission keeps, the counting rules (the same as the server's summary), and the small motion that eases the numbers, bars and donut into place |
| `src/busy.js` | The loading behaviour for the whole app: holds the button that was just pressed (spinner, no double press), the bar along the top for slow work, and the spinner markup for areas waiting for data |
| `src/questions.js` | The question editor: one card per question showing WhatsApp and phone wording, with Edit, Remove and Add. The changes it makes to a mission are plain functions, tested on their own |
| `src/styles.css` | All styling: colours and the type scale at the top, one look for every form field, then each screen |
| `src/ui.test.ts` | Clicks through the real page against the real API (in memory, fake data) |
| `src/busy.test.ts` | The loading rules: what is held, when the spinner and bar appear, and that everything is put back |
| `src/questions.test.ts` | Edit, remove and add rules, each result run through the server's own check |
| `src/select.test.ts`, `number.test.ts`, `file.test.ts` | Tests for the custom controls with fake data |
| `src/dashboard.test.ts` | Tests for the counting rules and the motion, with fake data |

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
