// topdrive supervisor: the limit-aware routing loop, run BESIDE the user's OpenRig.
//  - provider health: agy `/usage`, Codex session logs, Claude via OpenRig's provider signals; limit banners on seat screens
//  - failover: a packet whose seat's provider can't take it is re-homed with OpenRig's atomic workflow route
//  - independence: role history comes from the workflow trail; with no independent seat the packet is HELD (blocked)
// All OpenRig reads and writes go through OpenRigApi; topdrive's own state lives in its own SQLite (TopdriveStore).

import type { OpenRigApi, OpenRigSeat, WorkflowInstance } from "./openrig-client.js";
import { TopdriveStore } from "./core/store.js";
import { ProviderQuotaService, signalsToHealthSignal, type QuotaReader } from "./core/quota-service.js";
import { FailoverReactor, type ActiveWork, type HandoffOutcome, type ReactorHandoffInput, type RoutableSeat } from "./core/failover-reactor.js";
import { collectRepoEvidence } from "./core/evidence.js";
import { detectLimitMessage } from "./core/limit-detector.js";
import { parseAgyUsage, AGY_USAGE_ARGS } from "./core/agy-quota.js";
import { selectSeat, type Role, type RoleExecution, type SelectionResult } from "./core/eligibility.js";
import { API_CREDENTIAL_ENV, sanitizeEnv, type BillingPolicy } from "./core/billing-policy.js";
import { DEFAULT_CONFIG, type TopdriveConfig } from "./core/config.js";
import { runtimeProvider, seatPrefKeys } from "./core/seats.js";
import type { HealthSignal, ProviderFamily, ProviderHealth } from "./core/provider-health.js";

const ROLES: ReadonlySet<string> = new Set(["planner", "verifier", "implementer", "reviewer", "approver"]);
const asRole = (r: string | null | undefined): Role | null => (r && ROLES.has(r) ? (r as Role) : null);
const HELD_PREFIX = "provider-capacity:";

export interface SupervisorDeps {
  openrig: OpenRigApi;
  store: TopdriveStore;
  /** Runs `agy <args>` and returns stdout; rejects when agy is absent/unauthenticated. */
  agyExec: (args: readonly string[]) => Promise<string>;
  /** Codex rate limits from its session logs. Absent => OpenRig's provider signals. */
  readCodexQuota?: () => Promise<HealthSignal>;
  /** Visible screen text of a seat's tmux pane, for limit-banner detection. Absent => scan disabled. */
  capturePane?: (session: string) => Promise<string>;
  /** Read-only git in a seat's working directory (handoff evidence). Absent => no repo evidence. */
  gitExec?: (cwd: string, args: string[]) => Promise<string>;
  config?: TopdriveConfig;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** One consistent read of OpenRig for a supervisory pass. */
interface Snapshot { seats: OpenRigSeat[]; workflows: WorkflowInstance[]; work: Map<string, ActiveWork & { queueState: string; blockedOn: string | null }> }

export class Supervisor {
  readonly store: TopdriveStore;
  private quota: ProviderQuotaService;
  private cfg: TopdriveConfig;
  private transitions: string[] = [];
  private snap: Snapshot | null = null;
  private histories = new Map<string, { history: RoleExecution[]; provenanceKnown: boolean }>();
  /** True until the first tick: held work is retried even without a fresh `.available` transition (§80). */
  private pendingStartupRetry = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: SupervisorDeps) {
    this.store = d.store;
    this.cfg = d.config ?? DEFAULT_CONFIG;
    const readers: QuotaReader[] = [
      { provider: "anthropic", runtime: "claude-code", read: async () => signalsToHealthSignal((await d.openrig.providerSignals()).filter((s) => s.provider === "claude")) },
      { provider: "openai", runtime: "codex", read: async () => d.readCodexQuota ? d.readCodexQuota() : signalsToHealthSignal((await d.openrig.providerSignals()).filter((s) => s.provider === "codex")) },
      { provider: "google", runtime: "antigravity", read: async () => parseAgyUsage(await d.agyExec(AGY_USAGE_ARGS), "gemini") },
    ];
    this.quota = new ProviderQuotaService({
      store: this.store, readers, ...(d.now ? { now: d.now } : {}), policy: this.cfg.health,
      onTransition: (event) => { this.transitions.push(event); d.log?.(`[topdrive] ${event}`); },
    });
  }

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  // -- OpenRig snapshot -----------------------------------------------------
  private async snapshot(): Promise<Snapshot> {
    const [seats, workflows] = await Promise.all([this.d.openrig.listSeats(), this.d.openrig.listActiveWorkflows()]);
    const work: Snapshot["work"] = new Map();
    for (const wf of workflows) {
      for (const p of wf.frontier) {
        const role = asRole(await this.d.openrig.stepRole(wf.workflowName, wf.workflowVersion, p.stepId));
        if (!role) continue; // a step topdrive can't classify is never moved
        work.set(p.packetId, { qitemId: p.packetId, session: p.ownerSession, workflowInstanceId: wf.instanceId, stepId: p.stepId, role, queueState: p.queueState, blockedOn: p.blockedOn });
      }
    }
    this.histories.clear();
    this.snap = { seats, workflows, work };
    return this.snap;
  }

