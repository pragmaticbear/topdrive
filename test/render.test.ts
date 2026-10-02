import { describe, expect, it } from "vitest";
import { renderQuota, renderExplain, renderRoles } from "../src/render.js";

describe("topdrive CLI renderers", () => {
  it("quota table: unknown quota is shown as 'unknown', never a number (§14)", () => {
    const out = renderQuota([
      { provider: "anthropic", runtime: "claude-code", state: "draining", signalSource: "provider_warning", confidence: "direct", checkedAt: "t" },
      { provider: "google", runtime: "antigravity", state: "available", quota: { remainingPercent: 83.5, resetAt: "2026-10-02T16:59:24Z", unit: "5h" }, signalSource: "provider_exact", confidence: "exact", checkedAt: "t" },
    ] as never);
    expect(out).toContain("DRAINING");
    expect(out).toMatch(/anthropic\s+claude-code\s+DRAINING\s+unknown\s+--\s+provider_warning/);
    expect(out).toMatch(/google\s+antigravity\s+AVAILABLE\s+83.5%\s+2026-10-02T16:59:24Z\s+provider_exact/);
  });
  it("explain shows reasons for rejected seats and the selection / HELD", () => {
    const sel = { role: "reviewer", selected: null, held: true, candidates: [{ seat: "a@r", eligible: false, reason: "provider_cooldown" }, { seat: "b@r", eligible: false, reason: "performed_role:implementer" }] };
    const out = renderExplain({ instanceId: "wf", role: "reviewer", provenanceKnown: true, selection: sel } as never);
    expect(out).toContain("✗ provider_cooldown");
    expect(out).toContain("✗ performed_role:implementer");
    expect(out).toContain("HELD");
    const ok = renderExplain({ instanceId: "wf", role: "reviewer", provenanceKnown: true, selection: { ...sel, held: false, selected: { id: "c@r" }, candidates: [{ seat: "c@r", eligible: true, score: 142 }] } } as never);
    expect(ok).toContain("✓ eligible (score 142)");
    expect(ok).toContain("SELECTED: c@r");
  });
  it("roles lists who performed each role and warns when provenance is unknown", () => {
    const out = renderRoles({ instanceId: "wf", provenanceKnown: false, history: [{ stepId: "plan", role: "planner", seatId: "sol@r", provider: "openai", runtime: "codex", outcome: "completed" }], decisions: [{ role: "reviewer", selectedSeat: null, held: true, reason: "quota_exhausted" }] } as never);
    expect(out).toMatch(/planner\s+sol@r\s+openai/);
    expect(out).toContain("provenance UNKNOWN");
    expect(out).toContain("HELD");
  });
});
