// What the API needs from outside: the shape of the dependencies it is built with and of the per-request context.
import express, { type Request } from "express";
import { ROLES, type Principal } from "@dozai/contracts";
import type { MissionDrafter } from "@dozai/core";
import { CaseService, ConversationRunner, DozaiError } from "@dozai/core";
import { type VoiceDispatchConfig, type VoicePort, type AgentRuntimePort, type ChannelPort } from "@dozai/adapters";

export interface RequestContext { svc: CaseService; agent: AgentRuntimePort; runner?: ConversationRunner }

export interface AppDeps {
  /** Builds the service for one request (per-request Catalyst SDK context in the cloud). */
  forRequest: (req: Request) => RequestContext | Promise<RequestContext>;
  /** Local development only: trust x-dozai-role / x-dozai-user headers. Never enable in a deployed environment. */
  devAuth: boolean;
  /** Resolves the signed-in user. Return null for "not signed in"; throw DozaiError(403) for "signed in but not allowed". */
  resolvePrincipal?: (req: Request) => Promise<Principal | null>;
  /** Encrypts contact numbers on import. Without it, participant import is unavailable. */
  pii?: { key: string; defaultCountryCode: string };
  /** What is switched on, shown on the Mission and Agent pages. */
  runtime: { whatsapp: "live" | "off"; agent: "claude" | "scripted"; model: string | null; contact_window: string; window_forced?: boolean; classifier?: "rules" | "claude"; draft_instrument_allowed?: boolean };
  /** Enables POST /api/admin/purge-all (deletes every record). Development projects only. */
  allowPurge?: boolean;
  /** One-time setup: invites the people listed in DOZAI_ROLES to sign in. Guarded by a long random token. */
  bootstrap?: { token: string; emails: string[]; invite: (req: Request, email: string) => Promise<void> };
  /** Token for the scheduler routes under /api/jobs. Long random value; unset disables them. */
  jobToken?: string;
  /** Turns a plain-language brief into a draft mission. Claude when a key is set, otherwise a plain scripted draft. */
  drafter?: MissionDrafter;
  /** Interakt WhatsApp: webhook verification and (optionally) the live channel. */
  interakt?: { webhookSecret: string; piiKey: string; tenant: string; channel?: ChannelPort; defaultCountryCode?: string };
  /** Phone calls. `webhookSecret` is part of the callback address; the callback body is never trusted, only the call id it names. */
  voice?: { port: VoicePort; cfg: VoiceDispatchConfig; tenant: string; webhookSecret?: string; callbackUrl?: string };
}

declare module "express-serve-static-core" {
  interface Request { principal?: Principal; ctx: RequestContext; rawBody?: Buffer }
}
