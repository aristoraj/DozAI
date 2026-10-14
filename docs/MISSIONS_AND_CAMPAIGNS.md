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

- **Saved missions never change, with one exception: sign-off.** A change is a new version, and saving over an existing version is refused. The one thing that does change a saved mission is its sign-off, which approves the same mission in place (see Mission Studio below). After that it never changes again.
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
- **Automatic pause.** If the latest five first messages all failed (wrong key, a number WhatsApp rejects, provider outage) the campaign pauses and shows the reason. Resume after fixing it.
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

**Always a draft.** A drafted mission is saved as DRAFT wording. The drafter cannot approve its own work: only a person signs the wording off on the Mission page (see the Questionnaire wording card). Signing off approves **this same mission**: the version name does not change and no second mission is made. It records who signed and when, and the mission is then approved and never changes again. Until then every real reply is handed to a person.

**Still JSON underneath, on purpose.** The structure lets the employee know what is still missing for each person, lets reports compare cases, and keeps questions in approved wording. "Add from JSON" on the Mission page remains for developers. The review screen no longer has "Edit as JSON": the questions are managed on screen (below).

### Reviewing and editing the questions (14 October 2026)

The questions are shown as one card each, with **WhatsApp** and **Phone call** wording side by side, when the draft is made and again on the Mission page before sign-off. An unsigned mission opens its questions by itself.

- **Edit** a question: the WhatsApp wording, the wording of its answer choices, its category, and whether it must be answered. What each answer choice saves is locked, so saved data keeps its meaning.
- **The phone wording is read only.** The Phone call column shows exactly what the voice agent says, marked "read only". There is no box to change it, and editing the written question does not change it: the first time the written wording (or an answer choice) is edited, the wording the phone has at that moment is written into the question's own phone wording (its existing `spoken` field), so the call sounds the same. A question that is added gets the automatic phone wording and nothing else. The server refuses a sign-off whose edits would change what a call says.
- **Remove** a question (it asks first). Its "what to find out" entry goes with it, and the questions that led to it now lead past it. A question that other things depend on is not removed: it says what depends on it.
- **Add** a question: free text, choose one, or yes/no. It goes in the category of the question before it, or one you pick, or a new one you name. It is asked at the end, of everyone, and gets its own key and its own "what to find out" entry. Its phone wording is made automatically.
- **Categories.** Questions are shown grouped under their category (the existing `module` of each question), with a count. A question keeps its number, which is what the checks refer to. Claude is asked to give every question a category by purpose (work, support, income...) with 2 to 6 categories and one spelling each; a draft that puts four or more questions in one category is sent back. Names are tidied ("Same Job" and "same_job" are one category), a question is never left without one, and the plain draft made without a model sorts each line by the words in it (support is checked before job).
- **No repeats.** A question that says the same thing as another one that could be asked of the same person is refused, while typing and again on save. The same wording on two branches ("where do you work" for people who stayed and for people who moved) is allowed.
- **A live check** runs after every change and lists problems in plain words, including a call and WhatsApp asking different things. Saving and signing off stay disabled while there are problems or a question is open for editing.

**Sign-off updates the mission in place.** Edits made before the first save go into the one draft that is saved. At sign-off the same mission is approved with the questions as they stand: the sign-off request takes an optional `edits` with the questions and the "what to find out" list. Nothing else can be changed that way, and who signed and when is set by the platform. There is no `-signed` copy and the mission list has no extra entry. People already on the mission follow the approved wording straight away. If phone calls are used, the phone form shows "Out of date" and is published again. An approved mission is read only: a change after that is a new version, as before. A second sign-off is refused.

The check is `POST /api/missions/check`. It saves nothing and calls no model.

Drafting uses the model, so the kill switch and the daily spend limit apply to it.

## Status and result, in the mission's own words (14 October 2026)

A case used to show one pill and one "outcome" column that mixed two different things, and the outcome used job words for every mission, so a finished feedback case could read **Confirmed** with the outcome **Awaiting response**.

**Status** says where the case is in the process, in plain words: Not started, Waiting for a reply, In conversation, Call scheduled, On a call, Checking the answers, Needs a person, Complete (or Opted out, Cancelled).

**Result** says what was found out, in the words of the mission. It has two parts:
- The **finding**: one of the results the mission defines (\`outcomes\`: a key, a short label and a description). A placement check has Same job, Changed job, Currently unemployed, Education or training, Unclear. A feedback mission might have Satisfied, Mixed, Unhappy, Unclear. Mission Studio drafts them from the brief, and they are shown on the Mission page and in the draft review, so they are read and signed off with the rest of the wording.
- The **verdict** under it, once the case is finished: confirmed, not confirmed or inconclusive, worded for the mission (\`verdict_labels\`: "Feedback collected", "No feedback", "Unclear" for feedback; plain words when a mission gives none).

A case that is still in progress shows "—" and "Not known yet". It never claims to be "awaiting" something once it is finished.

**The agent chooses the finding.** The mission's findings are part of the agent's brief, and \`decision_propose\` takes exactly one of them (\`livelihood_state\`, the original field name, is kept in stored data). The platform rejects a finding the mission does not list and tells the agent which are allowed, so a feedback mission can never end with "same job". A mission saved before this has no list, and uses the original placement findings.

**The Command centre follows too.** One mission selected: the donut shows that mission's own first three findings and "other", and "confirmed" is worded the mission's way. Several missions together: the general results (confirmed, not confirmed, inconclusive), because job findings mean nothing for a feedback mission.

## The same person in several missions (14 October 2026)

A number used to be unique across the whole system, so someone in one mission could not be added to another. Now **the same number can be in different missions, once in each**:

- **Import:** "already loaded" is judged against the mission being loaded into. The message says which case already has the number ("already in this mission (DZ-0007). The same number can be added to a different mission."). The same number written differently (+91 98765 43210) is still caught, and so is a repeat inside one file. A deleted case no longer counts: its number was erased, so it can be added again.
- **One person, separate cases:** each mission gets its own participant record and case, with its own consent, conversation, evidence and result. Deleting one case erases that mission's record and leaves the person's case in another mission untouched.
- **Replies:** WhatsApp replies arrive by phone number, so a reply goes to the open case the person was **last written to in** (the question they are answering), and to the most recently touched case when nothing was sent to either. A finished case never receives a reply.
- **Not yet:** contact limits (attempts, hours) still count per case, not per person across missions, so a person in two missions can be contacted by both. A single contact budget per person is still to do. Deleting a case also clears any unprocessed raw inbound events for that number, which could include the other mission's if one was still waiting.
