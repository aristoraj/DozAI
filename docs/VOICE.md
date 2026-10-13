# Phone calls (ZoLabs)

How a phone call fits into a case, what is built, how to switch it on, and the details still to be confirmed with the ZoLabs team.

## The flow

```
mission published  ->  a person reviews the phone form  ->  "Create at ZoLabs"     (once per mission, and again when it changes)
                                                                  |
agent decides a call is needed  ->  voice_call_request (with a reason, now or at a time inside contact hours)
        gateway checks consent, hours, attempts, that the form is published, and that something is still missing
                                                                  |
scheduler places the call  ->  ZoLabs rings the person, following the form  ->  callback (a doorbell) to our address
                                                                  |
scheduler fetches the call: JSON answers + audio + transcript  ->  answers become evidence (source "voice"),
audio reference and transcript are kept on the call, the agent is woken to judge
```

## What the agent can and cannot do

- It asks for a call with `voice_call_request`: a short **reason**, and optionally a time (inside the contact hours, within 14 days). Everything else is refused by the gateway with a plain reason.
- A call **asks only for what is still missing**, plus needs that depend on an answer the call itself will get (a person who says they work somewhere is then asked where and as what).
- It never sees the phone number, the transcript or the audio. It sees that a call is possible and what has been tried (status, when, what was asked).
- It cannot create or edit the form. Only platform staff publish a form, after reading exactly what will be sent.

## The form published for a mission

Generated from the mission, never written by hand:

- **Instructions** for the voice agent: the employee's name and tone, the mission's purpose, then the call script. Consent is asked first, identity second, and a refusal or a wrong person ends the call with nothing else asked. It stops on distress or a request to delete data, never promises jobs or money, and asks only what the call details list.
- **Three fields on every form**: `consent_given`, `identity_confirmed`, `language`. They let the platform tell a refusal or a wrong number from an answer: a refusal closes the case as an opt-out and records no answers; a wrong person goes to a human and records no answers.
- **One field per thing the mission needs to learn**, with the question and the expected answers taken from the mission's questions, and the condition under which to ask.
- A fingerprint of the definition, so the mission page can say **"out of date"** when the mission or the employee's tone has changed since publishing.

Each call is given a short context: the person's first name, the language, and what is missing. Never a surname, number, or earlier answers. The case id travels as `source_id`.

## Same questions as WhatsApp

A mission describes its questions twice: the questionnaire (`instrument`: order and branching, used by WhatsApp) and the list of evidence it needs (`evidence_requirements`: order and "ask only if" conditions, used to build the phone form). `packages/core/src/flow.ts` walks every path through the questionnaire and checks that a call would ask the same keys in the same order. The built-in mission passes on all four branches.

What is checked: the same keys in the same order on every path; a need that waits for one a call reaches later; one key asked in two places with different kinds of answer; and a branching mission with no list of needs (a call would ask every question).

Where it is enforced: **Mission Studio drafts** are sent back to the drafter to correct. Saved missions are not held to it, because many were written by hand and some branch without a list of needs; for those, run `channelFlowProblems(mission.instrument, mission.evidence_requirements)` to see the differences.

What a finished call saves follows the same rules as a WhatsApp answer:
- Free text must be real text. "No", "none" and "I don't know" are not kept.
- An answer to a question this person would not be asked is not kept (for example a course for someone who works). If the answer it depends on is not known, the answer is kept, as a held answer is on WhatsApp.
- An unclear answer never replaces a clear one. If there is nothing better it is kept below the confidence bar so a person can see it was said.
- A clear new answer does replace an older one: that is what a follow-up call is for.

Not the same, on purpose: the exact words. WhatsApp uses the questionnaire's text and the fixed thank-you and re-ask lines (`phrases.ts`). The voice agent says each field's spoken question in its own voice and handles an unclear answer by asking once more in different words, as the form instructs. Confidence also differs: a typed option is 0.95, a model-read one is capped at 0.85, a call's free text is 0.85.

## Safety, in layers

| Layer | What it does |
|---|---|
| `ZOLABS_ALLOW_CALLS=1` | Master switch. Off: queued calls fail with a clear reason and nobody is rung |
| Gateway | Consent, contact hours, attempts, voice form published, something still missing |
| One claim per call | A call is claimed before ringing. If anything fails afterwards it is **not** repeated: ringing someone twice is worse than missing a call |
| Callback is a doorbell | Only the call id from the callback is kept. We fetch the call ourselves, so a forged callback can only make us look at a real call |
| Erasure | Deleting a case deletes its calls, audio references and transcripts on our side |

## Switching it on

Settings in `.env.local` (then `node scripts/deploy.mjs`):

