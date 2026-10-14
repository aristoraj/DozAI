// Checks on the questions of a mission being written: the same question twice, and a plain-words check of a whole draft.
// Used when Mission Studio drafts a mission, when a person edits the questions before sign-off, and by the "check this draft"
// request. It reads data only and changes nothing.
import { MissionInputSchema } from "@dozai/contracts";
import { nextQuestionId, optionsOf, questionById, type Instrument, type Question } from "./instrument";
import { channelFlowProblems } from "./flow";
import { missionProblems } from "./mission";
import { spokenQuestion } from "./voice";

const MAX_PATHS = 500;
const TEXT_ANSWER = "(text)";

/** Wording compared without capital letters, punctuation or extra spaces, so "Where do you work?" and "where do you work" match. */
export const normaliseWording = (s: string): string => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

/** Every road through the questionnaire as the ids of the questions asked, or null when there are too many to list. */
export function questionPaths(i: Instrument): string[][] | null {
  const out: string[][] = [];
  const first = i.questions[0];
  if (!first) return out;
  let capped = false;
  const walk = (q: Question, asked: string[]) => {
    if (capped) return;
    for (const v of q.type === "text" ? [TEXT_ANSWER] : optionsOf(q).map(o => o.value)) {
      const here = [...asked, q.id];
      const next = questionById(i, nextQuestionId(i, q, v));
      if (!next || here.includes(next.id)) { out.push(here); if (out.length > MAX_PATHS) { capped = true; return; } }
      else walk(next, here);
    }
  };
  walk(first, []);
  return capped ? null : out;
}

/** A category (the `module` of a question) as a short key: lower case, letters, digits and underscores. "Same Job" and "same_job" are one category. */
export function categoryKey(name: string): string {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
}
/** The category as people read it: "same_job" is "Same job". */
export const categoryTitle = (key: string): string => String(key).replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());

/**
 * Categories for a draft written by a model: every question in one, and no sign of grouping by purpose, is sent back. (A plain draft made
 * without a model groups by simple rules instead and is not held to this.)
 */
export function categoryProblems(i: Instrument): string[] {
  const keys = new Set(i.questions.map(q => q.module));
  if (i.questions.length >= 4 && keys.size === 1) return [`All ${i.questions.length} questions are in one category ("${[...keys][0]}"). Group them into categories by purpose, such as work or support, and give each question the category it belongs to.`];
  return [];
}

/**
 * The phone wording is fixed: it is what the voice agent says, and people do not change it. A question that already exists must sound the same on a call
 * as before (editing its written text is allowed only if the wording on the phone was pinned first), and a new question gets the automatic wording only.
 */
export function phoneWordingProblems(before: Instrument, after: Instrument): string[] {
  const out: string[] = [];
  after.questions.forEach((q, n) => {
    const old = before.questions.find(x => x.id === q.id);
    if (!old) { if (q.spoken) out.push(`Question ${n + 1} is new, so its phone wording is made automatically and cannot be written by hand.`); }
    else if (spokenQuestion(old) !== spokenQuestion(q)) out.push(`The phone wording of question ${n + 1} is fixed and cannot be changed.`);
  });
  return out;
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/**
 * Questions that repeat each other. Two questions with the same wording are a repeat when one person could be asked both.
 * Two questions that save to the same answer are a repeat when one person would be asked both. (Asking the same thing on
 * two different branches, such as "where do you work" for people who stayed and people who moved, is fine.)
 */
export function duplicateProblems(i: Instrument): string[] {
  const out: string[] = [];
  const qs = i.questions;
  const number = (q: Question) => qs.indexOf(q) + 1;
  const paths = questionPaths(i);
  const together = (a: Question, b: Question) => !paths || paths.some(p => p.includes(a.id) && p.includes(b.id));
  for (let x = 0; x < qs.length; x++) {
    for (let y = x + 1; y < qs.length; y++) {
      const a = qs[x]!, b = qs[y]!;
      if (normaliseWording(a.text) && normaliseWording(a.text) === normaliseWording(b.text) && together(a, b)) out.push(`Questions ${number(a)} and ${number(b)} are the same question: "${short(a.text)}". Keep one.`);
      else if (a.evidence_key === b.evidence_key && together(a, b)) out.push(`Questions ${number(a)} and ${number(b)} both collect "${a.evidence_key}" for the same person. Keep one.`);
    }
  }
  return out;
}

/** A schema complaint in plain words: which question, and what is wrong. */
function plainIssue(issue: { path: (string | number)[]; message: string }): string {
  const [root, list, n, field] = issue.path;
  if (root === "instrument" && list === "questions" && typeof n === "number") return `Question ${n + 1}${field ? `, ${String(field)}` : ""}: ${issue.message.toLowerCase()}`;
  if (root === "evidence_requirements" && typeof list === "number") return `What to find out, item ${list + 1}${n ? `, ${String(n)}` : ""}: ${issue.message.toLowerCase()}`;
  return `${issue.path.join(".") || "mission"}: ${issue.message}`;
}

export interface MissionCheck {
  /** Everything wrong with the draft, in plain words. Empty means it can be saved. */
  problems: string[];
  /** What the voice agent would say for each question, so both channels can be read side by side. */
  phone: { id: string; spoken: string }[];
}

/** Check a mission definition without saving it: the same rules that apply when it is saved, plus repeated questions. */
export function checkMissionDefinition(raw: unknown): MissionCheck {
  // The version name is not what is being checked here (and the built-in mission's own name would be refused), so a neutral one is used.
  const probe = raw && typeof raw === "object" ? { ...(raw as object), version: "check-only-v1.0" } : raw;
  const parsed = MissionInputSchema.safeParse(probe);
  if (!parsed.success) return { problems: parsed.error.issues.slice(0, 8).map(plainIssue), phone: [] };
  const ins = parsed.data.instrument as Instrument;
  return { problems: [...missionProblems(parsed.data), ...channelFlowProblems(ins, parsed.data.evidence_requirements ?? []), ...duplicateProblems(ins)], phone: ins.questions.map(q => ({ id: q.id, spoken: spokenQuestion(q) })) };
}
