// The conversational reply: what the interview says when a participant asks something instead of answering.
//
// The runner owns the question flow and every safety rule. This is the one place where a reply may be written for the person's own
// words: "who are you?", "why do you need this?", "how long will it take?". A writer (a model, or a plain stand-in) is given the
// message, the question we are on, what the programme has approved us to say (its FAQ, the programme name and purpose) and the last
// few turns, and returns a short reply. The runner then adds the current question underneath, so the interview carries on.
//
// Nothing a writer returns is trusted: `replyProblem` refuses links, phone numbers, promises and anything too long, and a refused or
// missing reply falls back to the approved wording. The reply counts as agent-written text, so it follows the autonomy setting for
// "WhatsApp message written by the agent".
import type { Instrument, Question } from "./instrument";

export interface ResponderFact { id: string; answer: string }

export interface ResponderInput {
  /** What the participant wrote, with names and numbers already removed. */
  text: string;
  question: Question | null;
  context: "consent" | "question";
  mission: { programme?: string; objective?: string; guidance?: string };
  /** What the programme has approved us to say. A reply may use only these, the programme name and the purpose. */
  facts: ResponderFact[];
  /** The last few messages in order. */
  recent: { from: "us" | "them"; text: string }[];
  language?: string;
  names: string[];
}

export interface ResponderOutput {
  /** The reply to show before the question. Empty when the message needs no answer of its own. */
  reply: string;
  /** "answered": it used the approved facts. "unknown": it could not answer from them and said so; a person is told. "noise": there was nothing to answer. */
  kind: "answered" | "unknown" | "noise";
}

export interface ConversationResponder { respond(input: ResponderInput): Promise<ResponderOutput | null> }

export const MAX_REPLY_CHARS = 480;

const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|org|net|io|co)\b)/i;
const EMAIL_LIKE = /\S+@\S+\.\S+/;
const PROMISES = /\b(guarantee|guaranteed|promise|i promise|we promise|definitely (get|offer)|job offer|you will get (a )?(job|paid|money)|will be paid|salary of|stipend of)\b/i;
const MONEY_ASK = /\b(send|pay|transfer|share)\b.{0,30}\b(money|upi|otp|password|pin|bank|card|aadhaar|aadhar)\b/i;

/** What is wrong with a written reply, in plain words. Null means it may be sent. */
export function replyProblem(reply: string): string | null {
  const r = reply.trim();
  if (!r) return "the reply is empty";
  if (r.length > MAX_REPLY_CHARS) return `the reply is longer than ${MAX_REPLY_CHARS} characters`;
  if (URL_LIKE.test(r) || EMAIL_LIKE.test(r)) return "the reply contains a link or an email address";
  if ((r.match(/\d/g) ?? []).length >= 7) return "the reply contains a long number";
  if (PROMISES.test(r)) return "the reply makes a promise the programme has not approved";
  if (MONEY_ASK.test(r)) return "the reply asks for money or private details";
  return null;
}

/** The approved facts of one mission's questionnaire, in the shape a writer needs. */
export function factsOf(ins: Instrument): ResponderFact[] { return ins.faq.map(f => ({ id: f.id, answer: f.answer })); }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const ASKS: [RegExp, string[]][] = [
  [/\b(who|kaun|kon)\b.*\b(you|are|aap|hai)\b|\bwho is this\b|\bwhat is this\b|\byou are\b.*\?/i, ["who", "about", "programme"]],
  [/\b(why|kyun|kyu|kis liye|kisliye)\b|\bwhat for\b|\bneed (this|my|the) (info|information|details)\b/i, ["why", "purpose", "reason"]],
  [/\b(safe|privacy|private|data|secure|share|confidential)\b/i, ["privacy", "data", "safe"]],
  [/\b(genuine|real|fake|scam|fraud|trust)\b/i, ["genuine", "real", "scam"]],
  [/\b(how long|time|minutes|kitna time|kitni der)\b/i, ["time", "long", "minutes"]],
];

/**
 * A plain stand-in for the model writer: finds the approved fact that matches what was asked and uses its words. It cannot compose
 * anything new, so it answers only the common questions and says nothing for the rest. Used when no model is switched on and in tests.
 */
export class ScriptedResponder implements ConversationResponder {
  async respond(i: ResponderInput): Promise<ResponderOutput | null> {
    const t = norm(i.text);
    if (!t) return null;
    for (const [re, hints] of ASKS) {
      if (!re.test(i.text) && !re.test(t)) continue;
      const hit = i.facts.find(f => hints.some(h => norm(f.id).includes(h) || norm(f.answer).includes(h)));
      if (hit) return { reply: hit.answer, kind: "answered" };
    }
    return null;
  }
}
