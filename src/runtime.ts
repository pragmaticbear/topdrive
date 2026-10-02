// Real-world wiring: topdrive's home, config, store, and the local tools it reads (agy, Codex logs, tmux, git).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTopdriveConfig, DEFAULT_CONFIG, type TopdriveConfig } from "./core/config.js";
import { openTopdriveDb, TopdriveStore } from "./core/store.js";
import { readLatestCodexRateLimits } from "./core/codex-quota.js";
import { HttpOpenRigApi, resolveOpenRigUrl } from "./openrig-client.js";
import { Supervisor } from "./supervisor.js";

/** topdrive's own state directory (database, config, pid, log). Never OpenRig's home. */
export function topdriveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["TOPDRIVE_HOME"] || path.join(env["HOME"] || os.homedir(), ".topdrive");
}

/** `<home>/topdrive.yaml`; absent => defaults. Invalid => throws (topdrive never runs on a config it can't read). */
export function loadConfig(home: string): TopdriveConfig {
  const p = path.join(home, "topdrive.yaml");
  return fs.existsSync(p) ? parseTopdriveConfig(fs.readFileSync(p, "utf-8")) : DEFAULT_CONFIG;
}

const run = (cmd: string, args: readonly string[], opts: { timeout: number; env?: NodeJS.ProcessEnv }) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, [...args], { timeout: opts.timeout, maxBuffer: 4 * 1024 * 1024, ...(opts.env ? { env: opts.env } : {}) }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

function readCodexQuota() {
  const root = path.join(process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"), "sessions");
  const TAIL_BYTES = 512 * 1024; // rollouts can be huge; rate_limits are re-emitted every turn, so the tail suffices
  const walk = (dir: string, depth: number): string[] => {
    if (depth > 4) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), depth + 1)
        : e.name.startsWith("rollout-") && e.name.endsWith(".jsonl") ? [path.join(dir, e.name)] : []);
    } catch { return []; }
  };
  return readLatestCodexRateLimits({
    listRollouts: () => walk(root, 0),
    mtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } },
    readTail: (p) => {
      const fd = fs.openSync(p, "r");
      try { const size = fs.fstatSync(fd).size; const len = Math.min(size, TAIL_BYTES); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); return buf.toString("utf-8"); }
      finally { fs.closeSync(fd); }
    },
    now: () => Date.now(),
  });
}

export function createSupervisor(opts: { home?: string; openrigUrl?: string; log?: (m: string) => void } = {}): { supervisor: Supervisor; openrig: HttpOpenRigApi; config: TopdriveConfig; home: string } {
  const home = opts.home ?? topdriveHome();
  fs.mkdirSync(home, { recursive: true });
  const config = loadConfig(home);
  const openrig = new HttpOpenRigApi(opts.openrigUrl ?? resolveOpenRigUrl());
  const store = new TopdriveStore(openTopdriveDb(path.join(home, "topdrive.sqlite")));
  const supervisor = new Supervisor({
    openrig, store, config, ...(opts.log ? { log: opts.log } : {}),
    // quota probe only; never hand agy an API key
    agyExec: (args) => run("agy", args, { timeout: 20_000, env: { ...process.env, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined } }),
    readCodexQuota,
    capturePane: async (session) => {
      const screen = await run("tmux", ["capture-pane", "-p", "-t", `=${session}:`], { timeout: 5_000 });
      return screen.trimEnd().split("\n").slice(-15).join("\n");
    },
    gitExec: (cwd, args) => run("git", ["-C", cwd, ...args], { timeout: 10_000 }), // read-only verbs only (see core/evidence.ts)
  });
  return { supervisor, openrig, config, home };
}
