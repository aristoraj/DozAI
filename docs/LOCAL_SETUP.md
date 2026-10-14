# Running DozAI on your computer

Two ways to run it locally. Start with the first; it needs no keys and cannot reach a real person.

## 1. Everything simulated (the default)

```bash
npm install
npm run dev        # API on http://localhost:3001, web on http://localhost:5173
```

You get 12 made-up cases. WhatsApp is simulated (type a participant's reply on the case page), phone calls go to a simulator (you finish the call yourself on the case page), and the agent is a script, so there is no cost. `npm run typecheck && npm test` before every push.

## 2. Real WhatsApp on your computer, through ngrok

**Goal:** receive real WhatsApp replies on your laptop, without changing anything in production.

### Rules first
- **Two env files, both gitignored. Never commit either, and never paste keys into a chat.** Get keys from the team password manager.
  - `.env.local` holds the keys. **Deploy also reads this file**, so put nothing in it that is only for your laptop.
  - `.env.dev-local` holds settings that exist only for your computer. Deploy never reads it. It overrides `.env.local`.
- **The switch that turns real sending on is read only from `.env.dev-local`** (or your shell), never from `.env.local`. Putting it in the deploy file does nothing, so a deploy file can never turn real sending on for a local run by accident.
- Use **your own WhatsApp number** as the test participant.
- Both files are read once, at startup. Restart the API after changing them. **The local store is in memory, so restarting the API forgets every case:** add your test participant after the last restart, not before.

### One-time setup
1. Install ngrok, sign in at ngrok.com, and run `ngrok config add-authtoken <your token>`.
2. In `.env.local`, make sure these keys are present: `INTERAKT_API_KEY`, `INTERAKT_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.
   - You do **not** need `DOZAI_PII_KEY`, `DOZAI_WHATSAPP` or any `ZOLABS_*` key locally. The local server uses a fixed development key for phone numbers, and phone calls always go to the simulator, so a local run can never place a real call.
3. Create `.env.dev-local` in the project root with one line:
   ```
   DOZAI_LOCAL_WHATSAPP=1
   ```
   If a key is missing, the API prints which one at startup and stays simulated.

### Each test session
1. **Start the API:** `npm run dev`. The startup message must say `WhatsApp: LIVE`. The page shows the badge "WhatsApp live" in the left menu.
2. **Start the tunnel** in a second terminal: `ngrok http 3001`. The port must be **3001**.
3. **Copy the Forwarding address**, for example `https://xxxx.ngrok-free.dev`. On the free plan it changes each time you restart ngrok.
4. **Check the tunnel:** open `<ngrok address>/api/health`. You should see `{"ok":true,…}`. `ERR_NGROK_8012` means the tunnel points at the wrong port.
5. **Point Interakt at your laptop.** Interakt → Developer Settings → Webhook:
   - **URL:** `<ngrok address>/api/webhooks/interakt` (do not add `/server/core_api`).
   - **Secret:** the value of `INTERAKT_WEBHOOK_SECRET`.
   - **Write down the old URL first**, so you can restore it.
6. **Test:** in the page at http://localhost:5173, import yourself as a participant, open the case, press **Run agent session**, receive the message, and reply. Open http://127.0.0.1:4040: you should see `POST /api/webhooks/interakt` with status 200. If the reply does not show up, press **Check for replies**.

With real WhatsApp on, the made-up cohort is **not** loaded, so nobody but the numbers you import can be messaged. The real agent and the model reader are used, so a reply such as "very good" is understood. This costs a few cents per run.

### Warning: the Interakt webhook is account-wide
Interakt sends to one address. While it points at your laptop, **Catalyst dev (and production, if it shares the Interakt account) stops receiving WhatsApp replies.** Ask first. If production shares the account, use a separate test number or account.

### When you finish
- Restore the original Interakt webhook URL.
- Stop ngrok and the API.
- Remove or comment out `DOZAI_LOCAL_WHATSAPP=1` in `.env.dev-local`.

### Troubleshooting
| Symptom | Cause |
|---|---|
| Badge says "WhatsApp off, replies are simulated" | The switch is not in `.env.dev-local`, a key is missing (read the startup message), or an old API process is still running. Stop it and restart. |
| `ERR_NGROK_8012` | ngrok points at the wrong port. Use `ngrok http 3001`. |
| No request appears in the ngrok inspector (http://127.0.0.1:4040) | The Interakt webhook URL is wrong or not saved. |
| `401 BAD_SIGNATURE` | The secret in Interakt does not match `INTERAKT_WEBHOOK_SECRET`. |
| Reply arrives (200) but nothing happens | The API was restarted after you added the participant, so the case no longer exists. Add the participant again. |
| Case stays "Not started" | The reply never reached the local API. |

### Before pushing code
`git status` must show no `.env*` file (they are all gitignored). Open a pull request for human review, and mark it AI-assisted if Claude helped.
