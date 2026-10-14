// Hash-chained, append-only event ledger (per case).
import { createHash, randomUUID } from "node:crypto";
import type { CaseEvent } from "@dozai/contracts";

export const GENESIS = "0".repeat(64);
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

/** Deterministic JSON: object keys sorted, so the same event always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export type UnhashedEvent = Omit<CaseEvent, "hash">;
export const hashEvent = (e: UnhashedEvent): string => createHash("sha256").update(canonical(e)).digest("hex");

export type ChainCheck = { ok: true; events: number } | { ok: false; at_seq: number; reason: string };

/** Recompute the chain for one case's events (ordered by seq). */
export function verifyChain(events: CaseEvent[]): ChainCheck {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const ev of events) {
    if (ev.seq !== expectedSeq) return { ok: false, at_seq: ev.seq, reason: `sequence gap: expected ${expectedSeq}` };
    if (ev.prev_hash !== prev) return { ok: false, at_seq: ev.seq, reason: "prev_hash does not match previous event" };
    const { hash, ...rest } = ev;
    if (hashEvent(rest) !== hash) return { ok: false, at_seq: ev.seq, reason: "event content was altered" };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, events: events.length };
}
