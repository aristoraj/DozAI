// What does a participant's reply mean? The rule classifier handles the clear cases deterministically and
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
  /** What the mission is about. Only a reader that understands meaning (a model) uses this. */
  mission?: { programme?: string; objective?: string };
  /** Answers already recorded in this conversation: evidence key and value. */
  known?: { key: string; value: string }[];
  /** The last few questions asked and what was understood from the replies, oldest first. */
  recent?: { question: string; answer: string }[];
}

export interface ReplyClassifier { classify(i: ClassifyInput): Promise<Classification> }

// Letters, digits and the vowel signs of Devanagari (category M) are kept: without them a word such as "हाँ" would be cut to one letter.
// Devanagari digits become ordinary digits so "२" and "2" are the same.
const DEVANAGARI_DIGITS = "०१२३४५६७८९";
export const normaliseReply = (s: string): string => s.toLowerCase().normalize("NFKC")
  .replace(/[०-९]/g, d => String(DEVANAGARI_DIGITS.indexOf(d)))
  .replace(/[^\p{L}\p{M}\p{N}\s?]/gu, " ").replace(/\s+/g, " ").trim();
const norm = normaliseReply;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (t: string, words: string[]) => words.some(w => new RegExp(`(^|\\s)${escapeRe(w)}(\\s|$|\\?)`, "u").test(t));
// \b does not work next to Devanagari, so words are bounded by "not a letter, mark or digit" instead.
const BEFORE = "(?<![\\p{L}\\p{M}\\p{N}])", AFTER = "(?![\\p{L}\\p{M}\\p{N}])";
const word = (alts: string) => new RegExp(`${BEFORE}(?:${alts})${AFTER}`, "u");

const STOP = word("stop|unsubscribe|opt ?out|do not contact|dont contact|don t contact|band karo|बंद करो|मैसेज बंद|संदेश बंद");
const DELETION = /\b(delete|remove|erase)\b.*\b(data|details|number|information|info|records?)\b|forget me|right to be forgotten/;
// "I am not <someone>" means wrong person. "I am not working / interested / sure" does not.
const WRONG_PERSON = /wrong (number|person)|\bi (am|m) not (?!(working|employed|studying|doing|interested|sure|able|looking|in |at |a |an |the |currently|now|really|yet|having|getting|going|available|well|happy|free|ready)\b)|this is not my|not the person|you have the wrong|गलत नंबर|गलत व्यक्ति/;
const DISTRESS = /suicid|kill myself|end my life|want to die|harass|abus(e|ing|ive)|threat|police|lawyer|legal action|consumer court|complain|report you|blackmail/;
const GREETING = /^(hi|hello|hey|hii+|ok|okay|k|thanks|thank you|thx|good (morning|evening|afternoon)|namaste|namaskar|hmm+|\?|\.+|नमस्ते|नमस्कार|धन्यवाद|शुक्रिया)$/u;
const QUESTIONISH = /\?|^(who|why|what|how|where|when|which|is this|are you|kaun|kyun|kyon|kya|kaise|kitna|कौन|क्यों|क्या|कैसे|कितना)(?![\p{L}\p{M}\p{N}])/u;
// The participant asks what the question or an option means, or asks us to say it again.
const CLARIFY = word("what do you mean|what does (it|that|this|[a-z]+( [a-z]+){0,2}) mean|^(please )?(repeat|explain)( please)?$|what is (that|this)|what is the meaning|meaning of|(can|could|will|would) you (please )?(repeat|explain|say)|(please )?(repeat|explain) (that|it|this|please|the question|again)|say (it )?again|once more|(i )?(do not|don t|dont) understand|did not understand|didn t understand|not clear|samajh nahi|samajh nahin|samjha nahi|samjhi nahi|kya matlab|matlab kya|समझ नहीं|समझा नहीं|क्या मतलब|मतलब क्या|दोबारा बोल|फिर से बोल|फिर से बताइए");
// A reply that says "I do not know" does not answer anything, in any of the three ways of writing it.
const DONT_KNOW = word("(i )?(do not|don t|dont|can t|cant|cannot) (know|say|tell|remember)|no idea|not sure|unsure|idk|pata nahi|pata nahin|pta nahi|nahi pata|nahin pata|maloom nahi|malum nahi|मालूम नहीं|पता नहीं|पता नही|नहीं पता|नहीं मालूम|याद नहीं");
// Words that are not an answer to a text question: yes, no, none, nothing.
const NON_ANSWER = new RegExp(`^(yes|y|yeah|yep|no|n|nope|na|n a|nil|none|nothing|haan|han|ha|ji|ok|okay|nahi|nahin|nhi|kuch nahi|koi nahi|हां|हाँ|हा|जी|नहीं|नही|ना|कुछ नहीं|कोई नहीं|कुछ नही|कोई नही)$`, "u");
const NEGATION = word("not|no|never|nahi|nahin|nhi|na|mat|नहीं|नही|ना|मत");
// Words that may sit around a bare option number and still mean "I pick that one".
const SELECTION_WORDS = new Set(["option", "number", "no", "answer", "ans", "is", "the", "it", "its", "it s", "please", "pls", "plz", "ji", "sahi", "hai", "wala", "wali", "one", "choose", "select", "pick", "नंबर", "विकल्प", "जी", "कृपया", "वाला", "है"]);
const ORDINALS: Record<string, string> = { first: "1", "1st": "1", second: "2", "2nd": "2", third: "3", "3rd": "3", fourth: "4", "4th": "4", fifth: "5", "5th": "5", pehla: "1", pehli: "1", dusra: "2", doosra: "2", dusri: "2", teesra: "3", teesri: "3", chautha: "4", "पहला": "1", "दूसरा": "2", "तीसरा": "3", "चौथा": "4", "पांचवां": "5" };

