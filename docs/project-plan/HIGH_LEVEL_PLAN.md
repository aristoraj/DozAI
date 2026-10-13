# DozAI high-level plan

23 major tasks, each with a visible outcome. It is a roll-up of the detailed plan (183 tasks): every detailed task belongs to exactly one high-level task, and the dates, hours and status below are calculated from it. The detailed task IDs are listed in the CSV so they can be kept as subtasks.

Import `dozai_high_level_tasks.csv` into Zoho Projects or Sprints the same way as the detailed file (map Task Name, Description, Owner, Priority, Status, Start Date, Due Date, Duration, Work Hours, Item Type). "Visible Outcome" is also written inside the description, so nothing is lost if that column is not mapped.

| ID | Task | Owner | Status | Window | Visible outcome when finished |
|---|---|---|---|---|---|
| H01 | Project governance and setup | Tech Lead | In Progress (2/11 done) | 6 Oct 2026 to 16 Oct 2026 | Zoho project running with this plan, a repository where nothing merges without review and a green build, and Development, UAT and Production environments created. |
| H02 | Architecture and technology decisions | Tech Lead | In Progress (7/14 done) | 7 Oct 2026 to 20 Oct 2026 | A signed architecture pack: the decision record for the agentic design, the cost model, the consent and data-policy decisions and the test strategy. |
| H03 | Agentic design: Verification Employee, mission and tools | Tech Lead | Open | 13 Oct 2026 to 22 Oct 2026 | Approved specifications for the Verification Employee, the mission, the four context layers and the tools master, plus a written recommendation on the agent runtime. |
| H04 | UX and screen design | Developer A | Open | 20 Oct 2026 to 26 Oct 2026 | Approved screen designs (clickable mockups) for every new screen. |
| H05 | Interview questions signed off (English and Hindi) | Programme Team | Open | 13 Oct 2026 to 9 Nov 2026 | One signed-off interview instrument document in English and Hindi, ready to load as a mission. |
| H06 | Core platform (built) | Tech Lead | Closed | 9 Oct 2026 to 12 Oct 2026 | A live app on Catalyst: sign in, import people, see cases, review queue, audit trail, delete a case. |
| H07 | Database: Data Store, indexes, backups and retention | Tech Lead | Open | 5 Nov 2026 to 2 Dec 2026 | A database that stays fast with 10,000 cases, with scheduled backups, a tested restore and working retention rules. |
| H08 | Authentication, tenancy and roles module | Developer A | Open | 15 Oct 2026 to 30 Nov 2026 | Staff sign in with a work account, an admin adds users in the app, and two test clients cannot see each other's data. |
| H09 | Missions and campaigns module | Developer A | In Progress (5/9 done) | 12 Oct 2026 to 17 Nov 2026 | An admin creates a mission, imports participants and starts a campaign; first messages go out by themselves every minute with progress, pause and retry visible. |
| H10 | Agent 1: Verification Employee (the core agent) | Developer B | Open | 26 Oct 2026 to 21 Dec 2026 | For any case the employee decides the channel and next action, shows its reason in the case history, stays inside consent, hours and cost limits, and can be stopped with one switch. |
| H11 | Agent 2: Interview runner and reply reader (built) | Developer B | In Progress (2/3 done) | 11 Oct 2026 to 26 Nov 2026 | A participant's reply on WhatsApp is understood and the right approved question or answer comes back; the 30-conversation set passes. |
| H12 | Integrations: WhatsApp and ZoLabs | Developer B | In Progress (6/18 done) | 10 Oct 2026 to 14 Dec 2026 | A real participant completes a WhatsApp interview and a real ZoLabs call places and returns answers that are saved as evidence. |
| H13 | Admin consoles module: employees, missions and simulator | Developer A | Open | 9 Nov 2026 to 23 Dec 2026 | EdZola staff create an employee and a mission from screens with no JSON, test them in a simulator and publish. |
| H14 | Cases, review and reports module | Developer A | Open | 26 Nov 2026 to 18 Dec 2026 | A reviewer sees one page per case with the full timeline and reasons, and the programme team sees funnel and outcome reports they can export. |
| H15 | Supporting minor modules: alerts, monitoring, notifications, accessibility | Developer A | In Progress | 9 Nov 2026 to 24 Dec 2026 | Alerts reach the right person (paused campaign, failed sends, scheduler down), an operations dashboard and runbooks exist, and the app passes an accessibility check. |
| H16 | Security and compliance | Tech Lead | Open | 2 Nov 2026 to 24 Dec 2026 | A penetration-test report with no open high findings, personal data unreadable in a database export, and the pilot client's agreement signed. |
| H17 | Scale and cost control | Tech Lead | Open | 16 Oct 2026 to 24 Dec 2026 | A measured cost per verified case with a monthly forecast, and a load-test report at 10,000 cases. |
| H18 | Testing and quality assurance | QA Lead | Open | 26 Oct 2026 to 28 Dec 2026 | A test report: the automated suite green in CI, agent evaluations above the pass mark, voice and Hindi test matrices passed and the real-WhatsApp checklist signed. |
| H19 | UAT environment, training and 25-case pilot | Product Lead | Open | 23 Nov 2026 to 8 Jan 2027 | The 25-case pilot completes with a pilot report, and the UAT sign-off is signed by the programme team and the product lead. |
| H20 | Production readiness and go-live | Tech Lead | Open | 8 Dec 2026 to 12 Jan 2027 | The production system is live and the first real campaign completes, with testing switches refused at start-up and a rehearsed rollback. |
| H21 | Hypercare and handover | Tech Lead | Open | 21 Dec 2026 to 28 Jan 2027 | Two weeks without a high defect, a documentation set delivered, the support team handling a mock incident alone, and the closure sign-off signed. |
| H22 | Roadmap after go-live (next release) | Product Lead | Open | 29 Jan 2027 to 15 Feb 2027 | A prioritised, estimated roadmap for the next release, approved by the product lead. |
| H23 | Wednesday demo: dry configuration | Tech Lead | Open | 13 Oct 2026 to 14 Oct 2026 | A working demo on Wednesday: a case runs from import to the review queue with the configured WhatsApp, agent and ZoLabs. |

## How the groups follow your list

- Design and architecture: H02 architecture, H03 agentic design, H04 UX and screens, H05 interview questions.
- Governance: H01.
- Database creation: H07.
- Modules: H06 core platform, H08 authentication and tenancy, H09 missions and campaigns, H13 admin consoles, H14 cases, review and reports.
- Multiple minor modules: H15 (alerts, monitoring, notifications, accessibility).
- Agent building, one task per agent: H10 Verification Employee, H11 interview runner and reply reader. The campaign scheduler is part of H09 and the ZoLabs voice agent is part of H12.
- Integration of ZoLabs and WhatsApp: H12 (one task, as asked).
- Testing: H18.
- Also needed so nothing is missing: H16 security and compliance, H17 scale and cost, H19 UAT and pilot, H20 go-live, H21 hypercare and handover, H22 roadmap, H23 Wednesday demo.

## Things to know

- H10, the Verification Employee, is the largest task (about 290 indicative hours across 17 detailed tasks). Keep its detailed tasks as subtasks so progress stays visible.
- H12 is partly done: WhatsApp works on real phones, ZoLabs is untested. It stays In Progress until a real call returns answers.
- Dates and hours are rolled up from the detailed plan, so the capacity warning in PROJECT_PLAN.md applies here too: the dates follow dependencies, not the number of people.
- H05 (interview questions) and H19 (pilot) are the two tasks that depend on people outside the engineering team.
