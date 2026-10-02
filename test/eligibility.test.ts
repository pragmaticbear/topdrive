import { describe, expect, it } from "vitest";
import { selectSeat, DEFAULT_ROLE_PREFS, DEFAULT_CONSTRAINTS, type SeatFacts, type RoleExecution } from "../src/core/eligibility.js";
import type { ProviderHealthState } from "../src/core/provider-health.js";

const seat = (id: string, provider: SeatFacts["provider"], runtime: string, state: ProviderHealthState = "available", extra: Partial<SeatFacts> = {}): SeatFacts => ({
  id, provider, runtime, prefKeys: [runtime, ...(extra.prefKeys ?? [])], healthState: state, remainingPercent: 80, operational: true, authenticated: true, ...extra,
});
const sol = (s: ProviderHealthState = "available") => seat("sol-reviewer", "openai", "codex", s, { prefKeys: ["codex:sol"] });
const claude = (s: ProviderHealthState = "available") => seat("claude-reviewer", "anthropic", "claude", s);
const gemini = (s: ProviderHealthState = "available") => seat("gemini-builder", "google", "antigravity", s);
const exec = (role: string, s: SeatFacts, outcome = "completed"): RoleExecution => ({ stepId: role, role, seatId: s.id, provider: s.provider, runtime: s.runtime, outcome });
const base = { prefs: DEFAULT_ROLE_PREFS, constraints: DEFAULT_CONSTRAINTS, unknownPolicy: "allow" as const, provenanceKnown: true };

describe("selectSeat", () => {
  it("normal flow: reviewer prefers Claude", () => {
    const r = selectSeat({ ...base, role: "reviewer", seats: [claude(), sol(), gemini()], history: [exec("implementer", gemini())] });
    expect(r.selected?.id).toBe("claude-reviewer");
  });
  it("Claude draining => Sol reviews (§73)", () => {
    const r = selectSeat({ ...base, role: "reviewer", seats: [claude("draining"), sol(), gemini()], history: [exec("implementer", gemini())] });
    expect(r.selected?.id).toBe("sol-reviewer");
    expect(r.candidates.find((c) => c.seat === "claude-reviewer")).toMatchObject({ eligible: false, reason: "provider_draining" });
    expect(r.candidates.find((c) => c.seat === "gemini-builder")).toMatchObject({ eligible: false, reason: "performed_role:implementer" });
  });
  it("implementer cannot review or approve itself, even if it is the only healthy seat", () => {
    const hist = [exec("implementer", gemini())];
    for (const role of ["reviewer", "approver"] as const) {
      const r = selectSeat({ ...base, role, seats: [gemini()], history: hist });
      expect(r.selected).toBeNull();
      expect(r.held).toBe(true);
    }
  });
  it("independence is provider-level: another Gemini seat cannot review Gemini work (§26)", () => {
    const other = seat("gemini-2", "google", "antigravity");
    const r = selectSeat({ ...base, role: "reviewer", seats: [other], history: [exec("implementer", gemini())] });
    expect(r.selected).toBeNull();
  });
  it("no independent reviewer => HELD, never self-review (§76)", () => {
    const hist = [exec("implementer", gemini()), exec("implementer", sol())];
    const r = selectSeat({ ...base, role: "reviewer", seats: [claude("cooldown"), gemini(), sol()], history: hist });
    expect(r).toMatchObject({ selected: null, held: true });
  });
  it("exhausted/cooldown/auth_required/disabled never receive work even with the top preference", () => {
    for (const s of ["exhausted", "cooldown", "auth_required", "disabled", "draining"] as const) {
      const r = selectSeat({ ...base, role: "planner", seats: [sol(s)], history: [] });
      expect(r.selected).toBeNull();
    }
  });
  it("unknown health: allowed by policy only when no evidence of exhaustion", () => {
    expect(selectSeat({ ...base, role: "planner", seats: [sol("unknown")], history: [] }).selected?.id).toBe("sol-reviewer");
    expect(selectSeat({ ...base, role: "planner", seats: [sol("unknown")], history: [], unknownPolicy: "deny" }).selected).toBeNull();
  });
  it("verifier must differ from planner provider", () => {
    const r = selectSeat({ ...base, role: "verifier", seats: [sol(), claude()], history: [exec("planner", sol())] });
    expect(r.selected?.id).toBe("claude-reviewer");
    expect(selectSeat({ ...base, role: "verifier", seats: [sol()], history: [exec("planner", sol())] }).selected).toBeNull();
  });
  it("unknown provenance fails conservatively for constrained roles (§55) but not for planner", () => {
    expect(selectSeat({ ...base, provenanceKnown: false, role: "reviewer", seats: [claude()], history: [] }).selected).toBeNull();
    expect(selectSeat({ ...base, provenanceKnown: false, role: "planner", seats: [sol()], history: [] }).selected?.id).toBe("sol-reviewer");
  });
  it("replacement implementer: both providers become ineligible reviewers (§75)", () => {
    const hist = [exec("implementer", gemini(), "quota_exhausted"), exec("implementer", sol())];
    const r = selectSeat({ ...base, role: "reviewer", seats: [claude(), gemini(), sol()], history: hist });
    expect(r.selected?.id).toBe("claude-reviewer");
    expect(selectSeat({ ...base, role: "reviewer", seats: [gemini(), sol()], history: hist }).held).toBe(true);
  });
  it("capability, operational and auth are hard gates", () => {
    expect(selectSeat({ ...base, role: "planner", seats: [{ ...sol(), operational: false }], history: [] }).selected).toBeNull();
    expect(selectSeat({ ...base, role: "planner", seats: [{ ...sol(), authenticated: false }], history: [] }).selected).toBeNull();
    expect(selectSeat({ ...base, role: "planner", seats: [{ ...sol(), roles: ["reviewer"] }], history: [] }).selected).toBeNull();
  });
  it("a degraded preferred provider yields to a healthy one; at equal health preference wins (§12, §29)", () => {
    const hist = [exec("implementer", gemini())];
    expect(selectSeat({ ...base, role: "reviewer", seats: [claude("degraded"), sol()], history: hist }).selected?.id).toBe("sol-reviewer");
    expect(selectSeat({ ...base, role: "reviewer", seats: [claude("degraded"), sol("degraded")], history: hist }).selected?.id).toBe("claude-reviewer");
  });
  it("score never overrides a hard constraint", () => {
    const r = selectSeat({ ...base, role: "reviewer", seats: [claude(), sol()], history: [exec("implementer", claude())] });
    expect(r.selected?.id).toBe("sol-reviewer");
  });
  it("decision record is explainable and deterministic (tie by id)", () => {
    const a = seat("b-seat", "openai", "codex", "available", { prefKeys: ["codex:sol"] });
    const b = seat("a-seat", "openai", "codex", "available", { prefKeys: ["codex:sol"] });
    const r = selectSeat({ ...base, role: "planner", seats: [a, b], history: [] });
    expect(r.selected?.id).toBe("a-seat");
    expect(r.candidates.every((c) => c.eligible ? typeof c.score === "number" : typeof c.reason === "string")).toBe(true);
  });
});
