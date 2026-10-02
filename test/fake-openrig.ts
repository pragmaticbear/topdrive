// An in-memory OpenRig that behaves like the stock HTTP API topdrive uses (verified against a live upstream daemon):
// route closes the packet and creates a new one on the target seat, CARRYING a blocked state over; update flips state.
import type { FrontierPacket, OpenRigApi, OpenRigSeat, TrailEntry, WorkflowInstance } from "../src/openrig-client.js";
import type { ProviderSignal } from "../src/core/quota-service.js";

interface Wf { instanceId: string; workflowName: string; workflowVersion: string; status: string; frontier: FrontierPacket[]; trail: TrailEntry[] }

export class FakeOpenRig implements OpenRigApi {
  seats: OpenRigSeat[] = [];
  workflows = new Map<string, Wf>();
  roles: Record<string, string> = { plan: "planner", verify: "verifier", implement: "implementer", review: "reviewer", approve: "approver" };
  signals: ProviderSignal[] = [];
  calls: string[] = [];
  failRouteFor = new Set<string>();
  private seq = 0;

  seat(session: string, runtime: string, extra: Partial<OpenRigSeat> = {}): this {
    this.seats.push({ session, runtime, model: null, cwd: null, operational: true, ...extra });
    return this;
  }
  /** A workflow whose trail is [step, role, actor][] and whose live packet is `stepId` on `owner`. */
  workflow(instanceId: string, trail: Array<[string, string, string]>, stepId: string, owner: string, queueState = "pending"): string {
    const packetId = `q-${++this.seq}`;
    this.workflows.set(instanceId, {
      instanceId, workflowName: "feature-build", workflowVersion: "1", status: "active",
      frontier: [{ packetId, stepId, ownerSession: owner, queueState, blockedOn: null }],
      trail: trail.map(([s, r, a], i) => ({ stepId: s, stepRole: r, actorSession: a, closedAt: `2026-10-02T1${i}:00:00Z` })),
    });
    return packetId;
  }
  packet(instanceId: string): FrontierPacket { return this.workflows.get(instanceId)!.frontier[0]!; }
  private find(packetId: string): FrontierPacket {
    for (const w of this.workflows.values()) { const p = w.frontier.find((x) => x.packetId === packetId); if (p) return p; }
    throw new Error(`unknown packet ${packetId}`);
  }

  async probe() { return { reachable: true, url: "fake://openrig", builtInTopdrive: false }; }
  async listSeats() { return this.seats.map((s) => ({ ...s })); }
  async listActiveWorkflows(): Promise<WorkflowInstance[]> {
    return [...this.workflows.values()].filter((w) => w.status === "active").map((w) => ({
      instanceId: w.instanceId, workflowName: w.workflowName, workflowVersion: w.workflowVersion,
      currentStepId: w.frontier[0]?.stepId ?? null, frontier: w.frontier.map((p) => ({ ...p })),
    }));
  }
  async trail(instanceId: string) { return [...(this.workflows.get(instanceId)?.trail ?? [])]; }
  async stepRole(_n: string, _v: string, stepId: string) { return this.roles[stepId] ?? null; }
  async route(instanceId: string, packetId: string, toSession: string, reason: string) {
    this.calls.push(`route ${packetId} -> ${toSession} (${reason})`);
    if (this.failRouteFor.has(packetId)) throw new Error("OpenRig POST route -> 500");
    const w = this.workflows.get(instanceId)!;
    const old = w.frontier.find((p) => p.packetId === packetId)!;
    const next: FrontierPacket = { ...old, packetId: `q-${++this.seq}`, ownerSession: toSession };
    w.frontier = w.frontier.map((p) => (p.packetId === packetId ? next : p));
    return { newPacketId: next.packetId };
  }
  async setBlocked(packetId: string, blockedOn: string) {
    this.calls.push(`block ${packetId} ${blockedOn}`);
    Object.assign(this.find(packetId), { queueState: "blocked", blockedOn });
  }
  async setPending(packetId: string) {
    this.calls.push(`release ${packetId}`);
    Object.assign(this.find(packetId), { queueState: "pending", blockedOn: null });
  }
  async providerSignals() { return this.signals; }
}
