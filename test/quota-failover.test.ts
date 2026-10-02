import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openTopdriveDb, TopdriveStore } from "../src/core/store.js";
import { ProviderQuotaService, signalsToHealthSignal, type ProviderSignal } from "../src/core/quota-service.js";
import { FailoverReactor, type RoutableSeat } from "../src/core/failover-reactor.js";
import type { HealthSignal, ProviderHealth } from "../src/core/provider-health.js";

function mk() {
  const db: Database.Database = openTopdriveDb(":memory:");
  return new TopdriveStore(db);
}
const T = (s: string) => new Date(`2026-10-02T${s}:00Z`);

describe("signalsToHealthSignal (existing ProviderSignal -> topdrive)", () => {
  const sig = (p: Partial<ProviderSignal>): ProviderSignal => ({ provider: "claude", sourceClass: "provider_statusline", authority: "device_local", asOf: "t", automationUse: "advisory_only", ...p });
  it("uses the tightest window; 100% used is zero remaining", () => {
    const r = signalsToHealthSignal([sig({ window: "five_hour", usedPercent: 40 }), sig({ window: "weekly", usedPercent: 91, resetsAt: "2026-10-05T00:00:00Z" })]);
    expect(r).toEqual({ kind: "quota", remainingPercent: 9, resetAt: "2026-10-05T00:00:00Z", source: "provider_exact", unit: "weekly" });
    expect(signalsToHealthSignal([sig({ usedPercent: 100 })])).toMatchObject({ remainingPercent: 0 });
  });
  it("unknown/absent readings are UNKNOWN, never zero or full", () => {
    expect(signalsToHealthSignal([])).toMatchObject({ kind: "none" });
    expect(signalsToHealthSignal([sig({ sourceClass: "unknown", authority: "unknown", unknownReason: "no statusline" })])).toMatchObject({ kind: "none" });
  });
  it("heuristic sources are labelled estimated, not exact", () => {
    expect(signalsToHealthSignal([sig({ sourceClass: "local_usage_attribution", usedPercent: 50 })])).toMatchObject({ source: "local_heuristic" });
  });
});

describe("ProviderQuotaService", () => {
  const reader = (signal: () => HealthSignal | Promise<HealthSignal>) => ({ provider: "anthropic" as const, runtime: "claude", read: async () => signal() });

  it("polls readers, persists health, reports transitions once", async () => {
    const store = mk(); let sig: HealthSignal = { kind: "quota", remainingPercent: 80, source: "provider_exact" };
    const events: string[] = [];
    const svc = new ProviderQuotaService({ store, readers: [reader(() => sig)], now: () => T("10:00"), onTransition: (e) => events.push(e) });
    await svc.pollOnce(); await svc.pollOnce();
    sig = { kind: "quota", remainingPercent: 5, source: "provider_exact" };
    await svc.pollOnce();
    expect(events).toEqual(["provider.anthropic.available", "provider.anthropic.draining"]);
  });
  it("a throwing reader yields UNKNOWN with a reason, not a crash or a fabricated value", async () => {
    const store = mk();
    const svc = new ProviderQuotaService({ store, readers: [reader(() => { throw new Error("boom"); })], now: () => T("10:00") });
    await svc.pollOnce();
    expect(store.getHealth("anthropic", "claude")).toMatchObject({ state: "unknown", confidence: "unknown" });
  });
  it("a stale 'fine' reading cannot lift a cooldown before its reset time; after reset it needs a successful probe (§40)", async () => {
    const store = mk(); let now = T("10:00");
    const svc = new ProviderQuotaService({ store, readers: [reader(() => ({ kind: "quota", remainingPercent: 90, source: "provider_exact" }))], now: () => now });
    svc.reportHardLimit("anthropic", "claude", "2026-10-02T14:00:00Z");
    await svc.pollOnce();
    expect(store.getHealth("anthropic", "claude")!.state).toBe("cooldown");
    now = T("14:05");
    await svc.pollOnce();
    expect(store.getHealth("anthropic", "claude")!.state).toBe("available");
  });
  it("after reset, an unreadable probe keeps cooldown flagged reprobeDue (machine slept through reset, §81)", async () => {
    const store = mk(); let now = T("10:00");
    const svc = new ProviderQuotaService({ store, readers: [reader(() => ({ kind: "none" }))], now: () => now });
    svc.reportHardLimit("anthropic", "claude", "2026-10-02T14:00:00Z");
    now = T("15:00");
    await svc.pollOnce();
    expect(store.getHealth("anthropic", "claude")).toMatchObject({ state: "cooldown", reprobeDue: true });
  });
  it("reportWarning => draining without a fabricated percentage", () => {
    const store = mk();
    new ProviderQuotaService({ store, readers: [], now: () => T("10:00") }).reportWarning("anthropic", "claude");
    const h = store.getHealth("anthropic", "claude") as ProviderHealth;
    expect(h.state).toBe("draining");
    expect(h.quota).toBeUndefined();
  });
});

