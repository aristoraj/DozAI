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

## The Command centre filter box was wider than the dropdown inside it

- **Symptom:** The filter box was 553px wide but its dropdown only 320px, leaving a blank gap, and the mission name was cut off.
- **Cause:** The dropdown's width limit was written with a percentage (`min(320px, 100%)`). A percentage cannot be used when a box is sized from its content, so the box sized itself to the whole long mission name (444px) first, and the dropdown was trimmed to 320px afterwards.
- **Fix:** A fixed limit in pixels, so the box matches its content. The button now shows only the mission name. A test reads the stylesheet and fails if a percentage comes back.

## The text boxes in "Create a mission" started one line tall

- **Symptom:** The first time the form opened, its text boxes were thin one-line strips.
- **Cause:** The boxes grow to fit their text, which means measuring them. The first draw happens while the dialog is still hidden, and a hidden box measures as zero.
- **Fix:** Do not measure while hidden, and measure again as soon as the dialog is shown. A box never needs to measure itself to look right when it is empty.

## "2 months ago I left my job" selected option 2

- **Symptom:** Any reply that started with a digit chose that option, even when the digit was a duration or an amount.
- **Cause:** The number match looked only at the first word of the reply.
- **Fix:** A number is a pick only when everything else in the reply is a selection word ("option", "please", "ji", "second"). A test covers durations, years and amounts.

## "I'm not working" was treated as the wrong person

- **Symptom:** The rule for "I am not <name>" (wrong person) also caught "I am not working right now", which is the label of option 3. The person would have been handed to a human as an identity mismatch.
- **Cause:** The rule matched "I am not" followed by anything.
- **Fix:** "I am not" counts only when it is not followed by working, employed, studying, interested, sure and similar words. "I am not Asha" still escalates. Both are tested.

## Devanagari words were cut to one letter

- **Symptom:** "हाँ" and "नहीं" were never recognised, so a Hindi consent reply was treated as unclear.
- **Cause:** Cleaning a reply kept only letters and digits. The vowel signs of Devanagari are a separate kind of character (marks) and were removed, leaving one consonant. Also, the usual "word boundary" in a pattern does not work next to Devanagari.
- **Fix:** Marks are kept, Devanagari digits become ordinary digits, and words are bounded by "not a letter, mark or digit". Tests cover Devanagari, Hinglish and English.

## A reply that turns an option around still matched it

- **Symptom:** "I do not work at the same place" matched "same place"; "same place or different" picked one option.
- **Fix:** If more than one option matches, or the rest of the reply holds a negation, the rules do not pick, and the model (if on) or a re-ask takes over.

## A bad phone answer could erase a good one

- **Symptom:** A call that returned an unplaceable answer (for example "it is complicated") for a question that already had a clear answer became the newest answer, so the question showed as "not clear enough" again.
- **Cause:** The newest answer for a key always wins, and a call saved its answers without looking at what was already known. WhatsApp does not have this problem because it only saves answers that passed its checks.
- **Fix:** A call's answer below the confidence bar is not saved when a clear one exists. With nothing better it is still saved so a person can see it was said.

## A phone call saved "I don't know" as an employer

- **Symptom:** On a call, free text was saved whatever it said.
- **Fix:** The same check as WhatsApp is applied: "no", "none", "I don't know" and bare numbers are not answers.

## Making the channel check a rule for every mission blocked saving

- **Symptom:** After the check was added to general mission validation, a dozen existing tests (and, in effect, any hand-written mission that branches without a list of needs) failed to save.
- **Fix:** The check is enforced only when Mission Studio drafts a mission. Saved missions are not held to it.

## Still open

- Nothing known on the pages that exist today. The audit that found the items above (every page and dialog, at desktop and phone width) can be run again after any UI change.

