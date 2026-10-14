// Loading real participants. Contact numbers are encrypted and matched by keyed hash; names stay out of the ledger.
import { MAX_IMPORT_ROWS, ParticipantRowSchema, type Participant, type Principal } from "@dozai/contracts";
import { newId } from "./ledger";
import { PLACEMENT_RETENTION_V1 } from "./mission";
import { encryptPhone, maskPhone, normalizeMsisdn, phoneHash } from "./pii";
import { DozaiError, type CaseService } from "./service";

export interface ImportResult {
  created: { row: number; case_id: string }[];
  skipped: { row: number; reason: string }[];
}

/** Next free case id (DZ-0001, ...). Claimed atomically, so ids are never reused, even after deletions. */
export async function nextCaseId(svc: CaseService, tenant: string): Promise<string> {
  const base = (await svc.store.listCases(tenant)).length;
  for (let n = base + 1; n < base + 1000; n++) {
    const id = `DZ-${String(n).padStart(4, "0")}`;
    if (await svc.store.claim(`caseid:${tenant}:${id}`)) return id;
  }
  throw new DozaiError("ID_EXHAUSTED", "could not allocate a case id", 500);
}

export async function importParticipants(
  svc: CaseService, p: Principal, rawRows: unknown[],
  opts: { piiKey: string; defaultCountryCode: string; runId?: string; missionVersion?: string },
): Promise<ImportResult> {
  if (rawRows.length > MAX_IMPORT_ROWS) throw new DozaiError("TOO_MANY_ROWS", `send at most ${MAX_IMPORT_ROWS} rows per request`, 400);
  // Choose the mission once, up front: an unknown mission refuses the whole batch instead of failing row by row.
  const mission = opts.missionVersion ? await svc.getMission(p.tenant_id, opts.missionVersion) : await svc.defaultMission(p.tenant_id);
  const result: ImportResult = { created: [], skipped: [] };
  // The same person can be in several missions (one case each), but only once in the same mission. So "already loaded" is judged against
  // this mission's own cases. A deleted case no longer counts: its number was erased, and it can be added again.
  const here = (await svc.store.listCases(p.tenant_id)).filter(c => !c.deleted_at && (c.mission_version ?? PLACEMENT_RETENTION_V1.version) === mission.version);
  const hashOf = new Map((await svc.store.listParticipants(p.tenant_id)).filter(x => x.phone_hash).map(x => [x.participant_id, x.phone_hash as string]));
  const seen = new Map<string, string>(); // number (keyed hash) -> the case it is already in, in this mission
  for (const c of here) { const h = hashOf.get(c.participant_id); if (h) seen.set(h, c.case_id); }
  const actor = `${p.role}:${p.user_id}`;

  for (let i = 0; i < rawRows.length; i++) {
    const row = i + 1;
    const parsed = ParticipantRowSchema.safeParse(rawRows[i]);
    if (!parsed.success) { result.skipped.push({ row, reason: parsed.error.issues.map(x => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") }); continue; }
    const r = parsed.data;
    const digits = normalizeMsisdn(r.phone, opts.defaultCountryCode);
    if (digits.length < 10 || digits.length > 15) { result.skipped.push({ row, reason: "phone: not a valid number" }); continue; }
    const hash = phoneHash(opts.piiKey, digits);
    if (seen.has(hash)) { result.skipped.push({ row, reason: `phone: already in this mission (${seen.get(hash)}). The same number can be added to a different mission.` }); continue; }

    const case_id = await nextCaseId(svc, p.tenant_id);
    seen.set(hash, case_id);
    const participant: Participant = {
      participant_id: newId("ptc"), tenant_id: p.tenant_id, display_name: r.name, first_name: r.name.split(/\s+/)[0],
      phone_masked: maskPhone(digits), phone_enc: encryptPhone(opts.piiKey, digits), phone_hash: hash,
      location: r.location || "—", cohort: r.cohort || "Unassigned", language: r.language, consent: "unknown", recorded_employer: r.employer || "—",
    };
    await svc.createCase({ tenant_id: p.tenant_id, run_id: opts.runId ?? "run_pilot", case_id, participant, actor, mission_version: mission.version, meta: { source: "import", consent_attested: true } });
    result.created.push({ row, case_id });
  }
  return result;
}
