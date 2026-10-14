// Talking to the server: api(), act() (do something, reload, say so), loadAll(), and the loading behaviour.
import { createBusy } from "../components/busy.js";
import { API_BASE, CLOUD, ROLE_HEADER } from "./config.js";
import { state } from "./state.js";
import { withIst } from "./format.js";
import { toast } from "../components/toast.js";

/** The page frame registers itself here once, so this file does not depend on the pages. */
let afterLoad = () => {};
export const onLoaded = fn => { afterLoad = fn; };

// ---- API -------------------------------------------------------------------------------------------------------------------
const busy = createBusy(); // holds the button that was just pressed, runs the top bar, and guards against double clicks (components/busy.js)
export async function api(path, { method = "GET", body, silent = false } = {}) {
  const end = busy.begin({ silent }); // silent: refreshes that run by themselves, which must not look like work
  try { return await request(path, method, body); } finally { end(); }
}
async function request(path, method, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers: { "content-type": "application/json", ...(CLOUD ? {} : { "x-dozai-role": ROLE_HEADER[state.localRole] }) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Cannot reach the server. Check your connection and try again."); }
  if (res.status === 401 && CLOUD) { location.href = "/__catalyst/auth/login"; return new Promise(() => {}); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || (res.status === 504 ? "The server took too long. The work may still be finishing; refresh in a minute." : `Request failed (${res.status})`));
  return json;
}
export async function loadAll() {
  try {
    // Configuration can change between deploys, so re-read it each time instead of trusting a stale tab.
    [state.me, state.mission] = await Promise.all([api("/me"), api("/mission")]);
    const [c, a, s, ss, ms, cp, em, ap, co, vo] = await Promise.all([api("/cases"), api("/audit?limit=300"), api("/summary"), api("/sessions"), api("/missions"), api("/campaigns"), api("/employees"), api("/approvals"), api("/controls"), api("/voice")]);
    Object.assign(state, { cases: c.cases, audits: a.events.map(withIst), summary: s, sessions: ss.sessions, missions: ms.missions, defaultMission: ms.default_version, campaigns: cp.campaigns, employees: em.employees, employeeCanEdit: em.can_edit, approvals: ap.approvals, approvalsWaiting: ap.waiting, controlsInfo: co, voice: vo, error: null, loaded: true });
    if (state.missionShown && !state.missions.some(m => m.version === state.missionShown.version)) state.missionShown = null;
  } catch (e) {
    state.error = e.message; state.loaded = true;
  }
  afterLoad();
}
export async function act(fn, okMessage) {
  try { const out = await fn(); await loadAll(); if (okMessage) toast(okMessage, "success"); return out; }
  catch (e) { toast(e.message, "warning"); return null; }
}
