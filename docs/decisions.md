# Decisions

Each entry: what we decided, why, and the option we did not take.

## Custom dropdowns replace every native `<select>` (apps/web/src/select.js)

- **Decision:** One small module turns each `<select>` into a styled button plus a popup list. The real `<select>` stays hidden inside it.
- **Why:** The browser's own dropdown cannot be styled and looks different on every system. Keeping the real `<select>` means existing code that reads `.value` or listens for `change` did not need to change, and the existing UI tests still pass.
- **How new selects get styled:** The app redraws whole screens from HTML text. A `MutationObserver` (a browser feature that reports when the page changes) finds new selects and styles them, so no screen needs to call anything.
- **Rejected:** Rewriting every select by hand in `main.js` (13 places, easy to miss a new one later). Also rejected: a UI library, which would add a dependency for one small job.
- **Popup placement:** The list is attached to `<body>` and positioned from the button, so the modal and drawer (which scroll) cannot clip it. It opens upward when there is more room above.
- **Escape key:** The dropdown handles Escape itself and stops it there, otherwise it would also close the dialog behind it.

## Custom number fields keep the real `<input type="number">` (apps/web/src/number.js)

- **Decision:** The browser's up/down arrows are hidden with CSS. Two small "−" and "+" buttons are added inside the field. They call the input's own `stepUp()` / `stepDown()`, then fire `input` and `change`.
- **Why:** The input still handles typing, arrow keys, and its `min`, `max` and `step` rules, so no new logic was written. The app reads these fields through the `input` event and `.value`, so both still work.
- **Rejected:** Replacing the input with a plain text box and checking the number ourselves. It would lose the browser's built-in limits and the mobile number keyboard.
- **Limits:** A button is greyed out when the value reaches `min` or `max`.

## One type scale for the whole UI (apps/web/src/styles.css, top of the file)

