// Contact details are encrypted at rest (AES-256-GCM) and matched by keyed hash, so a database read alone
// reveals no phone numbers, and inbound webhooks can still find the right participant.
// Key: DOZAI_PII_KEY = 32 random bytes, base64. Losing it means losing the numbers; keep it in the vault.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const keyOf = (b64: string): Buffer => {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("DOZAI_PII_KEY must be 32 bytes, base64 encoded");
  return k;
};

/** Normalise to digits only, including the country code, e.g. "+91 98765 43210" -> "919876543210". */
export const phoneDigits = (raw: string): string => raw.replace(/\D/g, "");

/** Digits with the country code. A bare 10-digit number gets the default country code (India: 91). */
export function normalizeMsisdn(raw: string, defaultCountryCode = "91"): string {
  const d = phoneDigits(raw).replace(/^0+/, "");
  if (d.length === 10) return `${defaultCountryCode}${d}`;
  // "+91 098765 43210": the trunk zero written after the country code is not part of the number.
  if (d.startsWith(defaultCountryCode) && /^0+\d{10}$/.test(d.slice(defaultCountryCode.length))) return `${defaultCountryCode}${d.slice(defaultCountryCode.length).replace(/^0+/, "")}`;
  return d;
}

export function encryptPhone(keyB64: string, digits: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(keyB64), iv);
  const ct = Buffer.concat([c.update(digits, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString("base64url")).join(".");
}

export function decryptPhone(keyB64: string, blob: string): string {
  const [iv, tag, ct] = blob.split(".").map(p => Buffer.from(p, "base64url"));
  if (!iv || !tag || !ct) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", keyOf(keyB64), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export const phoneHash = (keyB64: string, digits: string): string => createHmac("sha256", keyOf(keyB64)).update(`phone:${digits}`).digest("hex");

/**
 * Text that is about to go to a model: numbers that look like phone, ID or account numbers, e-mail addresses and PAN
 * numbers are replaced, so the model sees the meaning of a reply and not the details a person happened to type. `names` are
 * the person's own names (we know them): each part is replaced as a whole word, in any case.
 */
export function redactForModel(text: string, names: string[] = []): string {
  const parts = [...new Set(names.flatMap(n => n.split(/\s+/)).filter(p => p.length >= 3 && /^\p{L}+$/u.test(p)))];
  const named = parts.reduce((t, p) => t.replace(new RegExp(`(?<!\\p{L})${p}(?!\\p{L})`, "giu"), "[name]"), text);
  return named
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[id]")
    .replace(/(?<!\d)\+?\d[\d\s().-]{6,}\d(?!\d)/g, m => (m.replace(/\D/g, "").length >= 8 ? "[number]" : m));
}

/** Show only the last 4 digits. */
export const maskPhone = (digits: string): string => `•••• ${digits.slice(-4)}`;
