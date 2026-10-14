// Phone calls, independent of any vendor.
//
// A mission is published to the voice provider once, as a "form": the instructions the voice agent follows, plus one
// field for each thing the mission needs to learn. For each call the platform passes a short per-person context that
// says what is still missing, so a call can ask only for the gaps. The answers come back as structured values, with the
// audio and a transcript. We turn the values into evidence exactly as WhatsApp answers are, and keep the audio
// reference and transcript on the case, where deleting the case erases them.
//
// Nothing here knows how a provider formats its data. Providers are adapted in @dozai/adapters, which produce a
// VoiceResult for ingestVoiceResult.
import { createHash } from "node:crypto";
import type { CaseRecord } from "@dozai/contracts";
import type { EmployeeDefinition } from "../agent/employee";
import { matchOption, validateAnswer } from "./classifier";
import { optionsOf, type Question } from "../missions/instrument";
import { evaluateRequirements } from "../missions/requirements";
import type { MissionBundle } from "../missions/mission";
import { DozaiError, type CaseService } from "../cases/service";

// ---- the form published to the voice provider -----------------------------------------------------------------------
//
// Lessons from the first real call (12 Oct 2026) that shape everything below:
//   - The provider works through the form's FIELDS one by one and says what each field tells it to say. So every field carries
//     the exact spoken question, and no field is named or described in a way that could be read out ("consent given").
//   - It did not follow a numbered script in the general instructions, nor the "still needed" list, so those are enforced
//     through each field's own condition, written the way the provider writes its own ("Ask only if x = y").
//   - Written questions do not work aloud ("please type the name..."), so questions are converted to speech.

export interface VoiceFormField {
  field_id: string;
  field_name: string;
  datatype: "string" | "boolean" | "number";
  field_kind: "meta" | "demographic" | "outcome";
  analysis_type: "quantitative" | "qualitative";
  /** What the voice agent says and records for this field. Starts with the exact spoken question. */
  additional_info: string;
  /** The provider's own setting for when to ask. Empty means always. */
  condition_for_asking_this_field: string;
  /** How a spoken answer is turned into the value to record. */
  additional_parsing_comments?: string;
  /** What a valid recorded value looks like. */
  validation?: string;
}

export interface VoiceFormDefinition {
  form_field_name: string;
  form_context: string;
  start_message: string;
  form_fields: VoiceFormField[];
}

/** Every form starts with these two, so the platform can tell a wrong number or a refusal from an ordinary answer. */
export const VOICE_META_FIELDS = ["identity_confirmed", "consent_given"] as const;
/** Fields that are about the call itself, not answers to the mission's questions. */
const NOT_ANSWERS: readonly string[] = [...VOICE_META_FIELDS, "language"];

const questionFor = (m: MissionBundle, key: string): Question | undefined => m.instrument.questions.find(q => q.evidence_key === key);

/** A written question, said as speech. A mission can set Question.spoken to word it exactly. */
export function spokenQuestion(q: Question): string {
  const base = q.spoken ?? q.text.replace(/\s*Reply with the number\.?/gi, "").replace(/\b(please )type\b/gi, "$1tell me").replace(/\btype\b/gi, "tell me").trim();
  if (q.spoken || (q.type !== "choice" && q.type !== "yesno") || q.type === "yesno") return base;
  // A choice is offered in words, because numbers mean nothing on a call.
  const labels = optionsOf(q).map(o => o.label);
  return `${base} You can say: ${labels.slice(0, -1).join("; ")}; or ${labels.at(-1)}.`;
}

/** "work_status = same_job or work_status = changed_job" in the provider's own style. */
const asCondition = (w: { key: string; in: string[] }) => w.in.map(v => `${w.key} = ${v}`).join(" or ");