export const isDontKnow = (t: string): boolean => DONT_KNOW.test(t);
export const isNonAnswer = (t: string): boolean => NON_ANSWER.test(t) || /^[\d\s]+$/.test(t) || !/[\p{L}]/u.test(t);

export class RuleClassifier implements ReplyClassifier {
  async classify(i: ClassifyInput): Promise<Classification> {
    const raw = i.text.trim();
    const t = norm(raw);
    const out = (c: Partial<Classification> & { intent: Classification["intent"] }): Classification => ({ confidence: 0.9, ...c });

    if (!t) return out({ intent: "off_topic", value: "no text", confidence: 0.9 }); // media, sticker, emoji only
    if (!/[\p{L}\p{N}]/u.test(t)) return out({ intent: "off_topic", confidence: 0.9 }); // only punctuation such as "???"

    if (STOP.test(t)) return out({ intent: "stop" });
    if (i.context === "consent" && /^(no|nahi|nahin|नहीं|नही|ना)(?![\p{L}\p{M}])/u.test(t) && t.split(" ").length <= 3) return out({ intent: "stop" }); // a bare "No" to "May we continue?"
    if (DELETION.test(t)) return out({ intent: "deletion" });
    if (WRONG_PERSON.test(t)) return out({ intent: "wrong_person" });
    if (DISTRESS.test(t)) return out({ intent: "distress" });

    // Consent step: yes or no only.
    if (i.context === "consent") {
      if (/^(yes|y|yeah|yep|haan|han|ha|ji|ok|okay|sure|continue|yes continue|1|हां|हाँ|हा|जी|ठीक|ठीक है|जारी)(?![\p{L}\p{M}\p{N}])/u.test(t)) return out({ intent: "answer", value: "yes" });
      return this.faqOrUnclear(t, i);
    }

    const q = i.question;
    if (q && CLARIFY.test(t)) return out({ intent: "clarify", confidence: 0.8 });
    if (q && (q.type === "choice" || q.type === "yesno")) {
      const hit = matchOption(t, q);
      if (hit) return out({ intent: "answer", option_key: hit.key, value: hit.value, confidence: 0.95 });
      if (GREETING.test(t)) return out({ intent: "off_topic", confidence: 0.8 });
      if (isDontKnow(t)) return out({ intent: "unclear", confidence: 0.6 });
      return this.faqOrUnclear(t, i);
    }

    // Free-text question. Yes, no, "I don't know" and a bare number are not answers to it.
    if (GREETING.test(t) || t.length < 2) return out({ intent: "off_topic", confidence: 0.8 });
    if (isDontKnow(t) || isNonAnswer(t)) return out({ intent: "unclear", confidence: 0.6 });
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

/**
 * Match a reply to one of a question's options, but only when the reply clearly picks one.
 * - A number counts only when it stands alone ("2", "option 2", "2 please", "second one"). "2 months ago I left" is not a pick.
 * - A label or synonym counts when it is the whole reply or a whole phrase in it, as long as exactly one option matches and the
 *   rest of the reply does not turn it around ("I do not work at the same place" is not "same place").
 */
export function matchOption(t: string, q: Question) {
  const options = optionsOf(q);
  const tokens = t.split(" ");
  const keyTokens = tokens.map(w => (ORDINALS[w] ?? w)).filter(w => options.some(o => o.key === w));
  if (keyTokens.length === 1 && tokens.every(w => options.some(o => o.key === (ORDINALS[w] ?? w)) || SELECTION_WORDS.has(w))) return options.find(o => o.key === keyTokens[0]);

  const matches = options.filter(o => phrasesOf(o).some(n => t === n || has(t, [n])));
  if (matches.length !== 1) return undefined;
  const chosen = matches[0]!;
  const phrase = phrasesOf(chosen).filter(n => t === n || has(t, [n])).sort((a, b) => b.length - a.length)[0]!;
  const rest = t.replace(phrase, " ");
  if (NEGATION.test(rest)) return undefined;
  return chosen;
}
const phrasesOf = (o: { label: string; value: string; synonyms?: string[] }) => [o.label, o.value.replace(/_/g, " "), ...(o.synonyms ?? [])].map(norm).filter(Boolean);

/** True when the reply is nothing but a clear pick (a number, a label or a listed synonym), so no further reading is needed. */
export function isPlainSelection(t: string, q: Question): boolean {
  const options = optionsOf(q);
  const tokens = t.split(" ");
  if (tokens.length <= 3 && tokens.some(w => options.some(o => o.key === (ORDINALS[w] ?? w)))) return !!matchOption(t, q);
  const hit = matchOption(t, q);
  return !!hit && phrasesOf(hit).some(n => n === t);
}

/**
 * Is this a usable answer to the question? Checks the type and the allowed values, whoever read the reply.
 * A choice must name one of the question's options. A text answer must be real text: not yes/no, not "I don't know",
 * not just digits, and no longer than the contract allows.
 */
export function validateAnswer(q: Question, a: { option_key?: string; value?: string }): { value: string; label?: string } | null {
  if (q.type !== "text") {
    const options = optionsOf(q);
    const opt = options.find(o => o.key === a.option_key) ?? (a.option_key === undefined ? options.find(o => o.value === a.value) : undefined);
    return opt ? { value: opt.value, label: opt.label } : null;
  }
  const v = (a.value ?? "").trim().replace(/\s+/g, " ");
  if (v.length < 2 || v.length > 300) return null;
  const t = norm(v);
  if (!t || isNonAnswer(t) || isDontKnow(t)) return null;
  return { value: v };
}