| Setting | What it is |
|---|---|
| `ZOLABS_MCP_URL` | The ZoLabs MCP address |
| `ZOLABS_ACCESS_TOKEN` | The credential our server uses (see below) |
| `ZOLABS_WEBHOOK_SECRET` | Generated by the deploy script. Becomes part of the callback address |
| `DOZAI_PUBLIC_URL` | The address of the API, e.g. `https://dozai-dev-893409434.development.catalystserverless.com/server/core_api`, used to build the callback address |
| `ZOLABS_ALLOW_CALLS` | `1` to allow real calls |

The callback address is `DOZAI_PUBLIC_URL/api/webhooks/zolabs/<ZOLABS_WEBHOOK_SECRET>`. It is set on the form when it is published. The secret is in the address, so it will appear in request logs: treat the address as a secret.

## Getting the credentials

**What we need from ZoLabs**

1. **A credential our server can use without a person signing in.** The MCP address uses a browser login for a person (OAuth authorization code with PKCE, dynamic client registration, refresh tokens). There is no service-account option on it. Ask the ZoLabs developers (the QurateAI backend team) for one of:
   - an API key or service token for server-to-server use (best);
   - a client-credentials grant on their authorization server;
   - failing both, a **one-time sign-in by one person** to obtain a refresh token we store. This works but is tied to that person's account and breaks if they leave, so treat it as temporary.
2. **The callback.** We set the callback address ourselves when the form is published (`callback_url`). Ask them: what is posted, what field holds the call id, and how it is signed (header name and method), or whether we can give them a shared secret. We do not depend on the body (see "doorbell"), but we need to know the call id's field name.
3. **The shape of a finished call.** What `list_communications` returns for one call, and where the answers, audio link and transcript are. The best way to learn it: make **one test call to a team member's phone** from a test form and capture the record.
4. **Limits and cost:** cost per call minute, concurrency, quota on creating forms, and whether a form can be deleted or a call's data erased (the connector has no delete, which matters for deletion requests).
5. **A production backend.** The sign-in server is a development service on a free host that can sleep when idle.

**A message you can send**

> We are connecting DozAI (our placement verification platform) to ZoLabs for outbound follow-up calls. Our server will call your MCP/backend on behalf of a service account, not a person. Please can you share: (1) a service API key or token for server-to-server use, or confirm client-credentials is available; (2) what you post to a form's callback_url (payload, the field with the call id, how it is signed); (3) the exact JSON a finished call returns, including where answers, audio and transcript are; (4) cost per minute, concurrency limits and form quota; (5) how to delete a call's audio and transcript when a participant asks; (6) a production endpoint and an uptime commitment.

## Assumptions to check against the first real call

`parseZolabsCommunication` (in `packages/adapters/src/voice.ts`) is the one place that knows the provider's format. It was written before a real payload was seen and accepts several likely names for each part: the id, the status words, the answers (an object keyed by field id, or a list), the audio link, the transcript, the duration. Likewise, creating a form is assumed to return an id, and starting or scheduling a call is assumed to return a call id. Check each against the first test call and tighten them. The fixtures in `voice.test.ts` record what is expected today.

## Not built yet

Reminders and retry rules for calls (the platform currently allows the agent to ask again within the shared attempt limit); the autonomy dial (calls will start as "approve first" in step 4); the voice-first path for people who are not on WhatsApp; quality review of calls; cost tracking per call; a Hindi test matrix.


## Staying signed in, the Phone calls page, and what is still open (13 October 2026)

**Signing in.** ZoLabs signs people in with OAuth, so there is no API key. Run `node scripts/zolabs-login.mjs` once: it opens ZoLabs in the browser, you sign in with the account calls should be made as, and it saves `ZOLABS_CLIENT_ID` and `ZOLABS_REFRESH_TOKEN` to `.env.local` (not in git). Then `node scripts/deploy.mjs --only functions`. From then on the server renews its own access tokens (`RefreshingToken`). If ZoLabs ever issues a newer refresh token, the newest is kept in the database, encrypted with the PII key, so every copy of the server uses the same one. If the sign-in is ever revoked, repeat the steps above.

**The Phone calls page** shows the connection (live, simulated or off), whether calls are switched on and who can be called, a **Check connection** button (asks ZoLabs who we are signed in as; no call, no cost), the phone form for each mission and whether it is current, and every call with its result, length, what it asked, and (for reviewers and platform staff) the recording and transcript.

**The form generator** now also tells the voice agent that a short "yes", "haan", "ji" or "okay" is a clear yes, never to ask a question again once it was answered, and to go back over its fields before ending so none that applies is skipped. Check this on the next real call.

**Still open with ZoLabs:** where the recording link lives (records carry none today), the real callback payload and whether it is signed, a delete route for data held at ZoLabs, costs and limits, and the production host. **Still to build here:** confirming an unclear call result on WhatsApp.

**The safe lists were removed (13 October 2026).** There is no `ZOLABS_ALLOWLIST` or `INTERAKT_ALLOWLIST` any more. Calls and messages are controlled by consent, contact hours, the attempt cap, the approval setting for calls, spend limits and the kill switch. `ZOLABS_ALLOW_CALLS=1` remains as the master switch for real calls.