function metaFields(m: MissionBundle, e: EmployeeDefinition): VoiceFormField[] {
  const programme = m.programme_name ?? "the programme";
  return [
    { field_id: "identity_confirmed", field_name: "Identity confirmed", datatype: "boolean", field_kind: "meta", analysis_type: "quantitative", condition_for_asking_this_field: "",
      additional_info: `Ask: "Am I speaking with <first name from the call details>?" Do not say why you are calling yet. A short yes, haan, ji or okay is a clear yes: record true and go on, never ask again. If it is someone else or they will not confirm, apologise, record false, say nothing about the reason for the call, and end the call.`,
      validation: "true or false" },
    { field_id: "consent_given", field_name: "Consent given", datatype: "boolean", field_kind: "meta", analysis_type: "quantitative", condition_for_asking_this_field: "Ask only if identity_confirmed = true.",
      additional_info: `Say: "I am ${e.name}, calling on behalf of ${programme}. We would like to ask a few short questions about how things are going for you. This call may be recorded. May we continue?" A short yes, haan, ji or okay is a clear yes: record true and go straight on, and never ask this again. If they say no or are unsure, record false, thank them, and end the call. Ask nothing else.`,
      validation: "true or false" },
  ];
}

function fieldFor(m: MissionBundle, key: string, label: string, hint: string | undefined, when?: { key: string; in: string[] }): VoiceFormField {
  const q = questionFor(m, key);
  const isChoice = q?.type === "choice" || q?.type === "yesno";
  const options = q ? optionsOf(q) : [];
  // A yes/no need is a true/false field: the agent records true or false, never the platform's "yes"/"no" codes.
  const code = (v: string) => (q?.type === "yesno" ? (v === "yes" ? "true" : "false") : v);
  const parts: string[] = [];
  if (q) parts.push(`Ask: "${spokenQuestion(q)}"`);
  else parts.push(`Ask about: ${label}.`);
  if (isChoice) parts.push(`Record the answer as one of: ${options.map(o => code(o.value)).join(", ")}. Never say these codes aloud.`);
  if (hint) parts.push(hint);
  parts.push("Ask it once. If you did not understand, ask again once in different words, then move on and leave the field empty.");
  // Asked only when the call details list it as still needed, and (if it depends on an earlier answer) only then.
  // A field that depends on an earlier answer is asked ONLY when that answer fits, and is otherwise never asked: the voice agent
  // read "listed under Still needed" as permission to ask a field whose own condition was not met. A field that depends on nothing
  // is asked only while it is still needed.
  const condition = when
    ? `Ask ONLY if ${asCondition(when)}. If the answer is anything else, skip this field completely and never ask it.`
    : `Ask only if "${key}" is listed under Still needed in the call details.`;
  const mapping = isChoice ? options.map(o => `${[o.label, ...(o.synonyms ?? [])].map(x => `"${x}"`).join(", ")} -> ${code(o.value)}`).join("; ") : undefined;
  return {
    field_id: key, field_name: label, datatype: q?.type === "yesno" ? "boolean" : "string", field_kind: "outcome", analysis_type: q?.type === "text" ? "qualitative" : "quantitative",
    additional_info: parts.join(" "), condition_for_asking_this_field: condition,
    ...(isChoice ? { additional_parsing_comments: `Map what the person says to the closest value. ${mapping}. If it matches none of them, leave the field empty.`, validation: `Must be one of: ${options.map(o => code(o.value)).join(", ")}` } : { validation: "A short answer in the person's own words" }),
  };
}

function formContext(m: MissionBundle, e: EmployeeDefinition): string {
  const programme = m.programme_name ?? "the programme";
  return `You are ${e.name}, a digital assistant making a follow-up phone call on behalf of ${programme}.
${e.persona}
${m.objective ? `Purpose of the call: ${m.objective}` : ""}

The call details give the person's first name, their language, and which fields are still needed. Speak their language, and switch if they ask.

Rules for the whole call:
- Go through the form's fields in order and say each question naturally, as one short sentence of speech. Never read a field name, a field code or an answer code aloud.
- Ask each question once. If you did not understand, ask once more in different words, then move on and leave the field empty.
- Once the person has answered a question, never ask it again, even if you are unsure: record what they said and move on.
- Ask only the fields whose condition is met. A field with an "only if" condition is skipped completely, never asked, when the condition is not met. Never ask something the call details list as already known.
- If the person is not who we expected, declines, asks you to stop, sounds upset, or asks for their data to be deleted: be polite, ask nothing else, and end the call. If they are upset or ask for deletion, say a person from the team will follow up.
- Never promise jobs, money or outcomes. Never share anything about other people. Do not comment on whether their answers are good or bad.
- Before you finish, go back over the fields whose condition is met. If one still has no answer and the person has not refused it, ask it now.
- When every field that applies has been answered or skipped, thank the person warmly and end the call. Ask nothing after the last field.`.replace(/\n\n\n/g, "\n\n");
}

