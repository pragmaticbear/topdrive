// topdrive §57: topdrive's own state (provider health + transitions, role history, routing decisions) in its own
// SQLite file under TOPDRIVE_HOME. OpenRig's database is never written; OpenRig state is read over its HTTP API.
import Database from "better-sqlite3";
import type { ProviderHealth } from "./provider-health.js";
import { transitionEvent } from "./provider-health.js";
import type { RoleExecution } from "./eligibility.js";

export interface RoleExecutionRow extends RoleExecution {
  id: number; workflowInstanceId: string; startedAt: string; endedAt: string | null;
}
export interface DecisionRow {
  id: number; workflowInstanceId: string; stepId: string; role: string; qitemId: string | null;
  selectedSeat: string | null; held: boolean; reason: string | null; decisionJson: string; createdAt: string;
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS topdrive_provider_health (
      provider TEXT NOT NULL,
      runtime TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      health_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (provider, runtime, account_id)
    );
    CREATE TABLE IF NOT EXISTS topdrive_provider_health_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      runtime TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      event TEXT NOT NULL,
      reason TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topdrive_health_events_provider ON topdrive_provider_health_events(provider, id);
    CREATE TABLE IF NOT EXISTS topdrive_role_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_instance_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      role TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_topdrive_role_exec_wf ON topdrive_role_executions(workflow_instance_id, id);
    CREATE TABLE IF NOT EXISTS topdrive_routing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_instance_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      role TEXT NOT NULL,
      qitem_id TEXT,
      selected_seat TEXT,
      held INTEGER NOT NULL,
      reason TEXT,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topdrive_decisions_wf ON topdrive_routing_decisions(workflow_instance_id, id);
`;

/** Opens (creating if needed) topdrive's database. Pass ":memory:" in tests. */
export function openTopdriveDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export class TopdriveStore {
  constructor(private db: Database.Database) {}

  // -- provider health ------------------------------------------------------
  getHealth(provider: string, runtime: string, accountId = ""): ProviderHealth | null {
    const r = this.db.prepare("SELECT health_json FROM topdrive_provider_health WHERE provider=? AND runtime=? AND account_id=?").get(provider, runtime, accountId) as { health_json: string } | undefined;
    return r ? (JSON.parse(r.health_json) as ProviderHealth) : null;
  }
  listHealth(): ProviderHealth[] {
    return (this.db.prepare("SELECT health_json FROM topdrive_provider_health ORDER BY provider, runtime, account_id").all() as Array<{ health_json: string }>).map((r) => JSON.parse(r.health_json));
  }
  /** Persists the record; returns the §41 event name iff the state changed (history row written in the same txn). */
  upsertHealth(h: ProviderHealth): string | null {
    const acct = h.accountId ?? "";
    return this.db.transaction(() => {
      const prev = this.getHealth(h.provider, h.runtime, acct);
      this.db.prepare(
        `INSERT INTO topdrive_provider_health (provider, runtime, account_id, state, health_json, checked_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(provider, runtime, account_id) DO UPDATE SET state=excluded.state, health_json=excluded.health_json, checked_at=excluded.checked_at`,
      ).run(h.provider, h.runtime, acct, h.state, JSON.stringify(h), h.checkedAt);
      const event = transitionEvent(h.provider, prev?.state, h.state);
      if (event) {
        this.db.prepare("INSERT INTO topdrive_provider_health_events (provider, runtime, from_state, to_state, event, reason, at) VALUES (?,?,?,?,?,?,?)")
          .run(h.provider, h.runtime, prev?.state ?? null, h.state, event, h.reason ?? null, h.checkedAt);
      }
      return event;
    })();
  }
  listHealthEvents(provider?: string): Array<{ event: string; fromState: string | null; toState: string; at: string }> {
    const rows = (provider
      ? this.db.prepare("SELECT event, from_state, to_state, at FROM topdrive_provider_health_events WHERE provider=? ORDER BY id").all(provider)
      : this.db.prepare("SELECT event, from_state, to_state, at FROM topdrive_provider_health_events ORDER BY id").all()) as Array<{ event: string; from_state: string | null; to_state: string; at: string }>;
    return rows.map((r) => ({ event: r.event, fromState: r.from_state, toState: r.to_state, at: r.at }));
  }

  // -- role history ---------------------------------------------------------
  recordRoleExecution(e: { workflowInstanceId: string; stepId: string; role: string; seatId: string; runtime: string; provider: string; model?: string; startedAt: string; endedAt?: string; outcome?: string }): number {
    const r = this.db.prepare(
      "INSERT INTO topdrive_role_executions (workflow_instance_id, step_id, role, seat_id, runtime, provider, model, started_at, ended_at, outcome) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(e.workflowInstanceId, e.stepId, e.role, e.seatId, e.runtime, e.provider, e.model ?? null, e.startedAt, e.endedAt ?? null, e.outcome ?? null);
    return Number(r.lastInsertRowid);
  }
  closeOpenRoleExecution(workflowInstanceId: string, stepId: string, seatId: string, outcome: string, endedAt: string): number {
    return this.db.prepare("UPDATE topdrive_role_executions SET ended_at=?, outcome=? WHERE workflow_instance_id=? AND step_id=? AND seat_id=? AND ended_at IS NULL")
      .run(endedAt, outcome, workflowInstanceId, stepId, seatId).changes;
  }
  listRoleExecutions(workflowInstanceId: string): RoleExecutionRow[] {
    const rows = this.db.prepare("SELECT * FROM topdrive_role_executions WHERE workflow_instance_id=? ORDER BY id").all(workflowInstanceId) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: Number(r["id"]), workflowInstanceId: String(r["workflow_instance_id"]), stepId: String(r["step_id"]), role: String(r["role"]),
      seatId: String(r["seat_id"]), runtime: String(r["runtime"]), provider: r["provider"] as RoleExecution["provider"],
      ...(r["model"] ? { model: String(r["model"]) } : {}), startedAt: String(r["started_at"]),
      endedAt: (r["ended_at"] as string | null) ?? null, ...(r["outcome"] ? { outcome: String(r["outcome"]) } : {}),
    }));
  }

  // -- routing decisions ----------------------------------------------------
  saveDecision(d: { workflowInstanceId: string; stepId: string; role: string; qitemId?: string; selectedSeat: string | null; held: boolean; reason?: string; decision: unknown; createdAt: string }): number {
    return Number(this.db.prepare(
      "INSERT INTO topdrive_routing_decisions (workflow_instance_id, step_id, role, qitem_id, selected_seat, held, reason, decision_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(d.workflowInstanceId, d.stepId, d.role, d.qitemId ?? null, d.selectedSeat, d.held ? 1 : 0, d.reason ?? null, JSON.stringify(d.decision), d.createdAt).lastInsertRowid);
  }
  listDecisions(workflowInstanceId: string): DecisionRow[] {
    const rows = this.db.prepare("SELECT * FROM topdrive_routing_decisions WHERE workflow_instance_id=? ORDER BY id").all(workflowInstanceId) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      id: Number(r["id"]), workflowInstanceId: String(r["workflow_instance_id"]), stepId: String(r["step_id"]), role: String(r["role"]),
      qitemId: (r["qitem_id"] as string | null) ?? null, selectedSeat: (r["selected_seat"] as string | null) ?? null,
      held: r["held"] === 1, reason: (r["reason"] as string | null) ?? null, decisionJson: String(r["decision_json"]), createdAt: String(r["created_at"]),
    }));
  }
}