  /** Runtime topdrive routes a seat as: its OpenRig runtime, or the configured `seat_runtimes` override. */
  private seatRuntime(s: OpenRigSeat): string {
    return runtimeProvider(s.runtime) ? s.runtime : this.cfg.seatRuntimes[s.session] ?? s.runtime;
  }

  routableSeats(seats: OpenRigSeat[]): RoutableSeat[] {
    const out: RoutableSeat[] = [];
    for (const s of seats) {
      const runtime = this.seatRuntime(s);
      const provider = runtimeProvider(runtime);
      if (!provider) continue;
      const h = this.store.getHealth(provider, runtime);
      out.push({
        id: s.session, session: s.session, provider, runtime, prefKeys: seatPrefKeys(runtime, s.model),
        healthState: h?.state ?? "unknown", ...(h?.quota?.remainingPercent !== undefined ? { remainingPercent: h.quota.remainingPercent } : {}),
        operational: s.operational, authenticated: h?.state !== "auth_required",
      });
    }
    return out;
  }

  // -- role history ---------------------------------------------------------
  /** From OpenRig's workflow trail (who closed each step) plus topdrive's own handoff rows. A trail actor whose
   *  seat is gone or not an agent makes provenance UNKNOWN, and constrained roles then fail closed (§55). */
  async history(instanceId: string, seats: OpenRigSeat[]): Promise<{ history: RoleExecution[]; provenanceKnown: boolean }> {
    const cached = this.histories.get(instanceId);
    if (cached) return cached;
    const bySession = new Map(seats.map((s) => [s.session, s]));
    const history: RoleExecution[] = [];
    let provenanceKnown = true;
    for (const t of await this.d.openrig.trail(instanceId)) {
      const seat = bySession.get(t.actorSession);
      const runtime = seat ? this.seatRuntime(seat) : null;
      const provider = runtimeProvider(runtime);
      if (!seat || !provider || !runtime) { provenanceKnown = false; continue; }
      history.push({ stepId: t.stepId, role: t.stepRole, seatId: t.actorSession, provider, runtime, outcome: "completed" });
    }
    for (const r of this.store.listRoleExecutions(instanceId)) {
      if (!history.some((h) => h.stepId === r.stepId && h.seatId === r.seatId && h.role === r.role)) history.push(r);
    }
    const out = { history, provenanceKnown };
    this.histories.set(instanceId, out);
    return out;
  }

  private select(role: Role, seats: RoutableSeat[], hist: { history: RoleExecution[]; provenanceKnown: boolean }, owner?: string): SelectionResult {
    return selectSeat({
      role, seats: seats.map((s) => (s.session === owner ? { ...s, currentOwner: true } : s)), history: hist.history,
      prefs: this.cfg.prefs, constraints: this.cfg.constraints, unknownPolicy: this.cfg.unknownPolicy, provenanceKnown: hist.provenanceKnown,
    });
  }

  async explainRoute(instanceId: string, role: Role): Promise<{ instanceId: string; role: Role; provenanceKnown: boolean; selection: SelectionResult }> {
    const seats = await this.d.openrig.listSeats();
    const hist = await this.history(instanceId, seats);
    return { instanceId, role, provenanceKnown: hist.provenanceKnown, selection: this.select(role, this.routableSeats(seats), hist) };
  }

  // -- quota ----------------------------------------------------------------
  async pollQuota(): Promise<string[]> {
    this.transitions = [];
    await this.quota.pollOnce();
    return this.transitions;
  }
  listQuota(): ProviderHealth[] { return this.store.listHealth(); }
  reportHardLimit(p: ProviderFamily, runtime: string, resetAt?: string): void { this.quota.reportHardLimit(p, runtime, resetAt); }
  reportWarning(p: ProviderFamily, runtime: string, resetAt?: string): void { this.quota.reportWarning(p, runtime, resetAt); }

