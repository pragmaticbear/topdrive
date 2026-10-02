// topdrive: pure human renderers for `topdrive quota`, `topdrive explain`, `topdrive roles`.
// Unknown stays unknown: no quota number is ever invented for display (spec §14).

interface Health { provider: string; runtime: string; state: string; quota?: { remainingPercent?: number; resetAt?: string }; signalSource: string; reprobeDue?: boolean }
interface Candidate { seat: string; eligible: boolean; reason?: string; score?: number }
interface Explain { instanceId: string; role: string; provenanceKnown: boolean; selection: { selected: { id: string } | null; held: boolean; candidates: Candidate[] } }
interface Roles {
  instanceId: string; provenanceKnown: boolean;
  history: Array<{ stepId: string; role: string; seatId: string; provider: string; runtime: string; outcome?: string }>;
  decisions: Array<{ role: string; selectedSeat: string | null; held: boolean; reason: string | null }>;
}

const pad = (s: string, n: number) => s.padEnd(n);

export function renderQuota(rows: Health[]): string {
  const lines = [`${pad("PROVIDER", 11)}${pad("RUNTIME", 13)}${pad("STATE", 15)}${pad("QUOTA", 9)}${pad("RESET", 26)}SOURCE`];
  for (const h of rows) {
    const pct = h.quota?.remainingPercent;
    lines.push(
      pad(h.provider, 11) + pad(h.runtime, 13) + pad(h.state.toUpperCase(), 15) +
      pad(pct === undefined ? "unknown" : `${pct}%`, 9) + pad(h.quota?.resetAt ?? "--", 26) + h.signalSource + (h.reprobeDue ? "  (re-probe due)" : ""),
    );
  }
  return lines.join("\n");
}

export function renderExplain(e: Explain): string {
  const out = [`ROLE: ${e.role}  (workflow ${e.instanceId})`];
  if (!e.provenanceKnown) out.push("! role provenance UNKNOWN: independence-constrained roles fail closed");
  out.push("");
  for (const c of e.selection.candidates) {
    out.push(c.seat, c.eligible ? `  ✓ eligible (score ${c.score})` : `  ✗ ${c.reason}`);
  }
  out.push("", e.selection.selected ? `SELECTED: ${e.selection.selected.id}` : "HELD: no eligible seat (constraints are never weakened to keep moving)");
  return out.join("\n");
}

export function renderRoles(r: Roles): string {
  const out = [`WORKFLOW ${r.instanceId}`];
  if (!r.provenanceKnown) out.push("! provenance UNKNOWN: a past actor has no known seat; strict independence fails closed");
  for (const h of r.history) out.push(`${pad(h.role, 13)}${pad(h.seatId, 26)}${pad(h.provider, 11)}${h.outcome ?? ""}`);
  if (r.decisions.length) out.push("", "ROUTING DECISIONS");
  for (const d of r.decisions) out.push(`${pad(d.role, 13)}${d.held ? "HELD" : `-> ${d.selectedSeat}`}  (${d.reason ?? ""})`);
  return out.join("\n");
}
