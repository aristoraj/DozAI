# Challenges

Each problem: what we saw, why it happened, how we fixed it.

## A long dropdown label pushed the page wider than a phone screen

- **Symptom:** At phone width (390px) the "New campaign" dialog and the Mission and Employee screens scrolled sideways. It appeared only after the text sizes were increased.
- **Cause:** The custom dropdown button would not shrink below the width of its text. With tiny text the label always fit, so nobody noticed. With 13px text, a long label such as "Post-program placement and retention tracer · MSN-001-v1.3" stretched its form column.
- **Fix:** Let the form field, the dropdown wrapper and the button shrink (`min-width: 0`), hide the overflow on the button so the label ends in "…", and cap the filter dropdowns to the width of the page on phones. The full text is still shown in the open list.
- **How it was found:** Headless Chrome screenshots at 390px, and a check for elements wider than the screen. The check was run on the old and the new stylesheet to see which problems were new.

## A short number field stretched beside a tall one

- **Symptom:** In "New campaign", the − and + buttons of "Most messages a minute" sat at the bottom, outside the box.
- **Cause:** The field next to it has a hint line, so its row was taller. The shorter field's rows were stretched to match, and the buttons are centred in the stretched space.
- **Fix:** `.field { align-content: start }`, so rows keep their natural height.

## A text box used a monospace font

- **Symptom:** Text areas (for example the notes box in the Review queue) showed their text in a typewriter font.
- **Cause:** Text boxes do not inherit the page font unless told to; the base rule covered buttons, inputs and selects but not `textarea`.
- **Fix:** Added `textarea` to the base rule. The JSON editors still use the monospace helper class explicitly.

## Dialogs were a little wider than a phone screen

- **Symptom:** On a phone, every dialog stuck out 4px past the right edge, and the Mission dialog's "Start from" row pushed it wider still.
- **Cause:** The dialog was set to 96% of the screen width but also had 20px of space around it. And a form field could not shrink below the width of its longest line.
- **Fix:** The dialog is now as wide as the space it has, the space around it is 8px on phones, and a form field's column may shrink.

## One-off: ten test files failed to load right after the pull

- **Symptom:** The first full test run after pulling failed to load about ten files, including ones nobody touched. The same files passed on every later run.
- **Cause:** Not found. It happened once and I could not make it happen again.
- **What to do if it comes back:** run `npx vitest run` a second time, and tell me if it fails twice.

## Still open

- Nothing known on the pages that exist today. The audit that found the items above (every page and dialog, at desktop and phone width) can be run again after any UI change.

