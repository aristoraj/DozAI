// The questionnaire and the approved message bank. This is DATA, not logic: replacing it with the signed-off
// instrument (34 questions, Hindi, branching) must not need any code change.
//
// !! Everything below is DRAFT wording written to exercise the flow. Nothing here is approved by the programme team.
// The conversation runner refuses to message real participants with a draft instrument unless explicitly allowed.

export interface QuestionOption { key: string; label: string; value: string; synonyms?: string[] }

export interface Question {
  id: string;
  module: string;
  type: "choice" | "yesno" | "text";
  text: string;
  /** How to say it on a phone call, when the written wording does not work aloud. */
  spoken?: string;
  /** An open question that invites an extra comment ("Is there anything else you would like to tell us?"): "no" or "nothing" is a good answer. */
  optional?: boolean;
  options?: QuestionOption[];
  /** Stored as evidence under this key (the policy engine looks for e.g. "employer_name"). */
  evidence_key: string;
  /** After this question: first matching rule wins; no match means the next question in order. goto null ends the interview. */
  next?: { when?: { equals: string }; goto: string | null }[];
}

export interface FaqEntry { id: string; keywords: string[]; answer: string }

export interface Instrument {
  version: string;
  draft: boolean;
  questions: Question[];
  start_message: string;
  closing_message: string;
  reask_prefix: string;
  unsupported_prefix: string;
  handover_message: string;
  wrong_person_message: string;
  distress_message: string;
  deletion_message: string;
  faq: FaqEntry[];
  max_reasks: number;
  max_messages: number;
  /** Who approved this wording and when. Set by the platform, not by the person writing the mission. */
  signed_off?: { by: string; at: string };
}

export const YESNO: QuestionOption[] = [
  { key: "1", label: "Yes", value: "yes", synonyms: ["yes", "y", "yeah", "yep", "haan", "han", "ha", "ji", "ok", "okay", "sure", "हां", "हाँ", "हा", "जी", "ठीक है"] },
  { key: "2", label: "No", value: "no", synonyms: ["no", "n", "nope", "nahi", "nahin", "na", "nhi", "नहीं", "नही", "ना"] },
];

export const optionsOf = (q: Question): QuestionOption[] => (q.type === "yesno" ? YESNO : q.options ?? []);

/** What is saved when someone says there is nothing to add to an open question. */
export const NOTHING_TO_ADD = "Nothing to add";
const OPEN_ENDED = /\b(anything|something) else\b|\bany (other|further|more|additional) (comments?|feedback|thoughts?|suggestions?|things?)\b|\bany (comments?|feedback|suggestions?)\b|\bwould you like to (add|tell|share|say)\b|\bis there anything\b/i;
/**
 * A free-text question that invites an extra comment. For it, "no" and "nothing" are real answers, where for any other text question
 * (a name, a job title) they are not. A mission can say so with `optional`; questions written before that existed are recognised by their words.
 */
export const isOptionalText = (q: Question): boolean => q.type === "text" && (q.optional === true || OPEN_ENDED.test(q.text));

