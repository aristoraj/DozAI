// One loading behaviour for the whole app. Every request goes through api() in main.js, which tells this module when it starts and ends.
//
//  - The button the person just clicked is held while the work runs: it cannot be clicked again (so nothing is sent twice), it shows a small
//    spinner, and it can swap its label ("Saving…") through a data-busy-label attribute. It is released when the work is done, whether it
//    worked or failed. Only real buttons (class "button") are held, never menu items, tabs or close buttons.
//  - A thin bar runs along the top of the page while any request is slow, and a short note appears when it is very slow.
//  - Nothing flashes for quick work: the spinner and the bar only appear after a short delay. The button is guarded at once, though.
//  - Requests marked silent (the refreshes that run by themselves, and the live check of the questions) show nothing.
//
// The delays are constants here so one place decides how the whole app feels.
export const SPINNER_AFTER_MS = 250;   // the CSS shows the button spinner after this long (see .is-busy in styles/components/loading.css)
export const BAR_AFTER_MS = 350;       // the top bar appears if the work takes longer than this
export const HINT_AFTER_MS = 6000;     // and says it is still working after this long
export const IDLE_MS = 150;            // work that follows work (save, then reload the page) counts as one piece of work
const CLICK_WINDOW_MS = 150;           // a request that starts this soon after a click belongs to that click

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The same small ring everywhere a page area is waiting for data. */
export const spinnerHtml = () => `<span class="spinner" aria-hidden="true"></span>`;
export const loadingLine = (text = "Loading…") => `<p class="loading-line muted t-sm" role="status">${spinnerHtml()}<span>${esc(text)}</span></p>`;
export const loadingState = (title, text) => `<div class="empty-state loading-state" role="status">${spinnerHtml()}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

export function createBusy(doc = document) {
  let pending = 0, lastClick = null, idleTimer = 0, barTimer = 0, hintTimer = 0;
  const held = new Map(); // button -> what to put back

  const bar = doc.createElement("div");
  bar.className = "top-progress"; bar.hidden = true; bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", "Working"); bar.setAttribute("aria-busy", "true");
  bar.innerHTML = `<span class="top-progress-hint" role="status" aria-live="polite" hidden></span>`;
  doc.body.appendChild(bar);
  const hint = bar.querySelector(".top-progress-hint");

  // Which button did the person just press? Only buttons with class "button" count, and a button can opt out with data-no-busy.
  doc.addEventListener("click", e => {
    const b = e.target instanceof Element ? e.target.closest("button.button") : null;
    lastClick = b && b.dataset.noBusy === undefined ? { el: b, at: Date.now() } : null;
  }, true);

  function hold(el) {
    if (held.has(el)) return;
    held.set(el, { wasDisabled: el.disabled, html: el.dataset.busyLabel ? el.innerHTML : null });
    el.classList.add("is-busy"); el.setAttribute("aria-busy", "true"); el.disabled = true;
    if (el.dataset.busyLabel) el.textContent = el.dataset.busyLabel;
  }
  function releaseAll() {
    for (const [el, was] of held) {
      if (!el.isConnected) continue; // the page was redrawn: there is a new button now
      el.classList.remove("is-busy"); el.removeAttribute("aria-busy");
      if (was.html !== null) el.innerHTML = was.html;
      el.disabled = was.wasDisabled;
    }
    held.clear();
  }
  function showBar() { bar.hidden = false; }
  function showHint() { hint.textContent = "Still working… this can take a minute."; hint.hidden = false; }
  function hideBar() { bar.hidden = true; hint.hidden = true; hint.textContent = ""; }

  /** Call when a request starts. Returns the function to call when it ends (it is safe to call twice). */
  function begin({ silent = false } = {}) {
    if (silent) return () => {};
    clearTimeout(idleTimer);
    pending += 1;
    if (lastClick && Date.now() - lastClick.at <= CLICK_WINDOW_MS && lastClick.el.isConnected) hold(lastClick.el);
    if (pending === 1) { clearTimeout(barTimer); clearTimeout(hintTimer); barTimer = setTimeout(showBar, BAR_AFTER_MS); hintTimer = setTimeout(showHint, HINT_AFTER_MS); }
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      pending -= 1;
      if (pending > 0) return;
      // Wait a moment: the next request of the same piece of work usually starts straight away.
      idleTimer = setTimeout(() => { if (pending > 0) return; clearTimeout(barTimer); clearTimeout(hintTimer); hideBar(); releaseAll(); }, IDLE_MS);
    };
  }

  return { begin, pending: () => pending, heldCount: () => held.size, bar };
}
