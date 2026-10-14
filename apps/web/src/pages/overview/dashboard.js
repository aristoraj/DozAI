// Command centre: which cases a mission filter keeps, the counts the page shows, and the small motion that eases them into place.

export const ALL = "all";
export const MOTION_MS = 550;

/** The donut's slices: [key, label, colour]. Without a mission these are the original placement ones. */
export const OUTCOMES = [["same_job", "Same job", "#2c7771"], ["changed_job", "Changed job", "#e8967a"], ["not_employed", "Not employed", "#e5aa57"], ["other", "Other or unresolved", "#b8aaa2"]];
const COLOURS = ["#2c7771", "#e8967a", "#e5aa57"], OTHER = ["other", "Other or unresolved", "#b8aaa2"];
const VERDICT_SLOTS = Object.assign([["confirmed", "Confirmed", COLOURS[0]], ["not_confirmed", "Not confirmed", COLOURS[1]], ["inconclusive", "Inconclusive", COLOURS[2]], OTHER], { by: "verdict" });

/**
 * The slices for what is being shown. One mission: its own first three findings and "other". Several missions at once: the general results
 * (confirmed, not confirmed, inconclusive), because a job finding means nothing for a feedback mission.
 */
export function slotsFor(mission, mixedMissions) {
  if (mixedMissions) return VERDICT_SLOTS;
  const list = mission?.outcomes;
  if (!list?.length) return OUTCOMES;
  return Object.assign([...list.slice(0, 3).map((o, i) => [o.key, o.label, COLOURS[i]]), OTHER], { by: "finding" });
}

/** The legend under the donut. */
export const legendHtml = (slots, mix) => slots.map(([k, l, c]) => `<div class="legend-item"><span class="legend-dot" style="background:${c}"></span><span>${l.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]))}</span><strong data-mix="${k}">${mix[k] ?? 0}</strong></div>`).join("");

// ---- which cases, and what to count ---------------------------------------------------------------------------------------

/** The mission a case belongs to. A case from before missions existed has none: it belongs to the first mission, as the server counts it. */
export const missionOf = (c, missions) => c.mission_version ?? missions[0]?.version ?? null;

export const casesFor = (cases, missions, key) => (key === ALL ? cases : cases.filter(c => missionOf(c, missions) === key));

/** The same counting rules as GET /api/summary (functions/core_api/src/app.ts). A test keeps the two in step. */
export function summarize(cases, slots = OUTCOMES) {
  const count = f => cases.filter(f).length;
  const done = c => c.workflow_status === "complete";
  const by = slots.by === "verdict" ? c => c.final_outcome : c => c.livelihood_state;
  const named = slots.filter(([k]) => k !== "other").map(([k]) => k);
  const mix = {};
  for (const [k] of slots) mix[k] = k === "other" ? count(c => done(c) && !named.includes(by(c) ?? "")) : count(c => by(c) === k);
  return {
    total: cases.length,
    review: count(c => c.workflow_status === "review"),
    confirmed: count(c => c.final_outcome === "confirmed"),
    reached: count(c => c.attempts > 0 || done(c)),
    responded: count(c => c.confidence > 25 || done(c) || c.workflow_status === "review"),
    complete: count(done),
    mix,
  };
}

/** Everything the page needs for one mission (or all of them): the counts, and the campaigns and activity that belong to it. */
export function dashboardFor({ cases, missions, campaigns, audits, key }) {
  const mine = casesFor(cases, missions, key);
  const ids = new Set(mine.map(c => c.id));
  const first = missions[0]?.version;
  const slots = slotsFor(key === ALL ? (missions.length === 1 ? missions[0] : null) : missions.find(m => m.version === key), key === ALL && missions.length > 1);
  return {
    slots,
    summary: summarize(mine, slots),
    waiting: mine.filter(c => c.status === "progress").length,
    paused: campaigns.filter(c => c.status === "paused" && (key === ALL || (c.mission_version ?? first) === key)),
    activity: key === ALL ? audits : audits.filter(a => ids.has(a.case_id)),
  };
}

// ---- motion ------------------------------------------------------------------------------------------------------------------
// Only opacity, position and width move, and only briefly. People who ask their system for less motion get instant changes.

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = () => typeof requestAnimationFrame === "function" && !reducedMotion();
const ease = t => 1 - Math.pow(1 - t, 3);

function showNumber(el, value, format) {
  el._shown = value;
  el.dataset.shown = String(value);
  el.textContent = format(value);
}

