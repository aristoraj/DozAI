# DozAI project plan: design to production

Generated from the current state of the build (12 October 2026). 183 tasks in 17 milestones, written to be imported into Zoho Projects or Zoho Sprints.

## Files

| File | What it is |
|---|---|
| `dozai_milestones.csv` | 17 milestones with description, dates, task counts and indicative hours |
| `dozai_tasks.csv` | 183 tasks with description and a "Done when" test, owner role, priority, status, dates, duration, hours, dependencies, tags, item type and sprint |

## How to import

**Zoho Projects**
1. Create the project, then import `dozai_milestones.csv` (Milestones) so the 17 milestones exist.
2. Import `dozai_tasks.csv` (Tasks > Import). The "Task List" column creates one task list per milestone. Map the columns on the mapping screen: Task Name, Description, Owner, Priority, Status, Start Date, Due Date, Duration, Tags, and Work Hours if offered.
3. The dates are written as yyyy-mm-dd. If your portal expects another format, change the format in the import screen or in the portal settings before importing.
4. Owners are role labels (Tech Lead, Developer A, Developer B, Product Lead, Programme Team, QA Lead, Admin / IT, Whole team). Replace them with real people after import, or map them to users on the mapping screen.
5. "Depends On" holds task IDs (T001 style) separated by semicolons. If your import does not take dependencies, keep the Task ID column as a custom field and set dependencies from it, or use it as a reference when you link the key chains below.

**Zoho Sprints**
1. Import the tasks as backlog items (the "Item Type" column is Story or Task) and map Priority, Status, Description and Tags.
2. The "Sprint" column says which two-week sprint each task starts in. Create the sprints (dates in the table below) and move items by that column. Closed items belong to "Sprint 0 (done)", so import them as completed or skip them.

Status values used: **Closed** (already done), **In Progress**, **Open**. Map them to your own status names.

## Milestones

| Milestone | Window | Tasks | Not done | Indicative hours |
|---|---|---|---|---|
| M0 Project Setup and Governance | 6 Oct 2026 to 16 Oct 2026 | 10 | 8 | 46 |
| M1 Discovery and Design | 7 Oct 2026 to 9 Nov 2026 | 20 | 13 | 185 |
| M2 Foundation (Walking Skeleton) | 9 Oct 2026 to 12 Oct 2026 | 12 | 0 | 112 |
| M3 WhatsApp Channel | 10 Oct 2026 to 26 Nov 2026 | 15 | 7 | 133 |
| M4 Missions and Campaigns | 12 Oct 2026 to 11 Nov 2026 | 8 | 3 | 58 |
| M5 Agentic Core (Verification Employee) | 13 Oct 2026 to 21 Dec 2026 | 20 | 20 | 346 |
| M6 ZoLabs Voice Channel | 13 Oct 2026 to 14 Dec 2026 | 9 | 9 | 134 |
| M7 Authentication, Tenancy and Roles | 15 Oct 2026 to 30 Nov 2026 | 8 | 8 | 124 |
| M8 Admin UI: Employees, Missions, Reporting | 9 Nov 2026 to 24 Dec 2026 | 10 | 10 | 228 |
| M9 Scale, Data and Cost | 16 Oct 2026 to 24 Dec 2026 | 10 | 10 | 138 |
| M10 Security and Compliance | 2 Nov 2026 to 24 Dec 2026 | 11 | 11 | 116 |
| M11 Operations and Monitoring | 9 Nov 2026 to 9 Dec 2026 | 6 | 6 | 61 |
| M12 Quality Assurance | 26 Oct 2026 to 28 Dec 2026 | 9 | 9 | 130 |
| M13 Pilot and UAT | 23 Nov 2026 to 8 Jan 2027 | 11 | 11 | 163 |
| M14 Production Readiness and Go-Live | 8 Dec 2026 to 12 Jan 2027 | 10 | 10 | 55 |
| M15 Hypercare and Handover | 21 Dec 2026 to 28 Jan 2027 | 6 | 6 | 109 |
| M16 Roadmap (After Go-Live) | 29 Jan 2027 to 15 Feb 2027 | 8 | 8 | 290 |

Hours are indicative effort estimates, not commitments.

## Key dates (as scheduled by dependencies)

