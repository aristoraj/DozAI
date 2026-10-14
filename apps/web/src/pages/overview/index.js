// Command centre page: the mission filter, the numbers and charts, and updating them in place.
import { can, state } from "../../lib/state.js";
import { ALL, casesFor, dashboardFor, donutGradient, legendHtml, paintDashboard } from "./dashboard.js";
import { esc, plural } from "../../lib/format.js";
import { $, appView } from "../../lib/dom.js";
import { empty, pageHead } from "../../components/page.js";
import { bindGo, render } from "../../shell.js";

// ---- command centre -----------------------------------------------------------------------------------------------------------
// ---- command centre ------------------------------------------------------------------------------------------------------------
// One mission filter. Everything below it is counted over that mission's cases, with the same rules as the server's summary.
const dashKey = () => (state.missions.some(m => m.version === state.dashMission) ? state.dashMission : ALL);
/** Everything the page shows for the chosen mission. The first draw and the in-place updates both use it. */
function overviewModel() {
  const key = dashKey();
  const d = dashboardFor({ cases: state.cases, missions: state.missions, campaigns: state.campaigns, audits: state.audits, key });
  const s = d.summary, picked = state.missions.find(x => x.version === key);
  const signedOff = (picked ?? state.mission).instrument_signed_off;
  const pct = n => (s.total ? Math.round((n / s.total) * 100) : 0);
  const items = [];
  if (s.review) items.push(["!", `${plural(s.review, "case")} need${s.review === 1 ? "s" : ""} a person's decision`, "Evidence conflict or low confidence", "reviews"]);
  if (d.paused.length) items.push(["!", `${plural(d.paused.length, "campaign")} paused`, d.paused[0].pause_reason || "Resume it from the Campaigns page", "campaigns"]);
  if (d.waiting) items.push(["↗", `${plural(d.waiting, "case")} ${d.waiting === 1 ? "is" : "are"} waiting for a reply`, "Check for replies on the Cases page", "cases"]);
  if (state.mission.runtime.whatsapp !== "live") items.push(["◇", "WhatsApp sending is off", "The agent runs with simulated replies. Nothing is sent to anyone.", "missions"]);
  if (!signedOff) items.push(["?", "The questionnaire wording is not signed off", "The questions are placeholders until the programme team approves them", "missions"]);
  return {
    key, empty: !s.total, s,
    kpis: { total: s.total, reached: pct(s.reached), confirmed: s.confirmed, review: s.review },
    foots: { total: "loaded", reached: `${s.reached} of ${s.total}`, confirmed: `${s.complete} completed`, review: s.review ? "waiting for review" : "all clear", reviewTone: !!s.review },
    stages: { total: s.total, reached: s.reached, responded: s.responded, complete: s.complete, confirmed: s.confirmed },
    stagePct: { total: pct(s.total), reached: pct(s.reached), responded: pct(s.responded), complete: pct(s.complete), confirmed: pct(s.confirmed) },
    mix: s.mix, mixTotal: Object.values(s.mix).reduce((a, b) => a + b, 0), slots: d.slots,
    // What "confirmed" means for this mission, as the mission words it ("Feedback collected"), or the plain word.
    confirmedLabel: picked?.verdict_labels?.confirmed ?? "Confirmed",
    attentionHtml: items.length ? items.map(([i, t, sub, go]) => `<button class="attention-item" style="border:0;width:100%;text-align:left;cursor:pointer" data-go="${go}"><span class="attention-icon">${i}</span><span><strong>${esc(t)}</strong><small>${esc(sub)}</small></span><span>›</span></button>`).join("") : `<p class="muted t-sm">Nothing needs attention.</p>`,
    activityHtml: d.activity.slice(0, 5).map(timelineEvent).join("") || `<p class="muted t-sm">${key === ALL ? "No activity yet." : "No recent activity for this mission."}</p>`,
    caption: `Showing ${plural(s.total, "participant")} for ${picked ? picked.name : "all missions"}.`,
    countLine: picked ? `Showing ${s.total} of ${plural(state.cases.length, "participant")}` : `Showing all ${plural(s.total, "participant")}`,
  };
}
/** The filter bar under the greeting: the mission, a way back to everyone, and what is being shown. */
function missionBarHtml(md) {
  const count = v => casesFor(state.cases, state.missions, v).length;
  const option = m => `<option value="${esc(m.version)}" data-short="${esc(m.name)}" data-sub="${esc(`${m.version} · ${plural(count(m.version), "participant")}`)}" ${m.version === md.key ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)} (${plural(count(m.version), "participant")})</option>`;
  return `<div class="dash-bar"><label class="dash-filter ${md.key === ALL ? "" : "is-active"}"><span>Mission</span><select id="dashMission" class="filter-select" aria-label="Filter the Command centre by mission"><option value="${ALL}" data-short="All missions" data-sub="${esc(plural(state.cases.length, "participant"))}" ${md.key === ALL ? "selected" : ""}>All missions (${plural(state.cases.length, "participant")})</option>${state.missions.map(option).join("")}</select></label><button type="button" class="text-button dash-clear" data-dash-clear ${md.key === ALL ? "hidden" : ""}>Clear</button><span class="dash-count" id="dashCount">${esc(md.countLine)}</span></div>`;
}
/** Keeps the bar in step with the choice without redrawing it (so the open dropdown and its motion are not disturbed). */
function updateMissionBar(md) {
  const filter = appView.querySelector(".dash-filter");
  if (!filter) return;
  filter.classList.toggle("is-active", md.key !== ALL);
  appView.querySelector("[data-dash-clear]").hidden = md.key === ALL;
  $("dashCount").textContent = md.countLine;
}
export function renderOverview() {
  const md = overviewModel();
  const name = (state.me?.user || "").split("@")[0].split(/[._-]/)[0];
  const greeting = `Hello${name ? ", " + name.charAt(0).toUpperCase() + name.slice(1) : ""}.`;
  const head = pageHead("Command centre", greeting, "What is moving, what needs a person, and what happens next.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "");
  const bar = missionBarHtml(md);
  const live = `<p class="sr-only" id="dashLive" aria-live="polite">${esc(md.caption)}</p>`;
  if (md.empty) {
    return `${head}${bar}${live}${empty(md.key === ALL ? "No participants yet" : "No participants in this mission yet", can("intake") ? "Load your first cohort to start. Participant contact numbers are encrypted when stored." : "Ask an administrator or operator to load participants.", can("intake") ? `<button class="button primary" data-action="import">Add participants</button>` : "")}`;
  }
  const { kpis, foots, stages, stagePct, mix, mixTotal, slots, confirmedLabel } = md;
  const stage = (key, label) => `<div class="stage-row" data-stage="${key}"><strong>${label}</strong><div class="progress-track"><div class="progress-fill" style="width:${stagePct[key]}%"></div></div><span data-stage-count data-shown="${stages[key]}">${stages[key]}</span></div>`;
  const values = slots.map(([k]) => mix[k]);
  return `${head}${bar}${live}<div data-overview>
    <div class="grid kpis">
      ${kpi("Participants", "total", kpis.total, kpis.total, foots.total, "#e4f5f3")}
      ${kpi("Contacted", "reached", `${kpis.reached}%`, kpis.reached, foots.reached, "#fae8dc")}
      ${kpi(confirmedLabel === "Confirmed" ? "Outcomes confirmed" : confirmedLabel, "confirmed", kpis.confirmed, kpis.confirmed, foots.confirmed, "#e4f5f3")}
      ${kpi("Needs a person", "review", kpis.review, kpis.review, foots.review, "#fff1d9", foots.reviewTone ? "amber" : "")}
    </div>
    <div class="grid two">
      <section class="card card-pad"><div class="card-head"><div><h2>Progress</h2><p>How far participants have moved</p></div><button class="text-button" data-go="cases">Open cases →</button></div>
        <div class="stage-list">${stage("total", "Loaded")}${stage("reached", "Contacted")}${stage("responded", "Responded")}${stage("complete", "Completed")}${stage("confirmed", esc(confirmedLabel))}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Outcomes</h2><p>Where participants are now</p></div></div>
        <div class="donut-wrap"><div class="donut-holder"><div class="donut" data-donut data-values="${JSON.stringify(values)}" style="background:${donutGradient(values, slots)}"></div><div class="donut-centre"><strong data-donut-centre>${mixTotal}</strong><small>classified</small></div></div>
        <div class="legend">${legendHtml(slots, mix)}</div></div></section>
    </div>
    <div class="grid two-even" style="margin-top:16px">
      <section class="card card-pad"><div class="card-head"><div><h2>Needs attention</h2><p>Only what needs a decision or a setting</p></div></div>
        <div class="attention-list dash-swap" data-dash="attention">${md.attentionHtml}</div></section>
      <section class="card card-pad"><div class="card-head"><div><h2>Recent activity</h2><p>Every action is recorded</p></div><button class="text-button" data-go="audit">Audit trail →</button></div>
        <div class="timeline dash-swap" data-dash="activity">${md.activityHtml}</div></section>
    </div></div>`;
}
const kpi = (label, hook, value, shown, foot, soft, tone = "") => `<section class="card kpi-card" style="--accent-soft:${soft}"><div class="kpi-label">${esc(label)}</div><div class="kpi-value" data-kpi="${hook}" data-shown="${shown}">${esc(value)}</div><div class="kpi-foot"><span class="delta ${tone}" data-kpi-foot="${hook}">${esc(foot)}</span></div></section>`;
/** The filter changed. Update the page in place so the numbers, bars and donut can move. Draw it again only when its shape changes (empty or not). */
export function refreshOverview() {
  const md = overviewModel();
  const root = appView.querySelector("[data-overview]");
  if (md.empty || !root) { render(); return; }
  paintDashboard(root, md, { after: bindGo });
  updateMissionBar(md);
  const live = $("dashLive"); if (live) live.textContent = md.caption;
}
export const timelineEvent = a => `<div class="timeline-event"><span class="event-dot ${a.tone === "coral" ? "coral" : ""}">${esc(a.icon)}</span><span class="event-copy"><strong>${esc(a.action)}</strong><small>${esc(a.detail)}</small></span><span class="event-time">${esc(a.time)}</span></div>`;
