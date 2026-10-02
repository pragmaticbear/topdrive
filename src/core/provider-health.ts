// topdrive §11-14: normalized provider health. Pure. Never fabricates quota precision —
// a provider that only warned has state "draining" with `quota` omitted.

export type ProviderFamily = "openai" | "anthropic" | "google";
export type ProviderHealthState =
  | "available" | "degraded" | "draining" | "exhausted" | "cooldown" | "auth_required" | "disabled" | "unknown";

export type HealthSignal =
  | { kind: "quota"; remainingPercent: number; resetAt?: string; source: "provider_exact" | "local_heuristic"; unit?: string }
  | { kind: "warning"; resetAt?: string }
  | { kind: "hard_limit"; resetAt?: string }
  | { kind: "auth_expired" }
  | { kind: "none"; reason?: string };

export interface ProviderHealth {
  provider: ProviderFamily;
  runtime: string;
  accountId?: string;
  state: ProviderHealthState;
  quota?: { remainingPercent?: number; resetAt?: string; unit?: string };
  signalSource: "provider_exact" | "provider_warning" | "provider_error" | "local_heuristic" | "manual" | "unknown";
  confidence: "exact" | "direct" | "estimated" | "unknown";
  reason?: string;
  /** cooldown whose reset time has passed: the provider must be re-probed before it is eligible (§40). */
  reprobeDue?: boolean;
  checkedAt: string;
}

export interface HealthPolicy {
  degradedThresholdPercent: number;
  drainingThresholdPercent: number;
}
export const DEFAULT_HEALTH_POLICY: HealthPolicy = { degradedThresholdPercent: 25, drainingThresholdPercent: 10 };

export function deriveHealth(input: {
  provider: ProviderFamily; runtime: string; accountId?: string; signal: HealthSignal;
  now: Date; policy?: HealthPolicy; disabled?: boolean;
}): ProviderHealth {
  const { provider, runtime, accountId, signal, now } = input;
  const policy = input.policy ?? DEFAULT_HEALTH_POLICY;
  const base = { provider, runtime, ...(accountId ? { accountId } : {}), checkedAt: now.toISOString() };
  if (input.disabled) return { ...base, state: "disabled", signalSource: "manual", confidence: "exact", reason: "disabled by operator" };

  switch (signal.kind) {
    case "auth_expired":
      return { ...base, state: "auth_required", signalSource: "provider_error", confidence: "direct", reason: "interactive authentication missing or expired" };
    case "hard_limit": {
      const due = signal.resetAt !== undefined && Date.parse(signal.resetAt) <= now.getTime();
      return {
        ...base, state: signal.resetAt ? "cooldown" : "exhausted", signalSource: "provider_error", confidence: "direct",
        ...(signal.resetAt ? { quota: { resetAt: signal.resetAt } } : {}), ...(due ? { reprobeDue: true } : {}), reason: "subscription limit reached",
      };
    }
    case "warning":
      return { ...base, state: "draining", signalSource: "provider_warning", confidence: "direct", ...(signal.resetAt ? { quota: { resetAt: signal.resetAt } } : {}), reason: "provider low-capacity warning" };
    case "quota": {
      const pct = signal.remainingPercent;
      const quota = { remainingPercent: pct, ...(signal.resetAt ? { resetAt: signal.resetAt } : {}), ...(signal.unit ? { unit: signal.unit } : {}) };
      const exact = signal.source === "provider_exact";
      const meta = { signalSource: signal.source, confidence: exact ? "exact" : "estimated" } as const;
      if (pct <= 0) {
        const due = signal.resetAt !== undefined && Date.parse(signal.resetAt) <= now.getTime();
        return { ...base, ...meta, state: signal.resetAt ? "cooldown" : "exhausted", quota, ...(due ? { reprobeDue: true } : {}), reason: "quota exhausted" };
      }
      if (pct <= policy.drainingThresholdPercent) return { ...base, ...meta, state: "draining", quota, reason: `remaining ${pct}% <= draining threshold` };
      if (pct <= policy.degradedThresholdPercent) return { ...base, ...meta, state: "degraded", quota, reason: `remaining ${pct}% <= degraded threshold` };
      return { ...base, ...meta, state: "available", quota };
    }
    default:
      return { ...base, state: "unknown", signalSource: "unknown", confidence: "unknown", reason: signal.reason ?? "quota state could not be determined" };
  }
}

/** A cooldown/exhausted provider becomes available only after a successful probe (§40). */
export function applyProbeSuccess(h: ProviderHealth, now: Date): ProviderHealth {
  if (h.state !== "cooldown" && h.state !== "exhausted") return h;
  const { quota: _q, reprobeDue: _r, ...rest } = h;
  return { ...rest, state: "available", signalSource: "provider_exact", confidence: "direct", reason: "re-probe succeeded", checkedAt: now.toISOString() };
}

/** Worst-first ordering used when several signals describe one provider. */
const SEVERITY: Record<ProviderHealthState, number> = {
  available: 0, unknown: 1, degraded: 2, draining: 3, cooldown: 4, exhausted: 5, auth_required: 6, disabled: 7,
};
export function worst(a: ProviderHealth, b: ProviderHealth): ProviderHealth {
  return SEVERITY[b.state] > SEVERITY[a.state] ? b : a;
}

/** §41 event name for a state transition, or null when nothing changed. */
export function transitionEvent(provider: ProviderFamily, prev: ProviderHealthState | undefined, next: ProviderHealthState): string | null {
  return prev === next ? null : `provider.${provider}.${next}`;
}
