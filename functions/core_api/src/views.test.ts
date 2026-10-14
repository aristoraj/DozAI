import { describe, it, expect } from "vitest";
import type { CaseEvent } from "@dozai/contracts";
import { auditView } from "./views";

const ev = (type: string): CaseEvent => ({ event_id: "e", tenant_id: "t", case_id: "DZ-1", seq: 1, type, actor: "system", summary: "x", payload: {}, prev_hash: "p", hash: "abcdef123456", ts: "2026-10-14T10:00:00.000Z" }) as never;

describe("what the case history calls each event", () => {
  it("never shows a raw event name: every kind of event the platform writes has a plain label", () => {
    for (const t of ["message_sent", "message_status", "conversation_started", "question_asked", "answer_recorded", "reply_handled", "callback_scheduled", "case_deleted", "action_held", "action_approved", "action_rejected", "wake_scheduled", "wake_fired", "memory_noted"]) {
      const label = auditView(ev(t)).action;
      expect(label, t).not.toBe(t);
      expect(label, t).not.toMatch(/_/);
    }
    expect(auditView(ev("message_sent")).action).toBe("WhatsApp message sent");
    expect(auditView(ev("callback_scheduled")).action).toBe("Reminder set by the agent");
  });
});
