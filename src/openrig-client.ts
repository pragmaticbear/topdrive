// The only way topdrive touches OpenRig: its local HTTP API (the same one the `rig` CLI uses). Every call here
// exists in stock OpenRig, so topdrive runs on top of whatever OpenRig the user already has.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProviderSignal } from "./core/quota-service.js";

export interface OpenRigSeat { session: string; runtime: string; model: string | null; cwd: string | null; operational: boolean }
export interface FrontierPacket { packetId: string; stepId: string; ownerSession: string; queueState: string; blockedOn: string | null }
export interface WorkflowInstance { instanceId: string; workflowName: string; workflowVersion: string; currentStepId: string | null; frontier: FrontierPacket[] }
export interface TrailEntry { stepId: string; stepRole: string; actorSession: string; closedAt: string }

export interface OpenRigApi {
  /** Reachability, and whether this daemon already routes by quota itself (a topdrive fork build). */
  probe(): Promise<{ reachable: boolean; url: string; builtInTopdrive: boolean; error?: string }>;
  listSeats(): Promise<OpenRigSeat[]>;
  listActiveWorkflows(): Promise<WorkflowInstance[]>;
  trail(instanceId: string): Promise<TrailEntry[]>;
  /** Role (`actor_role`) of a workflow step; null when the spec can't be read. */
  stepRole(workflowName: string, workflowVersion: string, stepId: string): Promise<string | null>;
  /** Atomically re-home a workflow's live packet to another seat (stock `rig workflow route`). */
  route(instanceId: string, packetId: string, toSession: string, reason: string): Promise<{ newPacketId: string }>;
  setBlocked(packetId: string, blockedOn: string, note: string): Promise<void>;
  setPending(packetId: string, note: string): Promise<void>;
  providerSignals(): Promise<ProviderSignal[]>;
}

/** Where the user's OpenRig daemon listens: OPENRIG_URL, else its daemon.json, else OPENRIG_PORT, else 7433. */
export function resolveOpenRigUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env["OPENRIG_URL"]?.trim()) return env["OPENRIG_URL"].trim().replace(/\/+$/, "");
  const home = env["OPENRIG_HOME"] || path.join(env["HOME"] || os.homedir(), ".openrig");
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf-8")) as { host?: string; port?: number };
    if (d.port) {
      const host = !d.host || d.host === "0.0.0.0" || d.host === "::" ? "127.0.0.1" : d.host;
      return `http://${host.includes(":") ? `[${host}]` : host}:${d.port}`;
    }
  } catch { /* no daemon.json: fall through */ }
  return `http://127.0.0.1:${env["OPENRIG_PORT"] || "7433"}`;
}

