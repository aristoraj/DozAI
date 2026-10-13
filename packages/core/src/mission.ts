// A mission is everything that changes from one client to the next: the first message, the question flow, the contact
// rules and the agent's working notes. Missions are data, stored and versioned (never edited once saved). Every case is
// pinned to one mission version when it is created, so changing a mission never changes a conversation already running.
//
// The built-in mission below is the original placement and retention tracer. Cases created before missions existed use it.
import { MissionInputSchema, type MissionInput, type Requirement, type Strategy } from "@dozai/contracts";
import { DEFAULT_POLICY, type ContactPolicy } from "@dozai/domain";
import { DRAFT_INSTRUMENT, optionsOf, type Instrument } from "./instrument";

export interface MissionBundle {
  mission_id: string;
  version: string;
  name: string;
  instrument_signed_off: boolean;
  modules: { key: string; title: string; branch: string; question_ids: string[] }[];
  /** The full policy in force for this mission (platform defaults plus this mission's changes). */
  contact_policy: ContactPolicy;
  templates: { key: string; language: string; purpose: string; provider_name?: string; body_fields?: ("first_name" | "programme")[] }[];
  rubric: { auto_confirm_at: number; review_when: string[]; outcomes: string[] };
  instrument: Instrument;
  /** The template that opens contact. */
  intro_template: string;
  /** Only what this mission changes. Applied over the platform policy. */
  policy_overrides?: Partial<ContactPolicy>;
  programme_name?: string;
  /** Which employee does this mission, and optionally an exact version. Without a version it follows the employee's current one. */
  employee_id?: string;
  employee_version?: string;
  /** The goal in a sentence: what the employee is trying to find out. */
  objective?: string;
  /** What must be known about each person. The agent works to close the gaps. */
  evidence_requirements?: Requirement[];
  /** Hints about channels and timing. The agent may deviate inside the safety rules. */
  strategy?: Strategy;
  agent_guidance?: string;
  created_at?: string;
  created_by?: string;
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);

export const PLACEMENT_RETENTION_V1: MissionBundle = {
  mission_id: "MSN-001",
  version: "MSN-001-v1.3",
  name: "Post-program placement and retention tracer",
  instrument_signed_off: false,
  modules: [
    { key: "consent", title: "Consent and privacy", branch: "all", question_ids: ids("q_cons", 3) },
    { key: "identity", title: "Identity verification", branch: "all", question_ids: ids("q_idn", 2) },
    { key: "status", title: "Current status", branch: "all", question_ids: ids("q_sts", 4) },
    { key: "same_job", title: "Continuity: same job", branch: "same_job", question_ids: ids("q_same", 8) },
    { key: "changed_job", title: "Continuity: changed job", branch: "changed_job", question_ids: ids("q_chg", 9) },
    { key: "not_employed", title: "Job search and support", branch: "not_employed", question_ids: ids("q_ne", 8) },
  ],
  contact_policy: DEFAULT_POLICY,
  templates: [
    // The intro message created for this mission (Utility, English). Body: {{1}} first name, {{2}} programme name.
    { key: "placement_intro_v1", language: "en", purpose: "Purpose, caller and opt-out", provider_name: "placement_intro_v1", body_fields: ["first_name", "programme"] },
  ],
  rubric: {
    auto_confirm_at: DEFAULT_POLICY.autoConfirmAt,
    review_when: ["evidence conflict", "identity mismatch", "confidence below threshold"],
    outcomes: ["confirmed", "not_confirmed", "inconclusive", "opted_out", "cancelled"],
  },
  instrument: DRAFT_INSTRUMENT,
  intro_template: "placement_intro_v1",
  objective: "Find out whether the participant still works where the programme placed them, or what they do now, and whether they want support.",
  evidence_requirements: [
    { key: "work_status", label: "Current work status", hint: "Same job, a different job, not working, or studying.", required: true, min_confidence: 0.6 },
    { key: "employer_name", label: "Employer", hint: "The name of the place they work now.", required: true, when: { key: "work_status", in: ["same_job", "changed_job"] }, min_confidence: 0.6, verify_against: "programme_employer", verify_when: { key: "work_status", in: ["same_job"] } },
    { key: "role_title", label: "Job title or work", required: true, when: { key: "work_status", in: ["same_job", "changed_job"] }, min_confidence: 0.6 },
    { key: "change_reason", label: "Why they changed jobs", required: false, when: { key: "work_status", in: ["changed_job"] }, min_confidence: 0.6 },
    { key: "not_working_reason", label: "Why they are not working", required: true, when: { key: "work_status", in: ["not_employed"] }, min_confidence: 0.6 },
    { key: "job_search", label: "Looking for work", required: false, when: { key: "work_status", in: ["not_employed"] }, min_confidence: 0.6 },
    { key: "course", label: "What they study or train for", required: true, when: { key: "work_status", in: ["education_training"] }, min_confidence: 0.6 },
    { key: "support_requested", label: "Wants job support", required: false, min_confidence: 0.6 },
  ],
  strategy: { channels: ["whatsapp", "voice"], follow_up_after_hours: 48, notes: "WhatsApp first. If there is no reply after about two days, or the answers are too thin to judge, a phone call is allowed." },
};

