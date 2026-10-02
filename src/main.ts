#!/usr/bin/env node
// `topdrive`: limit-aware routing for the OpenRig you already run. It talks to OpenRig over its local API and keeps
// its own state in TOPDRIVE_HOME (~/.topdrive); it never edits OpenRig's files or database.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createSupervisor, loadConfig, topdriveHome } from "./runtime.js";
import { HttpOpenRigApi, resolveOpenRigUrl } from "./openrig-client.js";
import { renderExplain, renderQuota, renderRoles } from "./render.js";
import { topdriveDoctorChecks } from "./doctor.js";
import type { Role } from "./core/eligibility.js";

const ROLES = ["planner", "verifier", "implementer", "reviewer", "approver"];
const out = (json: boolean | undefined, data: unknown, human: () => string) => console.log(json ? JSON.stringify(data, null, 2) : human());
const fail = (msg: string): never => { console.error(`topdrive: ${msg}`); process.exit(1); };

interface PidInfo { pid: number; startedAt: string; openrigUrl: string }
const pidPath = (home: string) => path.join(home, "supervisor.pid");
function liveSupervisor(home: string): PidInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(pidPath(home), "utf-8")) as PidInfo;
    process.kill(info.pid, 0);
    return info;
  } catch { return null; }
}

const program = new Command()
  .name("topdrive")
  .description("Limit-aware multi-model routing for a running OpenRig (Claude Code, Codex, Antigravity).")
  .option("--openrig-url <url>", "OpenRig daemon URL (default: OPENRIG_URL, else ~/.openrig/daemon.json, else :7433)");

const url = () => (program.opts() as { openrigUrl?: string }).openrigUrl ?? resolveOpenRigUrl();
const setup = (log?: (m: string) => void) => {
  try { return createSupervisor({ openrigUrl: url(), ...(log ? { log } : {}) }); }
  catch (e) { return fail((e as Error).message); }
};

program.command("run")
  .description("Run the supervisor in the foreground (Ctrl-C stops it)")
  .action(async () => {
    const home = topdriveHome();
    const other = liveSupervisor(home);
    if (other && other.pid !== process.pid) fail(`a supervisor is already running (pid ${other.pid}); stop it with \`topdrive stop\``);
    const { supervisor, openrig, config } = setup((m) => console.log(`${new Date().toISOString()} ${m}`));
    const probe = await openrig.probe();
    if (probe.builtInTopdrive) fail(`the OpenRig daemon at ${probe.url} already has topdrive routing built in; running both would route every packet twice`);
    if (!probe.reachable) console.log(`${new Date().toISOString()} [topdrive] OpenRig not reachable at ${probe.url} (${probe.error}); will keep trying`);
    fs.writeFileSync(pidPath(home), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), openrigUrl: openrig.url } satisfies PidInfo));
    const stop = () => { supervisor.stopPolling(); try { if (liveSupervisor(home)?.pid === process.pid) fs.unlinkSync(pidPath(home)); } catch { /* gone */ } process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    console.log(`${new Date().toISOString()} [topdrive] supervising ${openrig.url} every ${config.pollSeconds}s (state: ${home})`);
    supervisor.startPolling();
  });

program.command("start")
  .description("Start the supervisor in the background (log: TOPDRIVE_HOME/topdrive.log)")
  .action(async () => {
    const home = topdriveHome();
    fs.mkdirSync(home, { recursive: true });
    const other = liveSupervisor(home);
    if (other) { console.log(`already running (pid ${other.pid}) against ${other.openrigUrl}`); return; }
    try { loadConfig(home); } catch (e) { fail((e as Error).message); }
    const log = fs.openSync(path.join(home, "topdrive.log"), "a");
    const args = [fileURLToPath(import.meta.url), ...(program.opts().openrigUrl ? ["--openrig-url", program.opts().openrigUrl] : []), "run"];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    for (let i = 0; i < 150; i++) { // up to 15s: the first OpenRig probe can take 10s on a slow host
      await new Promise((r) => setTimeout(r, 100));
      const info = liveSupervisor(home);
      if (info && info.pid === child.pid) { console.log(`topdrive supervisor started (pid ${info.pid}) against ${info.openrigUrl}`); return; }
      if (child.exitCode !== null) break;
    }
    fail(`the supervisor did not start; see ${path.join(home, "topdrive.log")}`);
  });

program.command("stop").description("Stop the background supervisor").action(() => {
  const info = liveSupervisor(topdriveHome());
  if (!info) { console.log("not running"); return; }
  process.kill(info.pid, "SIGTERM");
  console.log(`stopped (pid ${info.pid})`);
});

