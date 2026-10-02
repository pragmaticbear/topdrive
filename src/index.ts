// topdrive as a library: the supervisor, its OpenRig client, and the pure routing core.
export { Supervisor, type SupervisorDeps } from "./supervisor.js";
export { HttpOpenRigApi, resolveOpenRigUrl, type OpenRigApi, type OpenRigSeat, type WorkflowInstance, type FrontierPacket, type TrailEntry } from "./openrig-client.js";
export { createSupervisor, loadConfig, topdriveHome } from "./runtime.js";
export * from "./core/eligibility.js";
export * from "./core/provider-health.js";
export { parseTopdriveConfig, DEFAULT_CONFIG, type TopdriveConfig } from "./core/config.js";
