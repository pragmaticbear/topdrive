// topdrive §43: `quota_routing:` configuration, loaded from <TOPDRIVE_HOME>/topdrive.yaml (same shape as the
// proposed RigSpec block, so it can move into RigSpec without a rewrite). Strict: unknown keys, bad values, and any
// attempt to loosen the billing guard or the two hard separations are loud errors (§7, §25). Absent file => defaults.

import { parse as parseYaml } from "yaml";
import { DEFAULT_BILLING_POLICY, type BillingPolicy } from "./billing-policy.js";
import { DEFAULT_CONSTRAINTS, DEFAULT_ROLE_PREFS, type Constraints, type Role, type RolePrefs } from "./eligibility.js";
import { DEFAULT_HEALTH_POLICY, type HealthPolicy } from "./provider-health.js";

export interface TopdriveConfig {
  billing: BillingPolicy;
  pollSeconds: number;
  health: HealthPolicy;
  unknownPolicy: "allow" | "deny";
  constraints: Constraints;
  prefs: RolePrefs;
  /** Seat session -> runtime ("claude-code" | "codex" | "antigravity") for seats whose OpenRig runtime does not say
   *  which subscription they use (e.g. a terminal seat running a wrapper). Seats with a known runtime ignore it. */
  seatRuntimes: Record<string, string>;
}
export const DEFAULT_CONFIG: TopdriveConfig = {
  billing: DEFAULT_BILLING_POLICY, pollSeconds: 60, health: DEFAULT_HEALTH_POLICY, unknownPolicy: "allow",
  constraints: DEFAULT_CONSTRAINTS, prefs: DEFAULT_ROLE_PREFS, seatRuntimes: {},
};
export const AGENT_RUNTIMES = ["claude-code", "codex", "antigravity"] as const;

const ROLES: Role[] = ["planner", "verifier", "implementer", "reviewer", "approver"];
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function only(m: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(m)) if (!allowed.includes(k)) throw new Error(`topdrive config: unknown key "${k}" in ${where} (allowed: ${allowed.join(", ")})`);
}
function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`topdrive config: ${name} must be a number in [${min}, ${max}]`);
  return v;
}

// constraint flag -> [constrained role, role it must differ from, can be disabled]
const CONSTRAINT_FLAGS: Record<string, [Role, Role, boolean]> = {
  verifier_must_differ_from_planner: ["verifier", "planner", true],
  reviewer_must_differ_from_implementer: ["reviewer", "implementer", false],
  approver_must_differ_from_implementer: ["approver", "implementer", false],
};