/** Synchronous lookup of the built-in mission only. Stored missions are read through CaseService.getMission. */
export const getMissionBundle = (version: string): MissionBundle | undefined =>
  version === PLACEMENT_RETENTION_V1.version ? PLACEMENT_RETENTION_V1 : undefined;

// ---- checking a mission before it is saved ------------------------------------------------------------------------

/** Mistakes in a question flow that the schema cannot see: dangling jumps, loops, choices with no options. */
export function instrumentProblems(i: Instrument): string[] {
  const out: string[] = [];
  const idsSeen = new Set<string>();
  for (const q of i.questions) {
    if (idsSeen.has(q.id)) out.push(`question id "${q.id}" is used twice`);
    idsSeen.add(q.id);
  }
  for (const q of i.questions) {
    const opts = optionsOf(q);
    if (q.type === "choice") {
      if (opts.length < 2) out.push(`${q.id}: a choice question needs at least 2 options`);
      const keys = new Set<string>(), values = new Set<string>();
      for (const o of opts) {
        if (keys.has(o.key)) out.push(`${q.id}: option key "${o.key}" is used twice`);
        if (values.has(o.value)) out.push(`${q.id}: option value "${o.value}" is used twice`);
        keys.add(o.key); values.add(o.value);
      }
    }
    if (q.type !== "choice" && q.options?.length) out.push(`${q.id}: only choice questions take options`);
    for (const r of q.next ?? []) {
      if (r.goto !== null && !idsSeen.has(r.goto)) out.push(`${q.id}: jumps to "${r.goto}", which does not exist`);
      if (r.when && q.type !== "text" && !opts.some(o => o.value === r.when!.equals)) out.push(`${q.id}: a rule waits for "${r.when.equals}", which is not one of its options`);
    }
  }
  // A loop would keep asking until the message limit. Walk every path from the first question.
  const nextIds = (q: Instrument["questions"][number]): string[] => {
    const idx = i.questions.findIndex(x => x.id === q.id);
    const fallthrough = !(q.next ?? []).some(r => !r.when) && i.questions[idx + 1] ? [i.questions[idx + 1]!.id] : [];
    return [...(q.next ?? []).filter(r => r.goto).map(r => r.goto!), ...fallthrough].filter(id => idsSeen.has(id));
  };
  const state = new Map<string, 1 | 2>();
  let loop: string | null = null;
  const visit = (id: string) => {
    if (loop) return;
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { loop = id; return; }
    state.set(id, 1);
    const q = i.questions.find(x => x.id === id);
    if (q) for (const n of nextIds(q)) visit(n);
    state.set(id, 2);
  };
  if (i.questions[0]) visit(i.questions[0].id);
  if (loop) out.push(`the questions loop back to "${loop}" and would never finish`);
  const faqIds = new Set<string>();
  for (const f of i.faq) { if (faqIds.has(f.id)) out.push(`faq id "${f.id}" is used twice`); faqIds.add(f.id); }
  return out;
}