/** The form to publish for a mission. The employee's persona and name shape the voice agent. */
export function buildVoiceForm(mission: MissionBundle, employee: EmployeeDefinition): VoiceFormDefinition {
  const reqs = mission.evidence_requirements ?? [];
  const fields = reqs.length
    ? reqs.map(r => fieldFor(mission, r.key, r.label, r.hint, r.when))
    // A mission with no list of needs: every question becomes a field, once per evidence key.
    : [...new Map(mission.instrument.questions.map(q => [q.evidence_key, q])).values()].map(q => fieldFor(mission, q.evidence_key, q.evidence_key.replace(/_/g, " "), undefined));
  return {
    form_field_name: `${mission.name} (${mission.version})`.slice(0, 120),
    form_context: formContext(mission, employee),
    start_message: `Hello, this is ${employee.name} calling on behalf of ${mission.programme_name ?? "the programme"}.`,
    form_fields: [...metaFields(mission, employee), ...fields],
  };
}

/** A fingerprint of the definition, to notice when the published form no longer matches the mission. */
export const voiceFormHash = (d: VoiceFormDefinition): string => createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 16);

/** What we know about the published form for a mission. */
export interface VoiceFormLink { tenant_id: string; mission_version: string; form_id: number; definition_hash: string; published_at: string; published_by: string }

/** The per-call context. A first name, the language and what is missing: no surname, number or answers. */
export function buildCallContext(i: { first_name: string; programme?: string; language: string; missing: { key: string; label: string; condition?: string }[] | null; known?: string[] }): string {
  const lines = [`Person: first name ${i.first_name}.`, `Programme: ${i.programme ?? "the programme"}.`, `Language: ${i.language === "hi" ? "Hindi" : i.language === "en" ? "English" : i.language}.`];
  lines.push(i.missing === null
    ? "Still needed: ask every field in the form, in order."
    : `Still needed (ask only these, in this order):\n${i.missing.map((m, n) => `${n + 1}. ${m.label} (field ${m.key})${m.condition ? `, only if ${m.condition}` : ""}`).join("\n")}`);
  if (i.known?.length) lines.push(`Already known (do not ask again): ${i.known.join(", ")}.`);
  return lines.join("\n");
}

// ---- calls on the case -------------------------------------------------------------------------------------------------

export type CallStatus = "requested" | "scheduled" | "in_progress" | "completed" | "no_answer" | "busy" | "declined" | "failed" | "cancelled";

/** One phone call. Holds the audio reference and transcript, which are personal data and are erased with the case. */
export interface CallRecord {
  communication_id: string;
  tenant_id: string;
  case_id: string;
  form_id: number;
  status: CallStatus;
  requested_at: string;
  scheduled_for?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number | null;
  audio_url?: string | null;
  /** The provider holds a recording we can stream on demand (it is not a link: the audio needs our sign-in). Nothing is copied here. */
  recording?: boolean;
  transcript?: string | null;
  /** Which things the call was asked to find out. */
  asked: string[];
  reason?: string;
}

/** A finished (or failed) call, as the provider reports it, normalised by an adapter. */
export interface VoiceResult {
  communication_id: string;
  status: CallStatus;
  /** Values keyed by field id. */
  answers: Record<string, unknown>;
  consent_given?: boolean;
  identity_confirmed?: boolean;
  language?: string;
  audio_url?: string | null;
  has_recording?: boolean;
  transcript?: string | null;
  duration_seconds?: number | null;
  ended_at?: string;
}

