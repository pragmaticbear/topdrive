// topdrive §23-30, §55: role eligibility + selection. PURE (no db/clock/random) — same facts in, same seat out.
// Hard constraints are evaluated before scores; a score can never override one.

import type { ProviderFamily, ProviderHealthState } from "./provider-health.js";

export type Role = "planner" | "verifier" | "implementer" | "reviewer" | "approver";

export interface SeatFacts {
  id: string;
  provider: ProviderFamily;
  runtime: string;
  /** Matches role-preference tokens, e.g. ["codex", "codex:sol"]. */
  prefKeys: string[];
  healthState: ProviderHealthState;
  remainingPercent?: number;
  operational: boolean;
  authenticated: boolean;
  /** Roles this runtime can perform; absent = all. */
  roles?: Role[];
  /** The seat currently owning the work item (continuation affinity). */
  currentOwner?: boolean;
}

export interface RoleExecution {
  stepId: string;
  role: string;
  seatId: string;
  provider: ProviderFamily;
  runtime: string;
  model?: string;
  outcome?: string;
}

export type RolePrefs = Record<Role, string[]>;
export const DEFAULT_ROLE_PREFS: RolePrefs = {
  planner: ["codex:sol", "claude", "antigravity"],
  verifier: ["claude", "codex:sol", "antigravity"],
  implementer: ["antigravity", "codex:sol", "claude"],
  reviewer: ["claude", "codex:sol", "antigravity"],
  approver: ["codex:sol", "claude", "antigravity"],
};

/** role -> roles whose performing provider it must differ from (§25). */
export type Constraints = Partial<Record<Role, Role[]>>;
export const DEFAULT_CONSTRAINTS: Constraints = {
  verifier: ["planner"],
  reviewer: ["implementer"],
  approver: ["implementer"],
};

export interface Candidate { seat: string; eligible: boolean; reason?: string; score?: number }
export interface SelectionResult {
  role: Role;
  selected: SeatFacts | null;
  held: boolean;
  candidates: Candidate[];
}

const BLOCKING_STATES: ReadonlySet<ProviderHealthState> = new Set(["draining", "exhausted", "cooldown", "auth_required", "disabled"]);

export function selectSeat(input: {
  role: Role; seats: SeatFacts[]; history: RoleExecution[]; prefs: RolePrefs; constraints: Constraints;
  unknownPolicy: "allow" | "deny"; /** false => role provenance could not be determined (§55). */ provenanceKnown: boolean;
}): SelectionResult {
  const { role, history, prefs, constraints } = input;
  const mustDiffer = constraints[role] ?? [];
  const forbiddenProviders = new Map<ProviderFamily, string>();
  for (const e of history) if (mustDiffer.includes(e.role as Role)) forbiddenProviders.set(e.provider, e.role);
  const touched = new Set(history.map((e) => e.seatId));
  const order = [...prefs[role]];

  const candidates: Candidate[] = [];
  const scored: Array<{ seat: SeatFacts; score: number }> = [];
  for (const seat of [...input.seats].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const reject = (reason: string) => candidates.push({ seat: seat.id, eligible: false, reason });
    if (!seat.operational) { reject("seat_not_operational"); continue; }
    if (!seat.authenticated) { reject("provider_not_authenticated"); continue; }
    if (BLOCKING_STATES.has(seat.healthState)) { reject(`provider_${seat.healthState}`); continue; }
    if (seat.healthState === "unknown" && input.unknownPolicy === "deny") { reject("provider_unknown_denied"); continue; }
    if (seat.roles && !seat.roles.includes(role)) { reject(`role_unsupported:${role}`); continue; }
    if (mustDiffer.length) {
      if (!input.provenanceKnown) { reject("role_provenance_unknown"); continue; }
      const prior = forbiddenProviders.get(seat.provider);
      if (prior) { reject(`performed_role:${prior}`); continue; }
    }
    // "codex:sol" is satisfied by that exact key, or by "codex:*" (seat model unknown: do not penalise what we cannot see)
    const rank = order.findIndex((k) => seat.prefKeys.includes(k) || (k.includes(":") && seat.prefKeys.includes(`${k.split(":")[0]}:*`)));
    const score =
      (rank < 0 ? 0 : 100 - rank * 10) +
      ({ available: 40, degraded: 20, unknown: 10 } as Partial<Record<ProviderHealthState, number>>)[seat.healthState]! +
      (touched.has(seat.id) ? 20 : 0) +
      (seat.currentOwner ? 15 : 0) +
      Math.round(((seat.remainingPercent ?? 0) / 100) * 15);
    candidates.push({ seat: seat.id, eligible: true, score });
    scored.push({ seat, score });
  }
  // Highest score; deterministic tie-break on seat id (candidates already id-sorted, sort is stable).
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0]?.seat ?? null;
  return { role, selected, held: selected === null, candidates };
}
