// Small formatting helpers: escaping text for HTML, plurals, initials, and India-time dates.
import { TZ, palette } from "./config.js";

// ---- small helpers -----------------------------------------------------------------------------------------
export const esc = v => String(v ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
export const initials = n => String(n).split(/\s+/).map(x => x[0]).slice(0, 2).join("").toUpperCase() || "?";
export const colorFor = id => palette[Number(String(id).replace(/\D/g, "")) % palette.length];
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const istTime = ts => (ts ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: TZ }) : "");
export const istDay = ts => {
  if (!ts) return "";
  const day = d => d.toLocaleDateString("en-CA", { timeZone: TZ });
  const when = day(new Date(ts));
  return when === day(new Date()) ? "Today" : when === day(new Date(Date.now() - 86_400_000)) ? "Yesterday" : new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ });
};
export const withIst = e => ({ ...e, time: istTime(e.ts), date: istDay(e.ts) });
