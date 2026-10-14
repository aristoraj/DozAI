// The one shared state object every page reads and writes, and the role check.
import { ALL } from "../pages/overview/dashboard.js";
import { ALLOWED } from "./config.js";

export const state = {
  view: "overview", localRole: "admin", dashMission: ALL, caseTab: "overview", caseTabFor: null,
  me: null, mission: null, cases: [], audits: [], summary: null, sessions: [],
  missions: [], defaultMission: null, missionShown: null, campaigns: [],
  employees: [], employeeCanEdit: false, platform: null, platformShown: null, employeeShown: null, employeeDef: null, ctxPreview: null,
  voiceForm: null, voiceFormFor: null, voicePublishing: false, voiceLoading: false, wording: null, wordingFor: null, qeditor: null, wordingLoading: false, wordingFailedFor: null,
  approvals: [], approvalsWaiting: 0, controlsInfo: null, replay: null, voice: null, voiceCheck: null,
  loaded: false, error: null,
  caseFilter: "all", caseSearch: "", reviewSelected: null,
  agentTab: "agent", session: null, auditSearch: "", auditActor: "all",
};
export const can = cap => (ALLOWED[cap] || []).includes(state.me?.role);