const FINAL: CallStatus[] = ["completed", "no_answer", "busy", "declined", "failed", "cancelled"];
const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Turn what was said into the value we store: a choice becomes its option value, a yes or no becomes "yes" or "no". */
export function normaliseVoiceAnswer(q: Question | undefined, raw: unknown): { value: string; confidence: number } | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw).trim();
  if (!text) return null;
  if (q && (q.type === "yesno" || q.type === "choice")) {
    const hit = matchOption(norm(text), q);
    // The voice service already turns what was said into one of our option codes, so an exact code is as sure as a tapped option.
    // A phrase we had to match to an option ourselves is a little less sure.
    if (hit) return { value: hit.value, confidence: norm(hit.value) === norm(text) ? 0.95 : 0.85 };
    return { value: text.slice(0, 120), confidence: 0.5 }; // said something we could not place: kept, but below the bar
  }
  // Free text was extracted from speech: clear enough to rely on, and anything that must match the programme record is still checked against it.
  // Like a typed WhatsApp answer it must be a real answer: "no", "none" and "I don't know" say nothing, so they are not kept.
  if (q?.type === "text" && !validateAnswer(q, { value: text.slice(0, 300) })) return null;
  return { value: text.slice(0, 300), confidence: 0.85 };
}

export interface IngestResult { applied: boolean; action: "ignored" | "pending" | "answered" | "no_answer" | "opted_out" | "wrong_person" | "refused_call"; finished: boolean; detail?: string }

/**
 * Apply a finished call to its case. Safe to call again for the same result: each result is applied once.
 * Consent and identity come back as fields: a refusal closes the case as an opt-out, a wrong person goes to a human,
 * and answers become evidence. The agent is woken (finished: true) only when there are answers to judge.
 */
export async function ingestVoiceResult(svc: CaseService, tenant: string, caseId: string, r: VoiceResult): Promise<IngestResult> {
  if (!FINAL.includes(r.status)) return { applied: false, action: "pending", finished: false, detail: "the call is not finished" };
  const claim = `voiceres:${tenant}:${r.communication_id}`;
  if (!(await svc.store.claim(claim))) return { applied: false, action: "ignored", finished: false, detail: "already applied" };
  const prior = await svc.store.getCall(tenant, r.communication_id);
  try {
    return await applyVoiceResult(svc, tenant, caseId, r, prior);
  } catch (e) {
    // Something failed halfway (a concurrent change to the case, a store error). Give the result back so the next sync applies it:
    // otherwise the call looks finished and is never asked about again. A second pass records the answers once (recordInbound is keyed by the call).
    if (prior) await svc.store.putCall(prior);
    await svc.store.unclaim(claim);
    throw e;
  }
}

