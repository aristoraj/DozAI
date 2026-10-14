// What the agent may remember about one person between runs. Every item is a fixed key with a fixed set of values, so
// memory can never hold a name, a number, a health detail or an instruction smuggled in by a participant. It belongs to
// the case and is erased with it.
import { z } from "zod";

export const MEMORY_SPEC = {
  best_time_to_call: { values: ["morning", "afternoon", "evening", "weekend"], label: "Best time to call" },
  preferred_channel: { values: ["whatsapp", "voice"], label: "Prefers to be reached by" },
  preferred_language: { values: ["en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "pa"], label: "Preferred language" },
  prefers_short_contact: { values: ["yes", "no"], label: "Prefers short messages and calls" },
} as const;
export type MemoryKey = keyof typeof MEMORY_SPEC;
export const MEMORY_KEYS = Object.keys(MEMORY_SPEC) as MemoryKey[];

export interface MemoryItem { key: MemoryKey; value: string; source: string; at: string }
export interface CaseMemory { tenant_id: string; case_id: string; items: MemoryItem[]; updated_at: string }

export const MemoryNoteSchema = z.object({ key: z.enum(MEMORY_KEYS as [MemoryKey, ...MemoryKey[]]), value: z.string().trim().toLowerCase().max(10) });

/** A problem with a note, or null when it may be kept. */
export function memoryProblem(key: string, value: string): string | null {
  const spec = MEMORY_SPEC[key as MemoryKey];
  if (!spec) return `unknown memory key ${key}`;
  return (spec.values as readonly string[]).includes(value) ? null : `${key} must be one of: ${spec.values.join(", ")}`;
}

/** A later note on the same key replaces the earlier one. */
export function withNote(m: CaseMemory | undefined, base: { tenant_id: string; case_id: string }, item: MemoryItem): CaseMemory {
  return { tenant_id: base.tenant_id, case_id: base.case_id, items: [...(m?.items ?? []).filter(i => i.key !== item.key), item], updated_at: item.at };
}
