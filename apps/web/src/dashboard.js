// Command centre: which cases a mission filter keeps, the counts the page shows, and the small motion that eases them into place.

export const ALL = "all";
export const MOTION_MS = 550;

/** Same colours and order as the donut legend. */
export const OUTCOMES = [["same_job", "Same job", "#2c7771"], ["changed_job", "Changed job", "#e8967a"], ["not_employed", "Not employed", "#e5aa57"], ["other", "Other or unresolved", "#b8aaa2"]];

// ---- which cases, and what to count ---------------------------------------------------------------------------------------

/** The mission a case belongs to. A case from before missions existed has none: it belongs to the first mission, as the server counts it. */
export const missionOf = (c, missions) => c.mission_version ?? missions[0]?.version ?? null;

export const casesFor = (cases, missions, key) => (key === ALL ? cases : cases.filter(c => missionOf(c, missions) === key));

/** The same counting rules as GET /api/summary (functions/core_api/src/app.ts). A test keeps the two in step. */
export function summarize(cases) {
  const count = f => cases.filter(f).length;
  const done = c => c.workflow_status === "complete";
  return {
    total: cases.length,
    review: count(c => c.workflow_status === "review"),
    confirmed: count(c => c.final_outcome === "confirmed"),
    reached: count(c => c.attempts > 0 || done(c)),
    responded: count(c => c.confidence > 25 || done(c) || c.workflow_status === "review"),
    complete: count(done),
    mix: {
      same_job: count(c => c.livelihood_state === "same_job"),
      changed_job: count(c => c.livelihood_state === "changed_job"),
      not_employed: count(c => c.livelihood_state === "not_employed"),
      other: count(c => done(c) && !["same_job", "changed_job", "not_employed"].includes(c.livelihood_state ?? "")),
    },
  };
}

/** Everything the page needs for one mission (or all of them): the counts, and the campaigns and activity that belong to it. */
export function dashboardFor({ cases, missions, campaigns, audits, key }) {
  const mine = casesFor(cases, missions, key);
  const ids = new Set(mine.map(c => c.id));
  const first = missions[0]?.version;
  return {
    summary: summarize(mine),
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

export function donutGradient(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return "var(--line)";
  let sum = 0;
  return `conic-gradient(${values.map((n, i) => { const from = (sum / total) * 360; sum += n; return `${OUTCOMES[i][2]} ${from}deg ${(sum / total) * 360}deg`; }).join(",")})`;
}

/** Slides the donut slices to their new sizes, and counts the centre number and the legend with them. */
export function animateOutcomes(root, mix) {
  const donut = root.querySelector("[data-donut]");
  if (!donut) return;
  const to = OUTCOMES.map(([key]) => mix[key]);
  const from = donut._values ?? JSON.parse(donut.dataset.values);
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(donut._raf);
  const paint = values => {
    donut._values = values;
    donut.dataset.values = JSON.stringify(values);
    donut.style.background = donutGradient(values);
    root.querySelector("[data-donut-centre]").textContent = String(Math.round(values.reduce((a, b) => a + b, 0)));
    OUTCOMES.forEach(([key], i) => { root.querySelector(`[data-mix="${key}"]`).textContent = String(Math.round(values[i])); });
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
  animateOutcomes(root, m.mix);
  swapContent(root.querySelector('[data-dash="attention"]'), m.attentionHtml, after);
  swapContent(root.querySelector('[data-dash="activity"]'), m.activityHtml, after);
}
