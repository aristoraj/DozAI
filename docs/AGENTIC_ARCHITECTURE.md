# Agentic architecture

How DozAI becomes an agentic platform: an AI employee that works toward a goal for each person, chooses its own tools, and is held inside rules it cannot change. This replaces the earlier "WhatsApp, then a call" workflow. Decided with the product leads on 12 October 2026.

## The principle

**Hard-code safety, free-form strategy.**

- The platform enforces what must never be wrong: consent, contact hours, number of attempts, opt-out, spend limits, approved wording, what data the agent can see.
- The agent decides everything else: which channel, when to follow up, which question next, when there is enough evidence, when to ask a person.
- The agent proposes an action and the gateway accepts or refuses it. The agent cannot change the rules.

## The layers

```
Platform core        safety rules, data protection, audit, tenancy. Not editable by missions.
  Verification Employee   (versioned) role, persona, skills, allowed tools, escalation rules, evaluation set.
    Mission               (versioned) goal, evidence needed, question bank, strategy hints, contact rules, program context.
      Case                one person: what is known, attempts, timers, notes. Pinned to employee and mission versions.
```

Only EdZola staff create or change an employee. Clients will eventually deploy missions, never employees.

## What the agent does for one case

1. Is woken by an event (first contact due, a reply, a call result, a timer, a person's follow-up).
2. Reads a structured digest of the case (consent, attempts by channel, evidence so far, **what is still missing**), not a raw chat log.
3. Proposes actions: ask a question (message or call), wait and wake me later, confirm a detail, propose a decision, ask a person.
4. The gateway checks each action against the rules. Allowed actions run through a channel adapter. Refused ones come back with a reason.
5. The agent sleeps. Waiting costs nothing. It sets its own next wake-up.

## Goal-based missions (built: step 1)

A mission states a goal as **evidence needed**, not a script:

- Each need has a key, a label, whether it is required, the confidence at which an answer counts, and optionally a condition ("only if the person works"), and a check against the programme record.
- The question bank (the interview instrument) says how each need can be asked. Several questions may fill the same need.
- A mission also holds an objective and **strategy hints** (preferred channels in order, follow-up delay, notes). Hints are defaults the agent may override within the rules.
- Saving a mission checks that every need has a question that can fill it and that conditions refer to answers that can actually happen.

For a case, `evaluateRequirements` compares the needs with the evidence collected and gives each need a state:

| State | Meaning |
|---|---|
| missing | applies to this person and has no usable answer |
| stated | the participant said it (confidence at or above the threshold) |
| verified | checked against another source (today: the employer on the programme record) |
| conflict | checked and it does not match |
| not needed yet | depends on an earlier answer, or that answer says it is not needed |

The report also lists the gaps, in mission order, and whether the case is complete. A later answer to the same question replaces an earlier one. The agent receives this report in `case_get_context`, and people see the same list on the case page and the mission page.

## The Verification Employee (built: step 2)

One employee serves every mission. It is data, stored by the platform (not by any client), and a saved version never changes.

| Part | What it holds |
|---|---|
| Identity | name, purpose, persona and tone |
| Standing instructions | how it works: the rules of the job |
| Knowledge | organisation-wide facts every mission can rely on |
| Guardrails | reminders of what it must never do (the platform enforces the real limits whatever is written) |
| Escalation rules | when it hands a case to a person |
| Memory policy | what it may remember between runs |
| Allowed tools | the only tools it is offered. The gateway refuses any other, even if the model asks, and the limit travels in the signed session token |
| Run limits | model (leave out for the platform's pinned one), effort, most turns, most spend per run |

**Who sets it up:** administrators and agent operations (the platform staff for now). Clients never create an employee.

**Which employee does a mission:** a mission names an `employee_id` and may pin an exact `employee_version`. Without a pin it follows the employee's **current** (newest) version, so a fix to the tone reaches every mission at once. Saving a mission checks that the employee exists. To roll back, add a new version that copies the old one.

**What the agent is told**, in layers (the Employee tab shows the exact text for any mission):

1. **Platform rules** (every employee, never editable by an employee or mission).
2. **The employee** (identity, persona, instructions, guardrails, escalation, knowledge, memory).
3. **The mission** (objective, what must be known, suggested approach, programme name, approved templates, working notes).
4. **The case**: not in the instructions. The agent reads it through a tool, so one person's details never sit in a shared prompt.

Layers 1 and 2 are identical for every mission, and layer 3 is identical for every case of a mission, so each is sent as a **cached** block. The mission brief is preloaded, so the agent no longer spends calls reading it. On a synthetic case this took a full run from 6 tool calls to 4 and from about 6 cents to about 4 cents at indicative rates.

## The autonomy dial, approvals and replay (built: step 4)

Everything the agent sends or places goes through one door, the outbox, and the **autonomy dial** decides what happens there.

| Action type | Default | Meaning |
|---|---|---|
| WhatsApp template | automatic | approved wording chosen by the agent |
| WhatsApp interview question | automatic | the interview runner's own approved questions |
| WhatsApp message written by the agent | a person approves first | not used yet; the dial is ready for it |
| Phone call | a person approves first | the agent asks for a call; nothing rings until someone approves |

- A held action is not sent. The agent is told it was held and ends its turn. People see it on the **Approvals** page (and in the case drawer) with the person, the reason and what the call will ask.
- **Approve** releases it to the next scheduler pass. Before releasing, the platform checks again that the person may still be contacted (not opted out, case not closed) and that it is inside the contact hours, so a late approval never rings someone at a bad time. A scheduled call (with its own start time) skips the hours check.
- **Decline** cancels it and sends the case to a person, so a case never waits for contact that will not come.
- Ten approvals and no refusals for an action type earns a suggestion on the Controls tab that it could go automatic. Moving the dial is always a person's click.
- Only administrators and agent operations move the dial. Reviewers, administrators and agent operations approve.

**Decision traces.** Every tool call in an agent session records what the platform did with it (ran, held, refused), which version of the case the agent was looking at, and what woke the agent (first run, a reply, a timer). **Replay** re-checks each recorded action against today's rules without sending or changing anything: a withdrawn template, an opt-out, the kill switch or a moved dial shows up as "changed". Replay does not re-run the model, which is not repeatable; model replay arrives with the simulated participants in step 6.

## Waking, memory, limits and the kill switch (built: step 5)

**Wake service.** The agent never waits in a process.
- Sending a WhatsApp message starts a **silence timer** (the mission's follow-up hours, 48 by default). If the person has not replied when it comes due, the agent is woken and told why. If they replied, or the case closed, the timer is simply dropped.
- The agent can set its own wake-up with `callback_schedule`; a newer one replaces the older.
- Timers are acted on by the scheduler pass (`tick`), so a Catalyst Cron must call it. At most six wake-ups per case by default, then a person is asked to look.

**Memory.** One tool, `memory_note`, with four fixed keys (best time to call, preferred channel, preferred language, short-contact preference) and fixed values. Nothing else can be stored, so memory cannot hold a name, a number, a health detail or an instruction a participant slipped in. It belongs to the case and is erased with it.

**Limits and the kill switch** (Controls tab; the agent cannot read or change them):
- The agent will not start when the **daily spend** (last 24 hours, real sessions) or the **spend on one case** reaches its limit, checked before any model call. A case over its limit goes to a person; the daily limit holds all agent work until it falls.
- The **kill switch** stops every send, every call, every campaign and every wake-up, while replies are still recorded. Operators may press it, as stopping is always safe. Anything already queued goes out when it is switched back on, so look at the queue first.
- Participant text sent to the small reply-reading model has phone numbers, e-mail addresses and ID numbers masked first. Replies are only ever mapped to a fixed set of intents, never obeyed.

Not yet: spend by the reply-reading model is not counted in the daily limit; memory is per case, not per person across missions (comes with the contact budget per person); the daily-spend check reads all sessions and will need an index at 10,000 cases.

## The plan (what is built and what is next)

| Step | Delivers | Status |
|---|---|---|
| 1 | Goal model: evidence needs, question bank mapped to them, strategy hints. Current questions migrated. | **Built** |
| 2 | Employee record (versioned) and layered context; mission assigned an employee | **Built** |
| 3 | Tool manifests with simulator twins; channel-neutral actions that each carry a reason; contact budget per person across missions | **Phone call part built** (see [VOICE.md](VOICE.md)): the call action with a reason, the simulator twin, the form generated from a mission, results into evidence. The rest is planned |
| 4 | Autonomy dial per action type (approve first, then automatic) and decision traces that can be replayed | **Built** (see below) |
| 5 | Wake service (events and timers), fast path for routine replies, agent planner, structured memory, cost caps, kill switch | **Built** (see below). The fast path already existed (rules first, a small model only for unclear replies); redaction before any model call is new |
| 6 | Simulated participants, evaluation set, shadow mode | Planned |
| 7 | ZoLabs as a tool, including "call result unclear, so confirm on WhatsApp" | Adapter built and tested against a stand-in; waiting for a service credential and a real payload |
| 8 | Employee and mission consoles, sign-in and per-client isolation, UAT | Planned |

The interview runner stays as a **guided mode** and later becomes a tool the agent can call (`interpret_reply`).

## Decisions taken

1. Direction agreed: goal-based missions and a fast path for routine turns.
2. Autonomy dial starts at **approve first** for free-text messages and calls.
3. Participant replies **may be sent to the model**. Redaction and injection resistance are built into step 5.

## How we will know it works

Verification rate, cost per verified case, share of cases needing a person, time to verify, opt-out and complaint rate, and how often an auto-closed case was later overturned.

## The three layers are configuration (Claude engine page)

What the agent is told is built from three layers, and each one is saved as data in versions that never change:

| Layer | Where to edit | Who | What a new version does |
|---|---|---|---|
| 1. Platform rules | Claude engine, Platform tab | admin, agent operations | The newest version applies to every employee and every mission at once. The built-in `PL-1.0.0` is always there. |
| 2. Employee | Claude engine, Employees tab (a form: new employee, or new version of one; tools are tick boxes) | admin, agent operations | A mission follows an employee's newest version, or pins an exact one. |
| 3. Mission | Create a mission (plain language), with an Employee picker under Settings | admin | Signed off into its own immutable version. |

- The platform text is data, but the real safety rules are still enforced by the gateway and the contact policy, whatever the text says. A platform version must tell the agent that it acts only through tools.
- "What the agent is told" (Employees tab) previews the assembled text for any mission, and `?platform_version=` previews an older version. Each agent session records the platform version it ran under.
- API: `GET/POST /api/platform`, `GET/POST /api/employees`, and `employee_id` / `employee_version` in a mission brief.