async function applyVoiceResult(svc: CaseService, tenant: string, caseId: string, r: VoiceResult, prior: CallRecord | undefined): Promise<IngestResult> {
  let c = await svc.getCase(tenant, caseId);
  const record: CallRecord = {
    communication_id: r.communication_id, tenant_id: tenant, case_id: caseId, form_id: prior?.form_id ?? 0, requested_at: prior?.requested_at ?? svc.now().toISOString(),
    asked: prior?.asked ?? [], reason: prior?.reason, scheduled_for: prior?.scheduled_for, started_at: prior?.started_at,
    status: r.status, ended_at: r.ended_at ?? svc.now().toISOString(), duration_seconds: r.duration_seconds ?? null, audio_url: r.audio_url ?? null, recording: r.has_recording ?? !!r.audio_url, transcript: r.transcript ?? null,
  };
  // A deleted case's call record was erased with it: a late result must not write the transcript and audio back.
  if (c.deleted_at) return { applied: true, action: "ignored", finished: false, detail: "the case was deleted" };
  await svc.store.putCall(record);
  if (c.status === "complete") return { applied: true, action: "ignored", finished: false, detail: "the case is closed" };

  const mission = await svc.getMission(tenant, c.mission_version);
  // Consent, identity and language are not answers to the mission's questions, so they are not counted as such.
  const answeredCount = Object.entries(r.answers ?? {}).filter(([k, v]) => !NOT_ANSWERS.includes(k) && v !== null && v !== undefined && String(v).trim() !== "").length;
  const mins = r.duration_seconds ? ` (${Math.max(1, Math.round(r.duration_seconds / 60))} min)` : "";
  await svc.emit(c, "call_result", "zolabs", `Call ${r.status.replace(/_/g, " ")}${mins}; ${answeredCount} answer${answeredCount === 1 ? "" : "s"}`, { communication_id: r.communication_id, status: r.status, answers: answeredCount });

  // A call that never reached the person: back to waiting, so the agent may try another way later.
  if (r.status !== "completed") {
    if (["call_scheduled", "calling"].includes(c.status)) c = await svc.transition(tenant, caseId, c.version, "waiting", { actor: "zolabs", summary: `Call ${r.status.replace(/_/g, " ")}`, patch: { next_action: "The call did not connect. Another attempt is allowed inside the contact rules." } });
    return { applied: true, action: r.status === "declined" ? "refused_call" : "no_answer", finished: false };
  }

  // Consent: a clear no ends contact for good.
  if (r.consent_given === false) {
    await svc.recordInbound(tenant, caseId, { provider_event_id: r.communication_id, channel: "voice", summary: "Participant declined to continue on the call", opt_out: true });
    return { applied: true, action: "opted_out", finished: false };
  }

  // Identity: the wrong person must not have their answers recorded, and a human looks at it.
  if (r.identity_confirmed === false) {
    await svc.recordInbound(tenant, caseId, { provider_event_id: r.communication_id, channel: "voice", summary: "The call reached someone other than the participant" });
    c = await svc.getCase(tenant, caseId);
    // A call that was scheduled for later is still call_scheduled here, and review is only reached through calling.
    if (c.status === "call_scheduled") c = await svc.transition(tenant, caseId, c.version, "calling", { actor: "zolabs", summary: "Call connected" });
    if (!["review", "complete"].includes(c.status)) await svc.requestReview(tenant, caseId, c.version, "identity_mismatch", "The call reached someone other than the participant.", "zolabs");
    return { applied: true, action: "wrong_person", finished: false };
  }

  // The same rules as on WhatsApp: an answer to a question this person would not be asked is not kept, and a weak answer never
  // replaces one we already trust.
  const before = new Map<string, { value: string; confidence: number }>();
  for (const e of [...(await svc.store.listEvidence(caseId))].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))) if (e.value && e.value !== "[erased]") before.set(e.question_id, e);
  const heard = new Map<string, { value: string; confidence: number }>();
  for (const [key, raw] of Object.entries(r.answers ?? {})) {
    if (NOT_ANSWERS.includes(key)) continue;
    const n = normaliseVoiceAnswer(questionFor(mission, key), raw);
    if (n) heard.set(key, n);
  }
  const minFor = (key: string) => mission.evidence_requirements?.find(x => x.key === key)?.min_confidence ?? 0.6;
  /** What this person's answer to a question is, from this call if it was clear, else from before. */
  const known = (key: string) => { const h = heard.get(key); return h && h.confidence >= minFor(key) ? h.value : before.get(key)?.value; };
  const answers = [];
  for (const [key, n] of heard) {
    const when = mission.evidence_requirements?.find(x => x.key === key)?.when;
    const parent = when && known(when.key);
    if (when && parent !== undefined && !when.in.includes(parent)) continue; // not needed for this person's situation
    const had = before.get(key);
    if (had && had.confidence >= minFor(key) && n.confidence < minFor(key)) continue; // do not replace a clear answer with an unclear one
    answers.push({ question_id: key, value: n.value, confidence: n.confidence });
  }
  await svc.recordInbound(tenant, caseId, {
    provider_event_id: r.communication_id, channel: "voice", summary: `Participant answered a phone call (${answers.length} answer${answers.length === 1 ? "" : "s"})`,
    consent: r.consent_given === true ? "granted" : undefined, answers,
  });

  // Hand the case to the agent: from calling (or a call that was scheduled and has now happened) to evaluating.
  c = await svc.getCase(tenant, caseId);
  if (c.status === "call_scheduled") c = await svc.transition(tenant, caseId, c.version, "calling", { actor: "zolabs", summary: "Call connected" });
  // A call that connected but gave nothing to judge (it dropped, or the person hung up early) is not a finished interview. Nobody wakes the
  // agent for it, so moving to evaluating would leave the case stuck there. It goes back to waiting, where another call or message can follow.
  if (c.status === "calling" && !answers.length) {
    await svc.transition(tenant, caseId, c.version, "waiting", { actor: "zolabs", summary: "The call ended before any answers were collected", patch: { next_action: "The call ended before any answers were collected. Request another call, or wait for the follow-up." } });
    return { applied: true, action: "no_answer", finished: false, detail: "the call gave no answers" };
  }
  if (c.status === "calling") await svc.transition(tenant, caseId, c.version, "evaluating", { actor: "zolabs", summary: "Call finished: evaluating the answers" });
  return { applied: true, action: "answered", finished: answers.length > 0 };
}

