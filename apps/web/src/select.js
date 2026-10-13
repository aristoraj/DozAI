// Custom dropdowns. Replaces every native <select> with a styled button and list.
// The real <select> stays hidden inside, so code that reads .value or listens for "change" keeps working.
// An <option> may add data-short (shorter wording for the button and the list) and data-sub (a quiet second line in the list).

const CHEVRON = `<svg class="cs-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg class="cs-check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let menu = null; // the open list, or null: { select, trigger, list, items, active }
let nextId = 1;
let typed = "", typedTimer = 0;

const enabled = i => !!menu.items[i] && !menu.select.options[i].disabled;

function enhance(select) {
  select.dataset.cs = "1";
  const name = select.getAttribute("aria-label") || select.labels?.[0]?.textContent.trim() || "";

  const wrap = document.createElement("div");
  wrap.className = select.classList.contains("filter-select") ? "cs cs-compact" : "cs";
  if (select.style.flex) wrap.style.flex = select.style.flex;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="cs-value"></span>${CHEVRON}`;

  const sync = () => {
    const picked = select.options[select.selectedIndex];
    const text = picked?.dataset.short ?? picked?.textContent ?? "";
    trigger.firstChild.textContent = text;
    trigger.setAttribute("aria-label", name ? `${name}: ${text}` : text);
  };

  select.before(wrap);
  wrap.append(trigger, select);
  select.classList.add("cs-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  select.addEventListener("change", sync);
  select.addEventListener("focus", () => trigger.focus()); // a <label for=...> click lands here
  trigger.addEventListener("click", () => (menu?.trigger === trigger ? closeMenu() : openMenu(select, trigger)));
  trigger.addEventListener("keydown", e => onKey(e, select, trigger));
  sync();
}

function openMenu(select, trigger) {
  closeMenu();
  const list = document.createElement("ul");
  list.className = select.classList.contains("filter-select") ? "cs-list cs-compact" : "cs-list";
  list.id = `cs-list-${nextId++}`;
  list.setAttribute("role", "listbox");
  list.addEventListener("mousedown", e => e.preventDefault()); // keep focus on the button

  const items = [...select.options].map((option, i) => {
    const li = document.createElement("li");
    li.className = "cs-option";
    li.id = `${list.id}-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === select.selectedIndex));
    if (option.disabled) li.setAttribute("aria-disabled", "true");
    const text = document.createElement("span");
    text.className = "cs-opt";
    const main = document.createElement("span");
    main.textContent = option.dataset.short ?? option.textContent;
    text.append(main);
    if (option.dataset.sub) { const sub = document.createElement("small"); sub.textContent = option.dataset.sub; text.append(sub); } // a quiet second line
    li.append(text);
    li.insertAdjacentHTML("beforeend", CHECK);
    li.addEventListener("mouseover", () => setActive(i));
    li.addEventListener("click", () => choose(i));
    list.append(li);
    return li;
  });
  if (!items.length) list.innerHTML = `<li class="cs-empty">Nothing to choose from</li>`;

  document.body.append(list);
  menu = { select, trigger, list, items, active: -1 };
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", list.id);
  place();
  setActive(select.selectedIndex);

  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeMenu);
}

export function closeMenu() {
  if (!menu) return;
  const { list, trigger } = menu;
  list.remove();
  trigger.setAttribute("aria-expanded", "false");
  trigger.removeAttribute("aria-controls");
  trigger.removeAttribute("aria-activedescendant");
  document.removeEventListener("mousedown", onOutside, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", closeMenu);
  menu = null;
}

const onOutside = e => { if (!menu.list.contains(e.target) && !menu.trigger.contains(e.target)) closeMenu(); };
const onScroll = e => { if (menu && !menu.list.contains(e.target)) closeMenu(); };

// Opens below the button, or above it when there is more room there.
function place() {
  const { list, trigger } = menu;
  const r = trigger.getBoundingClientRect(), gap = 6, margin = 8;
  const below = window.innerHeight - r.bottom - margin, above = r.top - margin;
  const up = list.offsetHeight > below && above > below;
  list.style.minWidth = `${r.width}px`;
  list.style.maxHeight = `${Math.max(120, Math.min(280, up ? above : below))}px`;
  list.style.left = `${Math.max(margin, Math.min(r.left, window.innerWidth - list.offsetWidth - margin))}px`;
  list.style.top = up ? `${r.top - gap - list.offsetHeight}px` : `${r.bottom + gap}px`;
  list.classList.toggle("cs-up", up);
}

function setActive(i) {
  const { items, list, trigger } = menu;
  items[menu.active]?.classList.remove("is-active");
  menu.active = i;
  const li = items[i];
  if (!li) return;
  li.classList.add("is-active");
  trigger.setAttribute("aria-activedescendant", li.id);
  if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop - 5;
  else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight + 5;
}

function choose(i) {
  const { select, trigger } = menu;
  if (select.options[i].disabled) return;
  const changed = select.selectedIndex !== i;
  closeMenu();
  trigger.focus();
  if (!changed) return;
  select.selectedIndex = i;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function move(dir) {
  let i = menu.active;
  do { i += dir; } while (i >= 0 && i < menu.items.length && !enabled(i));
  if (enabled(i)) setActive(i);
}

function edge(dir) {
  const n = menu.items.length;
  for (let i = dir > 0 ? 0 : n - 1; i >= 0 && i < n; i += dir) if (enabled(i)) return setActive(i);
}

// Typing letters jumps to the next option that starts with them.
function typeAhead(ch) {
  typed += ch.toLowerCase();
  clearTimeout(typedTimer);
  typedTimer = setTimeout(() => { typed = ""; }, 600);
  const n = menu.items.length, from = typed.length === 1 ? menu.active + 1 : menu.active;
  for (let k = 0; k < n; k++) {
    const i = (from + k + n) % n;
    if (enabled(i) && menu.select.options[i].textContent.trim().toLowerCase().startsWith(typed)) return setActive(i);
  }
}

function onKey(e, select, trigger) {
  const k = e.key;
  if (menu?.trigger !== trigger) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(k)) { e.preventDefault(); openMenu(select, trigger); }
    return;
  }
  if (k === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); } // do not also close the dialog behind it
  else if (k === "Tab") closeMenu();
  else if (k === "ArrowDown") { e.preventDefault(); move(1); }
  else if (k === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (k === "Home") { e.preventDefault(); edge(1); }
  else if (k === "End") { e.preventDefault(); edge(-1); }
  else if (k === "Enter" || (k === " " && !typed)) { e.preventDefault(); if (enabled(menu.active)) choose(menu.active); }
  else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(k);
}

// The app redraws whole screens from HTML text, so watch for new <select> elements instead of wiring each one.
export function initSelects(root = document.body) {
  const scan = () => {
    root.querySelectorAll("select:not([data-cs])").forEach(enhance);
    if (menu && !menu.trigger.isConnected) closeMenu(); // the screen was redrawn under an open list
  };
  scan();
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
}
