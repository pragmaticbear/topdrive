import { describe, expect, it } from "vitest";
import { parseTopdriveConfig, DEFAULT_CONFIG } from "../src/core/config.js";
import { selectSeat, type SeatFacts } from "../src/core/eligibility.js";
import { seatPrefKeys } from "../src/core/seats.js";

describe("parseTopdriveConfig (spec §43 quota_routing shape)", () => {
  it("empty / absent => strict defaults", () => {
    expect(parseTopdriveConfig("")).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.billing).toEqual({ mode: "subscription_only", allowApiFallback: false, allowPaidOverage: false });
  });
  it("overrides thresholds, unknown policy, polling, and role preferences", () => {
    const c = parseTopdriveConfig(`
quota_routing:
  polling: { interval_seconds: 30 }
  health: { degraded_threshold_percent: 40, draining_threshold_percent: 15 }
  unknown_provider_policy: deny
  roles:
    reviewer: { prefer: [codex:sol, claude] }
`);
    expect(c.pollSeconds).toBe(30);
    expect(c.health).toEqual({ degradedThresholdPercent: 40, drainingThresholdPercent: 15 });
    expect(c.unknownPolicy).toBe("deny");
    expect(c.prefs.reviewer).toEqual(["codex:sol", "claude"]);
    expect(c.prefs.planner).toEqual(DEFAULT_CONFIG.prefs.planner);
  });
  it("constraint booleans map to independence rules; false removes the rule", () => {
    const c = parseTopdriveConfig("quota_routing:\n  constraints: { verifier_must_differ_from_planner: false }\n");
    expect(c.constraints.verifier).toBeUndefined();
    expect(c.constraints.reviewer).toEqual(["implementer"]);
  });
  it("the billing guard can only be tightened, never loosened toward API usage (§7)", () => {
    expect(() => parseTopdriveConfig("quota_routing:\n  billing: { allow_api_fallback: true }\n")).toThrow(/allow_api_fallback/);
    expect(() => parseTopdriveConfig("quota_routing:\n  billing: { allow_paid_overage: true }\n")).toThrow(/allow_paid_overage/);
    expect(() => parseTopdriveConfig("quota_routing:\n  billing: { mode: unrestricted }\n")).toThrow(/mode/);
  });
  it("the two hard separations (implementer != reviewer/approver) cannot be disabled (§25)", () => {
    expect(() => parseTopdriveConfig("quota_routing:\n  constraints: { reviewer_must_differ_from_implementer: false }\n")).toThrow(/reviewer_must_differ_from_implementer/);
    expect(() => parseTopdriveConfig("quota_routing:\n  constraints: { approver_must_differ_from_implementer: false }\n")).toThrow(/approver_must_differ_from_implementer/);
  });
  it("rejects bad shapes loudly: unknown keys, bad thresholds, unknown roles, empty prefs", () => {
    expect(() => parseTopdriveConfig("quota_routing:\n  nope: 1\n")).toThrow(/nope/);
    expect(() => parseTopdriveConfig("quota_routing:\n  health: { degraded_threshold_percent: 5, draining_threshold_percent: 10 }\n")).toThrow(/threshold/);
    expect(() => parseTopdriveConfig("quota_routing:\n  roles: { wizard: { prefer: [claude] } }\n")).toThrow(/wizard/);
    expect(() => parseTopdriveConfig("quota_routing:\n  roles: { reviewer: { prefer: [] } }\n")).toThrow(/prefer/);
    expect(() => parseTopdriveConfig("quota_routing: [1]")).toThrow(/mapping/);
    expect(() => parseTopdriveConfig("::: not yaml")).toThrow();
  });
});

describe("model-aware preference keys", () => {
  it("a codex seat whose model contains 'sol' matches codex:sol; other models do not; unknown model matches via wildcard", () => {
    expect(seatPrefKeys("codex", "gpt-5.6-sol")).toEqual(expect.arrayContaining(["codex", "codex:sol"]));
    expect(seatPrefKeys("codex", "gpt-5.1-mini")).not.toContain("codex:sol");
    expect(seatPrefKeys("codex", null)).toContain("codex:*");
    expect(seatPrefKeys("claude-code", "claude-opus-4-6")).toContain("claude");
    expect(seatPrefKeys("antigravity", null)).toContain("antigravity");
  });
  it("selection: sol model outranks a non-sol codex seat for planner", () => {
    const mk = (id: string, model: string | null): SeatFacts => ({ id, provider: "openai", runtime: "codex", prefKeys: seatPrefKeys("codex", model), healthState: "available", operational: true, authenticated: true });
    const r = selectSeat({ role: "planner", seats: [mk("a-mini", "gpt-5.1-mini"), mk("b-sol", "gpt-5.6-sol")], history: [], prefs: parseTopdriveConfig("").prefs, constraints: {}, unknownPolicy: "allow", provenanceKnown: true });
    expect(r.selected?.id).toBe("b-sol");
  });
  it("wildcard: a codex seat with no recorded model still matches 'codex:sol' preference", () => {
    const seat: SeatFacts = { id: "x", provider: "openai", runtime: "codex", prefKeys: seatPrefKeys("codex", null), healthState: "available", operational: true, authenticated: true };
    const r = selectSeat({ role: "planner", seats: [seat], history: [], prefs: parseTopdriveConfig("").prefs, constraints: {}, unknownPolicy: "allow", provenanceKnown: true });
    expect(r.candidates[0]!.score).toBeGreaterThanOrEqual(100);
  });
});