export const DRAFT_INSTRUMENT: Instrument = {
  version: "DRAFT-0.1",
  draft: true,
  start_message: "Thank you. We will now ask a few short questions. You can reply STOP at any time.",
  closing_message: "Thank you for your time. Our team will look at your answers.",
  reask_prefix: "Sorry, we could not understand that.",
  unsupported_prefix: "We can only read text messages for now.",
  handover_message: "Thank you. A member of our team will get in touch with you.",
  wrong_person_message: "Sorry for the mix-up. We will not message this number again.",
  distress_message: "Thank you for telling us. A member of our team will contact you soon.",
  deletion_message: "We have noted your request. Our team will confirm it with you.",
  max_reasks: 2,
  max_messages: 40,
  faq: [
    { id: "who", keywords: ["who", "kaun", "which organisation", "which organization", "who are you"], answer: "We are the follow-up team from EdZola, working with the programme you took part in." },
    { id: "why", keywords: ["why", "kyun", "kyon", "reason", "purpose"], answer: "We want to know how things are going after your training, so the programme can support you better." },
    { id: "data", keywords: ["data", "privacy", "private", "share", "shared", "safe", "secret"], answer: "Your answers are used only for programme follow-up. You can reply STOP at any time." },
    { id: "genuine", keywords: ["scam", "fraud", "fake", "genuine", "real", "trust", "money", "pay", "bank", "otp"], answer: "This is a genuine follow-up from the programme you attended. We will never ask for money, passwords or bank details." },
    { id: "time", keywords: ["how long", "time", "minutes", "kitna"], answer: "It takes about 5 minutes." },
  ],
  questions: [
    {
      id: "q_status", module: "status", type: "choice", evidence_key: "work_status", text: "Which of these describes you best right now?",
      options: [
        { key: "1", label: "I work at the same place as before", value: "same_job", synonyms: ["same job", "same place", "same"] },
        { key: "2", label: "I work at a different place now", value: "changed_job", synonyms: ["different", "new job", "changed", "new place"] },
        { key: "3", label: "I am not working right now", value: "not_employed", synonyms: ["not working", "no job", "unemployed", "jobless"] },
        { key: "4", label: "I am studying or in training", value: "education_training", synonyms: ["studying", "study", "training", "course", "college"] },
      ],
      next: [{ when: { equals: "same_job" }, goto: "q_same_employer" }, { when: { equals: "changed_job" }, goto: "q_new_employer" }, { when: { equals: "not_employed" }, goto: "q_ne_reason" }, { when: { equals: "education_training" }, goto: "q_edu_course" }],
    },
    { id: "q_same_employer", module: "same_job", type: "text", evidence_key: "employer_name", text: "Please type the name of the place where you work." },
    { id: "q_same_role", module: "same_job", type: "text", evidence_key: "role_title", text: "What is your job title or the work you do?", next: [{ goto: "q_support" }] },
    { id: "q_new_employer", module: "changed_job", type: "text", evidence_key: "employer_name", text: "Please type the name of the place where you work now." },
    { id: "q_new_role", module: "changed_job", type: "text", evidence_key: "role_title", text: "What is your job title or the work you do?" },
    {
      id: "q_new_reason", module: "changed_job", type: "choice", evidence_key: "change_reason", text: "Why did you change jobs?",
      options: [
        { key: "1", label: "Better pay", value: "better_pay", synonyms: ["pay", "salary"] },
        { key: "2", label: "Closer to home", value: "closer_home", synonyms: ["closer", "near home", "nearer"] },
        { key: "3", label: "A better role", value: "better_role", synonyms: ["role", "growth"] },
        { key: "4", label: "The earlier job ended", value: "job_ended", synonyms: ["ended", "contract", "laid off"] },
        { key: "5", label: "Another reason", value: "other", synonyms: ["other", "another"] },
      ],
      next: [{ goto: "q_support" }],
    },
    {
      id: "q_ne_reason", module: "not_employed", type: "choice", evidence_key: "not_working_reason", text: "What is the main reason you are not working?",
      options: [
        { key: "1", label: "I am looking for work", value: "seeking", synonyms: ["looking", "searching", "seeking"] },
        { key: "2", label: "Family or health reasons", value: "family_health", synonyms: ["family", "health", "ill", "marriage"] },
        { key: "3", label: "Another reason", value: "other", synonyms: ["other", "another"] },
      ],
    },
    { id: "q_ne_search", module: "not_employed", type: "yesno", evidence_key: "job_search", text: "Are you looking for a job right now?", next: [{ goto: "q_support" }] },
    { id: "q_edu_course", module: "education_training", type: "text", evidence_key: "course", text: "What are you studying or training for?", next: [{ goto: "q_support" }] },
    { id: "q_support", module: "support", type: "yesno", evidence_key: "support_requested", text: "Would you like our team to contact you about job support?", next: [{ goto: null }] },
  ],
};

export const questionById = (i: Instrument, id: string | null): Question | undefined => (id ? i.questions.find(q => q.id === id) : undefined);
export const firstQuestion = (i: Instrument): Question => i.questions[0]!;

/** The question that follows `q` given the participant's answer value. null = interview finished. */
export function nextQuestionId(i: Instrument, q: Question, answerValue: string): string | null {
  for (const r of q.next ?? []) {
    if (!r.when || r.when.equals === answerValue) return r.goto;
  }
  const idx = i.questions.findIndex(x => x.id === q.id);
  return i.questions[idx + 1]?.id ?? null;
}

/** The exact text sent to the participant for a question. */
export function renderQuestion(q: Question): string {
  if (q.type === "text") return q.text;
  const lines = optionsOf(q).map(o => `${o.key}. ${o.label}`);
  return `${q.text}\n${lines.join("\n")}\nReply with the number.`;
}
