# WhatsApp via Interakt

> **Current setup:** the mission bundle contains one template, `placement_intro_v1` (English, body `{{1}}` first name, `{{2}}` programme). Real WhatsApp is OFF (`DOZAI_WHATSAPP=off`) until Interakt shows it as Approved. The old catalog template failed with WhatsApp error WA404 even from Interakt's own screen and was removed.

Outbound: `InteraktChannels` sends approved templates through `POST https://api.interakt.ai/v1/public/message/`.
Inbound: Interakt calls our webhook; the handler verifies the signature, stores the event in the inbox, returns 200, then applies it to the case.
Code: `packages/adapters/src/interakt.ts`. Tests: `packages/adapters/src/interakt.test.ts`.

## One-time setup

1. **Interakt: templates.** Create and get approved a template named exactly as `provider_name` in `packages/core/src/mission.ts`
   (`placement_intro_v1`, language `en`, body variables `{{1}}` first name and `{{2}}` programme name; add a Quick Reply button "Yes, continue" and "No, stop").
   Hindi: `placement_intro_hi_v1`. Interakt rejects template names that differ in any character.
2. **Interakt: webhook.** Developer Settings > Webhook:
   - URL: `https://<project-domain>/server/core_api/api/webhooks/interakt`
   - Secret key: the value of `INTERAKT_WEBHOOK_SECRET` in `.env.local`
   - Events: message received, and the API message sent/delivered/read/failed events.
3. **Interakt: API key.** Developer Settings > API key. Put it in `.env.local` as `INTERAKT_API_KEY=...` (the value Interakt shows; it is sent as `Basic <key>`).
4. **Who is messaged.** There is no list of allowed numbers (it was removed on 13 October 2026). Anyone who has consented and is inside the contact hours, with attempts left, can be messaged. Stop everything at once with the kill switch on the Controls tab.
5. **Switch it on.** In `.env.local`: `DOZAI_WHATSAPP=interakt` and `ANTHROPIC_API_KEY=...`, then `node scripts/deploy.mjs`.

## Trying it end to end (your own number)

1. Sign in to the web app as admin.
2. `POST /api/admin/test-case` with `{"first_name":"<you>","phone":"+91...","employer":"Test Employer"}` (development only). The number is encrypted at rest; the agent never sees it.
3. Open the case, run an agent session. The agent queues `placement_intro_v1`; the dispatcher sends it; you reply on WhatsApp.
4. The reply arrives at the webhook, is stored, applied to the case, and `POST /api/cases/:id/resume-agent` lets the agent read it and decide.

## Rules built in

- A reply of STOP / unsubscribe / "No" completes the case as **opted out** and cancels queued messages.
- Unknown senders never create cases.
- Contact numbers are AES-256-GCM encrypted (`DOZAI_PII_KEY`, 32 random bytes, base64) and matched by keyed hash. Back the key up: without it numbers cannot be decrypted.
- Phone numbers do not appear in the ledger, the API responses or the agent's tool results.
- The webhook must answer within 3 seconds and Interakt does not retry: the handler does one write and returns. Processing can be re-driven with `POST /api/admin/process-inbox`.
- Free-text replies are stored as evidence (`reply_text`, first 300 characters). Decide in the data policy whether free text may reach the model.

## Not done

- A guaranteed scheduler. Replies are applied and the agent is resumed right after the webhook acknowledges (best effort), by the **Check for replies** button (`POST /api/admin/tick`), and by `POST /api/jobs/tick` with header `x-job-token: $DOZAI_JOB_TOKEN`. To make it automatic, create a Catalyst Cron in the console (Cloud Scale > Cron) that POSTs that URL every minute with the header. I could not verify the console's cron options from here; if URL targets are not offered, use a small Cron function that calls the URL.
- Automatic reminders after silence (`placement_reminder_v1` after 24h, up to 3 attempts). The policy gate currently demands recorded consent for any contact after the first, which a silent participant never gives; that rule needs a decision before reminders are automated.
- Reply parsing beyond opt-out and consent. Anything else is raw evidence for the agent or a reviewer.
- Interakt template approval status checks, per-number rate limiting beyond Interakt's own limits.

## Other templates to create

**placement_reminder_v1** (Utility, English, one variable {{1}} = first name, same two Quick Reply buttons):
```
Hello {{1}}, we sent you a short follow-up message about how things are going after your training. If you have a few minutes, please reply and we will continue. Your answers are used only for programme follow-up.
```

**placement_intro_hi_v1** (Utility, Hindi, same variables and buttons as the English intro). Have the programme team approve the Hindi wording before submitting.
