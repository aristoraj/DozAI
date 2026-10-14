# To discuss: per-customer connections (WhatsApp, ZoLabs, MCP)

Status: brainstorm, nothing built yet. Written to pick up in the next session.

## The goal
Today every connection is one global setting for the whole platform (one EdZola Interakt account, one shared ZoLabs sign-in). In production each customer should connect their own accounts, so messages go out from their own WhatsApp number and calls from their own ZoLabs account, the way each Zoho product has its own MCP link in Claude Connectors.

## The idea: a Connections layer
A Connections page per customer. Each connection has a type (WhatsApp, voice, later SMS and email), a provider (Interakt, Meta Cloud API, ZoLabs), encrypted credentials stored per customer, a status (connected, needs sign-in, failing, off), and a Test button with no side effects.
The code asks "send this for customer X" and gets the right adapter. The channel and voice interfaces already exist, so this is mostly wiring.

## WhatsApp: decision so far
Chosen direction: **Meta WhatsApp Cloud API with Embedded Signup** (self-serve, long term). The customer clicks "Connect WhatsApp", signs in with Facebook in a popup, picks their number, and DozAI stores their account id, number id and token.
Interim for the pilot: **staff paste a token** (no Meta review wait), if the pilot customers already have a verified Meta Business account.

### What we need from you (Meta side, only EdZola admins can do)
1. A Meta Business account for EdZola.
2. Business verification (company documents; usually the slowest step, days to weeks).
3. A Meta developer account and one Meta app of type Business with the WhatsApp product; all customers connect through it.
4. Tech Provider registration and app review for the WhatsApp permissions. Meta asks for a screen recording of how DozAI uses WhatsApp, a privacy policy URL, a terms URL, an app icon, a data-deletion URL, and a verified domain.
5. An Embedded Signup configuration (gives a configuration id).
6. A payment arrangement: normally each customer adds their own payment method to their WhatsApp account and Meta bills them directly.
7. A stable HTTPS domain for the sign-in popup (a custom domain is better than the long Catalyst address).

Check Meta's current rules, review times and fees when starting; they change.

### What stays private
Safe to share in chat: Meta App ID, configuration id, domain.
Never paste into chat or Claude: the App Secret, access tokens, the webhook verify token. Put those into Catalyst environment settings directly (the EdZola policy forbids secrets in chats). We will agree the exact variable names.

### What we build once the above exists
- "Connect WhatsApp" button and the Embedded Signup flow; credentials saved encrypted per customer.
- A webhook endpoint per customer, with Meta's verification handshake and signature checks.
- A Meta channel adapter behind the existing channel interface, and a sync of the customer's approved templates (a mission's template name is looked up per connection).
- The Connections page: status, Test, Disconnect, who connected it and when.
- A fake Meta API for tests, and the data-deletion endpoint Meta requires.
The interviews, campaigns and agent do not change.

## Voice (ZoLabs)
Each customer signs in to ZoLabs from the Connections page (OAuth, as done for the pilot account). Their renewing token is stored under their customer, with the existing single-use-token handling. Forms are published into their ZoLabs account.

## DozAI as an MCP server
Give each customer its own MCP URL (the existing gateway, scoped to their data) so they can add it to Claude Desktop, with the same permissions as the web app, read-only by default and writes only with an explicit scope.

## Reliability
- Timeouts, and retries only for things that cannot repeat (connect, reads, status). Never retry a send or a form creation without a stored idempotency key.
- A circuit breaker per connection: after repeated failures that customer's sending pauses and shows "needs attention"; one customer's outage cannot block another.
- A scheduled health check per connection, shown before a campaign starts.
- Per-customer daily caps and pace, because each WhatsApp number has its own quality rating.
- A simulated twin of each provider so every flow is testable without real accounts.
- Policy: written consent and scoped credentials before connecting to a client's system; record who connected and when; a Disconnect button.

## Phases
1. Connections store and page (customer-scoped, encrypted credentials, test, status); move Interakt and ZoLabs onto it as default connections so nothing breaks.
2. Per-customer webhooks and routing (replaces the account-wide Interakt webhook).
3. Customer-owned ZoLabs sign-in (OAuth per customer).
4. Customer-owned Interakt key (pilot), then the Meta Cloud API adapter with Embedded Signup.
5. Per-customer MCP URL for Claude Desktop, then the health and circuit-breaker layer.

## Open questions for the discussion
1. Do the pilot customers already have a verified Meta Business account? (Decides whether the staff-paste interim is realistic.)
2. Do they want to use an existing WhatsApp number or a new one? (An existing number needs extra care.)
3. Can customers connect themselves from day one, or do EdZola staff set it up at first?
4. Is one shared database with a customer id enough isolation, or do some clients need separate data?
5. Who pays Meta: each customer directly, or EdZola and re-bill?
6. Start the Meta business verification now, since it has the longest wait?
