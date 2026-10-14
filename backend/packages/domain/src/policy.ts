// Contact and decision policy. Pure functions; thresholds come from the mission bundle.

export interface ContactPolicy {
  maxAttempts: number;          // approved contact attempts per run
  windowStartHour: number;      // local hour, inclusive
  windowEndHour: number;        // local hour, exclusive
  autoConfirmAt: number;        // 0..1
  utcOffsetMinutes: number;     // IST = 330
}

export const DEFAULT_POLICY: ContactPolicy = {
  maxAttempts: 3,
  windowStartHour: 9.5,
  windowEndHour: 18,
  autoConfirmAt: 0.85,
  utcOffsetMinutes: 330,
};

export interface ContactCheckInput {
  now: Date;
  attempts: number;
  consent: "unknown" | "granted" | "declined";
  optedOut: boolean;
  isFirstContact: boolean;
}

export type ContactCheck = { allowed: true } | { allowed: false; code: "OPTED_OUT" | "CONSENT_DECLINED" | "ATTEMPT_CAP" | "OUTSIDE_WINDOW" | "CONSENT_REQUIRED"; message: string };

export function localHour(now: Date, offsetMinutes: number): number {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

export function checkContact(policy: ContactPolicy, i: ContactCheckInput): ContactCheck {
  if (i.optedOut) return { allowed: false, code: "OPTED_OUT", message: "participant opted out" };
  if (i.consent === "declined") return { allowed: false, code: "CONSENT_DECLINED", message: "consent declined" };
  if (!i.isFirstContact && i.consent !== "granted") return { allowed: false, code: "CONSENT_REQUIRED", message: "consent not recorded" };
  if (i.attempts >= policy.maxAttempts) return { allowed: false, code: "ATTEMPT_CAP", message: `max ${policy.maxAttempts} attempts reached` };
  const h = localHour(i.now, policy.utcOffsetMinutes);
  if (h < policy.windowStartHour || h >= policy.windowEndHour) return { allowed: false, code: "OUTSIDE_WINDOW", message: "outside approved contact window" };
  return { allowed: true };
}

/** Auto-confirm only at or above the threshold and with no evidence conflict. */
export function canAutoConfirm(policy: ContactPolicy, confidence: number, hasConflict: boolean): boolean {
  return !hasConflict && confidence >= policy.autoConfirmAt;
}