/** A need as the voice agent is told about it: its label, and the condition under which to ask. */
/** What is already known that decides which of the asked fields apply ("Current work status is same job"), so the voice agent need not ask it again. */
export function knownForCall(mission: MissionBundle, asked: string[], evidence: { question_id: string; value: string; at?: string }[]): string[] {
  const out = new Set<string>();
  for (const key of asked) {
    const parent = mission.evidence_requirements?.find(x => x.key === key)?.when?.key;
    if (!parent) continue;
    const last = evidence.filter(e => e.question_id === parent && e.value && e.value !== "[erased]").sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")).at(-1);
    if (last) out.add(`${(mission.evidence_requirements?.find(x => x.key === parent)?.label ?? parent).toLowerCase()} is ${last.value.replace(/_/g, " ")}`);
  }
  return [...out];
}
export function describeNeed(mission: MissionBundle, key: string): { key: string; label: string; condition?: string } {
  const r = mission.evidence_requirements?.find(x => x.key === key);
  const label = r?.label ?? key.replace(/_/g, " ");
  if (!r?.when) return { key, label };
  const on = mission.evidence_requirements?.find(x => x.key === r.when!.key)?.label ?? r.when.key;
  return { key, label, condition: `${on.toLowerCase()} is ${r.when.in.map(v => v.replace(/_/g, " ")).join(" or ")}` };
}

/**
 * Can a call be requested for this case, and what should it ask? Throws a DozaiError in plain words when it cannot.
 * A call asks only for what is still missing (or does not match): there is no point ringing someone for what is known.
 */
export async function planCall(svc: CaseService, c: CaseRecord): Promise<{ form: VoiceFormLink; missing: { key: string; label: string; condition?: string }[] | null }> {
  if (!svc.voiceEnabled) throw new DozaiError("VOICE_NOT_CONFIGURED", "phone calls are not switched on for this platform");
  const mission = await svc.getMission(c.tenant_id, c.mission_version);
  const link = await svc.store.getVoiceForm(c.tenant_id, mission.version);
  if (!link) throw new DozaiError("VOICE_FORM_NOT_PUBLISHED", "the phone form for this mission has not been created yet. A person must publish it first");
  if (!(mission.evidence_requirements ?? []).length) return { form: link, missing: null };
  const person = await svc.store.getParticipant(c.tenant_id, c.participant_id);
  const report = evaluateRequirements(mission, await svc.store.listEvidence(c.case_id), person?.recorded_employer);
  // What is missing now, plus the required needs that depend on an answer we do not have yet: the call will get that answer
  // and must then know to ask for them (a person who says they work somewhere is asked where, and as what).
  // Optional needs are asked too: a call is already happening, and "do you want job support" is the question that matters most to the person.
  const need = report.items.filter(x => (x.applicable && (x.state === "missing" || x.state === "conflict")) || (!x.applicable && x.note === "Depends on an earlier answer."));
  if (!need.length) throw new DozaiError("NOTHING_MISSING", "everything this mission needs is already known, so there is nothing to ask on a call");
  return { form: link, missing: need.map(x => describeNeed(mission, x.key)) };
}
