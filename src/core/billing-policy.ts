// topdrive §6-9, §54: subscription-only billing guard. Pure; fails closed.
import type { ProviderFamily } from "./provider-health.js";

export interface BillingPolicy { mode: "subscription_only" | "unrestricted"; allowApiFallback: boolean; allowPaidOverage: boolean }
export const DEFAULT_BILLING_POLICY: BillingPolicy = { mode: "subscription_only", allowApiFallback: false, allowPaidOverage: false };

/** Env vars that switch a harness from the interactive subscription login to API billing. CLAUDE_CODE_OAUTH_TOKEN is a subscription token, deliberately absent. */
export const API_CREDENTIAL_ENV: Record<ProviderFamily, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** Enforced = nothing may fall back to API billing. A seat can only tighten, never loosen (§7). */
export function enforced(policy: BillingPolicy): boolean {
  return policy.mode === "subscription_only" && !policy.allowApiFallback;
}
export function tighten(base: BillingPolicy, seatOverride: Partial<BillingPolicy> = {}): BillingPolicy {
  return {
    mode: base.mode === "subscription_only" || seatOverride.mode === "subscription_only" ? "subscription_only" : "unrestricted",
    allowApiFallback: base.allowApiFallback && (seatOverride.allowApiFallback ?? true),
    allowPaidOverage: base.allowPaidOverage && (seatOverride.allowPaidOverage ?? true),
  };
}

export function sanitizeEnv(
  provider: ProviderFamily, env: Record<string, string | undefined>, policy: BillingPolicy, extraNames: readonly string[] = [],
): { env: Record<string, string | undefined>; removed: string[] } {
  if (!enforced(policy)) return { env, removed: [] };
  const names = new Set([...API_CREDENTIAL_ENV[provider], ...extraNames]);
  const out = { ...env };
  const removed: string[] = [];
  for (const n of names) if (n in out && out[n] !== undefined) { delete out[n]; removed.push(n); }
  return { env: out, removed };
}

/** Operator-allowlisted names that would hand a seat an API credential. */
export function forbiddenAllowlistNames(names: readonly string[], policy: BillingPolicy): string[] {
  if (!enforced(policy)) return [];
  const bad = new Set(Object.values(API_CREDENTIAL_ENV).flat());
  return names.filter((n) => bad.has(n));
}

export type G1State = boolean | "unknown";
export interface BillingCheck { ok: boolean; blockers: string[]; warnings: string[] }

/** §9/§45: launch gate. `g1Credits` is only meaningful for google. Unknown => warn (setting location unverified), never silently pass as safe. */
export function checkLaunch(input: { provider: ProviderFamily; policy: BillingPolicy; allowlistedEnv?: readonly string[]; g1Credits?: G1State }): BillingCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const bad = forbiddenAllowlistNames(input.allowlistedEnv ?? [], input.policy);
  if (bad.length) blockers.push(`API credential env allowlisted for a managed seat: ${bad.join(", ")} (subscription_only)`);
  if (input.provider === "google" && !input.policy.allowPaidOverage) {
    if (input.g1Credits === true) blockers.push("useG1Credits=true while allow_paid_overage=false");
    else if (input.g1Credits === "unknown" || input.g1Credits === undefined) warnings.push("useG1Credits state could not be verified");
  }
  return { ok: blockers.length === 0, blockers, warnings };
}
