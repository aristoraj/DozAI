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

