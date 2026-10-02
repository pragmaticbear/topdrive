import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openTopdriveDb, TopdriveStore } from "../src/core/store.js";
import { Supervisor, type SupervisorDeps } from "../src/supervisor.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { ProviderSignal } from "../src/core/quota-service.js";
import { FakeOpenRig } from "./fake-openrig.js";

const RESET = "2026-10-02T22:00:00.000Z";
const claudeAt = (usedPercent: number): ProviderSignal[] => [{ provider: "claude", sourceClass: "provider_statusline", window: "5h", usedPercent }];

/** Sol (codex) planner, Claude verifier, two Gemini (agy) seats. */
function rig(): FakeOpenRig {
  return new FakeOpenRig()
    .seat("plan-sol@rig", "codex").seat("verify-claude@rig", "claude-code")
    .seat("impl-gem@rig", "antigravity").seat("other-gem@rig", "antigravity");
}

describe("Supervisor over the OpenRig API", () => {
  let db: Database.Database;
  let store: TopdriveStore;
  let or: FakeOpenRig;
  let now: Date;
  const make = (extra: Partial<SupervisorDeps> = {}) => new Supervisor({
    openrig: or, store, now: () => now, agyExec: async () => { throw new Error("agy absent"); }, ...extra,
  });
  const cool = (provider: "anthropic" | "openai" | "google", runtime: string, resetAt?: string) =>
    store.upsertHealth({ provider, runtime, state: "cooldown", signalSource: "provider_error", confidence: "direct", ...(resetAt ? { quota: { resetAt } } : {}), checkedAt: now.toISOString() });
  const drain = (provider: "anthropic" | "openai" | "google", runtime: string) =>
    store.upsertHealth({ provider, runtime, state: "draining", signalSource: "provider_warning", confidence: "direct", checkedAt: now.toISOString() });

  beforeEach(() => {
    db = openTopdriveDb(":memory:");
    store = new TopdriveStore(db);
    or = rig();
    now = new Date("2026-10-02T16:00:00Z");
  });

  describe("role history and explain (§25-§29)", () => {
    it("derives history from the workflow trail, mapping actor seats to providers", async () => {
      or.workflow("wf", [["plan", "planner", "plan-sol@rig"], ["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      const h = await make().history("wf", or.seats);
      expect(h.provenanceKnown).toBe(true);
      expect(h.history.map((e) => [e.role, e.provider])).toEqual([["planner", "openai"], ["implementer", "google"]]);
    });
    it("a trail actor whose seat no longer exists (or isn't an agent) makes provenance UNKNOWN (§55)", async () => {
      or.workflow("wf", [["implement", "implementer", "ghost@rig"]], "review", "verify-claude@rig");
      expect((await make().history("wf", or.seats)).provenanceKnown).toBe(false);
    });
    it("Claude preferred reviewer when healthy; every Gemini seat is rejected as the implementer's provider", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      const r = await make().explainRoute("wf", "reviewer");
      expect(r.selection.selected?.id).toBe("verify-claude@rig");
      expect(r.selection.candidates.find((c) => c.seat === "other-gem@rig")).toMatchObject({ eligible: false, reason: "performed_role:implementer" });
    });
    it("Claude in cooldown => Sol reviews (§74); Claude and Sol both out => HELD, never Gemini-reviews-Gemini (§76)", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code");
      expect((await make().explainRoute("wf", "reviewer")).selection.selected?.id).toBe("plan-sol@rig");
      cool("openai", "codex");
      const held = await make().explainRoute("wf", "reviewer");
      expect(held.selection.selected).toBeNull();
      expect(held.selection.held).toBe(true);
    });
    it("seat_runtimes lets a seat with a generic runtime (e.g. terminal) count as a known provider", async () => {
      or.seat("wrapped@rig", "terminal");
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code"); cool("openai", "codex");
      const plain = await make().explainRoute("wf", "reviewer");
      expect(plain.selection.candidates.map((c) => c.seat)).not.toContain("wrapped@rig");
      const withOverride = await make({ config: { ...DEFAULT_CONFIG, seatRuntimes: { "wrapped@rig": "claude-code" } } }).explainRoute("wf", "reviewer");
      expect(withOverride.selection.candidates.find((c) => c.seat === "wrapped@rig")).toMatchObject({ eligible: false, reason: "provider_cooldown" });
    });
  });

  describe("quota", () => {
    it("unreadable agy => google UNKNOWN, never a number (§82)", async () => {
      await make().pollQuota();
      expect(store.getHealth("google", "antigravity")).toMatchObject({ state: "unknown" });
      expect(store.getHealth("google", "antigravity")?.quota).toBeUndefined();
    });
    it("Claude health comes from OpenRig's provider signals; Codex from its session-log reader (§18-19)", async () => {
      or.signals = claudeAt(95);
      await make({ readCodexQuota: async () => ({ kind: "quota", remainingPercent: 0, resetAt: "2026-10-09T00:00:00Z", source: "provider_exact" }) }).pollQuota();
      expect(store.getHealth("anthropic", "claude-code")).toMatchObject({ state: "draining", quota: { remainingPercent: 5 } });
      expect(store.getHealth("openai", "codex")?.state).toBe("cooldown");
    });
  });

  describe("failover (§33-§39)", () => {
    it("a cooled-down provider's pending packet is routed to an independent seat; history + decision recorded", async () => {
      const q = or.workflow("wf", [["plan", "planner", "plan-sol@rig"], ["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code");
      const sup = make();
      expect(await sup.reactToHealth()).toMatchObject({ handedOff: 1, held: 0 });
      expect(or.packet("wf").ownerSession).toBe("plan-sol@rig");
      expect(or.calls[0]).toMatch(new RegExp(`^route ${q} -> plan-sol@rig \\(topdrive provider_cooldown`));
      expect(store.listDecisions("wf")[0]).toMatchObject({ role: "reviewer", selectedSeat: "plan-sol@rig", held: false, qitemId: or.packet("wf").packetId });
      expect(store.listRoleExecutions("wf").map((e) => [e.role, e.seatId])).toEqual([["reviewer", "plan-sol@rig"]]);
    });
    it("soft drain waits while the seat is mid-turn, then moves at the safe boundary (§33-34)", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig", "in-progress");
      drain("anthropic", "claude-code");
      const sup = make();
      expect(await sup.reactToHealth()).toMatchObject({ deferred: 1, handedOff: 0 });
      expect(or.calls).toEqual([]);
      or.packet("wf").queueState = "pending";
      expect(await sup.reactToHealth()).toMatchObject({ handedOff: 1 });
    });
    it("no independent reviewer => HELD as blocked provider-capacity:reviewer, decision persisted, not re-blocked each pass (§39, §76)", async () => {
      const q = or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code"); cool("openai", "codex");
      const sup = make();
      expect(await sup.reactToHealth()).toMatchObject({ held: 1 });
      expect(or.packet("wf")).toMatchObject({ packetId: q, queueState: "blocked", blockedOn: "provider-capacity:reviewer" });
      expect(store.listDecisions("wf")[0]).toMatchObject({ held: true, selectedSeat: null });
      await sup.reactToHealth(true);
      expect(or.calls.filter((c) => c.startsWith("block"))).toHaveLength(1);
    });
    it("a held packet moves once an independent seat recovers, and is released on its new seat (stock route keeps it blocked) (§77)", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code", RESET); cool("openai", "codex");
      const sup = make();
      await sup.reactToHealth();
      store.upsertHealth({ provider: "openai", runtime: "codex", state: "available", signalSource: "provider_exact", confidence: "exact", checkedAt: now.toISOString() });
      await sup.reactToHealth(true);
      expect(or.packet("wf")).toMatchObject({ ownerSession: "plan-sol@rig", queueState: "pending", blockedOn: null });
    });
    it("a held packet whose OWN seat's provider recovers is released in place, not routed", async () => {
      const q = or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code", RESET); cool("openai", "codex");
      const sup = make();
      await sup.reactToHealth();
      store.upsertHealth({ provider: "anthropic", runtime: "claude-code", state: "available", signalSource: "provider_exact", confidence: "exact", checkedAt: now.toISOString() });
      await sup.reactToHealth(true);
      expect(or.packet("wf")).toMatchObject({ packetId: q, ownerSession: "verify-claude@rig", queueState: "pending" });
      expect(or.calls.some((c) => c.startsWith("route"))).toBe(false);
    });
    it("unknown role provenance is never assumed independent: the constrained step is held", async () => {
      or.workflow("wf", [["implement", "implementer", "ghost@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code");
      expect(await make().reactToHealth()).toMatchObject({ held: 1, handedOff: 0 });
    });
    it("a step topdrive can't classify (no role in the spec) is never moved", async () => {
      or.roles = {};
      or.workflow("wf", [], "review", "verify-claude@rig");
      cool("anthropic", "claude-code");
      expect(await make().reactToHealth()).toMatchObject({ handedOff: 0, held: 0 });
      expect(or.calls).toEqual([]);
    });
    it("a failed route for one packet is reported, records nothing, and doesn't stop the others", async () => {
      const bad = or.workflow("wf1", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      or.workflow("wf2", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      or.failRouteFor.add(bad);
      cool("anthropic", "claude-code");
      expect(await make().reactToHealth()).toMatchObject({ handedOff: 1, failed: 1 });
      expect(store.listDecisions("wf1")).toEqual([]);
      expect(or.packet("wf2").ownerSession).toBe("plan-sol@rig");
    });
    it("a handoff closes the departing seat's open role execution", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      store.recordRoleExecution({ workflowInstanceId: "wf", stepId: "review", role: "reviewer", seatId: "verify-claude@rig", runtime: "claude-code", provider: "anthropic", startedAt: now.toISOString() });
      cool("anthropic", "claude-code");
      await make().reactToHealth();
      expect(store.listRoleExecutions("wf").find((e) => e.seatId === "verify-claude@rig")).toMatchObject({ outcome: "handoff:provider_cooldown" });
    });
    it("the route reason carries the departing seat's git evidence; git failure never blocks the move (§36, §48)", async () => {
      or.seats.find((s) => s.session === "verify-claude@rig")!.cwd = "/repo";
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      cool("anthropic", "claude-code");
      const git = async (_cwd: string, args: string[]) => (args.includes("--abbrev-ref") ? "main\n" : args.includes("HEAD") ? "abc1234\n" : " M src/a.ts\n");
      await make({ gitExec: git }).reactToHealth();
      expect(or.calls[0]).toContain("git:main@abc1234");
      or = rig(); or.seats.find((s) => s.session === "verify-claude@rig")!.cwd = "/repo";
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      expect(await make({ gitExec: async () => { throw new Error("not a repo"); } }).reactToHealth()).toMatchObject({ handedOff: 1 });
    });
  });

  describe("reactive limit scan (§35, §74)", () => {
    it("a seat showing its provider's limit banner puts that provider in cooldown with the parsed reset, once", async () => {
      let captures = 0;
      const sup = make({ capturePane: async (s) => { captures++; return s === "verify-claude@rig" ? "…\n⚠ Usage limit reached · limit resets 6pm (America/New_York)" : "$ "; } });
      expect(await sup.scanSeatsForLimits(or.seats)).toBe(1);
      expect(store.getHealth("anthropic", "claude-code")).toMatchObject({ state: "cooldown" });
      const before = captures;
      expect(await sup.scanSeatsForLimits(or.seats)).toBe(0);
      expect(captures - before).toBe(or.seats.length - 1); // the cooled seat is not re-captured
    });
    it("a seat that hits its limit mid-review is failed over on the same tick (§74)", async () => {
      or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      await make({ capturePane: async (s) => (s === "verify-claude@rig" ? "⚠ Usage limit reached · limit resets 6pm (America/New_York)" : "") }).tick();
      expect(or.packet("wf").ownerSession).toBe("plan-sol@rig");
    });
  });

  describe("assignment guard: independence on normal assignment, not only on failover (§25, §49)", () => {
    it("a verify packet owned by the planner's provider is re-routed to an independent seat", async () => {
      or.workflow("wf", [["plan", "planner", "impl-gem@rig"]], "verify", "other-gem@rig");
      expect(await make().enforceAssignments()).toBe(1);
      expect(or.packet("wf").ownerSession).toBe("verify-claude@rig");
    });
    it("an eligible owner is left alone even if a more-preferred seat exists; in-progress work is never yanked", async () => {
      or.workflow("wf", [["plan", "planner", "impl-gem@rig"]], "verify", "plan-sol@rig");
      or.workflow("wf2", [["plan", "planner", "impl-gem@rig"]], "verify", "other-gem@rig", "in-progress");
      expect(await make().enforceAssignments()).toBe(0);
      expect(or.calls).toEqual([]);
    });
    it("no independent seat => HELD, not left with the violating owner", async () => {
      or.workflow("wf", [["plan", "planner", "impl-gem@rig"]], "verify", "other-gem@rig");
      cool("anthropic", "claude-code"); cool("openai", "codex");
      await make().enforceAssignments();
      expect(or.packet("wf")).toMatchObject({ ownerSession: "other-gem@rig", queueState: "blocked" });
    });
  });

  describe("restart (§80) and sleep (§81): all topdrive state is in its own db; OpenRig state is re-read", () => {
    it("held work whose provider recovered while topdrive was down resumes on the first tick, exactly once", async () => {
      const q = or.workflow("wf", [["implement", "implementer", "impl-gem@rig"]], "review", "verify-claude@rig");
      const codexOut = async () => ({ kind: "hard_limit" as const, resetAt: "2026-10-09T00:00:00.000Z" });
      or.signals = claudeAt(10);
      const first = make({ readCodexQuota: codexOut });
      first.reportHardLimit("anthropic", "claude-code", RESET);
      await first.tick();
      expect(or.packet("wf")).toMatchObject({ packetId: q, queueState: "blocked" });
      now = new Date("2026-10-02T22:05:00Z");
      expect(await make({ readCodexQuota: codexOut }).pollQuota()).toContain("provider.anthropic.available"); // ...then topdrive stops

      now = new Date("2026-10-02T22:10:00Z");
      const second = make({ readCodexQuota: codexOut }); // fresh process: no transition left to observe
      await second.tick();
      expect(or.packet("wf")).toMatchObject({ ownerSession: "verify-claude@rig", queueState: "pending" });
      expect((await second.history("wf", or.seats)).history.map((h) => [h.role, h.provider])).toContainEqual(["implementer", "google"]);
      const callsAfter = or.calls.length;
      await second.tick(); await second.tick();
      expect(or.calls.length).toBe(callsAfter);
    });
    it("a restart before the reset time keeps the cooldown: a stale 'fine' reading cannot lift it (§40)", async () => {
      or.signals = claudeAt(10);
      make().reportHardLimit("anthropic", "claude-code", RESET);
      now = new Date("2026-10-02T17:00:00Z");
      await make().tick();
      expect(store.getHealth("anthropic", "claude-code")?.state).toBe("cooldown");
    });
    it("waking after the reset with an unreadable probe does not assume the provider is back (§81)", async () => {
      make().reportHardLimit("anthropic", "claude-code", RESET);
      now = new Date("2026-10-03T08:00:00Z");
      await make().tick();
      expect(store.getHealth("anthropic", "claude-code")).toMatchObject({ state: "cooldown", reprobeDue: true });
    });
  });

  it("billingCheck names API-credential env that is set, never its value", () => {
    const r = make().billingCheck({ ANTHROPIC_API_KEY: "sk-x", PATH: "/bin" });
    expect(r.apiCredentialsSet).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(r)).not.toContain("sk-x");
  });
});
