// topdrive §15-16, §40: ProviderQuotaService. Collect -> normalize -> persist -> emit transitions.
// Readers are injected (agy /usage, existing Claude/Codex ProviderSignals); a failing reader is UNKNOWN, never invented.

import type { TopdriveStore } from "./store.js";
import { deriveHealth, type HealthPolicy, type HealthSignal, type ProviderFamily, type ProviderHealth } from "./provider-health.js";
/** The subset of OpenRig's ProviderSignal (GET /api/provider/signals) that topdrive reads. */
export interface ProviderSignal {
  provider: string; sourceClass: string; window?: string; usedPercent?: number; resetsAt?: string; unknownReason?: string;
}

export interface QuotaReader { provider: ProviderFamily; runtime: string; accountId?: string; read(): Promise<HealthSignal> }

/** Map OpenRig's existing ProviderSignal rows (Claude statusline / Codex reads) onto a topdrive HealthSignal. */
export function signalsToHealthSignal(signals: ProviderSignal[]): HealthSignal {
  const usable = signals.filter((s) => typeof s.usedPercent === "number" && s.sourceClass !== "unknown");
  if (usable.length === 0) return { kind: "none", reason: signals.find((s) => s.unknownReason)?.unknownReason ?? "no usable quota signal" };
  const tight = usable.reduce((a, b) => (b.usedPercent! > a.usedPercent! ? b : a));
  const exact = tight.sourceClass === "provider_structured_read" || tight.sourceClass === "provider_statusline" || tight.sourceClass === "provider_event";
  return {
    kind: "quota", source: exact ? "provider_exact" : "local_heuristic",
    remainingPercent: Math.max(0, Math.min(100, 100 - tight.usedPercent!)),
    ...(tight.resetsAt ? { resetAt: tight.resetsAt } : {}), ...(tight.window ? { unit: String(tight.window) } : {}),
  };
}

export class ProviderQuotaService {
  constructor(private deps: {
    store: TopdriveStore; readers: QuotaReader[]; now?: () => Date; policy?: HealthPolicy;
    /** Called with the §41 event name + new health on every state change. */
    onTransition?: (event: string, health: ProviderHealth, from?: string) => void;
  }) {}

  private now() { return (this.deps.now ?? (() => new Date()))(); }

  private commit(h: ProviderHealth): void {
    const from = this.deps.store.getHealth(h.provider, h.runtime, h.accountId ?? "")?.state;
    const event = this.deps.store.upsertHealth(h);
    if (event) this.deps.onTransition?.(event, h, from);
  }

  async pollOnce(): Promise<void> {
    for (const r of this.deps.readers) {
      let signal: HealthSignal;
      try { signal = await r.read(); } catch (e) { signal = { kind: "none", reason: `reader error: ${(e as Error).message}` }; }
      const now = this.now();
      const fresh = deriveHealth({ provider: r.provider, runtime: r.runtime, ...(r.accountId ? { accountId: r.accountId } : {}), signal, now, ...(this.deps.policy ? { policy: this.deps.policy } : {}) });
      const prev = this.deps.store.getHealth(r.provider, r.runtime, r.accountId ?? "");
      this.commit(this.guardCooldown(prev, fresh, signal, now));
    }
  }

  /** A cooldown/exhausted provider leaves that state only via a successful reading after its reset time. */
  private guardCooldown(prev: ProviderHealth | null, fresh: ProviderHealth, signal: HealthSignal, now: Date): ProviderHealth {
    if (!prev || (prev.state !== "cooldown" && prev.state !== "exhausted")) return fresh;
    const resetAt = prev.quota?.resetAt;
    const resetPending = resetAt !== undefined && Date.parse(resetAt) > now.getTime();
    if (resetPending) return prev;
    if (signal.kind === "quota" && signal.remainingPercent > 0) return fresh;
    return resetAt ? { ...prev, reprobeDue: true, checkedAt: now.toISOString() } : prev;
  }

  // -- reactive reports (hard limit / warning / auth) from provider hooks and error detection --
  reportHardLimit(provider: ProviderFamily, runtime: string, resetAt?: string): void {
    this.commit(deriveHealth({ provider, runtime, signal: { kind: "hard_limit", ...(resetAt ? { resetAt } : {}) }, now: this.now() }));
  }
  reportWarning(provider: ProviderFamily, runtime: string, resetAt?: string): void {
    this.commit(deriveHealth({ provider, runtime, signal: { kind: "warning", ...(resetAt ? { resetAt } : {}) }, now: this.now() }));
  }
  reportAuthExpired(provider: ProviderFamily, runtime: string): void {
    this.commit(deriveHealth({ provider, runtime, signal: { kind: "auth_expired" }, now: this.now() }));
  }
}
