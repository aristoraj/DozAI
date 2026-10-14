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
| A valid answer | Checked against its question, stored as evidence (with the question's evidence key), next question sent |
| One reply that answers several questions ("Same place, Acme, cashier") | Each answer is checked and stored under its own key, the flow skips what is already answered, and one message asks the first thing still missing. An answer to a question this person would not be asked is not saved |
| "I don't know", "no", "none" to a question that wants a name | Not an answer. Asked again (counts as a re-ask) |
| "What do you mean?", "samajh nahi aaya", "क्या मतलब" | A line saying how to reply (by number or in their own words, or "a few words is enough" for a text question), then the same question again. Counts as a re-ask, so it cannot loop |
| Any saved answer, when another question follows | A short thank-you ("Thank you.", "Got it, thanks."), a different one each time. A reply that answered several questions gets a line that says so. Not added to the first question (the start message already thanks them) or to the closing message |
| A reply that was not understood | The instrument's "could not understand" line, then a hint: the first time both ways to reply, the second time plainer ("Please reply with one of the numbers below" / "type just the name"), then the question |
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

- **Rules** (`backend/packages/core/src/conversation/classifier.ts`) understand the clear replies, and always decide stop, wrong person, distress and deletion. No participant text leaves our system.
  - A number is a pick only when it stands alone: "2", "option 2", "2 please", "second one", "२", "दूसरा". "2 months ago I left my job" is not option 2.
  - A label or synonym is a pick only when exactly one option matches and the rest of the reply does not turn it around ("I do not work at the same place" is not "same place").
  - English, Hinglish and Devanagari yes, no, stop, "I don't know" and "what do you mean" are understood. Free Hindi sentences beyond those words need the model assist.
- **Optional model assist** (`DOZAI_CLASSIFIER=claude`): the same reader in `backend/packages/adapters/src/classifier.ts`. It is asked for a reply that is more than a clear pick (a sentence, a number inside a sentence, anything the rules could not place, or a question the approved explainers do not match). It is given the current question and options, the other fields with when each is asked, the answers so far, the last three questions and what was understood, and the mission's programme and objective. It returns an intent and the answers it finds, each with the exact words it relied on.
  It has no tools and treats the reply as untrusted data. We then check every answer ourselves: the field must be part of the mission, a choice must name a real option, a text answer must be real text that appears in the reply, the quoted words must appear in the reply, and its confidence must be at least 0.6 (it is capped at 0.85 for a choice and 0.7 for text). The conversation runner checks again before saving. Any failure falls back to the rules.
  **What leaves our system:** the reply, the earlier answers and the mission's programme name and objective, with phone numbers, e-mail addresses and PAN-style IDs replaced first. It is off by default and turning it on is a data-policy decision for the programme.
- **Wording** (`backend/packages/core/src/conversation/phrases.ts`): the thank-yous, re-ask hints and "what do you mean" lines are fixed text in English and in Hindi written in English letters (chosen by the participant's language). Which line is used depends only on how many messages were sent, so a conversation always reads the same and two neighbouring messages never repeat. A test checks that every message the runner sends is an instrument text or one of these lines.
- **The agent** is woken only after an interview and proposes the outcome. It cannot message the participant.

## Replacing the draft questionnaire

Each mission carries its own instrument (see [MISSIONS_AND_CAMPAIGNS.md](MISSIONS_AND_CAMPAIGNS.md)), and a case follows the
instrument of the mission it was created under. The built-in draft below is the instrument of the built-in mission. To go live
for a client, add a mission whose instrument has `draft: false`; no code changes.

Everything is data (the built-in one is in `backend/packages/core/src/missions/instrument.ts`): questions, options, branching (`next` rules), explainers, the
fixed responses, limits. The current content is **DRAFT** wording written to exercise the flow and is not approved. To go
live: put the signed-off wording in, set `draft: false`, and no code changes. Until then real conversations only use the
draft when `DOZAI_ALLOW_DRAFT_INSTRUMENT=1` is set (development and testing); otherwise the first reply is handed to a person.

Hindi: add a second language to each text and choose by the participant's language. Not built yet.

## Testing it

- `backend/packages/core/src/conversation/conversation.test.ts`: 30 scripted conversations (the gold set) and the safety limits.
- `backend/packages/core/src/conversation/classifier.test.ts`: the rule reader: picks, numbers inside sentences, Hindi, Hinglish and Devanagari, "I don't know", questions about the question, and the answer check.
- `backend/packages/core/src/missions/flow.test.ts`: the same questions in the same order on WhatsApp and on a call, drift cases, and the same answers saved under the same keys from both channels.
- `backend/packages/core/src/conversation/conversation.natural.test.ts`: thank-yous, the two re-ask tiers, "what do you mean", Hindi wording, and that all wording is fixed text.
- `backend/packages/core/src/conversation/conversation.freetext.test.ts`: several answers in one reply, branching, held answers, nothing overwritten, and full interviews in Devanagari and Hinglish. The model is replaced by a script.
- `backend/packages/adapters/src/classifier.test.ts`: when the model is asked, what it is told (and that it is redacted), and that nothing it returns is trusted without a check.
- `backend/packages/adapters/src/conversation-flow.test.ts`: the real path with the network mocked (webhook to tick to runner to send).
- With WhatsApp off, the case panel has a box to type a simulated participant reply. It runs the same logic.

## Open risk: free-text sending through Interakt

Interakt's public documentation does not describe sending a non-template message. `InteraktClient.sendText` uses
`type: "Text"` with `data.message`, the usual shape, and must be confirmed by one real send. If Interakt rejects it, the
reason appears in the case history ("Send failed: ...") and nothing else breaks. Fallback options: ask Interakt support,
or move the questions to approved templates with buttons.

## Scheduler

`backend/functions/cron_tick` is a Catalyst Cron function that calls `POST /api/jobs/tick` with the job token. Create the schedule
once in the Catalyst console: Cloud Scale > Cron > create a job, target the function `cron_tick`, repeat every minute.
Until then the webhook triggers a best-effort run after each reply, and **Check for replies** runs it by hand.
