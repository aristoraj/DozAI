// Phone calls: the published form, the calls list, recordings, requesting and simulating a call.
import type { Express } from "express";
import { GatewayTools, buildVoiceForm, voiceFormHash, CaseService, DozaiError } from "@dozai/core";
import { dispatchVoice, syncCalls, FakeVoice, processVoiceInbox, storeVoiceCallback } from "@dozai/adapters";
import type { AppDeps } from "../deps";
import { CAN, need, wrap } from "../http";
import { oneView } from "./case-views";

// Places a queued call now instead of waiting for the next scheduler run, and says what happened. The same safeguards apply:
// the on/off switch, consent and a claim before ringing, so a call is never placed twice.
export const placeCallNow = async (deps: AppDeps, svc: CaseService, tenant: string, outboxId: string): Promise<{ placed: boolean; status: string; error?: string }> => {
  const v = deps.voice;
  if (!v) return { placed: false, status: "pending", error: "phone calls are not switched on" };
  await dispatchVoice(svc, tenant, v.port, v.cfg);
  const o = (await svc.store.listOutbox(tenant)).find(x => x.outbox_id === outboxId);
  return { placed: o?.status === "sent", status: o?.status ?? "unknown", ...(o?.status === "failed" ? { error: String(o.payload.last_error ?? "the call could not be placed") } : {}) };
};

