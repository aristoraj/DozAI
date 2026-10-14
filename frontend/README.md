# Frontend (operator web app)

Plain JavaScript and CSS, built with Vite. It draws everything from the API; there is no sample data. The built files go to `client/` at the project root, which is the folder Catalyst hosts.

## Folders

| Path | What is in it |
|---|---|
| `index.html` | The page frame: sidebar, top bar and empty containers the app fills in |
| `src/main.js` | Starts the app: prepares the controls, wires page-level events, draws the first page |
| `src/shell.js` | The page frame: which page is showing, the sidebar, and the click handling shared by every page |
| `src/lib/` | Data and helpers with no screen of their own: `api.js` (calls the API, loads data), `state.js`, `config.js`, `dom.js`, `format.js`, `csv.js` |
| `src/components/` | Reusable pieces of UI: `modal.js`, `toast.js`, `page.js`, `case-drawer.js` (the case panel), `delete-modals.js`, `busy.js` (loading behaviour), `question-editor.js`, and `controls/` (custom dropdown, number field and file picker) |
| `src/pages/` | One file or folder per screen: `overview/`, `cases/`, `missions/`, `agent/`, `campaigns.js`, `reviews.js`, `phone-calls.js`, `approvals.js`, `audit.js` |
| `src/styles/` | All styling. `index.css` imports every other file in a fixed order |

Tests sit next to the file they test (`*.test.ts`). `src/ui.test.ts` clicks through the real page against the real API with fake data.

## Rules to keep it easy to change

- **CSS order matters.** Later rules win over earlier ones, so the lines in `src/styles/index.css` must stay in the same order. Add new files at the end unless you know which rules they override.
- **A page may use `lib/` and `components/`.** `lib/` should not import from `pages/`. `lib/api.js` calls `onLoaded(...)` so it does not need to know about the page frame.
- **Each file starts with one line saying what it is for.** Keep that line true when you change the file.
- Some styles (journey and phone-chat preview, in `styles/pages/journey.css`) are not used by the current screens. They were kept exactly as they were.

## Run it

From the project root: `npm run dev` (API on :3001, this app on :5173). `npm run build` builds into `client/`.