export function parseTopdriveConfig(text: string): TopdriveConfig {
  const doc = text.trim() === "" ? {} : parseYaml(text);
  if (doc === null || (isMap(doc) && Object.keys(doc).length === 0)) return DEFAULT_CONFIG;
  if (!isMap(doc)) throw new Error("topdrive config: top level must be a mapping");
  only(doc, ["quota_routing"], "top level");
  const qr = doc["quota_routing"];
  if (qr === undefined || qr === null) return DEFAULT_CONFIG;
  if (!isMap(qr)) throw new Error("topdrive config: quota_routing must be a mapping");
  only(qr, ["enabled", "billing", "polling", "health", "unknown_provider_policy", "constraints", "roles", "seat_runtimes"], "quota_routing");

  const cfg: TopdriveConfig = { ...DEFAULT_CONFIG, constraints: { ...DEFAULT_CONSTRAINTS }, prefs: { ...DEFAULT_ROLE_PREFS }, seatRuntimes: {} };

  if (qr["billing"] !== undefined) {
    const b = qr["billing"];
    if (!isMap(b)) throw new Error("topdrive config: billing must be a mapping");
    only(b, ["mode", "allow_api_fallback", "allow_paid_overage"], "billing");
    if (b["mode"] !== undefined && b["mode"] !== "subscription_only") throw new Error('topdrive config: billing.mode may only be "subscription_only"; the guard cannot be loosened here (set TOPDRIVE_BILLING_MODE=unrestricted to opt out explicitly)');
    if (b["allow_api_fallback"] !== undefined && b["allow_api_fallback"] !== false) throw new Error("topdrive config: billing.allow_api_fallback may only be false");
    if (b["allow_paid_overage"] !== undefined && b["allow_paid_overage"] !== false) throw new Error("topdrive config: billing.allow_paid_overage may only be false");
  }
  if (qr["polling"] !== undefined) {
    const p = qr["polling"];
    if (!isMap(p)) throw new Error("topdrive config: polling must be a mapping");
    only(p, ["interval_seconds"], "polling");
    if (p["interval_seconds"] !== undefined) cfg.pollSeconds = num(p["interval_seconds"], "polling.interval_seconds", 5, 3600);
  }
  if (qr["health"] !== undefined) {
    const h = qr["health"];
    if (!isMap(h)) throw new Error("topdrive config: health must be a mapping");
    only(h, ["degraded_threshold_percent", "draining_threshold_percent"], "health");
    const degraded = h["degraded_threshold_percent"] === undefined ? DEFAULT_HEALTH_POLICY.degradedThresholdPercent : num(h["degraded_threshold_percent"], "health.degraded_threshold_percent", 0, 100);
    const draining = h["draining_threshold_percent"] === undefined ? DEFAULT_HEALTH_POLICY.drainingThresholdPercent : num(h["draining_threshold_percent"], "health.draining_threshold_percent", 0, 100);
    if (degraded < draining) throw new Error("topdrive config: degraded threshold must be >= draining threshold");
    cfg.health = { degradedThresholdPercent: degraded, drainingThresholdPercent: draining };
  }
  if (qr["unknown_provider_policy"] !== undefined) {
    const u = qr["unknown_provider_policy"];
    if (u !== "allow" && u !== "deny") throw new Error('topdrive config: unknown_provider_policy must be "allow" or "deny"');
    cfg.unknownPolicy = u;
  }
  if (qr["constraints"] !== undefined) {
    const c = qr["constraints"];
    if (!isMap(c)) throw new Error("topdrive config: constraints must be a mapping");
    only(c, Object.keys(CONSTRAINT_FLAGS), "constraints");
    for (const [flag, value] of Object.entries(c)) {
      if (typeof value !== "boolean") throw new Error(`topdrive config: constraints.${flag} must be true or false`);
      const [role, differsFrom, disableable] = CONSTRAINT_FLAGS[flag]!;
      if (value === false) {
        if (!disableable) throw new Error(`topdrive config: constraints.${flag} cannot be disabled (implementer self-review/approval is never allowed)`);
        delete cfg.constraints[role];
      } else cfg.constraints[role] = [differsFrom];
    }
  }
  if (qr["roles"] !== undefined) {
    const r = qr["roles"];
    if (!isMap(r)) throw new Error("topdrive config: roles must be a mapping");
    for (const [role, v] of Object.entries(r)) {
      if (!ROLES.includes(role as Role)) throw new Error(`topdrive config: unknown role "${role}" (roles: ${ROLES.join(", ")})`);
      if (!isMap(v)) throw new Error(`topdrive config: roles.${role} must be a mapping`);
      only(v, ["prefer"], `roles.${role}`);
      const prefer = v["prefer"];
      if (!Array.isArray(prefer) || prefer.length === 0 || !prefer.every((x) => typeof x === "string" && /^[a-z0-9-]+(:[a-z0-9.*-]+)?$/.test(x))) {
        throw new Error(`topdrive config: roles.${role}.prefer must be a non-empty list of provider tokens like "claude" or "codex:sol"`);
      }
      cfg.prefs[role as Role] = prefer as string[];
    }
  }
  if (qr["seat_runtimes"] !== undefined) {
    const m = qr["seat_runtimes"];
    if (!isMap(m)) throw new Error("topdrive config: seat_runtimes must be a mapping of seat session to runtime");
    for (const [seat, rt] of Object.entries(m)) {
      if (!(AGENT_RUNTIMES as readonly unknown[]).includes(rt)) throw new Error(`topdrive config: seat_runtimes.${seat} must be one of ${AGENT_RUNTIMES.join(", ")}`);
      cfg.seatRuntimes[seat] = rt as string;
    }
  }
  return cfg;
}
