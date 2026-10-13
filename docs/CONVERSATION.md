# The conversation

After a participant agrees to continue, a fixed, approved question flow runs the interview. The Claude agent does not
write to participants. It is woken when the interview finishes, to propose the outcome from the evidence.

```
Intro template (agent)  ->  participant: "Yes, continue"
        |
        v
Conversation runner (rules)  --asks-->  approved question 1   -> reply -> question 2 -> ... -> closing message
        |                                                         |
        |  irrelevant / question / stop / wrong person / distress / delete my data -> approved response or a person
        v
Interview finished  ->  agent reads the answers (evidence)  ->  proposes outcome  ->  policy: auto-complete, or review
```

## What each kind of reply does

| Reply | System response |
|---|---|
| A valid answer | Stored as evidence (with the question's evidence key), next question sent |
| Irrelevant, gibberish, a greeting, emoji or media only | The same question again with a short notice. After 2 re-asks: a polite hand-over and a review task |
| A question (who are you, is this a scam, how long) | The approved explainer, then the question again. Does not count as a re-ask |
| STOP, or "No" while consent is being asked | Opted out; case closes; nothing more is sent |
| "Wrong number", "I am not ..." | Apology, no further messages, review task: identity mismatch |
| Complaint, threat, safety concern | Calm approved message, review task marked urgent |
| "Delete my data" | Acknowledgement and a review task for an admin |
| Any reply after the interview is finished or the case is closed | Ignored |

Limits: 2 re-asks per question, 40 messages per case, free-form messages only within 24 hours of the participant's last
message, never to someone who opted out, never without consent.

## Who decides what

- **Rules** (`packages/core/src/classifier.ts`) understand the common replies. No participant text leaves our system.
- **Optional model assist** (`DOZAI_CLASSIFIER=claude`): for replies the rules cannot place, a small model picks one intent
  from a fixed list. It has no tools, treats the reply as untrusted data, and cannot invent an option. Any failure falls
  back to the rules. This sends participant text to the model, so it is off by default and is a data-policy decision.
- **The agent** is woken only after an interview and proposes the outcome. It cannot message the participant.

## Replacing the draft questionnaire

Each mission carries its own instrument (see [MISSIONS_AND_CAMPAIGNS.md](MISSIONS_AND_CAMPAIGNS.md)), and a case follows the
instrument of the mission it was created under. The built-in draft below is the instrument of the built-in mission. To go live
for a client, add a mission whose instrument has `draft: false`; no code changes.

Everything is data (the built-in one is in `packages/core/src/instrument.ts`): questions, options, branching (`next` rules), explainers, the
fixed responses, limits. The current content is **DRAFT** wording written to exercise the flow and is not approved. To go
live: put the signed-off wording in, set `draft: false`, and no code changes. Until then real conversations only use the
draft when `DOZAI_ALLOW_DRAFT_INSTRUMENT=1` is set (development and testing); otherwise the first reply is handed to a person.

Hindi: add a second language to each text and choose by the participant's language. Not built yet.

## Testing it

- `packages/core/src/conversation.test.ts`: 30 scripted conversations (the gold set) and the safety limits.
- `packages/adapters/src/conversation-flow.test.ts`: the real path with the network mocked (webhook to tick to runner to send).
- With WhatsApp off, the case panel has a box to type a simulated participant reply. It runs the same logic.

## Open risk: free-text sending through Interakt

Interakt's public documentation does not describe sending a non-template message. `InteraktClient.sendText` uses
`type: "Text"` with `data.message`, the usual shape, and must be confirmed by one real send. If Interakt rejects it, the
reason appears in the case history ("Send failed: ...") and nothing else breaks. Fallback options: ask Interakt support,
or move the questions to approved templates with buttons.

## Scheduler

`functions/cron_tick` is a Catalyst Cron function that calls `POST /api/jobs/tick` with the job token. Create the schedule
once in the Catalyst console: Cloud Scale > Cron > create a job, target the function `cron_tick`, repeat every minute.
Until then the webhook triggers a best-effort run after each reply, and **Check for replies** runs it by hand.