  /** Scan operational agent seats' screens for limit banners; returns how many NEW provider limits were recorded. */
  async scanSeatsForLimits(seats: OpenRigSeat[]): Promise<number> {
    if (!this.d.capturePane) return 0;
    let reported = 0;
    for (const s of seats) {
      const runtime = this.seatRuntime(s);
      const provider = runtimeProvider(runtime);
      if (!provider || !s.operational) continue;
      const current = this.store.getHealth(provider, runtime)?.state;
      if (current === "cooldown" || current === "exhausted") continue; // already known; polling owns recovery
      let screen = "";
      try { screen = await this.d.capturePane(s.session); } catch { continue; }
      const hit = detectLimitMessage(provider, screen, this.now());
      if (!hit) continue;
      this.quota.reportHardLimit(provider, runtime, hit.resetAt);
      reported++;
    }
    return reported;
  }

  // -- failover -------------------------------------------------------------
  private reactor(snap: Snapshot): FailoverReactor {
    const seats = this.routableSeats(snap.seats);
    const providerOf = new Map(seats.map((s) => [s.session, s.provider]));
    const all = [...snap.work.values()];
    return new FailoverReactor({
      listActiveWork: (p) => all.filter((w) => (w.queueState === "pending" || w.queueState === "in-progress") && providerOf.get(w.session) === p),
      listHeldWork: () => all.filter((w) => w.queueState === "blocked" && (w.blockedOn ?? "").startsWith(HELD_PREFIX)),
      listSeats: () => seats,
      isSeatBusy: (session) => all.some((w) => w.session === session && w.queueState === "in-progress"),
      collectEvidence: (w) => this.evidenceRefs(snap, w.session),
      handoff: (i) => this.handoff(snap, i),
      ...(this.d.log ? { log: this.d.log } : {}),
    });
  }

  /** Move one packet to the best eligible seat, or hold it. Never weakens independence to keep moving (§39). */
  private async handoff(snap: Snapshot, i: ReactorHandoffInput): Promise<HandoffOutcome> {
    const packet = snap.work.get(i.qitemId);
    const wasBlocked = packet?.queueState === "blocked";
    const hist = await this.history(i.workflowInstanceId, snap.seats);
    const selection = this.select(i.role, i.seats, hist, i.fromSession);
    const at = this.now().toISOString();
    const decision = { workflowInstanceId: i.workflowInstanceId, stepId: i.stepId, role: i.role, reason: i.reason, createdAt: at, decision: selection };

    if (!selection.selected) {
      const blocker = `${HELD_PREFIX}${i.role}`;
      if (!(wasBlocked && packet?.blockedOn === blocker)) await this.d.openrig.setBlocked(i.qitemId, blocker, `held: no eligible ${i.role} (${i.reason})`);
      this.store.saveDecision({ ...decision, qitemId: i.qitemId, selectedSeat: null, held: true });
      if (!wasBlocked) this.d.log?.(`[topdrive] ${i.role} ${i.qitemId}: HELD on ${i.fromSession}, no eligible ${i.role} (${i.reason})`);
      return { action: "hold" };
    }

    const target = i.seats.find((s) => s.id === selection.selected!.id)!;
    if (target.session === i.fromSession) {
      // the owner's provider recovered: release it where it is
      if (wasBlocked) {
        await this.d.openrig.setPending(i.qitemId, `topdrive: ${i.reason}`);
        this.d.log?.(`[topdrive] ${i.role} ${i.qitemId}: released on ${i.fromSession} (${i.reason})`);
      }
      this.store.saveDecision({ ...decision, qitemId: i.qitemId, selectedSeat: target.id, held: false });
      return { action: "handoff" };
    }

    const reason = [`topdrive ${i.reason}`, ...i.evidenceRefs].join("; ");
    const { newPacketId } = await this.d.openrig.route(i.workflowInstanceId, i.qitemId, target.session, reason);
    // OpenRig's route carries a blocked state over to the new packet; the new owner is eligible, so release it.
    if (wasBlocked) await this.d.openrig.setPending(newPacketId, `topdrive: released on ${target.session}`);
    const source = i.seats.find((s) => s.session === i.fromSession);
    if (source) this.store.closeOpenRoleExecution(i.workflowInstanceId, i.stepId, source.id, `handoff:${i.reason}`, at);
    this.store.recordRoleExecution({ workflowInstanceId: i.workflowInstanceId, stepId: i.stepId, role: i.role, seatId: target.id, runtime: target.runtime, provider: target.provider, startedAt: at });
    this.store.saveDecision({ ...decision, qitemId: newPacketId, selectedSeat: target.id, held: false });
    this.histories.delete(i.workflowInstanceId); // the new role execution is part of this workflow's history now
    this.d.log?.(`[topdrive] ${i.role} ${i.qitemId}: ${i.fromSession} -> ${target.session} (${i.reason})`);
    return { action: "handoff" };
  }

