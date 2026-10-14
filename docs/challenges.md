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

## Removing a question could send people to the wrong branch

- **Symptom:** Taking "Why did you change jobs?" out of the built-in mission made people who changed jobs get the questions meant for people who are not working. Found by a test that runs the server's WhatsApp and phone-call agreement check on the edited mission.
- **Cause:** A question with no rule of its own goes to the next one in the list. Removing the question that was next changed what the earlier question led to.
- **Fix:** When a question is removed, any question that was relying on the list order gets an explicit rule to where the removed question would have gone.

## The same question on two branches was refused as a repeat

- **Symptom:** The built-in mission could not even be edited: "What is your job title or the work you do?" is asked on two branches, and the editor said it repeated another question.
- **Cause:** The first version of the repeat check compared wording across the whole list, not only questions one person could meet.
- **Fix:** A repeat means the same wording (or the same answer) for questions that can be asked of the same person. The browser and the server use the same idea.

## The wording comparison threw away Hindi vowel signs

- **Symptom:** "आप कहाँ काम करते हैं" was compared as "आप कह क म करत ह".
- **Cause:** The same mistake as in the reply reader: cleaning text kept only letters and digits, and Devanagari vowel signs are a separate kind of character.
- **Fix:** Marks are kept, in the server and in the browser. A test covers it in both.

## Signing off looked like it created a duplicate mission

- **Symptom:** After signing off, the mission picker listed the mission twice: `MSN-001-v1.3` and `MSN-001-v1.3-signed`.
- **Cause:** Not a double call. Sign-off saved a copy under a new name by design, because saved missions never change and the built-in mission cannot be edited at all. The original stayed in the list, and its participants stayed on unsigned wording.
- **Fix:** Sign-off approves the same mission in place. For the built-in mission an approved copy is stored under the same name and used instead of the code version. Checked in a real browser: one mission before, the same one signed afterwards, still with its participants, and one entry in the picker.

## Pressing a button twice could send the work twice

- **Symptom:** Buttons that call the server stayed clickable while the work ran, so a second click on a slow server sent the work again (for example two approvals, or two "check for replies").
- **Cause:** Only some buttons disabled themselves, and none showed that anything was happening, which invited the second click.
- **Fix:** The button that was pressed is held from the first moment (disabled, with the working label and a spinner after a short delay). A test presses a slow button three times and checks that one request went out.

## A confirm dialog closed before the work was done

- **Symptom:** After "Sign off" or "Switch everything off" the dialog vanished and the page showed nothing while the work ran.
- **Fix:** The dialog stays open, its button says what it is doing, and it closes when the work ends. Pressing the button twice does nothing.

## Showing a loading line for the mission questions could have retried forever

- **Found while building it:** Drawing a loading line means drawing the page, and drawing the page used to start the load again. A load that failed would then have restarted by itself without end.
- **Fix:** A failed load is remembered for that mission and is not started again by itself. The button to open the questions comes back.

## The card editor lost the category headings

- **Symptom:** The first version of the question editor listed the questions flat, so the groups ("work", "support") the old read-only view had were gone.
- **Cause:** The editor drew a list of cards and never used each question's `module`.
- **Fix:** The cards are grouped under their category with a count. A question keeps its number (its place in the order), because the checks and error messages use that number.

## Editing the written question would have changed what a call says

- **Symptom (before it shipped):** With the phone wording locked, a plain edit of the written question still changed the voice agent's words, because the phone wording follows the written text when no phone wording is set.
- **Fix:** The first edit of a question's written wording pins the phone wording it had, and the server refuses a sign-off that would make a call sound different.

## Still open

- Nothing known on the pages that exist today. The audit that found the items above (every page and dialog, at desktop and phone width) can be run again after any UI change.


## Moving the folders without breaking anything

- **Symptom:** None. This is how we made sure there would not be one.
- **Risk:** Paths are written in many places: the package list and scripts, the lock file, `tsconfig`, `catalyst.json`, `app-config.json`, the deploy script, the build commands of each function, tests that read files by path, and the `.gitignore`. A missed one breaks only the part that uses it (for example a deploy), which tests do not always reach.
- **What we did:** One step at a time, each on its own commit. After each step: typecheck, all tests, the web build, the cloud build, and loading the built API file the way the deploy script does. For the web app, the content-hashed file names of the production build were compared (same hash means same bytes). 29 screens were recorded at two widths (the style numbers and text of every element) before and after, and a script pressed every control on every page and listened for errors. For the API the list of routes was compared before and after.
- **A catch on the way:** The route order matters when two patterns overlap, so the routes were registered in the original order and compared as a list. Also, a tool I wrote to tidy imports dropped a name used as `...name(`; the typecheck found it straight away. That is why the typecheck runs after every step.
- **Lock file:** Moving the workspaces changes the paths in `package-lock.json`. `npm install` on Windows also reordered it and dropped the `libc` fields. We kept only the path changes and proved the result with a clean `npm ci`.
- **The screen compare showed one difference:** on the Audit screen, event ids and the clock time. These change every time the API starts (random ids and the real time), not because of the move. Every style value was identical.
- **Still to check by hand:** a real `catalyst deploy` to the development project. It reads `catalyst.json` (`functions.source` is now `backend/functions`) and `app-config.json` (`build_path` is now `./backend/appsail/mcp-gateway/dist`). That needs the Catalyst account, so it could not be run here. If the CLI cannot find the functions, those two lines are the first place to look.