- **Decision:** Every font size, weight and letter spacing comes from a short list defined once at the top of `styles.css`. No rule uses a raw `px` size (the only exceptions are the logo wordmark and the phone's three-dot menu).
- **Why:** Before this there were 18 different sizes (6px to 31px) and 7 weights, and 66 inline styles in `main.js` used larger sizes than the stylesheet, so similar text looked different on different screens. 91 rules used 6 to 9px, which is hard to read.
- **The scale:** smallest size is 11px.

| Name | Size | Used for |
|---|---|---|
| `--fs-xs` | 11px | Labels, status pills, table headers, captions |
| `--fs-sm` | 12px | Secondary text, descriptions, table cells, names in lists |
| `--fs-md` | 13px | Body text, inputs, buttons |
| `--fs-lg` | 15px | Card titles (h3) |
| `--fs-xl` | 20px | Section titles (h2) and large figures |
| `--fs-2xl` | 28px | Big numbers on the overview cards |
| `--fs-h1` | 26 to 36px | Page title, adjusts to screen width |

- **Weights:** 600, 700, 800 (and normal). **Letter spacing:** `tight` for big headings and figures, `caps` for UPPERCASE labels, `wide` for the small eyebrow labels.
- **How it was applied:** The old hierarchy was kept but compressed (6 to 9px became 11px, 10 to 11px became 12px, 12 to 13px became 13px). Descriptions and names in lists were moved up one step from captions, so they read as text and not as fine print.
- **Rejected:** A smaller scale with a 10px minimum. It would keep the denser look but stay hard to read and below common accessibility guidance.
- **Markup built in `main.js`:** Text size, font and colour no longer live in inline `style="..."`. 68 tags now use small helper classes from `styles.css`: `t-xs`, `t-sm`, `t-md`, `t-lg` (sizes from the scale), `t-regular`, `muted`, `danger-text`, `mono`. The size and weight helpers use `!important` because inline styles used to beat the stylesheet, and the helpers must keep doing so. Layout-only inline styles (margins, flex, widths) were left alone. One text style is still inline on purpose: a 700 weight with a colour that is chosen in code.
- **Base rule for `<small>`:** Without one the browser picks 10px or 10.8px. `small { font-size: var(--fs-xs) }` fixes all of them.
- **How to check it stays true:** Open each screen and read the real font size of every piece of text in the browser. A one-off script did this across 17 screens and dialogs, at 1440px and 390px wide. Only 11, 12, 13, 15, 20, 28 px, the page title and the logo showed up.

## One look for every field, a custom checkbox and a custom file picker (styles.css, apps/web/src/file.js)

- **Decision:** Text boxes, text areas and number fields share one look (border, radius, padding, hover, teal focus glow, disabled, placeholder), defined once under "Form controls" in `styles.css`. It is written with `:where()`, which gives it the lowest priority, so a specific rule (the search box, the number field) can still change one thing without fighting it.
- **Checkbox:** drawn in CSS (`appearance: none`, a tick that scales in). It is still the real checkbox, so keyboard, labels and form behaviour are unchanged.
- **File picker:** `file.js` hides the browser's "Choose file / No file chosen" and shows the same small button the rest of the app uses, plus the file name. The real `<input type="file">` stays hidden inside, so `.files` and the `change` listener work as before, like the dropdown and the number field.
- **Why:** before this, four different rules each styled a text box in their own way, the simulated-reply box used inline styles, and the checkbox and file input were the browser's own.
- **Rejected:** replacing each input by hand in `main.js`. Screens are redrawn from text, so the controls are found and styled automatically instead.
- **Small tables in small cards scroll sideways instead of squeezing.** At the new text sizes the Phone forms table put one word of the mission name on each line and clipped a column. Tables in these cards now have a minimum width, and their headers never wrap.


## The left panel follows the workflow (apps/web/index.html)

- **Decision:** The navigation is grouped by the order work actually happens, with small section labels. Command centre stays on top as the home page, with no label.

| Section | Items | Why it comes here |
|---|---|---|
| *(top)* | Command centre | Home: what is moving and what needs a person |
| Set up | Mission, Claude engine | Decide what is asked and who (the agent) asks it, before anyone is contacted |
| Reach people | Cases, Campaigns | Load the participants, then send the first message |
| Follow up | Approvals, Phone calls, Review queue | The agent asks for a call, a person approves it, the call is placed, then a person decides the outcome |
| Record | Audit trail | The history of everything above |

- **Nothing was renamed or removed.** All 9 items, their counts (cases, approvals, review queue), the active highlight and the phone menu are unchanged. The section labels are not buttons, so they cannot be clicked by mistake.
- **Why:** Before, the order was Cases, Campaigns, Review queue, Approvals, Phone calls, Claude engine, Mission, Audit trail. That put "Mission" (the first thing you do) near the bottom and "Review queue" before the approvals and calls that lead to it.
- **Rejected:** hiding rarely used items behind a "More" menu. Nine items is few, and a hidden item is a lost item.
- **Size:** the labels made the panel taller, so spacing was tightened slightly and the panel scrolls on very short screens. On a 900px-high screen everything fits.

## Phone calls page: status first, calls as rows, forms as a list (apps/web/src/main.js, `renderCalls`)

- **Decision:** The page now reads top to bottom as: a strip of four small tiles (Connection, Calls, Who can be called, Finished calls), then the calls, then the phone forms.
- **Calls as rows, not a six-column table.** Each call is one row: status, person (opens the case), what was asked and why, when it was requested and how long it lasted. The recording and transcript sit underneath. A row of small counts (scheduled, in progress, completed, not answered, failed) shows only what exists.
- **Forms as a list.** Each row shows the mission, its state, when and by whom it was published, and a "Preview or publish" button that now opens **that** mission. Before, one button went to the Mission page in general.
- **Calls come before forms** because calls are checked every day and a form is set up once per mission.
- **Quiet rows.** "No recording" appears only on a completed call, where one was expected, and "Length" only when there is one.
- **Nothing was removed:** the connection check and its result, calls on or off, who can be called, the finished-call mode, the recording player, the transcript, and the live refresh of calls in progress all work as before.
- **Why:** The old layout squeezed a table into a narrow card (the mission name wrapped one word per line and a column was hidden), led with setup instead of the calls, and left a tall empty area.
- **Not changed:** the recording player is the browser's own audio control. A custom player would be a separate piece of work.

## The Mission field in "Add participants" is always shown (apps/web/src/main.js, `openImportModal`)

- **Decision:** The dialog always shows which mission the participants will join. With one mission it shows that mission and adds "Only one mission exists at the moment." With two or more it is a dropdown to choose from.
- **Why:** The field used to appear only once a second mission existed. It seemed to come and go (for example after the local dev server restarted and forgot the missions that were created), and people could not tell which mission they were adding people to.
- **Nothing else changed:** the default mission is still pre-selected and sent with the import, as before.

## One mission filter on the Command centre (apps/web/src/dashboard.js, `renderOverview` in main.js)

- **Decision:** A single dropdown filters the whole Command centre by mission. It lives in its own slim bar under the greeting and above the numbers, because it controls what is below it. The header keeps only the main action ("Add participants"). The first option is "All missions" (what the page always showed). Then one option per mission.
- **The bar:** "Mission [dropdown]", a **Clear** link that appears only when a mission is picked, and a line saying what is shown ("Showing all 17 participants", "Showing 12 of 17 participants"). A picked mission gives the box a soft teal tint, so it is obvious the page is filtered. The bar is updated in place, so the open dropdown and the motion are not disturbed.
- **The button shows the mission's name only.** The open list shows each mission on two lines: the name, then a quiet "MSN-001-v1.3 · 12 participants". This uses a general feature of the custom dropdown: an `<option>` may add `data-short` (shorter wording for the button and the first line) and `data-sub` (a second line). Dropdowns that do not use them are unchanged.
- **What follows the filter:** the four number cards, the progress bars, the outcomes donut and its legend, "Needs attention" (that mission's review and waiting cases, its paused campaigns, its signed-off state) and "Recent activity" (events on that mission's cases). "WhatsApp sending is off" stays, because it is a platform setting, not a mission's.
- **Counted in the browser, from the cases already loaded.** The server's summary is six counting rules over the cases. `summarize()` repeats those six rules and applies them to one mission's cases. No backend change, no new endpoint, and switching is instant. A test runs the page against the real backend and requires the rules to give exactly the server's own `/api/summary` for "All missions", and requires the missions' counts to add up to the total.
- **Rejected:** a `?mission_version=` option on the server summary. It keeps one source of truth, but it adds a wait on every change and the lists would still be filtered in the browser. **Limit:** this relies on the page holding every case. If the case list is ever paginated for very large cohorts, the filter needs a server-side version.
- **A case with no mission belongs to the first mission,** which is how the server already counts it.
- **Recent activity** can only use the latest 300 events the page loads, so a quiet mission may show few or none. It says "No recent activity for this mission."
- **A mission with no participants** shows "No participants in this mission yet", and the filter stays so you can switch back.
- **Motion:** numbers count to their new value over about half a second, the donut slices glide, the bars slide (a CSS width transition), and the two lists fade and slide briefly. Only opacity, position and width move. If you change the filter part-way through, it continues from where it is. If the person's system asks for less motion, everything changes instantly. The page is updated in place (not redrawn), which is what lets it move, and it is redrawn only when its shape changes (empty or not).
- **Accessibility:** a hidden live line announces the result ("Showing 5 participants for Placement Check.").

## The "Create a mission" form (Mission Studio): clearer, same behaviour (apps/web/src/main.js, `openStudioModal`)

- **Decision:** Only the form screen was redesigned. The drafting call, the field ids, the draft screen and what is saved are unchanged.
- **What changed:**
  - **Steps:** a step bar (Describe, Draft, Read, Save) shows where the person is.
  - **Privacy note:** a visible note says to describe the programme, not people. It used to be in the subtitle.
  - **Sections:** About the mission, What it is for, Tone and style. Hints sit under each label, not under the box.
  - **Text boxes:** they grow as you type, and show a live count (amber while the text is too short to be accepted).
  - **Settings:** the optional settings (which mission to copy the first message, rules and employee from, attempts, contact hours) are folded away behind one line that summarises them. Contact hours are time dropdowns, not two bare numbers.
  - **Buttons:** Cancel and "Draft the mission" stay in view while only the middle scrolls.
  - **Problems:** a missing or too-short field is named in plain words at the top before anything is sent. The server still checks the same limits.
  - **While drafting:** the form is locked and dimmed, a thin progress bar runs under the header, and the note says it can take a minute. There are no invented progress steps, because the draft is one request and we cannot know how far along it is.
- **The limits are copied from the server's brief schema** (name 3 to 100, goal at least 20, people at least 10, and so on). If the schema changes, the form's copy needs the same change.
- **Not changed on purpose:** the "Read the draft" screen, which still shows internal names and keeps "Edit as JSON" beside Save.

## The case panel (right-hand drawer) has a header, a summary and four tabs (apps/web/src/main.js, `openCase`)

- **Decision:** The panel was one long scroll. It is now a header, a short summary, the next step, and four tabs: Overview, Conversation, Phone calls, Activity. The data, the buttons and every element id are unchanged.
- **Header:** initials avatar, case id, batch and place, and a coloured status pill.
- **Summary:** status, outcome and a confidence bar, then one card with the next permitted action and the buttons that act on it.
- **Tabs:** the tab bar sticks to the top while a tab scrolls. Conversation, Phone calls and Activity show a count once their data has loaded; an empty tab shows none.
- **Staying put:** if the same case is refreshed (for example after sending a reply), you stay on your tab. Opening a different case starts on Overview.
- **Keyboard:** Left, Right, Home and End move between tabs. On a phone the tab bar scrolls sideways and keeps the chosen tab in view.
- **Delete case:** moved to a danger zone at the bottom of Overview, away from the everyday buttons.
- **Width:** `min(560px, 94vw)`.

## Reading free-text replies on WhatsApp (packages/core/src/classifier.ts, conversation.ts, packages/adapters/src/classifier.ts)

- **Decision:** Improve the reader we have, in place. No new path, and the mission JSON, the evidence keys and the API are unchanged.
- **A number is a pick only when it stands alone.** "2 months ago I left my job" used to select option 2 because only the first word was looked at.
- **A label or synonym needs exactly one match and no turn-around.** "I do not work at the same place" used to match "same place".
- **Hindi, Hinglish and Devanagari.** Devanagari vowel signs were being thrown away when a reply was cleaned, so "हाँ" became one letter. They are kept now, Devanagari digits count as digits, and yes, no, stop, "I don't know" and "what do you mean" are understood in all three ways of writing. The yes/no options carry Devanagari words.
- **Not answers:** "no", "none", "nothing", a bare number and "I don't know" are never saved as a text answer. They are asked again, and the usual 2 re-asks then a hand-over still stops any loop.
- **A new intent, clarify.** "What do you mean?" repeats the same question with one fixed line. It counts as a re-ask so it cannot loop. Explaining or rephrasing the question is Step 2.
- **Several answers in one reply.** The reader returns the answer to the current question and answers to other fields, by evidence key. The runner keeps the others (in `ConversationState.held`, an optional field) and walks the flow: it saves an answer only when the question that wants it is reached by the answers so far. So an employer given while the status is still unknown is held, then used once the status is answered, and an employer given with "not working" is never saved. An answer already recorded is never replaced, and an already-answered field is not asked again.
- **Every answer is checked twice** (in the adapter, then in the runner) with `validateAnswer`: right type, a real option, real text that is not yes/no/"I don't know", not too long.
- **The model is asked less, and told more.** It is no longer asked for a plain pick or for stop / wrong person / distress / deletion. It is asked for sentences and for anything the rules cannot place. It gets the question, options, conditions, answers so far, the last three questions and answers, and the programme and objective.
- **The model must show its work.** Each answer carries the exact words it relied on, and the words (and, for text, the answer) must appear in the reply, or the answer is dropped. This stops a model from inventing or translating a name.
- **Confidence.** An answer under 0.6 is not used. A model's confidence is capped (0.85 choice, 0.7 text). A text answer typed straight into a text question still carries the old fixed 0.6, which is the lowest the requirement check accepts. That number is a convention, not a measurement.
- **Not changed:** the model is still off unless `DOZAI_CLASSIFIER=claude`. Nothing here turns on external processing. The model never writes to a participant.
- **"Last few messages" means** the last three questions asked and what was understood from each reply. The participant's own raw messages are not stored anywhere new.

## How the conversation sounds: thank-yous, gentler re-asks, "what do you mean" (packages/core/src/phrases.ts)

- **Decision:** Add a few fixed phrases around the approved questions. The questions, options, branching and the instrument's own messages are unchanged, and no model writes anything a participant sees.
- **Where the wording lives:** in code (`phrases.ts`), not in the mission JSON, so the mission schema does not change. A mission may be given its own wording later if the programme team wants to approve it per mission.
- **Thank-you:** after a saved answer when another question follows. Not on the first question (the start message already thanks them) and not on the closing message. Different words from one message to the next.
- **Re-ask:** the instrument's line stays first. A hint follows: gentle and showing both ways to reply the first time, plainer the second time. After the usual 2 re-asks a person takes over, as before.
- **"What do you mean":** how to reply, then the same question. It counts as a re-ask, so a participant who keeps asking is handed to a person and the conversation cannot loop. It does not explain the question's meaning, because explanations are mission content that someone has to approve.
- **Language:** English, and Hindi written in English letters, picked from the participant's language. The Hindi lines avoid gendered verbs. The wording was not reviewed by a Hindi speaker.

## WhatsApp and phone calls follow the same flow (packages/core/src/flow.ts, voice.ts)

- **Decision:** Keep the two descriptions of a mission (the questionnaire and the list of evidence needed), and check that they agree, instead of merging them. Merging would change the mission JSON.
- **The check:** every path through the questionnaire is listed, and for each one a call must ask the same keys in the same order. The built-in mission passes on all four branches, and the test would fail if either side drifted.
- **Where it is enforced:** Mission Studio drafts only, where a mistake is sent back to the drafter. Making it a rule for every saved mission was tried and rejected: it blocked saving existing and hand-written missions that branch without a list of needs, which changes what people may save. `channelFlowProblems` can be called on any mission to read the differences.
- **A call's answers follow WhatsApp's rules:** free text must be real text, an answer for a question this person would not be asked is dropped, and an unclear answer never replaces a clear one. These applied only to WhatsApp before. A voice answer whose condition cannot be checked yet is kept.
- **Not made identical:** wording and confidence. See docs/VOICE.md.

## Reviewing, editing and adding questions on screen (apps/web/src/questions.js, packages/core/src/questions.ts)

- **Decision:** Question management happens in the existing flow. Before the first save, edits are made to the draft in the browser and the one draft is saved. At sign-off, edits go into the mission being approved, through an optional `edits` on the sign-off request (see "Signing off approves the same mission" below). The mission JSON and its field names are unchanged.
- **The same screen twice.** One editor is used in the create flow and on the Mission page. Each question is a card with the WhatsApp wording and the phone wording side by side. The phone wording comes from the server (`POST /api/missions/check`), so it is never a second copy of the rule that turns a written question into speech.
- **"Edit as JSON" is gone from the create flow.** "Add from JSON" on the Mission page stays, as the way in for developers.
- **What can be edited:** wording on both channels, the wording of answer choices, and required or optional. Not the kind of answer, the saved value of a choice, the key, or the branching. Changing those can change what saved data means, so the way to change them is to remove the question and add a new one.
- **Remove** is safe by construction: it takes the question's "what to find out" entry with it unless another question still collects the same thing, sends branches past it, and keeps the flow of the questions before it (a question with no rule of its own goes to the next in the list, so taking one out of the list needed an explicit rule). A question other things depend on is not removed; the message says what depends on it.
- **Add** puts the question at the end, for everyone: every road that ended now ends with it. A new key is made from the wording and kept unique.
- **Repeats are checked in two places.** The browser warns while typing. The server decides: two questions are a repeat when they say the same thing (ignoring capitals and punctuation) or collect the same answer, and one person could be asked both. The same question on different branches is fine, which the built-in mission relies on (it asks for the employer on two branches). Mission Studio drafts are held to the same check, so the drafter is sent back to fix repeats.
- **The live check** is the same one a saved mission must pass, plus the WhatsApp/phone agreement check and repeats. It ignores the version name, so the built-in mission can be reviewed. Sign-off and save stay disabled while it reports problems.
- **Not built:** moving questions up and down, changing the kind of answer, editing the fixed messages or the answers to common questions, and editing branching on screen.

## Signing off approves the same mission, in place (packages/core/src/service.ts, `signOffMission`)

- **What was wrong:** Sign-off saved a COPY under a new name (`<version>-signed`). The unsigned original stayed in the list, so every sign-off looked like a duplicate mission, and the people already on the original stayed on unsigned wording. Nothing was triggered twice: it was the design.
- **Decision:** Sign-off approves the same mission. Same version name, same place in the list, no second mission. It records who signed and when (set by the platform, whatever the request says) and keeps the original creation time and author.
- **The one exception to "saved missions never change".** A mission can change exactly once, from draft to approved, and only through sign-off. After that it is read only: a second sign-off is refused (409), saving over it is refused, and a change is a new version. The store refuses to replace a mission that is already approved, so two sign-offs at once give one approval and one refusal.
- **Edits at sign-off** go into that one approval. Only the questions and the "what to find out" list can change that way. They are checked like a new draft first.
- **The built-in mission** is defined in code, so it has no stored copy to update. Its approved copy is stored under the same version name and is used from then on, in place of the code version, in every lookup and in the mission list. It is still the built-in mission: it cannot be deleted and its name cannot be used for another mission.
- **People already on the mission** follow the approved wording straight away. This is only acceptable because their wording was a draft; the change is limited to draft to approved, never one approved wording to another.
- **Caching:** approved missions are cached for good. A mission still being written, and the built-in one (which can be approved at any time), are read again after 5 seconds, so every copy of the server sees an approval within a few seconds.
- **The phone form** link is kept. The form shows as "out of date" because the mission changed, and is published again.
- **Not done:** no way to move people from an old version to a newer one, because nothing creates a newer copy any more.

## One way of showing that something is loading (apps/web/src/busy.js)

- **What was missing:** Most buttons that call the server gave no sign that anything was happening: a few said "Saving…", one screen had a bar, the rest did nothing, so people clicked again. Pages that wait for data said "Loading…" in plain text, in different ways.
- **Decision:** One mechanism, in one place, instead of a loader written by hand for each of about 45 actions. Every request goes through `api()`, which reports its start and end to `busy.js`. New buttons that call the server get the behaviour without any extra code.
- **The button that was just pressed is held.** It is disabled at once, so it cannot be sent twice (this also covers double clicks and a slow server). After a quarter of a second it shows a small spinner, so quick actions do not flash. It can swap its words ("Saving…") through a `data-busy-label` attribute. It is put back when the work is over, whether it worked or failed. Only real buttons of the app (class `button`) are held, never menu items, tabs or close buttons, and a button can opt out with `data-no-busy`.
- **A bar along the top** appears if any work takes longer than a third of a second, stays up through a chain of requests (save, then reload) instead of flickering, and after six seconds says "Still working… this can take a minute."
- **Confirm dialogs stay open while the work runs**, with their button saying so ("Signing off…") and Cancel disabled, and close when the work is done. Before, they closed first and nothing showed.
- **Areas waiting for data** (page loads, the case panel, the mission page opening its questions) use the same spinner and words.
- **Quiet on purpose:** the refreshes that run by themselves (the conversation every 5 seconds, the call check every 8 seconds) and the live check of the questions are marked `silent`, so they never look like work. Actions that finish at once show nothing.
- **Failure:** the end of a request is in a `finally`, so the button is released and the bar goes away on an error too. The reason still comes as a message.
- **Reduced motion:** the spinner and bar pulse instead of moving for people who ask for less motion.
- **Auto-opening the mission questions** will not retry by itself after a failure; the button comes back for a person to press. (A retry loop would have followed from showing a loading line.)
- **Not changed:** every API call and its contract, the layout of every screen, and the existing progress bar on the Create a mission draft step.

## The phone wording is read only, and questions are shown by category (questions.js, questions.ts, studio.ts)

- **The phone questions are not a separate list.** The voice agent's question is worked out from each question, or taken from its optional `spoken` field. So "ZoLabs questions cannot be edited" means the phone wording cannot be edited. Remove and Add stay, because they act on the whole question for both channels.
- **No box for it anywhere.** The Edit and Add forms have no phone-wording box. The editing code ignores any phone wording it is given, so the screen cannot be used to change it.
- **Editing the written question must not change what a call says.** The phone wording follows the written text automatically, so a plain edit would have changed the voice agent's words without anyone typing them. The first time the written wording (or an answer choice) of a question is edited, the wording the phone has right then is written into that question's own `spoken` field. Questions that are not edited are unchanged. This uses an existing field, so the mission JSON has the same shape.
- **Enforced on the server too.** Sign-off with edits is refused if a question that existed would sound different on a call, if phone wording is written over an existing question, or if a new question carries hand-written phone wording. (Mission Studio's first save is protected by the screen only: there is nothing saved yet to compare with.)
- **Categories reuse `module`.** No new field. The prompt changes from "group by branch" to "give every question a category by purpose", names are tidied, and a model's draft with four or more questions in one category is sent back to be grouped. The plain draft has no model, so it sorts by simple rules and is not held to the one-group check.
- **The screen shows each category as a heading with its count.** Moving a question to another category, or naming a new one, is a dropdown on Edit and Add. The category is only a label: it does not change the order or the branching.
- **Not built:** reordering questions, renaming a category for all its questions at once, and per-category rules.

## Running locally with the real wiring (scripts/dev-server.ts)

- **Decision:** `npm run dev` runs the same wiring as the deployed app (`functions/core_api/src/index.ts`) on an in-memory store, with its keys from `.env.local` (optional: a missing file is skipped). Before, it used a separate, simulated setup that ignored `.env.local`, so WhatsApp, Claude and phone calls could not be tried locally. The store is always in memory and dev sign-in is switched on by the script itself, never by the deployed app.
- **Why this cannot change production:** the dev script is not part of the deployed bundle; the deploy script reads `.env.local` as before; and the production bundle was built and checked: its entry is still the app itself, the extra `localSvc` export used by the dev script is dropped by the bundle's own footer, and no dev sign-in flag is set.
- **Care:** with `.env.local` loaded, a local run can use the real keys. It uses an in-memory store, so no production data is touched, but real messages or calls are possible if the keys allow them. Use made-up people only.