describe("FailoverReactor", () => {
  const seat = (id: string, provider: RoutableSeat["provider"], state: RoutableSeat["healthState"]): RoutableSeat => ({ id, session: `${id}@rig`, provider, runtime: id, prefKeys: [id], healthState: state, operational: true, authenticated: true });
  const work = [{ qitemId: "q1", session: "claude@rig", workflowInstanceId: "wf", stepId: "review", role: "reviewer" as const }];

  function setup(over: { busy?: boolean; state?: RoutableSeat["healthState"] } = {}) {
    const autoHandoff = vi.fn(async () => ({ action: "handoff" as const }) as never);
    const r = new FailoverReactor({
      listActiveWork: (p) => (p === "anthropic" ? work : []),
      listSeats: () => [seat("claude", "anthropic", over.state ?? "draining"), seat("sol", "openai", "available")],
      isSeatBusy: () => over.busy ?? false,
      handoff: autoHandoff as never,
    });
    return { r, autoHandoff };
  }
  it("hard limit hands off immediately even if the seat is mid-turn", async () => {
    const { r, autoHandoff } = setup({ busy: true, state: "cooldown" });
    const out = await r.react("anthropic", "cooldown");
    expect(autoHandoff).toHaveBeenCalledTimes(1);
    expect(autoHandoff.mock.calls[0]![0]).toMatchObject({ qitemId: "q1", reason: "provider_cooldown" });
    expect(out.deferred).toBe(0);
  });
  it("soft drain waits for the safe boundary, then hands off (§33-34)", async () => {
    const busy = setup({ busy: true });
    expect(await busy.r.react("anthropic", "draining")).toMatchObject({ handedOff: 0, deferred: 1 });
    expect(busy.autoHandoff).not.toHaveBeenCalled();
    const idle = setup({ busy: false });
    expect(await idle.r.react("anthropic", "draining")).toMatchObject({ handedOff: 1, deferred: 0 });
  });
  it("healthy/degraded states trigger nothing; other providers' work is untouched", async () => {
    const { r, autoHandoff } = setup();
    await r.react("anthropic", "available"); await r.react("anthropic", "degraded"); await r.react("google", "cooldown");
    expect(autoHandoff).not.toHaveBeenCalled();
  });
  it("a failing handoff for one item does not stop the rest and is reported", async () => {
    const r = new FailoverReactor({
      listActiveWork: () => [...work, { ...work[0]!, qitemId: "q2" }], listSeats: () => [], isSeatBusy: () => false,
      handoff: (async (i: { qitemId: string }) => { if (i.qitemId === "q1") throw new Error("nope"); return { action: "hold" }; }) as never,
    });
    expect(await r.react("anthropic", "exhausted")).toMatchObject({ failed: 1, held: 1 });
  });
});
