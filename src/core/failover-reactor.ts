// topdrive §33-35: turn a provider health transition into handoffs of the work its seats hold.
//  - draining (soft): wait for the seat's current turn to finish (safe boundary), then hand off.
//  - exhausted/cooldown/auth_required/disabled (hard): hand off immediately; the dead provider is never consulted.
// Retries for HELD work happen when a provider becomes available again (§40, §77).

import type { ProviderFamily, ProviderHealthState } from "./provider-health.js";
import type { Role, SeatFacts } from "./eligibility.js";

export interface RoutableSeat extends SeatFacts { session: string }
/** What a handoff attempt did: moved the packet to an eligible seat, or held it (no eligible seat). */
export interface HandoffOutcome { action: "handoff" | "hold" }

export interface ActiveWork { qitemId: string; session: string; workflowInstanceId: string; stepId: string; role: Role }
export interface ReactorHandoffInput { qitemId: string; fromSession: string; workflowInstanceId: string; stepId: string; role: Role; seats: RoutableSeat[]; reason: string; evidenceRefs: string[] }
export interface ReactionSummary { handedOff: number; held: number; deferred: number; failed: number }

const HARD: ReadonlySet<ProviderHealthState> = new Set(["exhausted", "cooldown", "auth_required", "disabled"]);

export class FailoverReactor {
  constructor(private deps: {
    listActiveWork: (provider: ProviderFamily) => ActiveWork[];
    /** Work parked by a prior hold (blocked on provider-capacity); retried when capacity returns. */
    listHeldWork?: () => ActiveWork[];
    listSeats: () => RoutableSeat[];
    isSeatBusy: (session: string) => boolean;
    handoff: (input: ReactorHandoffInput) => Promise<HandoffOutcome>;
    collectEvidence?: (work: ActiveWork) => Promise<string[]>;
    log?: (msg: string) => void;
  }) {}

  async react(provider: ProviderFamily, state: ProviderHealthState): Promise<ReactionSummary> {
    const out: ReactionSummary = { handedOff: 0, held: 0, deferred: 0, failed: 0 };
    if (state === "available") return this.retryHeld(out);
    const soft = state === "draining";
    if (!soft && !HARD.has(state)) return out;
    for (const w of this.deps.listActiveWork(provider)) {
      if (soft && this.deps.isSeatBusy(w.session)) { out.deferred++; continue; }
      await this.move(w, `provider_${state}`, out);
    }
    return out;
  }

  async retryHeld(out: ReactionSummary = { handedOff: 0, held: 0, deferred: 0, failed: 0 }): Promise<ReactionSummary> {
    for (const w of this.deps.listHeldWork?.() ?? []) await this.move(w, "capacity_restored", out);
    return out;
  }

  /** Hand one packet off right now (assignment guard path). True when it moved or was held. */
  async handoffNow(w: ActiveWork, reason: string): Promise<boolean> {
    const out: ReactionSummary = { handedOff: 0, held: 0, deferred: 0, failed: 0 };
    await this.move(w, reason, out);
    if (out.failed) throw new Error(`handoff failed for ${w.qitemId}`);
    return out.handedOff + out.held > 0;
  }

  private async move(w: ActiveWork, reason: string, out: ReactionSummary): Promise<void> {
    try {
      const evidenceRefs = (await this.deps.collectEvidence?.(w)) ?? [];
      const r = await this.deps.handoff({ qitemId: w.qitemId, fromSession: w.session, workflowInstanceId: w.workflowInstanceId, stepId: w.stepId, role: w.role, seats: this.deps.listSeats(), reason, evidenceRefs });
      if (r.action === "handoff") out.handedOff++; else out.held++;
    } catch (e) {
      out.failed++;
      this.deps.log?.(`failover handoff failed for ${w.qitemId}: ${(e as Error).message}`);
    }
  }
}