export function registerVoiceRoutes(app: Express, deps: AppDeps) {
  const voiceState = async (svc: CaseService, t: string, version: string) => {
    const m = await svc.getMission(t, version);
    const def = buildVoiceForm(m, await svc.employeeFor(m));
    const link = (await svc.store.getVoiceForm(t, m.version)) ?? null;
    return { definition: def, link, in_sync: !!link && link.definition_hash === voiceFormHash(def), voice: { enabled: !!deps.voice, kind: deps.voice?.port.kind ?? "off" } };
  };

  // Exactly what would be published, and whether what is published still matches the mission and the employee.
  app.get("/api/missions/:version/voice-form", need("read"), wrap(async (req, res) => res.json(await voiceState(req.ctx.svc, req.principal!.tenant_id, String(req.params.version)))));

  // Creates the form at the provider, or brings it up to date. A person reviews the preview first, so this needs an explicit confirmation.
  app.post("/api/missions/:version/voice-form/publish", need("employee"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    if (req.body?.confirm !== true) throw new DozaiError("CONFIRMATION_REQUIRED", "send {\"confirm\": true} after reviewing the preview", 400);
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const version = String(req.params.version);
    // One publish per mission at a time. Creating a form at ZoLabs is slow, and a second request that starts before the first has
    // saved its form id would create a second form. The lock is per two-minute window and the previous window's lock must be free too,
    // so a publish that started just before a boundary still holds it; a request that dies halfway blocks for at most four minutes.
    const slot = Math.floor(svc.now().getTime() / 120_000), lock = `voicepub:${t}:${version}:${slot}`;
    const busy = () => new DozaiError("PUBLISH_IN_PROGRESS", "This phone form is already being published. Wait for it to finish, then refresh the page. Publishing again now would create a duplicate form at ZoLabs.", 409);
    if (!(await svc.store.claim(lock))) throw busy();
    if (await svc.store.getIdem(`voicepub:${t}:${version}:${slot - 1}`)) { await svc.store.unclaim(lock); throw busy(); }
    try {
      const state = await voiceState(svc, t, version); // read after taking the lock, so a finished publish is seen as an existing form
      const { form_id } = await v.port.publishForm(state.definition, { existingFormId: state.link?.form_id, callbackUrl: v.callbackUrl });
      await svc.store.putVoiceForm({ tenant_id: t, mission_version: version, form_id, definition_hash: voiceFormHash(state.definition), published_at: svc.now().toISOString(), published_by: `${req.principal!.role}:${req.principal!.user_id}` });
      res.json(await voiceState(svc, t, version));
    } finally { await svc.store.unclaim(lock); }
  }));

  // The phone channel at a glance: is it connected and allowed to ring, which missions have a published form and whether it is
  // current, and the calls made so far. Transcripts and audio are personal data, so only reviewers and platform staff see them.
  app.get("/api/voice", need("read"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const v = deps.voice;
    const seesTranscripts = CAN.review!.includes(req.principal!.role) || CAN.employee!.includes(req.principal!.role);
    const forms = [];
    for (const m of await svc.listMissions(t)) {
      const s = await voiceState(svc, t, m.version);
      forms.push({ mission_version: m.version, name: m.name, form_id: s.link?.form_id ?? null, published_at: s.link?.published_at ?? null, published_by: s.link?.published_by ?? null, state: !s.link ? "not_published" : s.in_sync ? "current" : "out_of_date" });
    }
    const calls = (await svc.store.listCalls(t)).sort((a, b) => b.requested_at.localeCompare(a.requested_at)).slice(0, 100);
    const people = new Map<string, string>();
    for (const k of calls) {
      if (people.has(k.case_id)) continue;
      const c = await svc.store.getCase(t, k.case_id); const p = c && (await svc.store.getParticipant(t, c.participant_id));
      people.set(k.case_id, p?.display_name ?? "—");
    }
    res.json({
      kind: v?.port.kind ?? "off", calls_enabled: v?.cfg.callsEnabled ?? false,
      who_can_be_called: !v || !v.cfg.callsEnabled ? "nobody (calls are switched off)" : "anyone who has consented",
      callback_ready: !!v?.callbackUrl, can_check: CAN.employee!.includes(req.principal!.role), forms,
      calls: calls.map(k => ({ communication_id: k.communication_id, case_id: k.case_id, person: people.get(k.case_id), status: k.status, requested_at: k.requested_at, scheduled_for: k.scheduled_for ?? null, ended_at: k.ended_at ?? null, duration_seconds: k.duration_seconds ?? null, asked: k.asked, reason: k.reason ?? null, has_audio: !!(k.recording || k.audio_url), has_transcript: !!k.transcript, audio_url: seesTranscripts ? (k.recording ? `/calls/${k.communication_id}/recording` : k.audio_url ?? null) : null, transcript: seesTranscripts ? k.transcript ?? null : null })),
    });
  }));

  // A call's recording, streamed from ZoLabs with our own sign-in. Reviewers and platform staff only. Nothing is copied or stored here,
  // and the recording is reachable only while the call record exists, so deleting the case removes our way to it.
  app.get("/api/calls/:id/recording", need("read"), wrap(async (req, res) => {
    const role = req.principal!.role;
    if (!CAN.review!.includes(role) && !CAN.employee!.includes(role)) throw new DozaiError("FORBIDDEN", `${role} cannot listen to recordings`, 403);
    const v = deps.voice; const t = req.principal!.tenant_id;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    const call = await req.ctx.svc.store.getCall(t, String(req.params.id));
    if (!call || !call.recording) throw new DozaiError("NOT_FOUND", "there is no recording for this call", 404);
    const rec = await v.port.fetchRecording(call.communication_id);
    if (!rec) throw new DozaiError("NOT_FOUND", "the provider has no recording for this call", 404);
    res.set({ "content-type": rec.contentType, "content-length": String(rec.data.length), "cache-control": "private, no-store" }).send(rec.data);
  }));


  // A person asks for a phone call on a case. It goes through exactly the same door as the agent's request: the same checks
  // (consent, hours, attempts, a published form, something still missing) and the same approval, so staff cannot ring anyone the agent could not.
  app.post("/api/cases/:id/request-call", need("run"), wrap(async (req, res) => {
    if (!deps.voice) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    const { svc } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    let c = await svc.getCase(t, id);
    if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
    const actor = `${req.principal!.role}:${req.principal!.user_id}`;
    if (c.status === "draft" || c.status === "ready") c = await svc.beginSession(t, id, actor);
    // A case stuck in "checking the answers" (an earlier call dropped and nothing was left to judge) goes back to waiting so a person can try again.
    if (c.status === "evaluating") c = await svc.transition(t, id, c.version, "waiting", { actor, summary: "Back to waiting so another call can be placed" });
    const mission = await svc.getMission(t, c.mission_version);
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim().length >= 5 ? req.body.reason.trim().slice(0, 300) : "Phone call requested by staff";
    const r = await new GatewayTools(svc).call({ session_id: `staff_${req.principal!.user_id}`.replace(/[^A-Za-z0-9_.:-]/g, "_"), tenant_id: t, case_id: id, mission_version: mission.version, employee_version: (await svc.employeeFor(mission)).version, actor }, "voice_call_request", { case_id: id, idempotency_key: `staff-${id}-${svc.now().getTime()}`, expected_version: c.version, reason });
    if (r.error) throw new DozaiError(r.error.code, r.error.message, 422);
    const held = !!(r.data as { held?: boolean } | undefined)?.held;
    // Not held: ring now. Held: it waits for approval, and approving rings.
    const now = held ? undefined : await placeCallNow(deps, svc, t, (r.data as { outbox_id: string }).outbox_id);
    const message = held ? "The call is waiting for approval on the Approvals page. Approving it places the call." : now?.placed ? "Calling now." : `The call could not be placed: ${now?.error ?? "unknown reason"}.`;
    res.json({ requested: true, held, placed: !!now?.placed, message, case: await oneView(req, id) });
  }));

  // Asks the provider about unfinished calls and applies any that have finished, then lets the agent judge the answers. The page calls this
  // while a call is in progress, so results appear without waiting for the scheduler or for the provider's callback.
  app.post("/api/voice/sync", need("run"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) return res.json({ checked: 0, applied: 0, woken: [], errors: [] });
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id;
    const r = await syncCalls(svc, t, v.port);
    const woken: string[] = [];
    if (agent.resumeCase) for (const w of r.wake) {
      if (!(await svc.store.claim(`resume:${w.case_id}:${w.key}`))) continue; // the scheduler may have got there first
      if (!(await svc.agentGate(t, w.case_id)).ok) continue;
      try { await agent.resumeCase(svc, t, w.case_id); woken.push(w.case_id); } catch (e) { console.error("resume after call", (e as Error).message); }
    }
    res.json({ checked: r.checked, applied: r.applied, woken, errors: [...new Set(r.errors)] });
  }));

  // Proves the connection works: asks the provider who we are signed in as. Places no call and costs nothing.
  app.post("/api/voice/check", need("employee"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform", 503);
    try { res.json({ ok: true, kind: v.port.kind, account: await v.port.whoami() }); }
    catch (e) { res.json({ ok: false, kind: v.port.kind, error: (e as Error).message.slice(0, 300) }); }
  }));

  // Simulator only: finish the latest call on a case the way you choose, then apply it exactly as a real result would be.
  app.post("/api/cases/:id/simulate-call", need("run"), wrap(async (req, res) => {
    const v = deps.voice;
    if (!v || !(v.port instanceof FakeVoice)) throw new DozaiError("NOT_ALLOWED", "calls are real here: results come from the provider", 400);
    const { svc, agent } = req.ctx; const t = req.principal!.tenant_id; const id = String(req.params.id);
    const call = (await svc.store.listCalls(t, id)).filter(k => k.status === "in_progress" || k.status === "scheduled").sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
    if (!call) throw new DozaiError("NO_CALL", "there is no call in progress on this case", 400);
    const outcome = String(req.body?.outcome ?? "answered");
    const base = { answered: {}, no_answer: { status: "no_answer" as const, consent_given: undefined, identity_confirmed: undefined }, refused: { consent_given: false }, wrong_person: { identity_confirmed: false } }[outcome];
    if (!base) throw new DozaiError("INVALID_INPUT", "outcome must be answered, no_answer, refused or wrong_person", 400);
    const answers = outcome === "answered" && req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.slice(0, 5000) : undefined;
    v.port.complete(call.communication_id, { ...base, answers, ...(transcript ? { transcript } : {}) });
    await storeVoiceCallback(svc, v.tenant, { communication_id: call.communication_id });
    const r = await processVoiceInbox(svc, v.tenant, v.port);
    let session = null;
    if (r.wake.some(w => w.case_id === id) && agent.resumeCase) session = await agent.resumeCase(svc, t, id);
    res.json({ applied: r.processed, session, case: await oneView(req, id) });
  }));
}
