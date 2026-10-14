// Single source of truth for every shape that crosses a boundary:
// API, MCP tools, ledger events and (later) channel webhooks.
import { z } from "zod";

// ---- Enums (Core Team Walkthrough, slides 5 and 11) -------------------------

export const STATUSES = [
  "draft", "ready", "running", "waiting", "call_scheduled",
  "calling", "evaluating", "review", "complete",
] as const;
export const OUTCOMES = ["confirmed", "not_confirmed", "inconclusive", "opted_out", "cancelled"] as const;
export const LIVELIHOOD_STATES = ["same_job", "changed_job", "not_employed", "education_training", "unreachable_unclear"] as const;
export const ROLES = ["admin", "agent_ops", "operator", "reviewer"] as const;
export const CHANNELS = ["whatsapp", "voice", "programme_record", "reviewer"] as const;

export type Status = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type LivelihoodState = (typeof LIVELIHOOD_STATES)[number];
export type Role = (typeof ROLES)[number];
export type Channel = (typeof CHANNELS)[number];

export const StatusSchema = z.enum(STATUSES);
export const OutcomeSchema = z.enum(OUTCOMES);
export const LivelihoodStateSchema = z.enum(LIVELIHOOD_STATES);
export const RoleSchema = z.enum(ROLES);

// ---- Ledger -----------------------------------------------------------------

export const EVENT_TYPES = [
  "case_created", "status_changed", "message_queued", "message_received",
  "call_requested", "call_result", "evidence_added", "decision_proposed",
  "review_requested", "review_decided", "agent_session_started", "agent_session_ended",
  "callback_scheduled", "message_sent", "message_status", "case_deleted",
  "conversation_started", "question_asked", "answer_recorded", "reply_handled", "call_started",
  "action_held", "action_approved", "action_rejected", "wake_scheduled", "wake_fired", "memory_noted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const CaseEventSchema = z.object({
  event_id: z.string(),
  tenant_id: z.string(),
  case_id: z.string(),
  seq: z.number().int().positive(),
  type: z.enum(EVENT_TYPES),
  actor: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()),
  prev_hash: z.string(),
  hash: z.string(),
  ts: z.string(),
});
export type CaseEvent = z.infer<typeof CaseEventSchema>;

// ---- Records ----------------------------------------------------------------

