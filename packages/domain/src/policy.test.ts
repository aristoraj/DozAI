import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY as P, checkContact, canAutoConfirm } from "./policy";

// 11:00 IST = 05:30 UTC ; 20:00 IST = 14:30 UTC
const inWindow = new Date("2026-10-09T05:30:00Z");
const outWindow = new Date("2026-10-09T14:30:00Z");
const base = { now: inWindow, attempts: 0, consent: "granted" as const, optedOut: false, isFirstContact: false };

describe("checkContact", () => {
  it("allows a normal contact inside the window", () => expect(checkContact(P, base).allowed).toBe(true));
  it("blocks outside the window", () => expect(checkContact(P, { ...base, now: outWindow })).toMatchObject({ allowed: false, code: "OUTSIDE_WINDOW" }));
  it("blocks after opt-out", () => expect(checkContact(P, { ...base, optedOut: true })).toMatchObject({ code: "OPTED_OUT" }));
  it("blocks at the attempt cap", () => expect(checkContact(P, { ...base, attempts: 3 })).toMatchObject({ code: "ATTEMPT_CAP" }));
  it("needs consent after the first message", () => expect(checkContact(P, { ...base, consent: "unknown" })).toMatchObject({ code: "CONSENT_REQUIRED" }));
  it("allows the first message before consent", () => expect(checkContact(P, { ...base, consent: "unknown", isFirstContact: true }).allowed).toBe(true));
});

describe("canAutoConfirm", () => {
  it("needs confidence at the threshold and no conflict", () => {
    expect(canAutoConfirm(P, 0.85, false)).toBe(true);
    expect(canAutoConfirm(P, 0.84, false)).toBe(false);
    expect(canAutoConfirm(P, 0.99, true)).toBe(false);
  });
});
