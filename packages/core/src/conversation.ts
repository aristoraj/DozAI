// The conversation runner: rails for the interview, judgment only where needed.
//
// A fixed, approved question flow decides WHAT to say next. Participant replies are classified into a fixed set of
// intents (answer, question, stop, wrong person, distress, deletion, off-topic, unclear), and every intent has an
// approved response. The model never writes text that goes to a participant, and a participant's words are never
// treated as instructions. When the interview finishes, the agent is woken to propose the outcome from the evidence.
import type { CaseRecord, Classification, ConversationState } from "@dozai/contracts";
import { newId } from "./ledger";
import { DozaiError, type CaseService } from "./service";
import { validateAnswer, type ReplyClassifier } from "./classifier";
import { clarifyLine, langOf, reaskHint, thanks } from "./phrases";
import { DRAFT_INSTRUMENT, firstQuestion, nextQuestionId, questionById, renderQuestion, type Instrument, type Question } from "./instrument";

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
    const known = st.answers.flatMap(a => { const k = questionById(ins, a.question_id)?.evidence_key; return k ? [{ key: k, value: a.value }] : []; });
    const recent = st.answers.slice(-3).map(a => ({ question: questionById(ins, a.question_id)?.text ?? a.question_id, answer: a.label ?? a.value }));
    const cls = await this.deps.classifier.classify({ text, question: q, context, instrument: ins, mission: await this.missionContext(c), known, recent });
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
      case "clarify": return this.reask(c, st, ins, q, context, false, "clarify");
      case "off_topic":
      case "unclear": return this.reask(c, st, ins, q, context, text.trim() === "");
      case "answer": return context === "consent" ? this.begin(c, st, ins, person.consent) : this.apply(c, st, ins, q!, cls);
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

  private async saveAnswer(c: CaseRecord, st: ConversationState, q: Question, v: { value: string; label?: string }, confidence: number): Promise<void> {
    const ev = await this.svc.emit(c, "answer_recorded", "conversation-runner", `Answer recorded for ${q.id}`, { question: q.id, evidence_key: q.evidence_key });
    await this.svc.store.addEvidence({ evidence_id: newId("ev"), case_id: c.case_id, question_id: q.evidence_key, value: v.value, source: "whatsapp", confidence, event_id: ev.event_id, at: this.svc.now().toISOString() });
    st.answers.push({ question_id: q.id, value: v.value, label: v.label, at: this.svc.now().toISOString(), after: st.messages_sent });
  }

  /**
   * A reply to the current question. It may also answer questions that come later ("I work at Acme as a cashier").
   * Every answer is validated against its own question before it is saved, and the flow only moves through questions that the
   * answers so far lead to, so a later answer is never saved for a question this person would not be asked.
   * An answer already recorded is never replaced, and a question already answered is never asked again.
   */
  private async apply(c: CaseRecord, st: ConversationState, ins: Instrument, q: Question, cls: Classification): Promise<ReplyResult> {
    const keyOf = (questionId: string) => questionById(ins, questionId)?.evidence_key;
    const answered = new Set(st.answers.map(a => keyOf(a.question_id)));
    const held = { ...(st.held ?? {}) };
    let newlyHeld = 0;
    for (const x of cls.also ?? []) {
      if (x.key === q.evidence_key || answered.has(x.key) || x.key in held) continue;
      if (!ins.questions.some(o => o.evidence_key === x.key)) continue; // not something this mission asks
      held[x.key] = { option_key: x.option_key, value: x.value, confidence: x.confidence }; newlyHeld += 1;
    }

    const own = validateAnswer(q, { option_key: cls.option_key, value: cls.value });
    if (!own) {
      st.held = Object.keys(held).length ? held : undefined;
      // The reply did not answer this question. If it told us something else we keep it and ask again without counting a failure.
      if (newlyHeld) { await this.say(c, st, ins, `${thanks(await this.langFor(c), newlyHeld, st.messages_sent)}\n\n${renderQuestion(q)}`, "question", q.id); return { handled: true, action: "reasked", detail: "answered another question" }; }
      return this.reask(c, st, ins, q, "question", false);
    }
    held[q.evidence_key] = { option_key: cls.option_key, value: cls.value, confidence: cls.confidence };

    let cur: Question | undefined = q;
    let finished = false;
    let saved = 0;
    for (let n = 0; cur && n <= ins.questions.length; n++) {
      let value: string;
      if (cur !== q && answered.has(cur.evidence_key)) {
        value = [...st.answers].reverse().find(a => keyOf(a.question_id) === cur!.evidence_key)!.value; // asked before on another path
      } else {
        const h = held[cur.evidence_key];
        const v = h && validateAnswer(cur, h);
        if (!v) break;
        await this.saveAnswer(c, st, cur, v, h.confidence); saved += 1;
        answered.add(cur.evidence_key); delete held[cur.evidence_key]; value = v.value;
      }
      const nextId = nextQuestionId(ins, cur, value);
      const next = questionById(ins, nextId);
      if (!next) { finished = true; cur = undefined; break; }
      cur = next;
    }
    st.reasks = 0;
    st.held = !finished && Object.keys(held).length ? held : undefined;
    if (finished || !cur) {
      st.status = "done"; st.current = null;
      await this.say(c, st, ins, ins.closing_message, "closing");
      return { handled: true, action: "finished", finished: true };
    }
    st.current = cur.id;
    await this.say(c, st, ins, `${thanks(await this.langFor(c), saved, st.messages_sent)}\n\n${renderQuestion(cur)}`, "question", cur.id);
    return { handled: true, action: "answered" };
  }

  /** The participant's language, which picks the wording of the thank-you and re-ask lines. */
  private async langFor(c: CaseRecord) { return langOf((await this.svc.store.getParticipant(c.tenant_id, c.participant_id))?.language); }

  /** What the mission is about, for a reader that understands meaning. Missing is fine: the flow does not depend on it. */
  private async missionContext(c: CaseRecord): Promise<{ programme?: string; objective?: string } | undefined> {
    try { const m = await this.svc.getMission(c.tenant_id, c.mission_version); return { programme: m.programme_name ?? undefined, objective: m.objective ?? undefined }; } catch { return undefined; }
  }

  private async reask(c: CaseRecord, st: ConversationState, ins: Instrument, q: Question | null, context: "consent" | "question", noText: boolean, mode: "reask" | "clarify" = "reask"): Promise<ReplyResult> {
    st.reasks += 1;
    if (st.reasks > ins.max_reasks) {
      await this.escalate(c, st, ins, "unclear_replies", "The participant's replies could not be understood after repeated tries.", ins.handover_message);
      return { handled: true, action: "escalated", detail: "unclear_replies" };
    }
    const lang = await this.langFor(c);
    let text: string;
    if (context === "consent" || !q) text = `${noText ? ins.unsupported_prefix : ins.reask_prefix}\n\n${CONSENT_PROMPT}`;
    else if (mode === "clarify") text = `${clarifyLine(lang, q.type, st.reasks)}\n\n${renderQuestion(q)}`;
    else text = `${noText ? ins.unsupported_prefix : `${ins.reask_prefix}\n${reaskHint(lang, q.type, st.reasks)}`}\n\n${renderQuestion(q)}`;
    await this.say(c, st, ins, text, "reask", q?.id);
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
