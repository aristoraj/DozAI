// Campaigns: send the first message to many participants at a pace WhatsApp and our own limits allow.
//
// A campaign is a saved instruction ("this mission, this cohort, at most N a day"), not a list of people. The scheduler
// (about once a minute) takes the next few participants who are eligible and sends each the mission's intro template.
// Nothing here calls the agent: the agent is only woken after a participant has finished the interview.
//
// Who is in a campaign is fixed when it starts: participants of the chosen mission (and cohort) who were loaded before
// that moment and have not been messaged. Anyone loaded later is not contacted unless a new campaign is started.
//
// Several schedulers may run at once (webhook, cron, a button). Safety comes from claims, not from timing:
//   - each participant's first message is claimed once (`outreach:<case>`), so nobody is messaged twice;
//   - each message to send today takes a numbered slot (`slot:<campaign>:<day>:<n>`), so the daily cap is exact.
import { CampaignInputSchema, type Campaign, type CampaignInput, type CaseRecord, type Principal } from "@dozai/contracts";
import { localHour } from "@dozai/domain";
import { newId } from "../storage/ledger";
import { PLACEMENT_RETENTION_V1 } from "../missions/mission";
import { DozaiError, type CaseService } from "./service";

export type CampaignAction = "start" | "pause" | "resume" | "stop";

export interface CampaignProgress {
  /** Eligible and not yet messaged. */
  queued: number;
  /** First message sent by this campaign. */
  contacted: number;
  waiting: number;
  needs_review: number;
  complete: number;
  /** First messages that could not be delivered to WhatsApp. */
  send_failed: number;
}

export interface CampaignRunResult { campaign_id: string; sent: number; errors: number; note: string | null }

