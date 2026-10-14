// DozAI operator app. Everything shown here comes from the API: there is no sample data.
// This file only starts the app: it prepares the controls, wires the page-level events, and draws the first page.
import { initSelects } from "./components/controls/select.js";
import { initNumbers } from "./components/controls/number.js";
import { initFiles } from "./components/controls/file.js";
import { $, drawerBackdrop, modalBackdrop } from "./lib/dom.js";
import { state } from "./lib/state.js";
import { action, chrome, go, render } from "./shell.js";
import { loadAll, onLoaded } from "./lib/api.js";
import { closeDrawer } from "./components/case-drawer.js";
import { closeModal } from "./components/modal.js";

initSelects();
initNumbers();
initFiles();
$("primaryNav").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (!b) return; state.session = null; go(b.dataset.view); document.querySelector(".sidebar").classList.remove("open"); });
$("roleSwitcher").addEventListener("change", e => { state.localRole = e.target.value; state.me = null; state.loaded = false; render(); loadAll(); });
$("refresh").addEventListener("click", () => action("refresh"));
$("mobileMenu").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
drawerBackdrop.addEventListener("click", closeDrawer);
modalBackdrop.addEventListener("click", e => { if (e.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeModal(); document.querySelector(".sidebar").classList.remove("open"); } });
onLoaded(chrome); // once the data has loaded, redraw the page frame
render();
loadAll();
