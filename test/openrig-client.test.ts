import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpOpenRigApi, resolveOpenRigUrl } from "../src/openrig-client.js";

describe("resolveOpenRigUrl: find the OpenRig the user already runs", () => {
  it("OPENRIG_URL wins; else daemon.json in OPENRIG_HOME (or ~/.openrig); else OPENRIG_PORT; else 7433", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "td-url-"));
    try {
      expect(resolveOpenRigUrl({ OPENRIG_URL: "http://box:9000/", HOME: home })).toBe("http://box:9000");
      expect(resolveOpenRigUrl({ HOME: home })).toBe("http://127.0.0.1:7433");
      expect(resolveOpenRigUrl({ HOME: home, OPENRIG_PORT: "7500" })).toBe("http://127.0.0.1:7500");
      fs.mkdirSync(path.join(home, ".openrig"));
      fs.writeFileSync(path.join(home, ".openrig", "daemon.json"), JSON.stringify({ pid: 1, port: 7444, host: "0.0.0.0" }));
      expect(resolveOpenRigUrl({ HOME: home })).toBe("http://127.0.0.1:7444");
      fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: 1, port: 7455, host: "::1" }));
      expect(resolveOpenRigUrl({ HOME: "/nowhere", OPENRIG_HOME: home })).toBe("http://[::1]:7455");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe("HttpOpenRigApi", () => {
  it("probe: reachable, and flags a daemon that already has topdrive built in (/api/topdrive answers)", async () => {
    const fetchFor = (topdriveStatus: number) => (async (u: string | URL | Request) =>
      new Response("{}", { status: String(u).endsWith("/api/topdrive/quota") ? topdriveStatus : 200 })) as typeof fetch;
    expect(await new HttpOpenRigApi("http://x", undefined, fetchFor(404)).probe()).toMatchObject({ reachable: true, builtInTopdrive: false });
    expect(await new HttpOpenRigApi("http://x", undefined, fetchFor(200)).probe()).toMatchObject({ reachable: true, builtInTopdrive: true });
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    expect(await new HttpOpenRigApi("http://x", undefined, down).probe()).toMatchObject({ reachable: false, error: "ECONNREFUSED" });
  });
  it("API errors surface with method, path and status (never swallowed into an empty answer)", async () => {
    const f = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(new HttpOpenRigApi("http://x", undefined, f).route("wf", "q1", "s@r", "why")).rejects.toThrow("OpenRig POST /api/workflow/wf/route -> 500: boom");
  });
});