program.command("status").description("Supervisor and OpenRig connection status").option("--json").action(async (o: { json?: boolean }) => {
  const home = topdriveHome();
  const info = liveSupervisor(home);
  const probe = await new HttpOpenRigApi(url()).probe();
  out(o.json, { supervisor: info, home, openrig: probe }, () => [
    `supervisor: ${info ? `running (pid ${info.pid}, since ${info.startedAt})` : "stopped"}`,
    `state:      ${home}`,
    `openrig:    ${probe.url} ${probe.reachable ? "reachable" : `UNREACHABLE (${probe.error})`}${probe.builtInTopdrive ? "  (has built-in topdrive: do not run the supervisor against it)" : ""}`,
  ].join("\n"));
});

program.command("tick").description("Run one supervisory pass now and exit").action(async () => {
  const { supervisor } = setup((m) => console.log(m));
  await supervisor.tick();
});

program.command("quota").description("Normalized provider health").option("--json").option("--refresh", "probe providers now").action(async (o: { json?: boolean; refresh?: boolean }) => {
  const { supervisor } = setup();
  if (o.refresh) await supervisor.pollQuota();
  const providers = supervisor.listQuota();
  out(o.json, { providers, events: supervisor.store.listHealthEvents().slice(-20) }, () => providers.length ? renderQuota(providers) : "no provider health recorded yet; run `topdrive quota --refresh`");
});

program.command("explain").description("Which seat would take a role now, and why the others can't")
  .requiredOption("--role <role>", ROLES.join(" | ")).requiredOption("--workflow <instanceId>", "workflow instance id").option("--json")
  .action(async (o: { role: string; workflow: string; json?: boolean }) => {
    if (!ROLES.includes(o.role)) fail(`--role must be one of ${ROLES.join(", ")}`);
    const { supervisor } = setup();
    const e = await supervisor.explainRoute(o.workflow, o.role as Role);
    out(o.json, e, () => renderExplain(e));
  });

program.command("roles <instanceId>").description("Role history (who did which role) and topdrive's routing decisions").option("--json")
  .action(async (id: string, o: { json?: boolean }) => {
    const { supervisor, openrig } = setup();
    const { history, provenanceKnown } = await supervisor.history(id, await openrig.listSeats());
    const decisions = supervisor.store.listDecisions(id);
    out(o.json, { instanceId: id, provenanceKnown, history, decisions }, () => renderRoles({ instanceId: id, provenanceKnown, history, decisions }));
  });

program.command("billing-check").description("API-credential env that would break subscription-only billing").option("--json").action((o: { json?: boolean }) => {
  const { supervisor } = setup();
  const r = supervisor.billingCheck(process.env);
  out(o.json, r, () => r.apiCredentialsSet.length
    ? `subscription_only: API credentials set in this shell: ${r.apiCredentialsSet.join(", ")} (unset them before starting OpenRig)`
    : "subscription_only: no API credentials in this shell");
  if (r.apiCredentialsSet.length) process.exitCode = 1;
});

program.command("doctor").description("Check OpenRig connection, config, billing posture and Antigravity readiness").option("--json").action(async (o: { json?: boolean }) => {
  const home = topdriveHome();
  const checks: Array<{ name: string; status: string; message: string; reason?: string; fix?: string }> = [];
  const probe = await new HttpOpenRigApi(url()).probe();
  checks.push(probe.reachable
    ? { name: "openrig_reachable", status: "pass", message: `OpenRig daemon at ${probe.url}` }
    : { name: "openrig_reachable", status: "fail", message: `OpenRig not reachable at ${probe.url} (${probe.error})`, fix: "Start OpenRig (`rig daemon start`) or pass --openrig-url." });
  if (probe.builtInTopdrive) checks.push({ name: "openrig_builtin_topdrive", status: "fail", message: "This OpenRig build already routes by quota itself; don't also run the topdrive supervisor against it." });
  try { loadConfig(home); checks.push({ name: "config", status: "pass", message: `config ok (${path.join(home, "topdrive.yaml")})` }); }
  catch (e) { checks.push({ name: "config", status: "fail", message: (e as Error).message }); }
  const sup = liveSupervisor(home);
  checks.push(sup ? { name: "supervisor", status: "pass", message: `running (pid ${sup.pid})` } : { name: "supervisor", status: "warn", message: "not running; nothing is failing over", fix: "topdrive start" });
  checks.push(...topdriveDoctorChecks({ env: process.env, exec: (cmd) => execSync(cmd, { encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }) }));
  out(o.json, { checks }, () => checks.map((c) => `[${c.status.toUpperCase()}] ${c.name}: ${c.message}${c.fix ? `\n  Fix: ${c.fix}` : ""}`).join("\n"));
  if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
});

program.parseAsync().catch((e: Error) => fail(e.message));
