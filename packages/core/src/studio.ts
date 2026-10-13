// Mission Studio: a mission starts as a plain-language brief. A drafter turns it into the structure the platform runs on (what must
// be known, the questions, the fixed messages). The draft is always saved as DRAFT wording: only a person signs it off.
//
// The brief describes a programme, never a person. The drafter sees the brief and nothing else.
import { MissionDraftSchema, MissionInputSchema, type MissionBrief, type MissionDraft, type MissionInput } from "@dozai/contracts";
import { missionProblems, type MissionBundle } from "./mission";

export interface MissionDrafter {
  readonly kind: "claude" | "scripted";
  /** Produce a draft from the brief. `fix` lists what was wrong with the previous attempt, so the next one can correct it. */
  draft(brief: MissionBrief, base: MissionBundle, fix?: string[]): Promise<MissionDraft>;
}

const slug = (s: string, max: number) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** A version name for the new mission that nothing already uses. */
export function newVersionName(name: string, taken: Iterable<string>): { mission_id: string; version: string } {
  const used = new Set(taken);
  const base = slug(name, 22) || "mission";
  let n = 1, version = `${base}-v1.0`;
  while (used.has(version)) version = `${base}-v1.${n++}`;
  return { mission_id: `MSN-${base.toUpperCase().slice(0, 24)}`.replace(/-+$/, ""), version };
}

/** The brief, the draft and the mission it was based on, joined into a mission definition. The wording is always a draft. */
export function assembleMission(brief: MissionBrief, d: MissionDraft, base: MissionBundle, ids: { mission_id: string; version: string }): MissionInput {
  const policy = { ...(base.policy_overrides ?? {}), ...(brief.max_attempts !== undefined ? { maxAttempts: brief.max_attempts } : {}), ...(brief.window_start_hour !== undefined ? { windowStartHour: brief.window_start_hour } : {}), ...(brief.window_end_hour !== undefined ? { windowEndHour: brief.window_end_hour } : {}) };
  return {
    mission_id: ids.mission_id, version: ids.version, name: brief.name, programme_name: brief.programme_name,
    employee_id: base.employee_id, employee_version: base.employee_version,
    objective: d.objective, evidence_requirements: d.evidence_requirements, strategy: d.strategy, agent_guidance: d.agent_guidance,
    intro_template: base.intro_template, templates: base.templates.map(t => ({ key: t.key, language: t.language, purpose: t.purpose, provider_name: t.provider_name, body_fields: t.body_fields })),
    ...(Object.keys(policy).length ? { policy } : {}),
    instrument: {
      version: `DRAFT-${ids.version}`.slice(0, 40), draft: true, questions: d.questions,
      start_message: d.start_message, closing_message: d.closing_message, reask_prefix: d.reask_prefix, unsupported_prefix: d.unsupported_prefix,
      handover_message: d.handover_message, wrong_person_message: d.wrong_person_message, distress_message: d.distress_message, deletion_message: d.deletion_message,
      faq: d.faq, max_reasks: 2, max_messages: 40,
    },
  } as MissionInput;
}

export interface DraftResult {
  /** The mission definition, ready to read and save, or null when no attempt produced a valid one. */
  definition: MissionInput | null;
  /** Plain-words problems with the last attempt. Empty when the draft is valid. */
  problems: string[];
  /** Assumptions the drafter made. */
  notes: string[];
  attempts: number;
  source: "claude" | "scripted";
}

/**
 * Drafts a mission, checks it with the same rules a saved mission must pass, and gives the drafter its mistakes to correct,
 * up to three attempts. Nothing is saved here.
 */
export async function draftMission(drafter: MissionDrafter, brief: MissionBrief, base: MissionBundle, takenVersions: Iterable<string>): Promise<DraftResult> {
  const ids = newVersionName(brief.name, takenVersions);
  let fix: string[] | undefined, problems: string[] = [], notes: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let d: MissionDraft;
    try { d = await drafter.draft(brief, base, fix); }
    catch (e) { problems = [(e as Error).message.slice(0, 400)]; fix = problems; continue; }
    notes = d.notes ?? [];
    const input = assembleMission(brief, MissionDraftSchema.parse(d), base, ids);
    const parsed = MissionInputSchema.safeParse(input);
    problems = parsed.success ? missionProblems(parsed.data) : parsed.error.issues.map(i => `${i.path.join(".") || "mission"}: ${i.message}`);
    if (!problems.length) return { definition: input, problems: [], notes, attempts: attempt, source: drafter.kind };
    fix = problems;
  }
  return { definition: null, problems, notes, attempts: 3, source: drafter.kind };
}

// ---- a drafter that needs no model: a plain starting point for development and for when no key is set ------------------------------------------------

/** One text question per line of "find out". Good enough to see the flow; a person is expected to rewrite it. */
export class ScriptedMissionDrafter implements MissionDrafter {
  readonly kind = "scripted" as const;
  async draft(brief: MissionBrief): Promise<MissionDraft> {
    const items = brief.find_out.split(/\n|;|•|^\s*[-*]\s*/m).map(x => x.replace(/^[\s\-*•\d.)]+/, "").trim()).filter(x => x.length >= 3).slice(0, 12);
    const seen = new Set<string>();
    const rows = items.map((label, i) => { let key = slug(label, 30).replace(/-/g, "_") || `item_${i + 1}`; if (/^\d/.test(key)) key = `q_${key}`; while (seen.has(key)) key += "_2"; seen.add(key); return { key, label: label.charAt(0).toUpperCase() + label.slice(1, 80) }; });
    return {
      objective: brief.goal.slice(0, 400),
      agent_guidance: brief.approach?.slice(0, 2000),
      strategy: { channels: ["whatsapp", "voice"], follow_up_after_hours: 48 },
      evidence_requirements: rows.map(r => ({ key: r.key, label: r.label, required: true, min_confidence: 0.6 })),
      questions: rows.map(r => ({ id: `q_${r.key}`.slice(0, 40), module: "questions", type: "text" as const, evidence_key: r.key, text: `${r.label}?` })),
      start_message: "Thank you. We will now ask a few short questions. You can reply STOP at any time.",
      closing_message: "Thank you for your time. Our team will look at your answers.",
      reask_prefix: "Sorry, we could not understand that.", unsupported_prefix: "We can only read text messages for now.",
      handover_message: "Thank you. A member of our team will get in touch with you.",
      wrong_person_message: "Sorry for the mix-up. We will not message this number again.",
      distress_message: "Thank you for telling us. A member of our team will contact you soon.",
      deletion_message: "We have noted your request. Our team will confirm it with you.",
      faq: [
        { id: "who", keywords: ["who", "which organisation", "who are you"], answer: `We are the follow-up team for ${brief.programme_name}.` },
        { id: "why", keywords: ["why", "reason", "purpose"], answer: "We want to know how things are going, so the programme can support you better." },
        { id: "data", keywords: ["data", "privacy", "share", "safe"], answer: "Your answers are used only for programme follow-up. You can reply STOP at any time." },
      ],
      notes: ["No model was available, so this is a plain draft: one question per line you wrote. Rewrite the questions and add answer choices before signing off."],
    };
  }
}
