// What does a participant's reply mean? The rule classifier handles the common cases deterministically and
// cheaply. A model-based classifier (in @dozai/adapters) can be layered on top for replies the rules cannot place.
// Either way the result is one of a fixed set of intents: free text from a participant never becomes an instruction.
import type { Classification } from "@dozai/contracts";
import { optionsOf, type Instrument, type Question } from "./instrument";

export interface ClassifyInput {
  text: string;
  /** The question currently waiting for an answer, or null while waiting for consent. */
  question: Question | null;
  context: "consent" | "question";
  instrument: Instrument;
}

export interface ReplyClassifier { classify(i: ClassifyInput): Promise<Classification> }

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s?]/gu, " ").replace(/\s+/g, " ").trim();
const has = (t: string, words: string[]) => words.some(w => new RegExp(`(^|\\s)${w}(\\s|$|\\?)`).test(t));

const STOP = /\b(stop|unsubscribe|opt ?out|do not contact|dont contact|don t contact|band karo)\b/;
const DELETION = /\b(delete|remove|erase)\b.*\b(data|details|number|information|info|records?)\b|forget me|right to be forgotten/;
const WRONG_PERSON = /wrong (number|person)|\bi am not\b|\bi m not\b|this is not my|not the person|you have the wrong/;
const DISTRESS = /suicid|kill myself|end my life|want to die|harass|abus(e|ing|ive)|threat|police|lawyer|legal action|consumer court|complain|report you|blackmail/;
const GREETING = /^(hi|hello|hey|hii+|ok|okay|k|thanks|thank you|thx|good (morning|evening|afternoon)|namaste|namaskar|hmm+|\?|\.+)$/;
const QUESTIONISH = /\?|^(who|why|what|how|where|when|which|is this|are you|kaun|kyun|kyon|kya|kaise|kitna)\b/;

export class RuleClassifier implements ReplyClassifier {
  async classify(i: ClassifyInput): Promise<Classification> {
    const raw = i.text.trim();
    const t = norm(raw);
    const out = (c: Partial<Classification> & { intent: Classification["intent"] }): Classification => ({ confidence: 0.9, ...c });

    if (!t) return out({ intent: "off_topic", value: "no text", confidence: 0.9 }); // media, sticker, emoji only
    if (!/[\p{L}\p{N}]/u.test(t)) return out({ intent: "off_topic", confidence: 0.9 }); // only punctuation such as "???"

    if (STOP.test(t)) return out({ intent: "stop" });
    if (i.context === "consent" && /^no\b/.test(t) && t.split(" ").length <= 3) return out({ intent: "stop" }); // a bare "No" to "May we continue?"
    if (DELETION.test(t)) return out({ intent: "deletion" });
    if (WRONG_PERSON.test(t)) return out({ intent: "wrong_person" });
    if (DISTRESS.test(t)) return out({ intent: "distress" });

    // Consent step: yes or no only.
    if (i.context === "consent") {
      if (/^(yes|y|yeah|yep|haan|han|ha|ji|ok|okay|sure|continue|yes continue|1)\b/.test(t)) return out({ intent: "answer", value: "yes" });
      return this.faqOrUnclear(t, i);
    }

    const q = i.question;
    if (q && (q.type === "choice" || q.type === "yesno")) {
      const hit = matchOption(t, q);
      if (hit) return out({ intent: "answer", option_key: hit.key, value: hit.value, confidence: 0.95 });
      if (GREETING.test(t)) return out({ intent: "off_topic", confidence: 0.8 });
      return this.faqOrUnclear(t, i);
    }

    // Free-text question.
    if (GREETING.test(t) || t.length < 2) return out({ intent: "off_topic", confidence: 0.8 });
    if (QUESTIONISH.test(t)) return this.faqOrUnclear(t, i);
    if (raw.length > 200) return out({ intent: "unclear", confidence: 0.4 });
    return out({ intent: "answer", value: raw, confidence: 0.6 });
  }

  private faqOrUnclear(t: string, i: ClassifyInput): Classification {
    if (QUESTIONISH.test(t)) {
      const hit = i.instrument.faq.find(f => f.keywords.some(k => t.includes(k)));
      return { intent: "faq", faq_id: hit?.id ?? "who", confidence: hit ? 0.8 : 0.5 };
    }
    return { intent: GREETING.test(t) ? "off_topic" : "unclear", confidence: 0.6 };
  }
}

/** Match a reply to one of a question's options: by number, by label, or by a synonym. */
export function matchOption(t: string, q: Question) {
  const options = optionsOf(q);
  const first = t.split(" ")[0]!;
  const byNumber = options.find(o => o.key === first);
  if (byNumber) return byNumber;
  for (const o of options) {
    const names = [o.label, o.value.replace(/_/g, " "), ...(o.synonyms ?? [])].map(norm);
    if (names.some(n => n && (t === n || has(t, [n])))) return o;
  }
  return undefined;
}
