// The conversation runner: rails for the interview, judgment only where needed.
//
// A fixed, approved question flow decides WHAT to say next. Participant replies are classified into a fixed set of
// intents (answer, question, stop, wrong person, distress, deletion, off-topic, unclear), and every intent has an
// approved response. The model never writes text that goes to a participant, and a participant's words are never
// treated as instructions. When the interview finishes, the agent is woken to propose the outcome from the evidence.
import type { CaseRecord, ConversationState } from "@dozai/contracts";
import { newId } from "./ledger";
import { DozaiError, type CaseService } from "./service";
import type { ReplyClassifier } from "./classifier";
import { DRAFT_INSTRUMENT, firstQuestion, nextQuestionId, optionsOf, questionById, renderQuestion, type Instrument, type Question } from "./instrument";

export interface RunnerDeps {
  classifier: ReplyClassifier;
  instrument?: Instrument;
  /** A draft instrument is only used on real conversations when this is set (development and testing). */
  allowDraft?: boolean;
  /** WhatsApp only allows free-form messages for 24 hours after the participant's last message. */
  sessionWindowMs?: number;
}

export interface ReplyResult {
  handled: boolean;
  action: "ignored" | "started" | "answered" | "faq" | "reasked" | "escalated" | "finished" | "stopped" | "blocked";
  /** The interview is complete: wake the agent to propose the outcome. */
  finished?: boolean;
  detail?: string;
}

const DAY = 24 * 60 * 60 * 1000;
const CONSENT_PROMPT = "Reply YES to continue, or STOP to end.";

export class ConversationRunner {
  constructor(private svc: CaseService, private deps: RunnerDeps) {}

  /** The question flow for one case: the mission the case was created under (tests may force one). */
  async instrumentFor(c: CaseRecord): Promise<Instrument> {
    return this.deps.instrument ?? (await this.svc.getMission(c.tenant_id, c.mission_version)).instrument ?? DRAFT_INSTRUMENT;
  }

  async state(tenant: string, caseId: string): Promise<ConversationState | undefined> { return this.svc.store.getConversation(tenant, caseId); }

  async handleReply(tenant: string, caseId: string, text: string): Promise<ReplyResult> {
    const svc = this.svc;
    const c = await svc.getCase(tenant, caseId);
    const ins = await this.instrumentFor(c);
    if (c.deleted_at || c.status === "complete") return { handled: false, action: "ignored", detail: "case is closed" };
    const person = await svc.store.getParticipant(tenant, c.participant_id);
    if (!person || person.consent === "declined") return { handled: false, action: "ignored", detail: "no contact allowed" };

    let st = (await svc.store.getConversation(tenant, caseId)) ?? this.fresh(tenant, caseId);
    st.last_inbound_at = svc.now().toISOString();
    if (["done", "escalated", "stopped"].includes(st.status)) { await svc.store.putConversation(st); return { handled: false, action: "ignored", detail: `conversation is ${st.status}` }; }

    // A draft questionnaire must not reach real people by accident.
    if (ins.draft && !this.deps.allowDraft) {
      st = await this.escalate(c, st, ins, "instrument_not_approved", "The questionnaire is not approved for live use, so a person must continue this conversation.");
      return { handled: true, action: "blocked", detail: "instrument not approved" };
    }

    const context = st.status === "awaiting_consent" ? "consent" : "question";
    const q = questionById(ins, st.current) ?? null;
    const cls = await this.deps.classifier.classify({ text, question: q, context, instrument: ins });
    await svc.emit(c, "reply_handled", "conversation-runner", `Reply understood as: ${cls.intent}`, { intent: cls.intent, confidence: cls.confidence, question: q?.id ?? null });

    switch (cls.intent) {
      case "stop": {
        await svc.recordInbound(tenant, caseId, { provider_event_id: `conv-stop-${newId("s")}`, channel: "whatsapp", summary: "Participant asked to stop", opt_out: true });
        st.status = "stopped"; await svc.store.putConversation(st);
        return { handled: true, action: "stopped" };
      }
      case "wrong_person": { st = await this.escalate(c, st, ins, "identity_mismatch", "The reply says this may be the wrong person.", ins.wrong_person_message); return { handled: true, action: "escalated", detail: "identity_mismatch" }; }
      case "distress": { st = await this.escalate(c, st, ins, "urgent_distress_or_complaint", "The participant raised a complaint or a safety concern. A person should respond promptly.", ins.distress_message); return { handled: true, action: "escalated", detail: "distress" }; }
      case "deletion": { st = await this.escalate(c, st, ins, "deletion_request", "The participant asked for their data to be deleted.", ins.deletion_message); return { handled: true, action: "escalated", detail: "deletion_request" }; }
      case "faq": {
        const entry = ins.faq.find(f => f.id === cls.faq_id) ?? ins.faq[0]!;
        await this.say(c, st, ins, `${entry.answer}\n\n${context === "consent" ? CONSENT_PROMPT : renderQuestion(q!)}`, "faq");
        return { handled: true, action: "faq", detail: entry.id };
      }
      case "off_topic":
      case "unclear": return this.reask(c, st, ins, q, context, text.trim() === "");
      case "answer": return context === "consent" ? this.begin(c, st, ins, person.consent) : this.record(c, st, ins, q!, cls.value ?? "", cls.option_key, cls.confidence);
    }
  }

