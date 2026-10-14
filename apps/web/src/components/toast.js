// Toast messages in the corner.
import { esc } from "../lib/format.js";
import { toastRegion } from "../lib/dom.js";

export function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.innerHTML = `<span class="toast-icon">${tone === "warning" ? "!" : "✓"}</span><span>${esc(message)}</span>`;
  toastRegion.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