/** Mistakes in the list of evidence a mission needs: a need nothing can fill, a rule that waits for an answer that cannot happen. */
export function requirementProblems(reqs: Requirement[], i: Instrument): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const r of reqs) { if (keys.has(r.key)) out.push(`evidence need "${r.key}" is listed twice`); keys.add(r.key); }
  const valuesFor = (key: string): Set<string> | null => {
    const qs = i.questions.filter(q => q.evidence_key === key);
    if (qs.some(q => q.type === "text")) return null; // free text: any value
    return new Set(qs.flatMap(q => optionsOf(q).map(o => o.value)));
  };
  for (const r of reqs) {
    if (!i.questions.some(q => q.evidence_key === r.key)) out.push(`evidence need "${r.key}" has no question that can fill it`);
    for (const [name, c] of [["when", r.when], ["verify_when", r.verify_when]] as const) {
      if (!c) continue;
      if (c.key === r.key) { out.push(`"${r.key}": ${name} cannot depend on itself`); continue; }
      if (!keys.has(c.key)) { out.push(`"${r.key}": ${name} waits for "${c.key}", which is not an evidence need`); continue; }
      const allowed = valuesFor(c.key);
      const bad = allowed ? c.in.filter(v => !allowed.has(v)) : [];
      if (bad.length) out.push(`"${r.key}": ${name} waits for "${bad.join(", ")}", which "${c.key}" can never have`);
    }
    if (r.verify_against && !r.required) out.push(`"${r.key}": only required needs can be checked against the programme record`);
  }
  return out;
}

/** Everything wrong with a mission definition, in plain words. Empty means it can be saved. */
export function missionProblems(input: MissionInput): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const t of input.templates) { if (keys.has(t.key)) out.push(`template "${t.key}" is listed twice`); keys.add(t.key); }
  if (!keys.has(input.intro_template)) out.push(`intro_template "${input.intro_template}" is not in the templates list`);
  if (input.version === PLACEMENT_RETENTION_V1.version) out.push("that version name belongs to the built-in mission");
  out.push(...requirementProblems(input.evidence_requirements ?? [], input.instrument as Instrument));
  const p = input.policy;
  if (p?.windowStartHour !== undefined && p?.windowEndHour !== undefined && p.windowStartHour >= p.windowEndHour) out.push("the contact window must end after it starts");
  return [...out, ...instrumentProblems(input.instrument as Instrument)];
}

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());

/** Turns a validated definition into the stored bundle. */
export function bundleFromInput(input: MissionInput, by: string, now: Date): MissionBundle {
  const instrument = input.instrument as Instrument;
  const order: string[] = [];
  const byModule = new Map<string, string[]>();
  for (const q of instrument.questions) {
    if (!byModule.has(q.module)) { byModule.set(q.module, []); order.push(q.module); }
    byModule.get(q.module)!.push(q.id);
  }
  const policy: ContactPolicy = { ...DEFAULT_POLICY, ...input.policy };
  return {
    mission_id: input.mission_id, version: input.version, name: input.name,
    instrument_signed_off: !instrument.draft,
    modules: order.map((m, n) => ({ key: m, title: titleCase(m), branch: n === 0 ? "all" : m, question_ids: byModule.get(m)! })),
    contact_policy: policy,
    templates: input.templates,
    rubric: { auto_confirm_at: policy.autoConfirmAt, review_when: ["evidence conflict", "identity mismatch", "confidence below threshold"], outcomes: ["confirmed", "not_confirmed", "inconclusive", "opted_out", "cancelled"] },
    instrument, intro_template: input.intro_template,
    policy_overrides: input.policy ? { ...input.policy } : undefined,
    programme_name: input.programme_name, agent_guidance: input.agent_guidance,
    employee_id: input.employee_id, employee_version: input.employee_version,
    objective: input.objective, evidence_requirements: input.evidence_requirements, strategy: input.strategy,
    created_at: now.toISOString(), created_by: by,
  };
}

/** Parse, check and build in one step. Throws a list of plain problems. */
export function parseMission(raw: unknown, by: string, now: Date): { bundle?: MissionBundle; problems: string[] } {
  const parsed = MissionInputSchema.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map(i => `${i.path.join(".") || "mission"}: ${i.message}`) };
  const problems = missionProblems(parsed.data);
  return problems.length ? { problems } : { bundle: bundleFromInput(parsed.data, by, now), problems: [] };
}
