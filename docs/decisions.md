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
