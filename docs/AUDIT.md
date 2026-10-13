# Engineering audit

A review of every module: why it exists, what was wrong, what is fixed, and what is still open. Updated with each pass.

## Pass 4: missions and campaigns

### Built

- Missions as versioned data (first message, questions, contact rules, agent notes), checked before saving, pinned to each case when it is created. See [MISSIONS_AND_CAMPAIGNS.md](MISSIONS_AND_CAMPAIGNS.md).
- Campaigns: a saved instruction (mission, cohort, daily cap, batch size) that the scheduler works through at a safe pace, with pause/resume/stop, an exact daily cap, no double messages, and an automatic pause when sends keep failing.
- Screens: Campaigns, mission picker and "Add a mission", mission choice on import, mission shown on each case.
- 50 new tests (207 in all), including overlapping schedulers, the daily cap, contact hours per mission, and a click-through of the new screens.

### Open

| # | Finding | Severity | Suggested fix |
|---|---|---|---|
| 15 | The scheduler lists every case each minute. Fine for hundreds, a bottleneck near the thousands. | High before a 10,000-person campaign | Add Data Store columns for status and mission, and query "draft cases for mission X" directly |
| 16 | The Cron schedule does not exist yet, so batches after the first need the Send next batch now button. | Manual step | Create the Cron job in the Catalyst console (every minute) |
| 17 | A first message that could not be sent leaves the case waiting, with no one-click retry. | Medium | Retry or reset action on failed first messages |
| 18 | Every mission lives in one workspace; users are not separated per client. | Decision needed | Per-client tenants and user lists |
| 19 | A mission is edited as JSON; there is no question builder. | Low for now | Builder screen once the format settles |
| 20 | WhatsApp sending limits (daily tier) are a setting the operator must get right. | Medium | Read the tier from Meta when moving to the Cloud API |

## Pass 3: the conversation

### Built

- A conversation runner that asks approved questions after consent, understands replies, and handles irrelevant replies, questions, stop, wrong person, distress and deletion requests. See [CONVERSATION.md](CONVERSATION.md).
- 30-scenario gold set plus end-to-end tests of the real webhook to send path.
- Optional, off-by-default model assist for replies the rules cannot place; closed set of intents; cannot invent options.
- Scheduler function (`cron_tick`) and a simulate-reply box for testing with WhatsApp off.
- A bare "No" now means stop only while consent is being asked, not during the interview.

### Open

- The questions are DRAFT wording; the 34-question instrument and Hindi are not signed off.
- Sending free-form WhatsApp text through Interakt is unconfirmed (their docs do not cover it). One real send will tell.
- The Cron schedule must be created once in the Catalyst console.
- Policy decisions still needed: reminders after silence, answering outside the contact window, who handles urgent escalations, whether participant text may reach a model.

## Pass 2: making it a live application

### Fixed

