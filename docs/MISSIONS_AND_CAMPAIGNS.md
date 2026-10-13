# Missions and campaigns

Two ideas make DozAI work for more than one client, and for thousands of people at once.

## Missions: what changes from one client to the next

A **mission** is data, not code. It holds:

| Part | What it is |
|---|---|
| Intro template | The first WhatsApp message (a Meta-approved template, set up by hand per client) and the programme name shown in it |
| Questions | The whole interview: questions, options, branching, FAQ answers, the fixed replies (stop, wrong person, distress, deletion, hand-over), limits |
| Contact rules | Contact hours, attempts, auto-confirm threshold. Only what differs from the platform defaults |
| Agent notes | Extra working instructions for the agent, written by the programme team. They sit below the safety rules and cannot loosen them (the tool gateway enforces the rules regardless) |
| Goal and evidence needed | What the employee must find out about each person (see [AGENTIC_ARCHITECTURE.md](AGENTIC_ARCHITECTURE.md)) |
| Employee | Which Verification Employee does the mission, and optionally an exact version. Without a version it follows the employee's current one |

Rules that keep it safe:

- **Saved missions never change.** A change is a new version. Saving an existing version is refused.
- **A case is pinned to one mission version when it is created.** Editing or adding missions never alters a conversation in progress. Cases made before missions existed use the built-in mission (`MSN-001-v1.3`).
- A mission is **checked before it is saved**: unknown jump targets, repeated ids, choice questions with fewer than two options, rules that wait for an answer that does not exist, loops that would never finish, an intro template that is not in the list. Problems come back in plain words.
- Participants join a mission when they are imported (a chooser appears once there is more than one; the default is the most recently added).
- Only administrators add missions. Add one from the **Mission** page: "Copy it here" loads an existing mission as JSON, change the ids, wording and questions, save.

Where it is used: the conversation runner (questions, wording, limits), the intro template sender (template, programme name), the contact gate (hours, attempts), the agent (pinned version, notes, tool gateway bundle), campaigns.

Storage: one row per piece (about 4,000 characters each) plus a header row that is written last and only once per version, so two people saving the same version at once cannot produce a half-and-half mission. `purge-all` leaves missions in place (configuration, not personal data).

**Not built yet:** a point-and-click builder for questions (today a mission is JSON), per-client users and workspaces (every mission lives in one workspace for now), translating a mission into Hindi in one step.

## Campaigns: the first message to many people

A **campaign** is a saved instruction: *this mission, this cohort, at most N a day, M a minute*. It is not a list of people, so starting one is instant even for 10,000 participants.

```
Import participants (each joins a mission)  ->  New campaign (draft, nothing sent)  ->  Start
                                                                      |
          scheduler, about once a minute  <---------------------------+
             1. take the next few eligible people (batch size, daily cap, contact hours)
             2. send each the mission's intro template   (no agent involved)
             3. if the last five first messages all failed, pause the campaign
          participant replies -> conversation runner -> ... -> agent is woken once, at the end
```

- **Pace.** One batch per campaign per minute, however many things trigger a run (the Cron job, a webhook, a button). The daily cap is exact: every message takes a numbered slot for the day, so even overlapping runs cannot exceed it.
- **No double messages.** Only one writer can move a case out of `draft` (a compare-and-set), so a participant cannot be started twice even if two runs overlap.
- **Contact hours** come from the mission (platform default 09:30 to 18:00 IST). Outside them the campaign waits and says so.
- **Who is in it** is fixed at start: the chosen mission and cohort, loaded before the campaign started, not yet messaged. People imported later need their own campaign.
- **Controls.** Draft, Start, Pause, Resume, Stop. Stop is final. A pause pressed while a batch is running is never undone by that batch's bookkeeping.
- **Refusals.** With WhatsApp live, a campaign will not start if the mission's questions are not approved (every reply would be handed to a person) or its intro template has no WhatsApp template name.
- **Automatic pause.** If the latest five first messages all failed (wrong key, number not on the allowlist, provider outage) the campaign pauses and shows the reason. Resume after fixing it.
- **Screen.** Waiting to send, messaged, waiting for a reply, needs review, finished, could not send, sent today. Counts are read from the cases, so they cannot drift. A warning appears if a running campaign has not been run for three minutes (the Cron job is missing).

### Manual step still needed

Create the Catalyst Cron job once (Cloud Scale > Cron > job that calls the `cron_tick` function, every minute). Until then, **Start** sends the first batch immediately and **Send next batch now** sends the next one by hand.

### Limits to know before 10,000 people

- **WhatsApp tiers.** A new number may be allowed to start conversations with only about 250 new people a day, rising as quality and business verification grow. Set the daily cap at or below your number's limit. The cap is a setting, not a guess.
- **Provider speed.** Interakt allows 300 messages a minute on Growth and 600 on Advanced. The default batch is 15 a minute, which is about 900 an hour. Raising it up to 50 a minute is allowed; beyond that the scheduler needs to run more often or in parallel.
- **Reading 10,000 cases each minute is too slow.** The scheduler lists all cases on every run, which is fine for hundreds and will become the bottleneck near the thousands. The fix is an indexed lookup of "draft cases for this mission" (Data Store columns for status and mission). Do it before the first large campaign. Listed in the audit.
- **People who could not be sent to** stay in the waiting state with a failed message; the screen counts them but there is no one-click retry yet.
- **Quality score.** If many people report the number or reply "not interested", Meta can reduce the sending limit. The approved wording, the clear opt-out and the consent attestation on import are what protect it.

## Mission Studio: writing a mission in plain words (13 October 2026)

A mission no longer has to be written as JSON. On the Mission page, **Create a mission** asks for a brief in plain language: the goal, who the people are, what must be found out (one thing per line), the tone, and optionally the contact hours and attempts. It also asks which existing mission to copy the first-message template, the contact rules and the employee from, because the first WhatsApp message must be a template approved by WhatsApp and cannot be drafted.

**Draft with Claude.** The drafter (Claude when a key is set, a plain scripted drafter otherwise) turns the brief into the structure the platform runs on: the goal, the evidence checklist (what must be known, which things depend on an earlier answer), the questions with answer choices and branching, the fixed messages, the answers to common questions, the suggested approach and working notes, plus a list of assumptions to check. It sees the brief only, never anything about a person, and the brief screen says not to write names or phone numbers.

**Checked like any mission.** The draft goes through exactly the rules a saved mission must pass (every need has a question that can fill it, no loops, no dangling jumps, conditions that can happen). If it fails, the drafter is given its own mistakes and tries again, up to three times. Nothing is saved while drafting.

**Always a draft.** A drafted mission is saved as DRAFT wording. The drafter cannot approve its own work: only a person signs the wording off on the Mission page (see the Questionnaire wording card), which saves a new signed-off version with their name and the time on it. Until then every real reply is handed to a person.

**Still JSON underneath, on purpose.** The structure lets the employee know what is still missing for each person, lets reports compare cases, and keeps questions in approved wording. "Add from JSON" remains for developers, and "Edit as JSON" on the review screen opens the draft for fine changes.

Drafting uses the model, so the kill switch and the daily spend limit apply to it.
