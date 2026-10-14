// Phone calls page (ZoLabs): connection, calls, forms, and checking on calls in progress.
import { esc, istDay, istTime } from "../lib/format.js";
import { API_BASE } from "../lib/config.js";
import { can, state } from "../lib/state.js";
import { loadingState } from "../components/busy.js";
import { empty, pageHead } from "../components/page.js";
import { api, loadAll } from "../lib/api.js";
import { toast } from "../components/toast.js";
import { render } from "../shell.js";

// ---- phone calls (ZoLabs): connection, forms and the calls made ---------------------------------------------------------------------------
const CALL_STATUS = { scheduled: ["progress", "Scheduled"], in_progress: ["progress", "In progress"], completed: ["confirmed", "Completed"], no_answer: ["review", "No answer"], busy: ["review", "Busy"], declined: ["not-confirmed", "Declined"], failed: ["not-confirmed", "Failed"] };
const FORM_STATE = { current: ["confirmed", "Published and current"], out_of_date: ["review", "Out of date"], not_published: ["not-started", "Not published"] };
const callPill = s => { const [cls, label] = CALL_STATUS[s] || ["progress", String(s).replace(/_/g, " ")]; return `<span class="status ${cls}">${esc(label)}</span>`; };
// A recording we stream ourselves comes as a path on this server; one from another provider is a full link.
export const recordingSrc = u => (u.startsWith("/") ? `${API_BASE}${u}` : u);
const mmss = s => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
export function renderCalls() {
  const v = state.voice;
  if (!v) return loadingState("Loading phone calls…", "Reading the connection and the calls.");
  const [kindTone, kindLabel] = { zolabs: ["ok", "ZoLabs, live"], simulated: ["warn", "Simulator: nobody is rung"], off: ["off", "Not connected"] }[v.kind] || ["off", v.kind];
  const chk = state.voiceCheck;
  const account = chk?.ok ? (typeof chk.account === "string" ? chk.account : chk.account?.email || chk.account?.name || chk.account?.account || JSON.stringify(chk.account).slice(0, 120)) : "";
  const checkNote = chk ? (chk.ok ? `<p class="pc-note ok">Connected. Signed in as ${esc(account)}.</p>` : `<p class="pc-note bad">Could not connect: ${esc(chk.error)}</p>`) : "";
  const canCheck = v.can_check && v.kind !== "off";

  // 1. Status strip: is it working, and who can it reach?
  const tile = (label, value, note, tone, extra = "") => `<div class="pc-tile"><span class="pc-label">${label}</span><strong class="pc-value">${tone ? `<i class="pc-dot ${tone}"></i>` : ""}${esc(value)}</strong><small>${esc(note)}</small>${extra}</div>`;
  const strip = `<section class="pc-strip" aria-label="Phone connection">
    ${tile("Connection", kindLabel, canCheck ? "Asks ZoLabs who we are signed in as. Places no call and costs nothing." : "", kindTone, canCheck ? `<button type="button" class="button ghost small" data-action="voice-check" data-busy-label="Checking…">Check connection</button>` : "")}
    ${tile("Calls", v.calls_enabled ? "Switched on" : "Switched off", v.calls_enabled ? "Approved calls are placed by the scheduler." : "Nothing will ring, even when a call is approved.", v.calls_enabled ? "ok" : "off")}
    ${tile("Who can be called", v.who_can_be_called, "Only people who have not opted out, inside the contact hours.", "")}
    ${tile("Finished calls", v.callback_ready ? "ZoLabs rings us back" : "Found by the scheduler", v.callback_ready ? "ZoLabs tells us the moment a call finishes, and we fetch the details ourselves." : "No callback address is set, so results are picked up when the scheduler runs.", "")}
  </section>`;

  // 2. The calls, most recent first. One row each; the recording and transcript sit underneath.
  const count = (statuses, cls, label) => { const n = v.calls.filter(k => statuses.includes(k.status)).length; return n ? `<span class="status ${cls}">${n} ${label}</span>` : ""; };
  const counts = [count(["scheduled"], "progress", "scheduled"), count(["in_progress"], "progress", "in progress"), count(["completed"], "confirmed", "completed"), count(["no_answer", "busy", "declined"], "review", "not answered"), count(["failed"], "not-confirmed", "failed")].join("");
  const callRow = k => {
    const asked = k.asked?.length ? k.asked.join(", ").replace(/_/g, " ") : "everything";
    const recording = k.audio_url ? `<audio class="pc-audio" controls preload="none" src="${esc(recordingSrc(k.audio_url))}"></audio>` : k.has_audio ? `<small>Recording kept. Reviewers can play it.</small>` : k.status === "completed" ? `<small>No recording</small>` : "";
    const transcript = k.transcript ? `<details class="pc-transcript"><summary>Transcript</summary><pre class="mono t-xs">${esc(k.transcript)}</pre></details>` : k.has_transcript ? `<small>Transcript kept. Reviewers can read it.</small>` : "";
    return `<article class="pc-call">
      <div class="pc-who">${callPill(k.status)}<button type="button" class="pc-person" data-case="${esc(k.case_id)}">${esc(k.person)}</button><small>${esc(k.case_id)}</small></div>
      <div class="pc-what"><span class="pc-k">Asked for</span><span>${esc(asked)}</span>${k.reason ? `<small>${esc(k.reason)}</small>` : ""}</div>
      <div class="pc-when"><span class="pc-k">Requested</span><span>${esc(istDay(k.requested_at))} ${esc(istTime(k.requested_at))}</span>${k.scheduled_for ? `<small>for ${esc(istDay(k.scheduled_for))} ${esc(istTime(k.scheduled_for))}</small>` : ""}${k.duration_seconds != null ? `<small>Length ${esc(mmss(k.duration_seconds))}</small>` : ""}</div>
      <div class="pc-media">${recording}${transcript}</div>
    </article>`;
  };

  // 3. The phone form of each mission: published once per mission, and again when the mission changes.
  const formRow = f => `<div class="pc-form">
      <div class="pc-form-name"><strong>${esc(f.name)}</strong><small>${esc(f.mission_version)}</small></div>
      <span class="status ${FORM_STATE[f.state][0]}">${esc(FORM_STATE[f.state][1])}</span>
      <div class="pc-form-meta">${f.published_at ? `Published ${esc(istDay(f.published_at))} ${esc(istTime(f.published_at))}${f.published_by ? ` by ${esc(f.published_by)}` : ""}` : "Not published yet"}${f.form_id ? `<small>Form ${esc(f.form_id)}</small>` : ""}</div>
      <button type="button" class="button ghost small" data-open-mission="${esc(f.mission_version)}">Preview or publish</button>
    </div>`;

  return `${pageHead("Phone calls", "How the voice agent reaches people.", "The platform asks for a call, a person approves it, and ZoLabs places it. Here is the connection, every call made, and the form each mission uses.")}
    ${strip}${checkNote}
    <section class="card card-pad pc-section"><div class="card-head"><div><h2>Calls</h2><p>Most recent first. Recordings and transcripts are shown to reviewers and platform staff only.</p></div><span class="status active">${v.calls.length}</span></div>
      ${counts ? `<div class="pc-counts">${counts}</div>` : ""}
      ${v.calls.length ? `<div class="pc-list">${v.calls.map(callRow).join("")}</div>` : empty("No calls yet", "When the agent asks for a call and a person approves it, it appears here.")}</section>
    <section class="card card-pad pc-section"><div class="card-head"><div><h2>Phone forms</h2><p>One per mission. The form the voice agent follows on a call.</p></div></div>
      ${v.forms.length ? `<div class="pc-forms">${v.forms.map(formRow).join("")}</div>` : empty("No missions yet", "Each mission gets its own phone form.")}</section>`;
}
// While a call is in progress, ask the server every few seconds whether it has finished, and show the result when it has.
let callSyncBusy = false, lastSyncError = "";
async function syncCallsNow() {
  if (callSyncBusy || !state.loaded || !state.me || state.me.voice === "off" || !can("run")) return;
  if (!state.voice?.calls?.some(k => k.status === "in_progress" || k.status === "scheduled")) return;
  callSyncBusy = true;
  try {
    const r = await api("/voice/sync", { method: "POST", silent: true });
    if (r.errors?.length && r.errors[0] !== lastSyncError) { lastSyncError = r.errors[0]; toast("Could not check the call at ZoLabs: " + r.errors[0], "warning"); }
    if (r.applied > 0) { await loadAll(); toast(r.applied === 1 ? "A call finished. The answers are on the case." : r.applied + " calls finished. The answers are on the cases.", "success"); }
  } catch { /* try again on the next beat */ } finally { callSyncBusy = false; }
}
setInterval(syncCallsNow, 8000);
export async function checkVoice() {
  try { state.voiceCheck = await api("/voice/check", { method: "POST" }); render(); toast(state.voiceCheck.ok ? "Connected to ZoLabs." : "Could not connect to ZoLabs.", state.voiceCheck.ok ? "success" : "warning"); }
  catch (e) { toast(e.message, "warning"); }
}