export class HttpOpenRigApi implements OpenRigApi {
  private specRoles = new Map<string, Map<string, string>>();
  constructor(readonly url: string, private actorSession = "topdrive@supervisor", private fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.url}${p}`, {
      method, signal: AbortSignal.timeout(10_000),
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenRig ${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async probe(): Promise<{ reachable: boolean; url: string; builtInTopdrive: boolean; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.url}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { reachable: false, url: this.url, builtInTopdrive: false, error: `healthz ${res.status}` };
      const td = await this.fetchImpl(`${this.url}/api/topdrive/quota`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      return { reachable: true, url: this.url, builtInTopdrive: td !== null && td.status !== 404 };
    } catch (e) {
      return { reachable: false, url: this.url, builtInTopdrive: false, error: (e as Error).message };
    }
  }

  async listSeats(): Promise<OpenRigSeat[]> {
    const rigs = await this.call<Array<{ rigId: string; isArchived?: boolean }>>("GET", "/api/ps");
    const out: OpenRigSeat[] = [];
    for (const rig of rigs.filter((r) => !r.isArchived)) {
      const nodes = await this.call<Array<Record<string, unknown>>>("GET", `/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
      for (const n of nodes) {
        const session = n["canonicalSessionName"];
        if (typeof session !== "string" || !session) continue;
        out.push({
          session, runtime: String(n["runtime"] ?? ""), model: (n["model"] as string | null) ?? null, cwd: (n["cwd"] as string | null) ?? null,
          operational: n["sessionStatus"] === "running" && n["startupStatus"] === "ready",
        });
      }
    }
    return out;
  }

  async listActiveWorkflows(): Promise<WorkflowInstance[]> {
    const list = await this.call<Array<{ instanceId: string; status: string }>>("GET", "/api/workflow/list");
    const out: WorkflowInstance[] = [];
    for (const w of list.filter((x) => x.status === "active")) {
      const d = await this.call<Record<string, unknown>>("GET", `/api/workflow/${encodeURIComponent(w.instanceId)}`);
      const packets = (d["frontierPackets"] as Array<Record<string, unknown>> | undefined) ?? [];
      out.push({
        instanceId: w.instanceId, workflowName: String(d["workflowName"]), workflowVersion: String(d["workflowVersion"]),
        currentStepId: (d["currentStepId"] as string | null) ?? null,
        frontier: packets.map((p) => ({
          packetId: String(p["packetId"]), stepId: String(p["stepId"]), ownerSession: String(p["ownerSession"]),
          queueState: String(p["queueState"]), blockedOn: (p["blockedOn"] as string | null) ?? null,
        })),
      });
    }
    return out;
  }

  async trail(instanceId: string): Promise<TrailEntry[]> {
    const t = await this.call<{ trail?: Array<Record<string, unknown>> }>("GET", `/api/workflow/${encodeURIComponent(instanceId)}/trace`);
    return (t.trail ?? []).map((e) => ({ stepId: String(e["stepId"]), stepRole: String(e["stepRole"]), actorSession: String(e["actorSession"]), closedAt: String(e["closedAt"]) }));
  }

  async stepRole(workflowName: string, workflowVersion: string, stepId: string): Promise<string | null> {
    const key = `${workflowName}@${workflowVersion}`;
    if (!this.specRoles.has(key)) {
      const { specs } = await this.call<{ specs: Array<{ name: string; version: string; sourcePath?: string }> }>("GET", "/api/workflow/specs");
      const spec = specs.find((s) => s.name === workflowName && String(s.version) === workflowVersion);
      const roles = new Map<string, string>();
      try {
        const doc = parseYaml(fs.readFileSync(spec?.sourcePath ?? "", "utf-8")) as { workflow?: { steps?: Array<{ id?: string; actor_role?: string }> } };
        for (const s of doc.workflow?.steps ?? []) if (s.id && s.actor_role) roles.set(s.id, s.actor_role);
      } catch { /* unreadable spec: roles unknown; topdrive leaves the workflow alone */ }
      if (roles.size) this.specRoles.set(key, roles);
      else return null;
    }
    return this.specRoles.get(key)!.get(stepId) ?? null;
  }

  async route(instanceId: string, packetId: string, toSession: string, reason: string): Promise<{ newPacketId: string }> {
    const r = await this.call<{ newPacketId: string }>("POST", `/api/workflow/${encodeURIComponent(instanceId)}/route`, {
      packetId, toSession, actorSession: this.actorSession, reason,
    });
    return { newPacketId: r.newPacketId };
  }

  async setBlocked(packetId: string, blockedOn: string, note: string): Promise<void> {
    await this.call("POST", `/api/queue/${encodeURIComponent(packetId)}/update`, { actorSession: this.actorSession, state: "blocked", blockedOn, transitionNote: note });
  }

  async setPending(packetId: string, note: string): Promise<void> {
    await this.call("POST", `/api/queue/${encodeURIComponent(packetId)}/update`, { actorSession: this.actorSession, state: "pending", transitionNote: note });
  }

  async providerSignals(): Promise<ProviderSignal[]> {
    try { return (await this.call<{ signals?: ProviderSignal[] }>("GET", "/api/provider/signals")).signals ?? []; } catch { return []; }
  }
}
