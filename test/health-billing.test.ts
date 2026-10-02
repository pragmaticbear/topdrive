import { describe, expect, it } from "vitest";
import { deriveHealth, applyProbeSuccess, transitionEvent, worst } from "../src/core/provider-health.js";
import { parseAgyUsage, parseAgyCredits } from "../src/core/agy-quota.js";
import { checkLaunch, forbiddenAllowlistNames, sanitizeEnv, tighten, DEFAULT_BILLING_POLICY } from "../src/core/billing-policy.js";

const now = new Date("2026-10-02T16:00:00Z");
// Captured from agy 1.2.14 `-p "/usage" --output-format json` (trimmed).
const AGY_USAGE = JSON.stringify({ command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-09T15:00:14Z" },
    { id: "gemini-5h", window: "5h", remaining_fraction: 0.835075318813324, reset_time: "2026-10-02T16:59:24Z" } ] },
  { name: "Claude and GPT models", buckets: [{ id: "3p-5h", window: "5h", remaining_fraction: 0.02, reset_time: "2026-10-02T21:40:32Z" }] },
] } } });

describe("deriveHealth", () => {
  const d = (signal: never, extra = {}) => deriveHealth({ provider: "google", runtime: "antigravity", signal, now, ...extra });
  it("thresholds: available > degraded(25) > draining(10) > exhausted", () => {
    expect(d({ kind: "quota", remainingPercent: 62, source: "provider_exact" } as never).state).toBe("available");
    expect(d({ kind: "quota", remainingPercent: 25, source: "provider_exact" } as never).state).toBe("degraded");
    expect(d({ kind: "quota", remainingPercent: 10, source: "provider_exact" } as never).state).toBe("draining");
    expect(d({ kind: "quota", remainingPercent: 0, source: "provider_exact" } as never).state).toBe("exhausted");
  });
  it("a warning without a number is DRAINING with no fabricated quota (§14)", () => {
    const h = d({ kind: "warning" } as never);
    expect(h.state).toBe("draining");
    expect(h.quota).toBeUndefined();
    expect(h.signalSource).toBe("provider_warning");
  });
  it("hard limit with reset => cooldown; reprobeDue once reset passed", () => {
    expect(d({ kind: "hard_limit", resetAt: "2026-10-02T18:00:00Z" } as never)).toMatchObject({ state: "cooldown" });
    expect(d({ kind: "hard_limit", resetAt: "2026-10-02T15:00:00Z" } as never)).toMatchObject({ state: "cooldown", reprobeDue: true });
    expect(d({ kind: "hard_limit" } as never).state).toBe("exhausted");
  });
  it("auth, disabled, unknown", () => {
    expect(d({ kind: "auth_expired" } as never).state).toBe("auth_required");
    expect(d({ kind: "none" } as never)).toMatchObject({ state: "unknown", confidence: "unknown" });
    expect(d({ kind: "none" } as never, { disabled: true }).state).toBe("disabled");
  });
  it("only a successful probe lifts cooldown; other states untouched", () => {
    const cool = d({ kind: "hard_limit", resetAt: "2026-10-02T15:00:00Z" } as never);
    expect(applyProbeSuccess(cool, now)).toMatchObject({ state: "available" });
    expect(applyProbeSuccess(cool, now).reprobeDue).toBeUndefined();
    const auth = d({ kind: "auth_expired" } as never);
    expect(applyProbeSuccess(auth, now)).toBe(auth);
  });
  it("transition events + worst()", () => {
    expect(transitionEvent("anthropic", "available", "draining")).toBe("provider.anthropic.draining");
    expect(transitionEvent("anthropic", "draining", "draining")).toBeNull();
    const a = d({ kind: "quota", remainingPercent: 80, source: "provider_exact" } as never);
    const b = d({ kind: "warning" } as never);
    expect(worst(a, b).state).toBe("draining");
  });
});

describe("parseAgyUsage", () => {
  it("takes the tightest Gemini window, exact source", () => {
    expect(parseAgyUsage(AGY_USAGE)).toEqual({ kind: "quota", source: "provider_exact", unit: "5h", remainingPercent: 83.5, resetAt: "2026-10-02T16:59:24Z" });
  });
  it("third-party family reads the other group", () => {
    expect(parseAgyUsage(AGY_USAGE, "third_party")).toMatchObject({ remainingPercent: 2 });
  });
  it("parser failure is UNKNOWN, never a number (§56)", () => {
    expect(parseAgyUsage("not json").kind).toBe("none");
    expect(parseAgyUsage("{}").kind).toBe("none");
    expect(parseAgyUsage(JSON.stringify({ command: { data: { groups: [] } } })).kind).toBe("none");
  });
  it("credits", () => {
    expect(parseAgyCredits(JSON.stringify({ command: { data: { remaining_credits: 0 } } }))).toBe(0);
    expect(parseAgyCredits("garbage")).toBeNull();
  });
});

describe("billing guard", () => {
  it("strips API credentials per provider under subscription_only, keeps subscription token", () => {
    const env = { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" };
    const r = sanitizeEnv("anthropic", env, DEFAULT_BILLING_POLICY);
    expect(r.removed).toEqual(["ANTHROPIC_API_KEY"]);
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" });
    expect(sanitizeEnv("openai", { CODEX_API_KEY: "x", OPENAI_API_KEY: "y" }, DEFAULT_BILLING_POLICY).removed.sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    expect(sanitizeEnv("google", { GEMINI_API_KEY: "x" }, DEFAULT_BILLING_POLICY).removed).toEqual(["GEMINI_API_KEY"]);
  });
  it("unrestricted policy leaves env alone", () => {
    const r = sanitizeEnv("anthropic", { ANTHROPIC_API_KEY: "k" }, { mode: "unrestricted", allowApiFallback: true, allowPaidOverage: true });
    expect(r.removed).toEqual([]);
  });
  it("a seat can only tighten, never loosen toward API usage (§7)", () => {
    expect(tighten(DEFAULT_BILLING_POLICY, { mode: "unrestricted", allowApiFallback: true, allowPaidOverage: true })).toEqual(DEFAULT_BILLING_POLICY);
  });
  it("blocks launch when an API key is allowlisted", () => {
    expect(forbiddenAllowlistNames(["OPENAI_API_KEY", "PATH"], DEFAULT_BILLING_POLICY)).toEqual(["OPENAI_API_KEY"]);
    expect(checkLaunch({ provider: "openai", policy: DEFAULT_BILLING_POLICY, allowlistedEnv: ["OPENAI_API_KEY"] }).ok).toBe(false);
    expect(checkLaunch({ provider: "openai", policy: DEFAULT_BILLING_POLICY, allowlistedEnv: ["OPENAI_BASE_URL"] }).ok).toBe(true);
  });
  it("google: useG1Credits=true blocks; unknown warns; false passes (§79)", () => {
    expect(checkLaunch({ provider: "google", policy: DEFAULT_BILLING_POLICY, g1Credits: true })).toMatchObject({ ok: false });
    expect(checkLaunch({ provider: "google", policy: DEFAULT_BILLING_POLICY, g1Credits: "unknown" })).toMatchObject({ ok: true, warnings: [expect.any(String)] });
    expect(checkLaunch({ provider: "google", policy: DEFAULT_BILLING_POLICY, g1Credits: false })).toMatchObject({ ok: true, warnings: [] });
  });
});