| Area | Problem | Fix |
|---|---|---|
| Demo data | A synthetic cohort was seeded automatically, an admin endpoint re-seeded it, and the web app fell back to hardcoded sample cases whenever the API failed. | The cloud API never seeds. `seedDemo` is local development only (`DOZAI_DEV_AUTH=1`). The web app has no sample data at all; an offline server shows an error with a retry button. |
| Fake screens | Hardcoded name, workspace and role; a mission builder that "published" nothing; invented agent resource IDs; monitoring charts with made-up numbers; a participant simulator; export, search and filter controls that did nothing. | Rewritten. Every number and label comes from the API. Mission and agent pages are read-only and show the real configuration. Sessions and cost are computed from real runs. Exports download real CSVs. Audit search and filter work. |
| No way to load real people | Only a test-case endpoint for the admin's own number. | `POST /api/participants/import` plus a CSV import screen: validation per row, duplicate detection by keyed phone hash, a recorded consent attestation, batches of 20. |
| No delete | Nothing could be removed; the ledger and evidence kept personal data forever. | `deleteCase`: stops contact, cancels queued messages, erases name, number, employer, reply text, evidence values, decision text, agent traces and queued inbound events, and keeps an anonymous ledger stub. Admin only, typed confirmation, safe to repeat. Test asserts that no stored row still contains the personal data. |
| Personal data in storage | Inbound webhook events stored the sender's phone number and reply text indefinitely; reviewer notes were written into the immutable ledger. | The inbox stores only a keyed hash, and the reply text is dropped once applied. Reviewer notes live in the erasable decision row, never in the ledger. Found by a test. |
| Personal data in the page | Closing the case drawer or an import dialog left names and pasted rows in hidden page elements. | Both are cleared on close. Found by the UI test. |
| Unsafe defaults | The contact window was opened 24 hours, the seed endpoint was enabled, and the user-invite route was deployed. | Live defaults: 09:30-18:00 IST. Override `DOZAI_DEMO_WINDOW=1` only from `.env.local`. The invite route is not deployed. A purge route exists only if `DOZAI_ALLOW_PURGE=1`, needs admin plus a typed phrase. |
| Case ids | Derived from a count, so deletions would have caused reuse. | Allocated with an atomic claim; ids are never reused. |
| Error messages | Raw validation text ("String must contain at least 8 character(s)") reached users. | Plain messages. |
| Process | No version control, no CI. | Git initialised (nothing committed yet); `.github/workflows/ci.yml` runs typecheck, tests and build. |
| API code | Repeated boilerplate in every handler; a leftover no-op middleware. | Rewritten with shared helpers. |

### Still open (in priority order)

| # | Finding | Severity | Why it matters | Suggested fix |
|---|---|---|---|---|
| 1 | Participant names and programme-record employers are stored in plain text (phone numbers are encrypted). | Medium | A database export would expose names. | Encrypt these fields too, or confirm Catalyst encryption at rest and restrict the `dozai_docs` table permissions to the project's functions (check in the console). |
| 2 | Free-text WhatsApp replies are given to the model as evidence. | Medium | May contain personal details. | Decide in the data policy; options are redaction, or classifying replies before the model sees them. |
| 3 | The agent runs inside the web request. | Medium | A slow model call can hit the function time limit (the UI warns after a timeout). | Move runs to a Catalyst job and poll. |
| 4 | No scheduler. Replies are applied right after the webhook and by the Check for replies button. | Medium | Replies can wait until someone clicks. | Create a Catalyst Cron that POSTs `/api/jobs/tick` with the job token. |
| 5 | Reminders after silence are not automated, and the contact policy requires consent after the first message. | Decision needed | A silent participant is never reminded. | Decide whether "consent not declined" is enough for one reminder. |
| 6 | Roles come from the `DOZAI_ROLES` setting. | Low | Adding a user needs a redeploy. | Store roles in the data store with an admin screen. |
| 7 | The 34 questions are placeholders; the mission is defined in code. | Blocking for a real pilot | The instrument must be signed off. | Programme team sign-off, then load the real wording as a new mission version. |
| 8 | No API rate limiting. | Low | A signed-in user could hammer the API. | Catalyst API gateway limits. |
| 9 | Lists load every case and every evidence row. | Low until hundreds of cases | Slower pages as data grows. | Paginate; add a per-case evidence read. |
| 10 | The audit ledger is verified by reading every event. | Low | Verification slows as it grows. | Verify per case, or checkpoint. |
| 11 | No alerting or monitoring beyond Catalyst's console logs. | Medium for live use | Failures go unnoticed. | Alerts on failed sends, rejected webhooks, agent errors. |
| 12 | ZoLabs voice is not built; WhatsApp reminders and the Hindi template were removed from the bundle for now. | Scope | Voice is part of the locked design. | Next sprint. |
| 13 | Unused prototype CSS remains in `styles.css`. | Cosmetic | Dead weight. | Prune. |
| 14 | `.env.local` exists on one laptop. | Medium | Losing it loses the keys (the PII key cannot be recovered). | Keep a copy of `DOZAI_PII_KEY` in the team's password manager. |
