// Do WhatsApp and a phone call ask the same questions, in the same order, for the same person?
//
// WhatsApp follows the questionnaire (the instrument): questions in order, with branching rules. A call follows the list of
// evidence the mission needs: fields in order, each with an "ask only if" condition. They are two descriptions of one mission,
// and they can drift apart. This walks every path through the questionnaire and checks that a call would ask the same
// things in the same order. It reads data only and changes nothing.
import type { Requirement } from "@dozai/contracts";
import { nextQuestionId, optionsOf, questionById, type Instrument, type Question } from "./instrument";

/** The value used for a free-text answer when walking paths: any text takes the same road. */
const TEXT = "(text)";
const MAX_PATHS = 500;

export interface FlowPath {
  /** The answers that decide the path, in the order they are given: only choice and yes/no questions. */
  decided_by: { key: string; value: string }[];
  /** Every evidence key WhatsApp asks on this path, in order. */
  whatsapp: string[];
  /** Every evidence key a call asks on this path, in order. */
  call: string[];
}

/** Every path through the questionnaire, or null when there are too many to list (a mission that large is not checked). */
export function whatsappPaths(i: Instrument): { answers: [string, string][] }[] | null {
  const out: { answers: [string, string][] }[] = [];
  const first = i.questions[0];
  if (!first) return out;
  let capped = false;
  const walk = (q: Question, answers: [string, string][], seen: Set<string>) => {
    if (capped) return;
    for (const v of q.type === "text" ? [TEXT] : optionsOf(q).map(o => o.value)) {
      const here: [string, string][] = [...answers, [q.evidence_key, v]];
      const next = questionById(i, nextQuestionId(i, q, v));
      if (!next || seen.has(next.id)) { out.push({ answers: here }); if (out.length > MAX_PATHS) { capped = true; return; } }
      else walk(next, here, new Set([...seen, next.id]));
    }
  };
  walk(first, [], new Set([first.id]));
  return capped ? null : out;
}

/** What a call asks, given the answers on a path: the needs in list order, each only when its own condition holds. */
export function callKeys(reqs: Requirement[], given: Map<string, string>): string[] {
  const earlier = new Set<string>();
  const asked: string[] = [];
  for (const r of reqs) {
    // A call only knows an answer it has already heard, so a condition on a later need is never met.
    if (!r.when || (earlier.has(r.when.key) && r.when.in.includes(given.get(r.when.key) ?? ""))) asked.push(r.key);
    earlier.add(r.key);
  }
  return asked;
}

/** The paths with what each channel asks. Null when the questionnaire has too many paths to list. */
export function compareChannels(i: Instrument, reqs: Requirement[]): FlowPath[] | null {
  const paths = whatsappPaths(i);
  if (!paths) return null;
  return paths.map(p => {
    const given = new Map(p.answers);
    const whatsapp = [...new Set(p.answers.map(([k]) => k))];
    // Without a list of needs a call asks every field once, with no conditions.
    const call = reqs.length ? callKeys(reqs, given) : [...new Set(i.questions.map(q => q.evidence_key))];
    // Only the answers that send the questionnaire down a different road are worth naming.
    const branching = new Set(i.questions.filter(q => q.next?.some(r => r.when)).map(q => q.evidence_key));
    return { decided_by: p.answers.filter(([k]) => branching.has(k)).map(([key, value]) => ({ key, value })), whatsapp, call };
  });
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, n) => x === b[n]);
const say = (keys: string[]) => (keys.length ? keys.join(", ") : "nothing");
const describe = (p: FlowPath) => (p.decided_by.length ? `when ${p.decided_by.map(d => `${d.key} is ${d.value}`).join(" and ")}` : "on every path");

/**
 * Plain-words problems where a call would not ask what WhatsApp asks. Empty means the two agree on every path.
 * Checks: the same questions in the same order on every path; a need that waits for a later need; and one evidence key
 * asked in two places with a different kind of answer.
 */
export function channelFlowProblems(i: Instrument, reqs: Requirement[]): string[] {
  const out: string[] = [];

  // One key, one kind of answer: a call asks the first question for a key, so a second one must expect the same answers.
  const byKey = new Map<string, Question[]>();
  for (const q of i.questions) byKey.set(q.evidence_key, [...(byKey.get(q.evidence_key) ?? []), q]);
  for (const [key, qs] of byKey) {
    if (qs.length < 2) continue;
    const shape = (q: Question) => (q.type === "text" ? "text" : optionsOf(q).map(o => o.value).sort().join("|"));
    if (new Set(qs.map(shape)).size > 1) out.push(`"${key}" is asked in more than one place with different kinds of answer, so a call cannot ask it the same way`);
  }

  // A need cannot wait for one that comes after it: a call has not heard that answer yet.
  const index = new Map(reqs.map((r, n) => [r.key, n]));
  for (const r of reqs) {
    const w = r.when && index.get(r.when.key);
    if (r.when && w !== undefined && w > (index.get(r.key) ?? 0)) out.push(`"${r.key}" waits for "${r.when.key}", but a call reaches "${r.when.key}" later. Move "${r.when.key}" before it`);
  }

  const paths = compareChannels(i, reqs);
  if (!paths) return out;
  const seen = new Set<string>();
  for (const p of paths) {
    if (sameList(p.whatsapp, p.call)) continue;
    const onlyWa = p.whatsapp.filter(k => !p.call.includes(k)), onlyCall = p.call.filter(k => !p.whatsapp.includes(k));
    let msg: string;
    if (!reqs.length) msg = `a call would ask every question, but WhatsApp asks only ${say(p.whatsapp)} ${describe(p)}. Add the list of evidence the mission needs, with the conditions`;
    else if (onlyWa.length || onlyCall.length) msg = `${describe(p)}: WhatsApp asks ${say(p.whatsapp)}; a call asks ${say(p.call)}${onlyWa.length ? ` (a call never asks ${say(onlyWa)})` : ""}${onlyCall.length ? ` (WhatsApp never asks ${say(onlyCall)})` : ""}`;
    else msg = `${describe(p)}: the two ask the same things in a different order (WhatsApp: ${say(p.whatsapp)}; a call: ${say(p.call)})`;
    if (!seen.has(msg)) { seen.add(msg); out.push(msg); }
    if (out.length >= 6) break; // enough to see the pattern
  }
  return out;
}