  /** Re-route work off every provider that cannot take it; optionally retry held work. */
  async reactToHealth(retryHeld = false, snap?: Snapshot): Promise<{ handedOff: number; held: number; deferred: number; failed: number }> {
    const s = snap ?? (await this.snapshot());
    const reactor = this.reactor(s);
    const total = { handedOff: 0, held: 0, deferred: 0, failed: 0 };
    const add = (r: typeof total) => { for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += r[k]; };
    for (const h of this.store.listHealth()) {
      if (h.state === "available" || h.state === "unknown" || h.state === "degraded") continue;
      add(await reactor.react(h.provider, h.state));
    }
    if (retryHeld) add(await reactor.retryHeld());
    return total;
  }

  /** §25/§49: every PENDING packet must sit with a seat eligible for its role; violators are re-routed or held. */
  async enforceAssignments(snap?: Snapshot): Promise<number> {
    const s = snap ?? (await this.snapshot());
    const seats = this.routableSeats(s.seats);
    const reactor = this.reactor(s);
    let acted = 0;
    for (const w of s.work.values()) {
      if (w.queueState !== "pending") continue;
      if (!seats.some((x) => x.session === w.session)) continue; // not a routable agent seat: not ours to judge
      const hist = await this.history(w.workflowInstanceId, s.seats);
      const verdict = this.select(w.role, seats, hist).candidates.find((c) => c.seat === w.session);
      if (!verdict || verdict.eligible) continue;
      try { if (await reactor.handoffNow(w, `assignment_ineligible:${verdict.reason}`)) acted++; }
      catch (e) { this.d.log?.(`[topdrive] assignment guard failed for ${w.qitemId}: ${(e as Error).message}`); }
    }
    return acted;
  }

  /** One supervisory pass: scan screens, probe providers, fail over, resume held work, enforce assignments. */
  async tick(): Promise<void> {
    await this.scanSeatsForLimits(await this.d.openrig.listSeats());
    const events = await this.pollQuota();
    // A provider can recover (and be stored `available`) right before topdrive stops; that transition is never seen
    // again, so the first tick retries held work unconditionally (§80).
    const retryHeld = this.pendingStartupRetry || events.some((e) => e.endsWith(".available"));
    this.pendingStartupRetry = false;
    await this.reactToHealth(retryHeld);
    await this.enforceAssignments(); // fresh snapshot: the reaction may have moved packets
  }

  startPolling(intervalMs = this.cfg.pollSeconds * 1000): void {
    if (this.timer) return;
    const run = () => void this.tick().catch((e) => this.d.log?.(`[topdrive] tick failed: ${(e as Error).message}`));
    run();
    this.timer = setInterval(run, intervalMs);
  }
  stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // -- billing --------------------------------------------------------------
  billingCheck(env: Record<string, string | undefined>): { policy: BillingPolicy; apiCredentialsSet: string[]; apiCredentialNames: string[] } {
    const set: string[] = [];
    for (const p of Object.keys(API_CREDENTIAL_ENV) as ProviderFamily[]) set.push(...sanitizeEnv(p, env, this.cfg.billing).removed);
    return { policy: this.cfg.billing, apiCredentialsSet: set, apiCredentialNames: Object.values(API_CREDENTIAL_ENV).flat() };
  }

  /** Evidence refs for a handoff: git state of the departing seat's repo. Never throws; empty when unavailable. */
  private async evidenceRefs(snap: Snapshot, session: string): Promise<string[]> {
    const cwd = snap.seats.find((s) => s.session === session)?.cwd;
    if (!cwd || !this.d.gitExec) return [];
    const git = this.d.gitExec;
    const ev = await collectRepoEvidence((args) => git(cwd, args));
    if (ev.sha === null && ev.branch === null) return [];
    const refs = [`git:${ev.branch ?? "?"}@${ev.sha ?? "?"}`];
    if (ev.dirty !== null) refs.push(ev.dirty ? "worktree:dirty" : "worktree:clean");
    if (ev.changedPaths.length) refs.push(`changed:${ev.changedPaths.slice(0, 20).join(",")}${ev.changedPaths.length > 20 ? `,+${ev.changedPaths.length - 20}` : ""}`);
    return refs;
  }
}
