// Settings that do not change while the app runs: the API address, the time zone, role names, and which roles may do what.

export const API_BASE = (window.DOZAI_API_BASE || "/api").replace(/[/]$/, "");
export const CLOUD = API_BASE.startsWith("/server");
export const TZ = "Asia/Kolkata"; // all times are shown in India Standard Time
export const ROLE_HEADER = { admin: "admin", agentops: "agent_ops", operator: "operator", reviewer: "reviewer" };
export const palette = ["#f4c7b7", "#b9e3df", "#ead6a8", "#d7cfeb", "#bcd7ea", "#f1c0cd"];
export const ALLOWED = { intake: ["admin", "operator"], run: ["admin", "agent_ops", "operator"], review: ["admin", "reviewer"], admin: ["admin"], approve: ["admin", "reviewer", "agent_ops"], controls: ["admin", "agent_ops"], killswitch: ["admin", "agent_ops", "operator"] };