| Moment | Window |
|---|---|
| Wednesday demo: dry configuration | 13 Oct 2026 to 14 Oct 2026 |
| Architecture decision: agentic design | 13 Oct 2026 to 14 Oct 2026 |
| Interview instrument signed off (programme team) | 13 Oct 2026 to 9 Nov 2026 |
| Verification Employee record built | 26 Oct 2026 to 30 Oct 2026 |
| Agent-driven interview loop | 4 Dec 2026 to 15 Dec 2026 |
| 25-case pilot | 16 Dec 2026 to 22 Dec 2026 |
| UAT sign-off | 6 Jan 2027 to 6 Jan 2027 |
| Production smoke test and first live campaign | 11 Jan 2027 to 12 Jan 2027 |
| Hypercare | 13 Jan 2027 to 26 Jan 2027 |
| Project closure | 28 Jan 2027 to 28 Jan 2027 |

## Sprints

Two-week sprints starting Tuesday 13 October 2026. Sprint 6 runs across the year-end break, so expect little progress that fortnight.

| Sprint | Tasks starting | Indicative hours |
|---|---|---|
| Sprint 0 (done) | 35 | 251 |
| Sprint 1 | 27 | 237 |
| Sprint 2 | 13 | 256 |
| Sprint 3 | 26 | 460 |
| Sprint 4 | 33 | 420 |
| Sprint 5 | 24 | 291 |
| Sprint 6 | 8 | 126 |
| Sprint 7 | 6 | 88 |
| Sprint 8 | 11 | 299 |

## The chain that decides the end date

1. Agentic design decision and the Verification Employee and mission specifications (Sprint 1).
2. Employee record, context builder and case digest, then tools and guardrails (Sprints 2 and 3).
3. Wake mechanism, then the agent-driven interview loop (Sprint 4 and 5).
4. Pilot (needs the signed-off questions, the approved templates, the UAT environment and the voice results), then UAT fixes, sign-off and go-live.

The interview instrument is the long pole on the programme side: 34 questions in English and Hindi with sign-off, which blocks loading the pilot mission.

## Read this before committing dates

- **The dates follow dependencies only. They do not account for how many people there are.** Tasks that can run in parallel are shown in parallel, even when the same person owns both.
- **Open work by owner, excluding the after-go-live roadmap** (indicative hours): see the table below. Developer A carries about 500 hours and the tech lead about 370 hours between now and a mid-January go-live, roughly 11 working weeks once year-end is taken out. At 25 to 30 focused hours a week, one person does about 275 to 330 hours in that time.
- So either the go-live moves later (roughly Q2 2027 at that pace), the scope is cut, another developer joins, or the estimates turn out smaller because of AI-assisted development. **Re-baseline after Sprint 1 using the real velocity** and move dates before the client sees them.
- Dependency dates assume no delay from outside: Meta template approvals, ZoLabs API behaviour (not yet tested), programme-team sign-offs and the legal paperwork.

| Owner (open work) | Indicative hours |
|---|---|
| Tech Lead | 411 |
| Developer A | 580 |
| Product Lead | 134 |
| Programme Team | 114 |
| QA Lead | 170 |
| Admin / IT | 57 |
| Developer B | 520 |
| Whole team | 192 |

## Assumptions

- Team: tech lead, Developer A (web app, authentication, Zoho-side work), Developer B (agent, channels and tools), plus product lead, programme team and QA. Role names are placeholders.
- Everything marked Closed is already built and live in the development project, with 210 automated tests passing.
- Decisions still open (they gate Sprint 1 and 2): one employee for all missions or one per mission; whether the agent may write its own message text; whether participant replies may reach the model; Managed Agents or our own tool loop; reminder policy; who owns escalations; Meta Cloud API versus Interakt long term.
- The after-go-live roadmap (email, SMS, connectors, multi-agent, client self-service, new missions, more languages) is scheduled after closure and is not part of the first release.
- Year-end holidays are not removed from the calendar.

## Milestone checklist (nothing skipped)

Project setup and governance, discovery and design, foundation, WhatsApp, missions and campaigns, agentic core, voice, authentication and tenancy, admin UI, scale and data, security and compliance, operations and monitoring, quality assurance, pilot and UAT, production readiness and go-live, hypercare and handover, roadmap.