/** Counts a number up or down to `to`. A new call takes over from wherever the last one had got to, so quick changes never jump. */
export function animateNumber(el, to, format = String) {
  const from = el._shown ?? Number(el.dataset.shown);
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(el._raf);
  if (!canAnimate() || !Number.isFinite(from) || from === to) { showNumber(el, to, format); return; }
  let start = null;
  const step = now => {
    if (!el.isConnected) return;                       // the page moved on: stop
    start ??= now;                                     // time from the first frame, whatever clock the browser uses
    const t = Math.min(1, (now - start) / MOTION_MS);
    if (t >= 1) { showNumber(el, to, format); return; }
    showNumber(el, Math.round(from + (to - from) * ease(t)), format);
    el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

export function donutGradient(values, slots = OUTCOMES) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return "var(--line)";
  let sum = 0;
  return `conic-gradient(${values.map((n, i) => { const from = (sum / total) * 360; sum += n; return `${slots[i][2]} ${from}deg ${(sum / total) * 360}deg`; }).join(",")})`;
}

/** Slides the donut slices to their new sizes, and counts the centre number and the legend with them. */
export function animateOutcomes(root, mix, slots = OUTCOMES) {
  const donut = root.querySelector("[data-donut]");
  if (!donut) return;
  // A different mission has different slices: redraw the legend, and let the donut grow from nothing.
  const legend = root.querySelector(".legend");
  if (legend && [...legend.querySelectorAll("[data-mix]")].map(e => e.dataset.mix).join() !== slots.map(([k]) => k).join()) {
    legend.innerHTML = legendHtml(slots, mix);
    donut._values = slots.map(() => 0);
  }
  const to = slots.map(([key]) => mix[key]);
  const from = donut._values?.length === slots.length ? donut._values : (() => { try { const v = JSON.parse(donut.dataset.values); return v.length === slots.length ? v : slots.map(() => 0); } catch { return slots.map(() => 0); } })();
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(donut._raf);
  const paint = values => {
    donut._values = values;
    donut.dataset.values = JSON.stringify(values);
    donut.style.background = donutGradient(values, slots);
    root.querySelector("[data-donut-centre]").textContent = String(Math.round(values.reduce((a, b) => a + b, 0)));
    slots.forEach(([key], i) => { const el = root.querySelector(`[data-mix="${key}"]`); if (el) el.textContent = String(Math.round(values[i])); });
  };
  if (!canAnimate()) { paint(to); return; }
  let start = null;
  const step = now => {
    if (!donut.isConnected) return;
    start ??= now;
    const t = Math.min(1, (now - start) / MOTION_MS);
    if (t >= 1) { paint(to); return; }
    paint(from.map((a, i) => a + (to[i] - a) * ease(t)));
    donut._raf = requestAnimationFrame(step);
  };
  donut._raf = requestAnimationFrame(step);
}

/** Replaces a list's content with a short fade, so it does not blink. `after` runs on the new content (to attach click handlers). */
export function swapContent(el, html, after) {
  clearTimeout(el._swap);
  if (!canAnimate()) { el.innerHTML = html; after?.(el); return; }
  el.classList.add("is-swapping");
  el._swap = setTimeout(() => { el.innerHTML = html; after?.(el); el.classList.remove("is-swapping"); }, 140);
}

/**
 * Updates the Command centre in place, so the numbers, bars and donut can move. The page draws the same markup
 * with these data-hooks: data-kpi, data-kpi-foot, data-stage, data-donut, data-donut-centre, data-mix, data-dash.
 */
export function paintDashboard(root, m, { after } = {}) {
  root.querySelectorAll("[data-kpi]").forEach(el => animateNumber(el, m.kpis[el.dataset.kpi], el.dataset.kpi === "reached" ? v => `${v}%` : String));
  root.querySelectorAll("[data-kpi-foot]").forEach(el => {
    el.textContent = m.foots[el.dataset.kpiFoot];
    if (el.dataset.kpiFoot === "review") el.classList.toggle("amber", !!m.foots.reviewTone);
  });
  root.querySelectorAll("[data-stage]").forEach(row => {
    const key = row.dataset.stage;
    animateNumber(row.querySelector("[data-stage-count]"), m.stages[key]);
    row.querySelector(".progress-fill").style.width = `${m.stagePct[key]}%`; // the width eases by CSS
  });
  animateOutcomes(root, m.mix, m.slots ?? OUTCOMES);
  swapContent(root.querySelector('[data-dash="attention"]'), m.attentionHtml, after);
  swapContent(root.querySelector('[data-dash="activity"]'), m.activityHtml, after);
}
