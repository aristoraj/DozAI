// Campaigns: list, create, run now and pause/resume/stop.
import type { Express, Request } from "express";
import { CampaignService, DozaiError, type CampaignAction } from "@dozai/core";
import { FakeChannels } from "@dozai/adapters";
import type { AppDeps } from "../deps";
import { need, wrap } from "../http";

export function registerCampaignRoutes(app: Express, deps: AppDeps) {
  const campaignList = async (req: Request) => {
    const cs = new CampaignService(req.ctx.svc); const t = req.principal!.tenant_id;
    const list = await cs.list(t);
    const progress = await cs.progress(t, list);
    return list.map(c => ({ ...c, progress: progress.get(c.campaign_id) }));
  };
  // One pass: queue the next batch, send what is queued, and pause a campaign whose sends keep failing.
  const campaignPass = async (req: Request) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const cs = new CampaignService(svc);
    const campaigns = await cs.run(t);
    const channel = deps.interakt?.channel ?? (deps.runtime.whatsapp === "live" ? undefined : new FakeChannels());
    const sent = channel ? await channel.dispatchOutbox(svc, t) : 0;
    return { campaigns, sent, paused: campaigns.length ? await cs.checkHealth(t) : [] };
  };

  app.get("/api/campaigns", need("read"), wrap(async (req, res) => res.json({ campaigns: await campaignList(req) })));

  app.post("/api/campaigns", need("intake"), wrap(async (req, res) => {
    const c = await new CampaignService(req.ctx.svc).create(req.principal!, req.body);
    res.status(201).json({ campaign: c });
  }));

  app.post("/api/campaigns/run-now", need("intake"), wrap(async (req, res) => res.json(await campaignPass(req))));

  app.post("/api/campaigns/:id/delete", need("intake"), wrap(async (req, res) => {
    await new CampaignService(req.ctx.svc).remove(req.principal!, String(req.params.id));
    res.json({ deleted: true, campaign_id: String(req.params.id) });
  }));

  app.post("/api/campaigns/:id/:action", need("intake"), wrap(async (req, res) => {
    const { svc } = req.ctx; const t = req.principal!.tenant_id;
    const action = String(req.params.action) as CampaignAction;
    if (!["start", "pause", "resume", "stop"].includes(action)) throw new DozaiError("NOT_FOUND", "unknown campaign action", 404);
    const cs = new CampaignService(svc);
    if (action === "start" || action === "resume") {
      // Do not message hundreds of people with a flow that will only hand every reply to a person.
      const camp = await cs.get(t, String(req.params.id));
      const m = await svc.getMission(t, camp.mission_version);
      if (deps.runtime.whatsapp === "live") {
        if (m.instrument.draft && !deps.runtime.draft_instrument_allowed) throw new DozaiError("INSTRUMENT_NOT_APPROVED", "This mission's questions are not approved for live use, so every reply would be handed to a person. Approve the questions first.", 409);
        if (!m.templates.find(x => x.key === m.intro_template)?.provider_name) throw new DozaiError("TEMPLATE_NOT_CONFIGURED", "The intro template has no WhatsApp template name. Add the approved template's name to the mission.", 409);
      }
    }
    const campaign = await cs.act(req.principal!, String(req.params.id), action);
    const pass = action === "start" || action === "resume" ? await campaignPass(req) : null; // first batch now, so nobody waits for the next scheduler run
    res.json({ campaign: (await campaignList(req)).find(c => c.campaign_id === campaign.campaign_id), pass });
  }));
}