  // ---- pieces --------------------------------------------------------------------------------------------------

  private fresh(tenant: string, caseId: string): ConversationState {
    return { case_id: caseId, tenant_id: tenant, status: "awaiting_consent", current: null, reasks: 0, answers: [], messages_sent: 0, last_inbound_at: null };
  }

  private async begin(c: CaseRecord, st: ConversationState, ins: Instrument, consent: string): Promise<ReplyResult> {
    const person = (await this.svc.store.getParticipant(c.tenant_id, c.participant_id))!;
    if (consent !== "granted") await this.svc.store.putParticipant({ ...person, consent: "granted" });
    const first = firstQuestion(ins);
    st.status = "asking"; st.current = first.id; st.reasks = 0;
    await this.svc.emit(c, "conversation_started", "conversation-runner", "Consent given: questions started", { instrument: ins.version });
    await this.say(c, st, ins, `${ins.start_message}\n\n${renderQuestion(first)}`, "question", first.id);
    return { handled: true, action: "started" };
  }

  private async record(c: CaseRecord, st: ConversationState, ins: Instrument, q: Question, value: string, optionKey: string | undefined, confidence: number): Promise<ReplyResult> {
    const opt = optionKey ? optionsOf(q).find(o => o.key === optionKey) : undefined;
    const stored = opt ? opt.value : value;
    const ev = await this.svc.emit(c, "answer_recorded", "conversation-runner", `Answer recorded for ${q.id}`, { question: q.id, evidence_key: q.evidence_key });
    await this.svc.store.addEvidence({ evidence_id: newId("ev"), case_id: c.case_id, question_id: q.evidence_key, value: stored, source: "whatsapp", confidence, event_id: ev.event_id, at: this.svc.now().toISOString() });
    st.answers.push({ question_id: q.id, value: stored, label: opt?.label, at: this.svc.now().toISOString() });
    st.reasks = 0;

    const nextId = nextQuestionId(ins, q, stored);
    const next = questionById(ins, nextId);
    if (!next) {
      st.status = "done"; st.current = null;
      await this.say(c, st, ins, ins.closing_message, "closing");
      return { handled: true, action: "finished", finished: true };
    }
    st.current = next.id;
    await this.say(c, st, ins, renderQuestion(next), "question", next.id);
    return { handled: true, action: "answered" };
  }

  private async reask(c: CaseRecord, st: ConversationState, ins: Instrument, q: Question | null, context: "consent" | "question", noText: boolean): Promise<ReplyResult> {
    st.reasks += 1;
    if (st.reasks > ins.max_reasks) {
      await this.escalate(c, st, ins, "unclear_replies", "The participant's replies could not be understood after repeated tries.", ins.handover_message);
      return { handled: true, action: "escalated", detail: "unclear_replies" };
    }
    const prefix = noText ? ins.unsupported_prefix : ins.reask_prefix;
    await this.say(c, st, ins, `${prefix}\n\n${context === "consent" ? CONSENT_PROMPT : renderQuestion(q!)}`, "reask", q?.id);
    return { handled: true, action: "reasked" };
  }

  private async escalate(c: CaseRecord, st: ConversationState, ins: Instrument, reason: string, note: string, messageToParticipant?: string): Promise<ConversationState> {
    st.status = "escalated"; st.escalation_reason = reason;
    if (messageToParticipant) await this.say(c, st, ins, messageToParticipant, "handover").catch(() => undefined);
    const fresh = await this.svc.getCase(c.tenant_id, c.case_id);
    if (!["review", "complete"].includes(fresh.status)) await this.svc.requestReview(c.tenant_id, c.case_id, fresh.version, reason, note, "conversation-runner");
    await this.svc.store.putConversation(st);
    return st;
  }

  /** Queue an approved message. Checks every limit that applies to a free-form reply. */
  private async say(c: CaseRecord, st: ConversationState, ins: Instrument, text: string, kind: "question" | "faq" | "reask" | "closing" | "handover", questionId?: string): Promise<void> {
    const now = this.svc.now().getTime();
    const person = await this.svc.store.getParticipant(c.tenant_id, c.participant_id);
    if (!person || person.consent === "declined") throw new DozaiError("CONTACT_NOT_ALLOWED", "participant opted out");
    const last = st.last_inbound_at ? new Date(st.last_inbound_at).getTime() : 0;
    if (now - last > (this.deps.sessionWindowMs ?? DAY)) throw new DozaiError("SESSION_WINDOW_CLOSED", "more than 24 hours since the participant's last message");
    if (st.messages_sent >= ins.max_messages) throw new DozaiError("MESSAGE_CAP", "message limit for this case reached");
    st.messages_sent += 1;
    await this.svc.queueOutbox(c, "whatsapp_text", { text, kind, question: questionId ?? null }, `conv:${c.case_id}:${st.messages_sent}`);
    await this.svc.emit(c, "question_asked", "conversation-runner", kind === "question" ? `Question sent: ${questionId}` : `Message sent: ${kind}`, { kind, question: questionId ?? null });
    await this.svc.store.putConversation(st);
  }
}