export const CaseRecordSchema = z.object({
  case_id: z.string(),
  tenant_id: z.string(),
  run_id: z.string(),
  participant_id: z.string(),
  status: StatusSchema,
  outcome: OutcomeSchema.nullable(),
  livelihood_state: LivelihoodStateSchema.nullable(),
  confidence: z.number().min(0).max(100),
  version: z.number().int().positive(),
  next_action: z.string(),
  owner: z.string(),
  attempts: z.number().int().nonnegative(),
  last_touch: z.string().nullable(),
  reason: z.string(),
  /** Set when personal data was erased. The case then stays only as an anonymous stub. */
  deleted_at: z.string().optional(),
  deleted_by: z.string().optional(),
  /** The mission this case runs under, fixed when the case is created. Older cases have none and use the built-in mission. */
  mission_version: z.string().optional(),
  /** Set when a campaign sent the first message. */
  campaign_id: z.string().optional(),
  created_at: z.string().optional(),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

export const ParticipantSchema = z.object({
  participant_id: z.string(),
  tenant_id: z.string(),
  display_name: z.string(),
  phone_masked: z.string(), // real numbers are encrypted server-side; never exposed here
  location: z.string(),
  cohort: z.string(),
  language: z.string(),
  consent: z.enum(["unknown", "granted", "declined"]),
  recorded_employer: z.string(),
  // Real contact details live only here, encrypted. Never returned by the API and never given to the agent.
  phone_enc: z.string().optional(),
  phone_hash: z.string().optional(),
  first_name: z.string().optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const EvidenceSchema = z.object({
  evidence_id: z.string(),
  case_id: z.string(),
  question_id: z.string(),
  value: z.string(),
  source: z.enum(CHANNELS),
  confidence: z.number().min(0).max(1),
  event_id: z.string(),
  /** When it was recorded. A later answer to the same question replaces an earlier one. Older rows have none. */
  at: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const DecisionSchema = z.object({
  decision_id: z.string(),
  case_id: z.string(),
  kind: z.enum(["proposal", "final"]),
  proposed_outcome: OutcomeSchema.nullable(),
  livelihood_state: LivelihoodStateSchema.nullable(),
  confidence: z.number().min(0).max(1),
  evidence_refs: z.array(z.string()),
  rationale: z.string(),
  actor: z.string(),
  ts: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ---- MCP tool contracts (slide 13) ------------------------------------------

export const ToolEnvelopeSchema = z.object({
  operation_id: z.string(),
  case_version: z.number().int(),
  next_allowed_actions: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

const writeFields = {
  case_id: z.string(),
  idempotency_key: z.string().min(8),
  expected_version: z.number().int().positive(),
};

export const ToolInputs = {
  case_get_context: z.object({ case_id: z.string() }),
  mission_get_bundle: z.object({ mission_version_id: z.string() }),
  case_get_timeline: z.object({ case_id: z.string(), limit: z.number().int().min(1).max(50).default(20) }),
  whatsapp_send_template: z.object({ ...writeFields, template_key: z.string() }),
  callback_schedule: z.object({ ...writeFields, after_hours: z.number().min(1).max(72), channel: z.enum(["whatsapp", "voice"]) }),
  // Ask for a phone call now, or at a time inside the contact hours. The call asks only for what is still missing.
  voice_call_request: z.object({ ...writeFields, reason: z.string().trim().min(5).max(300), start_at: z.string().datetime().optional() }),
  decision_propose: z.object({
    ...writeFields,
    proposed_outcome: OutcomeSchema,
    livelihood_state: LivelihoodStateSchema.nullable(),
    confidence: z.number().min(0).max(1),
    evidence_refs: z.array(z.string()),
    rationale: z.string().min(1),
  }),
  review_request: z.object({ ...writeFields, reason_code: z.string(), note: z.string().default("") }),
  // Remember one fixed fact about this person (best time to call, preferred channel...). The keys and values are a closed list.
  memory_note: z.object({ case_id: z.string(), idempotency_key: z.string().min(8), key: z.string().max(40), value: z.string().max(20) }),
} as const;
export type ToolName = keyof typeof ToolInputs;
export const TOOL_NAMES = Object.keys(ToolInputs) as ToolName[];

// ---- Core API ---------------------------------------------------------------

export const ReviewDecisionInputSchema = z.object({
  decision: z.enum(["confirm", "not_confirm", "followup", "inconclusive"]),
  note: z.string().max(2000).default(""),
  expected_version: z.number().int().positive(),
});
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInputSchema>;

export const RunAgentInputSchema = z.object({
  scenario: z.enum(["same_job", "changed_job", "employer_conflict", "not_employed", "opt_out", "no_response"]),
});
export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;

export interface Principal {
  user_id: string;
  tenant_id: string;
  role: Role;
}

// ---- Participant intake and deletion

export const ParticipantRowSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80, "name is too long"),
  phone: z.string().trim().min(8, "phone is not a valid number").max(20, "phone is not a valid number"),
  employer: z.string().trim().max(80).default(""),
  location: z.string().trim().max(60).default(""),
  cohort: z.string().trim().max(60).default(""),
  language: z.enum(["en", "hi"]).default("en"),
});
export type ParticipantRow = z.infer<typeof ParticipantRowSchema>;

/** Small batches: each row costs several Data Store round trips, and a request has a time limit. */
export const MAX_IMPORT_ROWS = 20;
export const ImportInputSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS),
  consent_attested: z.literal(true),
  /** Which mission these participants belong to. Omitted: the most recently added mission. */
  mission_version: z.string().max(40).optional(),
});

export const DeleteCaseInputSchema = z.object({
  confirm: z.string().min(1),
  reason_code: z.enum(["participant_request", "data_entry_error", "test_data", "other"]),
});
export type DeleteCaseInput = z.infer<typeof DeleteCaseInputSchema>;

// ---- Missions: everything that changes from one client to the next, as data

const ident = z.string().regex(/^[A-Za-z0-9_]{1,40}$/, "use letters, numbers and underscores only");
const text900 = z.string().trim().min(1).max(900);

export const QuestionOptionSchema = z.object({
  key: z.string().trim().min(1).max(10),
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(60),
  synonyms: z.array(z.string().max(40)).max(20).optional(),
});

export const QuestionSchema = z.object({
  id: ident,
  module: z.string().trim().min(1).max(40),
  type: z.enum(["choice", "yesno", "text"]),
  text: text900,
  /** How to say it on a phone call, when the written wording does not work aloud. Left out: the written text is adapted automatically. */
  spoken: text900.optional(),
  /** An open "anything else?" question: "no" or "nothing" is a fine answer. */
  optional: z.boolean().optional(),
  options: z.array(QuestionOptionSchema).max(10).optional(),
  evidence_key: ident,
  next: z.array(z.object({ when: z.object({ equals: z.string().max(60) }).optional(), goto: z.string().nullable() })).max(12).optional(),
});

export const InstrumentSchema = z.object({
  version: z.string().trim().min(1).max(40),
  draft: z.boolean(),
  questions: z.array(QuestionSchema).min(1).max(80),
  start_message: text900, closing_message: text900, reask_prefix: text900, unsupported_prefix: text900,
  handover_message: text900, wrong_person_message: text900, distress_message: text900, deletion_message: text900,
  faq: z.array(z.object({ id: ident, keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(20), answer: text900 })).max(20),
  max_reasks: z.number().int().min(0).max(5),
  max_messages: z.number().int().min(5).max(200),
  /** Who approved this wording and when. Set by the platform when a wording is saved as approved, never taken from what a person types. */
  signed_off: z.object({ by: z.string(), at: z.string() }).optional(),
});

// What a mission needs to learn about each person. The agent works to close the gaps between this list and what it
// has collected, choosing the cheapest, least intrusive way. The question bank below supplies the ways to ask.
const Cond = z.object({ key: ident, in: z.array(z.string().trim().min(1).max(60)).min(1).max(10) });
export const RequirementSchema = z.object({
  /** Matches the evidence_key of the questions that can fill it. */
  key: ident,
  label: z.string().trim().min(2).max(80),
  /** What counts as a good answer, for the agent and for people writing missions. */
  hint: z.string().trim().max(300).optional(),
  required: z.boolean().default(true),
  /** Only needed when an earlier answer has one of these values (for example an employer is needed only if the person works). */
  when: Cond.optional(),
  /** An answer below this confidence does not count. */
  min_confidence: z.number().min(0.3).max(1).default(0.6),
  /** Check the answer against what the programme already has on file. */
  verify_against: z.enum(["programme_employer"]).optional(),
  /** Only check when an earlier answer has one of these values (a new employer is expected to differ). */
  verify_when: Cond.optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/** Hints, not steps: the agent may deviate inside the platform's safety rules. */
export const StrategySchema = z.object({
  channels: z.array(z.enum(["whatsapp", "voice"])).min(1).max(2).default(["whatsapp", "voice"]),
  follow_up_after_hours: z.number().int().min(1).max(336).default(48),
  notes: z.string().trim().max(800).optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

// ---- The Verification Employee: the reusable AI worker above every mission

const lines = (min: number, max: number, items: number) => z.array(z.string().trim().min(min).max(max)).max(items);
export const EmployeeInputSchema = z.object({
  employee_id: z.string().regex(/^[a-z0-9-]{3,40}$/, "employee_id: lower-case letters, numbers and dashes, 3-40 characters"),
  version: z.string().regex(/^[A-Za-z0-9._-]{3,40}$/, "version: letters, numbers, dots, dashes and underscores, 3-40 characters"),
  name: z.string().trim().min(2).max(60),
  /** What this employee is for, in a sentence or two. */
  purpose: z.string().trim().min(10).max(400),
  /** Tone and mindset when dealing with people. */
  persona: z.string().trim().min(10).max(1200),
  /** How it works: the standing rules of the job. */
  instructions: z.string().trim().min(40).max(6000),
  /** Organisation-wide knowledge every mission can rely on. */
  knowledge: z.array(z.object({ title: z.string().trim().min(2).max(80), text: z.string().trim().min(5).max(2000) })).max(10).optional(),
  /** Reminders of what it must never do. The platform enforces the real rules whatever is written here. */
  guardrails: lines(5, 300, 20).optional(),
  /** When it hands a case to a person. */
  escalation_rules: lines(5, 300, 20).optional(),
  /** What it may remember between runs. */
  memory_policy: z.string().trim().max(600).optional(),
  /** The only tools it is offered. The gateway refuses any other, whatever the model asks for. */
  allowed_tools: z.array(z.enum(TOOL_NAMES as unknown as [ToolName, ...ToolName[]])).min(1).max(12),
  model: z.object({
    /** Leave out to use the platform's pinned model. */
    name: z.string().trim().max(60).optional(),
    effort: z.enum(["low", "medium", "high"]).default("medium"),
    max_turns: z.number().int().min(2).max(30).default(12),
    /** The most one run may spend, in US dollars. */
    budget_usd: z.number().min(0.05).max(5).default(0.5),
  }).optional(),
});
export type EmployeeInput = z.infer<typeof EmployeeInputSchema>;

export const MissionInputSchema = z.object({
  mission_id: z.string().regex(/^[A-Za-z0-9-]{3,30}$/, "mission_id: letters, numbers and dashes, 3-30 characters"),
  version: z.string().regex(/^[A-Za-z0-9._-]{3,40}$/, "version: letters, numbers, dots, dashes and underscores, 3-40 characters"),
  name: z.string().trim().min(3).max(100),
  /** Shown to participants in the intro message ({{programme}}). */
  programme_name: z.string().trim().min(1).max(80).optional(),
  /** Which employee does this mission. Leave out for the platform's verification employee. */
  employee_id: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  /** Pin an exact employee version. Leave out to follow the employee's current version, so improvements reach every mission at once. */
  employee_version: z.string().max(40).optional(),
  /** The goal in a sentence or two: what the employee is trying to find out. */
  objective: z.string().trim().min(10).max(400).optional(),
  /** What must be known about each person for the case to be judged. Missions saved before this existed have none. */
  evidence_requirements: z.array(RequirementSchema).max(40).optional(),
  strategy: StrategySchema.optional(),
  /** The template that opens contact. Must be one of `templates`. */
  intro_template: z.string(),
  templates: z.array(z.object({
    key: z.string().regex(/^[a-z0-9_]{1,60}$/, "template key: lower-case letters, numbers and underscores"),
    language: z.string().min(2).max(10),
    purpose: z.string().max(200),
    provider_name: z.string().regex(/^[a-z0-9_]{1,100}$/, "provider_name: the approved template's exact name").optional(),
    body_fields: z.array(z.enum(["first_name", "programme"])).max(5).optional(),
  })).min(1).max(10),
  /** Only what differs from the platform defaults. */
  policy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    windowStartHour: z.number().min(0).max(24),
    windowEndHour: z.number().min(0).max(24),
    autoConfirmAt: z.number().min(0.5).max(1),
  }).partial().optional(),
  /** Extra working instructions for the agent, written by the programme team. Never overrides the safety rules. */
  agent_guidance: z.string().trim().max(2000).optional(),
  instrument: InstrumentSchema,
});
export type MissionInput = z.infer<typeof MissionInputSchema>;

// ---- Mission Studio: a mission written as a plain-language brief, then drafted into the structure the platform runs on ------------------------

/** What a programme person writes. No names or phone numbers belong here: it describes the programme, not any person. */
export const MissionBriefSchema = z.object({
  name: z.string().trim().min(3).max(100),
  /** How the programme is named to participants in the first message. */
  programme_name: z.string().trim().min(1).max(80),
  /** What the mission is trying to achieve, in the writer's own words. */
  goal: z.string().trim().min(20).max(1500),
  /** Who the participants are and how they know us. */
  people: z.string().trim().min(10).max(1000),
  /** What must be found out about each person, in plain words. One thing per line is clearest. */
  find_out: z.string().trim().min(10).max(3000),
  /** Tone, things to avoid, languages, anything the employee should keep in mind. */
  approach: z.string().trim().max(1500).optional(),
  /** An existing mission to copy the approved first-message template, the contact rules and the employee from. */
  start_from: z.string().max(40).optional(),
  max_attempts: z.number().int().min(1).max(10).optional(),
  window_start_hour: z.number().min(0).max(24).optional(),
  window_end_hour: z.number().min(0).max(24).optional(),
}).strict();
export type MissionBrief = z.infer<typeof MissionBriefSchema>;

/** What the drafter produces from a brief: the structure under the plain text. Everything in it is a proposal for a person to read and sign off. */
export const MissionDraftSchema = z.object({
  /** The goal in a sentence or two. */
  objective: z.string().trim().min(10).max(400),
  /** Working notes for the employee, drawn from the approach in the brief. Never overrides the safety rules. */
  agent_guidance: z.string().trim().max(2000).optional(),
  strategy: StrategySchema,
  /** Everything that must be known about a person, each with at least one question that can fill it. */
  evidence_requirements: z.array(RequirementSchema).min(1).max(20),
  questions: z.array(QuestionSchema).min(1).max(30),
  start_message: text900, closing_message: text900, reask_prefix: text900, unsupported_prefix: text900,
  handover_message: text900, wrong_person_message: text900, distress_message: text900, deletion_message: text900,
  faq: z.array(z.object({ id: ident, keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(20), answer: text900 })).min(3).max(12),
  /** Assumptions the drafter made and things a person should check, in plain words. */
  notes: z.array(z.string().trim().min(3).max(300)).max(12).default([]),
});
export type MissionDraft = z.infer<typeof MissionDraftSchema>;


// ---- Campaigns: send the first message to many participants, at a safe pace

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "completed", "stopped"] as const;
export const CampaignSchema = z.object({
  campaign_id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  mission_version: z.string(),
  /** Only participants of this cohort. null = everyone loaded before the campaign started. */
  cohort: z.string().nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
  /** Most first messages sent per day (WhatsApp limits how many new people a number may contact). */
  daily_cap: z.number().int().min(1).max(10000),
  /** Most first messages sent per scheduler run (about one a minute). */
  per_tick: z.number().int().min(1).max(50),
  created_at: z.string(), created_by: z.string(),
  started_at: z.string().nullable(),
  updated_at: z.string(),
  pause_reason: z.string().nullable(),
  sent_day: z.string().nullable(), sent_today: z.number().int().nonnegative(), sent_total: z.number().int().nonnegative(),
  last_run_at: z.string().nullable(), last_note: z.string().nullable(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const CampaignInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  mission_version: z.string().max(40).optional(),
  cohort: z.string().trim().max(60).nullable().optional(),
  daily_cap: z.number().int().min(1).max(10000).default(200),
  per_tick: z.number().int().min(1).max(50).default(15),
});
export type CampaignInput = z.infer<typeof CampaignInputSchema>;

// ---- Conversation (question flow after consent)

export const INTENTS = ["answer", "clarify", "faq", "stop", "wrong_person", "distress", "deletion", "off_topic", "unclear"] as const;
export type Intent = (typeof INTENTS)[number];

/** What a participant reply means. Produced by rules or by a model; always one of these fixed values. */
export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  option_key: z.string().max(20).optional(),   // for choice questions: which option
  value: z.string().max(300).optional(),       // for text questions: the answer
  faq_id: z.string().max(40).optional(),       // for faq: which approved answer
  confidence: z.number().min(0).max(1).default(0.5),
  /** Answers to OTHER questions found in the same reply, by evidence key. Held until the flow reaches that question. */
  also: z.array(z.object({
    key: z.string().max(80),
    option_key: z.string().max(20).optional(),
    value: z.string().max(300).optional(),
    confidence: z.number().min(0).max(1),
  })).max(20).optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const ConversationStateSchema = z.object({
  case_id: z.string(),
  tenant_id: z.string(),
  status: z.enum(["awaiting_consent", "asking", "done", "escalated", "stopped"]),
  current: z.string().nullable(),
  reasks: z.number().int().nonnegative(),
  answers: z.array(z.object({ question_id: z.string(), value: z.string(), label: z.string().optional(), at: z.string() })),
  messages_sent: z.number().int().nonnegative(),
  last_inbound_at: z.string().nullable(),
  escalation_reason: z.string().optional(),
  /** Answers the participant gave before we asked for them, by evidence key. Used when the flow reaches that question. */
  held: z.record(z.string(), z.object({ option_key: z.string().optional(), value: z.string().optional(), confidence: z.number() })).optional(),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;
