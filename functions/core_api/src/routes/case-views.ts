// Reading cases for a request: the live (not deleted) cases and the screen-ready view of one or many.
import type { Request } from "express";
import { type CaseRecord } from "@dozai/contracts";
import { DozaiError, type MissionBundle } from "@dozai/core";
import { caseView } from "../views";

export const live = async (req: Request): Promise<CaseRecord[]> => (await req.ctx.svc.store.listCases(req.principal!.tenant_id)).filter(c => !c.deleted_at);
export const views = async (req: Request, cases: CaseRecord[]) => {
  const { svc } = req.ctx; const t = req.principal!.tenant_id;
  const [people, evidence] = await Promise.all([svc.store.listParticipants(t), svc.store.listAllEvidence()]);
  const byPerson = new Map(people.map(p => [p.participant_id, p]));
  const bundles = new Map<string, MissionBundle>();
  for (const v of new Set(cases.map(c => c.mission_version))) bundles.set(String(v), await svc.getMission(t, v));
  return cases.map(c => caseView(c, byPerson.get(c.participant_id), evidence.filter(e => e.case_id === c.case_id), bundles.get(String(c.mission_version))));
};
export const oneView = async (req: Request, caseId: string) => {
  const { svc } = req.ctx; const t = req.principal!.tenant_id;
  const c = await svc.getCase(t, caseId);
  if (c.deleted_at) throw new DozaiError("CASE_DELETED", "this case was deleted", 410);
  return caseView(c, await svc.store.getParticipant(t, c.participant_id), await svc.store.listEvidence(caseId), await svc.getMission(t, c.mission_version));
};
