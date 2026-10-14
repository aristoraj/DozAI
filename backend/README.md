# Backend

Everything that runs on the server.

| Path | What it is |
|---|---|
| `functions/core_api` | The API (Express). `src/app.ts` lists the route groups in the order they are registered; the routes are in `src/routes/` |
| `functions/cron_tick` | Calls the scheduler route on a timer |
| `appsail/mcp-gateway` | The MCP server the agent uses |
| `packages/` | Shared code. The functions and gateway are bundled with it for Catalyst |

The names `core_api`, `cron_tick` and `mcp-gateway` are part of the public web addresses (for example `/server/core_api/api` and the webhooks). Do not rename them.

## The API (`functions/core_api/src`)

| File | What it does |
|---|---|
| `app.ts` | Builds the app. Order matters: the self-authenticating routes first, then the sign-in check, then everything that needs a user |
| `deps.ts` | What the API is built with (store, channels, voice, settings) and what each request carries |
| `http.ts` | Who may do what (`CAN`), the error wrapper (`wrap`), the role check (`need`) |
| `auth.ts` | The sign-in check |
| `views.ts` | Turns stored records into what the screens show |
| `routes/` | `public` (health, webhooks, jobs), `identity`, `missions`, `voice`, `employees`, `approvals`, `campaigns`, `cases`, `reports`, `admin`; `case-views.ts` holds the helpers for reading cases |

When two route patterns overlap, the one registered first wins (for example `/api/campaigns/run-now` before `/api/campaigns/:id/:action`). Keep new routes in the right order, and run the tests.

## The packages

| Package | What it holds |
|---|---|
| `contracts` | zod schemas: the shapes of requests, events and tool inputs |
| `domain` | the case state machine and contact policy (pure) |
| `core` | business rules, grouped by subject, see below |
| `adapters` | Claude, Interakt WhatsApp, ZoLabs calls and the fake versions used in tests |
| `catalyst` | the Catalyst data store and sign-in |

`core/src` folders: `missions/` (the mission, its questions and requirements, the studio), `conversation/` (reading replies, the wording, the phone form), `agent/` (the employee, tools, tokens, controls, memory, wake-ups, replay), `storage/` (the store port, the document store, the ledger), `cases/` (the case service, intake, campaigns, personal data, seed data). Everything is still exported from `@dozai/core`, so other packages import it the same way as before.