/** The calendar day in the policy's time zone, used to count "today". */
const dayOf = (now: Date, offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/** The mission a case belongs to (cases made before missions existed use the built-in one). */
const missionOf = (c: CaseRecord) => c.mission_version ?? PLACEMENT_RETENTION_V1.version;

export class CampaignService {
  constructor(private svc: CaseService) {}
  private get store() { return this.svc.store; }

  // ---- create and control ------------------------------------------------------------------------------------------

  async create(p: Principal, raw: unknown): Promise<Campaign> {
    const input: CampaignInput = CampaignInputSchema.parse(raw ?? {});
    const mission = input.mission_version ? await this.svc.getMission(p.tenant_id, input.mission_version) : await this.svc.defaultMission(p.tenant_id);
    const now = this.svc.now().toISOString();
    const c: Campaign = {
      campaign_id: newId("cmp"), tenant_id: p.tenant_id, name: input.name, mission_version: mission.version, cohort: input.cohort || null,
      status: "draft", daily_cap: input.daily_cap, per_tick: input.per_tick, created_at: now, created_by: `${p.role}:${p.user_id}`,
      started_at: null, updated_at: now, pause_reason: null, sent_day: null, sent_today: 0, sent_total: 0, last_run_at: null, last_note: null,
    };
    await this.store.putCampaign(c);
    return c;
  }

  async get(tenant: string, id: string): Promise<Campaign> {
    const c = await this.store.getCampaign(tenant, id);
    if (!c) throw new DozaiError("NOT_FOUND", `campaign ${id} not found`, 404);
    return c;
  }

  async list(tenant: string): Promise<Campaign[]> {
    return (await this.store.listCampaigns(tenant)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Start, pause, resume or stop. Stopped and finished campaigns cannot be restarted: make a new one. */
  async act(p: Principal, id: string, action: CampaignAction): Promise<Campaign> {
    const c = await this.get(p.tenant_id, id);
    const now = this.svc.now().toISOString();
    const bad = (why: string) => new DozaiError("ILLEGAL_STATE", why, 409);
    let next: Campaign;
    switch (action) {
      case "start":
        if (c.status !== "draft") throw bad(`this campaign is ${c.status}; only a draft campaign can be started`);
        next = { ...c, status: "running", started_at: now, pause_reason: null, last_note: "Started." };
        break;
      case "pause":
        if (c.status !== "running") throw bad(`this campaign is ${c.status}, not running`);
        next = { ...c, status: "paused", pause_reason: `Paused by ${p.user_id}.` };
        break;
      case "resume":
        if (c.status !== "paused") throw bad(`this campaign is ${c.status}, not paused`);
        next = { ...c, status: "running", pause_reason: null, last_note: "Resumed." };
        break;
      case "stop":
        if (c.status === "stopped" || c.status === "completed") throw bad(`this campaign is already ${c.status}`);
        next = { ...c, status: "stopped", pause_reason: null, last_note: `Stopped by ${p.user_id}.` };
        break;
    }
    next.updated_at = now;
    await this.store.putCampaign(next);
    return next;
  }

  // ---- who is in it ----------------------------------------------------------------------------------------------------

  private async cohorts(tenant: string, need: boolean): Promise<Map<string, string>> {
    if (!need) return new Map();
    return new Map((await this.store.listParticipants(tenant)).map(p => [p.participant_id, p.cohort]));
  }

  private isEligible(c: CaseRecord, camp: Campaign, cohortOf: Map<string, string>): boolean {
    if (c.deleted_at || (c.status !== "draft" && c.status !== "ready") || c.campaign_id) return false;
    if (missionOf(c) !== camp.mission_version) return false;
    if (camp.cohort && cohortOf.get(c.participant_id) !== camp.cohort) return false;
    // Loaded after the campaign started: not part of it. (Cases without a creation time pre-date this rule.)
    if (camp.started_at && c.created_at && c.created_at > camp.started_at) return false;
    return true;
  }

  /** Counts for the screen, read from the cases themselves so they cannot drift. */
  async progress(tenant: string, camps: Campaign[]): Promise<Map<string, CampaignProgress>> {
    const out = new Map<string, CampaignProgress>();
    if (!camps.length) return out;
    const cases = (await this.store.listCases(tenant)).filter(c => !c.deleted_at);
    const needCohort = camps.some(c => c.cohort);
    const cohortOf = await this.cohorts(tenant, needCohort);
    const outbox = await this.store.listOutbox(tenant);
    for (const camp of camps) {
      const mine = cases.filter(c => c.campaign_id === camp.campaign_id);
      const ids = new Set(mine.map(c => c.case_id));
      out.set(camp.campaign_id, {
        // A draft campaign counts everyone who would be included if it started now.
        queued: cases.filter(c => this.isEligible(c, camp.status === "draft" ? { ...camp, started_at: null } : camp, cohortOf)).length,
        contacted: mine.length,
        waiting: mine.filter(c => c.status === "waiting").length,
        needs_review: mine.filter(c => c.status === "review").length,
        complete: mine.filter(c => c.status === "complete").length,
        send_failed: outbox.filter(o => o.kind === "whatsapp_template" && o.status === "failed" && ids.has(o.case_id)).length,
      });
    }
    return out;
  }

  // ---- the scheduler step ---------------------------------------------------------------------------------------------

  /** One pass over every running campaign. Queues first messages; the channel sends them afterwards. Safe to run concurrently. */
  async run(tenant: string): Promise<CampaignRunResult[]> {
    const running = (await this.store.listCampaigns(tenant)).filter(c => c.status === "running");
    if (!running.length) return [];
    const cases = await this.store.listCases(tenant);
    const cohortOf = await this.cohorts(tenant, running.some(c => c.cohort));
    const results: CampaignRunResult[] = [];
    for (const camp of running) results.push(await this.runOne(tenant, camp, cases, cohortOf));
    return results;
  }

  private async runOne(tenant: string, camp: Campaign, cases: CaseRecord[], cohortOf: Map<string, string>): Promise<CampaignRunResult> {
    const svc = this.svc;
    let sent = 0, errors = 0;
    let note: string | null = null;
    // One batch per campaign per minute, however many things trigger a run (the cron, a webhook, a button). This is the pace.
    if (!(await this.store.claim(`batch:${camp.campaign_id}:${svc.now().toISOString().slice(0, 16)}`))) return { campaign_id: camp.campaign_id, sent: 0, errors: 0, note: "Already ran this minute." };
    try {
      const mission = await svc.getMission(tenant, camp.mission_version);
      const policy = svc.policyFor(mission);
      const now = svc.now();
      const day = dayOf(now, policy.utcOffsetMinutes);
      const sentToday = camp.sent_day === day ? camp.sent_today : 0;
      const queue = cases.filter(c => this.isEligible(c, camp, cohortOf));
      const h = localHour(now, policy.utcOffsetMinutes);

      if (!queue.length) {
        note = "Finished: everyone in this campaign has been messaged.";
      } else if (h < policy.windowStartHour || h >= policy.windowEndHour) {
        note = `Waiting for the contact window (${hhmm(policy.windowStartHour)} to ${hhmm(policy.windowEndHour)} IST).`;
      } else {
        for (const c of queue) {
          if (sent >= camp.per_tick) break;
          const slot = await this.takeSlot(camp, day, sentToday + sent);
          if (!slot) { note = `Daily limit of ${camp.daily_cap} reached. Continues tomorrow.`; break; }
          // Keeps two schedulers that start in the same minute off the same participant. The case state machine is the real
          // guard (only one writer can move a case out of draft); the minute lets a failed attempt be tried again later.
          if (!(await this.store.claim(`outreach:${c.case_id}:${now.toISOString().slice(0, 16)}`))) continue;
          try {
            await svc.sendIntro(tenant, c.case_id, { actor: `campaign:${camp.campaign_id}`, campaignId: camp.campaign_id });
            sent++;
          } catch (e) {
            errors++;
            note = `${c.case_id}: ${(e as Error).message.slice(0, 120)}`;
          }
        }
        if (!note) note = `Queued ${sent} first message${sent === 1 ? "" : "s"}.`;
      }
      const finished = !queue.length || (!errors && sent >= queue.length);
      await this.record(tenant, camp.campaign_id, { sent, day, sentToday, note, finished });
    } catch (e) {
      note = `Could not run: ${(e as Error).message.slice(0, 140)}`;
      await this.record(tenant, camp.campaign_id, { sent, day: camp.sent_day ?? "", sentToday: camp.sent_today, note, finished: false });
    }
    return { campaign_id: camp.campaign_id, sent, errors, note };
  }

  /** Take the next free numbered slot for today. Returns null when the daily cap is used up. */
  private async takeSlot(camp: Campaign, day: string, taken: number): Promise<number | null> {
    for (let n = taken + 1; n <= camp.daily_cap; n++) if (await this.store.claim(`slot:${camp.campaign_id}:${day}:${n}`)) return n;
    return null;
  }

  /** Writes counters on top of the latest copy, so a pause pressed during the run is never undone. */
  private async record(tenant: string, id: string, r: { sent: number; day: string; sentToday: number; note: string | null; finished: boolean }) {
    const fresh = await this.store.getCampaign(tenant, id);
    if (!fresh) return;
    const now = this.svc.now().toISOString();
    const keepStatus = fresh.status === "running";
    await this.store.putCampaign({
      ...fresh,
      status: keepStatus && r.finished ? "completed" : fresh.status,
      sent_day: r.day || fresh.sent_day, sent_today: r.sent || r.day !== fresh.sent_day ? r.sentToday + r.sent : fresh.sent_today, sent_total: fresh.sent_total + r.sent,
      last_run_at: now, last_note: keepStatus ? r.note : fresh.last_note, updated_at: now,
    });
  }

  // ---- watching for trouble -----------------------------------------------------------------------------------------------

  /**
   * Pause a campaign whose last few first messages all failed (a wrong key, a blocked number list, a provider outage).
   * Better to stop after a handful than to burn through the whole list. Run after the channel has tried to send.
   */
  async checkHealth(tenant: string, inRow = 5): Promise<{ campaign_id: string; reason: string }[]> {
    const running = (await this.store.listCampaigns(tenant)).filter(c => c.status === "running");
    if (!running.length) return [];
    const cases = await this.store.listCases(tenant);
    const outbox = (await this.store.listOutbox(tenant)).filter(o => o.kind === "whatsapp_template");
    const paused: { campaign_id: string; reason: string }[] = [];
    for (const camp of running) {
      const ids = new Set(cases.filter(c => c.campaign_id === camp.campaign_id).map(c => c.case_id));
      const recent = outbox.filter(o => ids.has(o.case_id) && o.status !== "pending").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, inRow);
      if (recent.length < inRow || !recent.every(o => o.status === "failed")) continue;
      const why = String(recent[0]!.payload.last_error ?? "unknown error").slice(0, 120);
      const reason = `Paused automatically: the last ${inRow} first messages all failed (${why}). Fix the cause, then resume.`;
      const fresh = await this.store.getCampaign(tenant, camp.campaign_id);
      if (fresh?.status !== "running") continue;
      await this.store.putCampaign({ ...fresh, status: "paused", pause_reason: reason, last_note: reason, updated_at: this.svc.now().toISOString() });
      paused.push({ campaign_id: camp.campaign_id, reason });
    }
    return paused;
  }
}
