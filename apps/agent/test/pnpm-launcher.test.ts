import { describe, expect, it, vi } from "vitest";
import {
  performSelfUpdate,
  resolvePnpmLauncher,
  type CommandOutcome,
  type SelfUpdateDeps,
  type SelfUpdateFs,
} from "../src/self-update.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const PNPM_CJS_PF = "C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs";
const APPDATA = "C:\\Windows\\system32\\config\\systemprofile\\AppData\\Roaming";

function fakeFs(files: string[], dirs: Record<string, string[]> = {}): SelfUpdateFs {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return { exists: (p) => set.has(p.toLowerCase()), listDir: (p) => dirs[p] ?? [] };
}

const winBase = {
  platform: "win32" as NodeJS.Platform,
  execPath: NODE_EXE,
  env: { ProgramFiles: "C:\\Program Files", APPDATA, SystemDrive: "C:", Path: "C:\\Windows\\System32" } as NodeJS.ProcessEnv,
};

describe("resolvePnpmLauncher (the Agent runs as a Windows service: no user PATH, .cmd shims cannot be spawned)", () => {
  it("uses PRINTIO_PNPM_PATH when it points at an existing pnpm.cjs: node + cjs + install", () => {
    const cjs = "D:\\tools\\pnpm\\bin\\pnpm.cjs";
    const r = resolvePnpmLauncher({ ...winBase, env: { ...winBase.env, PRINTIO_PNPM_PATH: cjs }, fs: fakeFs([cjs, PNPM_CJS_PF]) });
    expect(r.launcher).toMatchObject({ command: NODE_EXE, args: [cjs, "install"], kind: "node-cjs" });
  });

  it("runs a pnpm.exe from PRINTIO_PNPM_PATH directly", () => {
    const exe = "D:\\tools\\pnpm.exe";
    const r = resolvePnpmLauncher({ ...winBase, env: { ...winBase.env, PRINTIO_PNPM_PATH: exe }, fs: fakeFs([exe]) });
    expect(r.launcher).toMatchObject({ command: exe, args: ["install"], kind: "exe" });
  });

  it("runs a pnpm.cmd from PRINTIO_PNPM_PATH only via cmd.exe /d /s /c with the quoted validated path", () => {
    const cmd = "D:\\tools\\pnpm.cmd";
    const r = resolvePnpmLauncher({ ...winBase, env: { ...winBase.env, PRINTIO_PNPM_PATH: cmd }, fs: fakeFs([cmd]) });
    expect(r.launcher).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${cmd}" install"`],
      kind: "cmd-shim",
      windowsVerbatimArguments: true,
    });
  });

  it("rejects an unusable PRINTIO_PNPM_PATH (relative, missing, wrong name, shell metacharacters) and falls through to discovery", () => {
    const evil = [
      "D:\\x\\evil.cmd",
      "D:\\a&b\\pnpm.cmd",
      "D:\\a%PATH%\\pnpm.cmd",
      'D:\\a"b\\pnpm.cmd',
      "D:\\a^b\\pnpm.cmd",
      "D:\\a|b\\pnpm.cmd",
    ];
    for (const bad of ["pnpm.cjs", "D:\\nope\\pnpm.cjs", ...evil]) {
      const r = resolvePnpmLauncher({
        ...winBase,
        env: { ...winBase.env, PRINTIO_PNPM_PATH: bad },
        fs: fakeFs([...evil, PNPM_CJS_PF]),
      });
      expect(r.launcher?.args).toEqual([PNPM_CJS_PF, "install"]);
      expect(r.rejected.join(" ")).toContain("PRINTIO_PNPM_PATH");
    }
  });

  it("finds pnpm.cjs under Program Files\\nodejs first, then %APPDATA%\\npm", () => {
    const appdata = `${APPDATA}\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs`;
    expect(resolvePnpmLauncher({ ...winBase, fs: fakeFs([appdata, PNPM_CJS_PF]) }).launcher?.args[0]).toBe(PNPM_CJS_PF);
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([appdata]) });
    expect(r.launcher).toMatchObject({ command: NODE_EXE, args: [appdata, "install"], kind: "node-cjs" });
  });

  it("finds pnpm.cjs in ANOTHER user's profile (the service account has none of its own)", () => {
    const other = "C:\\Users\\shneu\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs";
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([other], { "C:\\Users": ["Public", "shneu"] }) });
    expect(r.launcher).toMatchObject({ command: NODE_EXE, args: [other, "install"], kind: "node-cjs" });
  });

  it("falls back to a pnpm.cmd shim (via cmd.exe) only when no pnpm.cjs exists anywhere", () => {
    const shim = "C:\\Users\\shneu\\AppData\\Roaming\\npm\\pnpm.cmd";
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([shim], { "C:\\Users": ["shneu"] }) });
    expect(r.launcher).toMatchObject({ command: "cmd.exe", kind: "cmd-shim", args: ["/d", "/s", "/c", `""${shim}" install"`] });
  });

  it("refuses a discovered shim whose path contains shell metacharacters", () => {
    const shim = "C:\\Users\\a&b\\AppData\\Roaming\\npm\\pnpm.cmd";
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([shim], { "C:\\Users": ["a&b"] }) });
    expect(r.launcher).toBeNull();
  });

  it("uses corepack (next to node, run by node itself) as the last resort", () => {
    const corepack = "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js";
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([corepack]) });
    expect(r.launcher).toMatchObject({ command: NODE_EXE, args: [corepack, "pnpm", "install"], kind: "corepack" });
  });

  it("returns no launcher when nothing exists", () => {
    expect(resolvePnpmLauncher({ ...winBase, fs: fakeFs([]) }).launcher).toBeNull();
  });

  it("prepends the node directory to PATH for the child, keeping the Windows 'Path' key spelling", () => {
    const r = resolvePnpmLauncher({ ...winBase, fs: fakeFs([PNPM_CJS_PF]) });
    expect(r.launcher?.env?.Path).toBe("C:\\Program Files\\nodejs;C:\\Windows\\System32");
  });

  it("on Linux/mac: finds pnpm on PATH and runs it directly with ['install']", () => {
    const linux = { platform: "linux" as NodeJS.Platform, execPath: "/usr/bin/node" };
    const r = resolvePnpmLauncher({ ...linux, env: { PATH: "/usr/local/bin:/usr/bin" }, fs: fakeFs(["/usr/local/bin/pnpm"]) });
    expect(r.launcher).toMatchObject({ command: "/usr/local/bin/pnpm", args: ["install"], kind: "exe" });
    expect(resolvePnpmLauncher({ ...linux, env: { PATH: "/usr/bin" }, fs: fakeFs([]) }).launcher).toBeNull();
  });
});

function ok(stdout = ""): CommandOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}

function scripted(opts: { install?: CommandOutcome | Error; pull?: CommandOutcome } = {}) {
  const hashes = ["3f2a1b9", "8c4d0e2"];
  return vi.fn<SelfUpdateDeps["run"]>(async (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return ok(`${hashes.shift() ?? "8c4d0e2"}\n`);
    if (command === "git") return opts.pull ?? ok("Fast-forward\n");
    if (command === "powershell.exe") return ok();
    if (opts.install instanceof Error) throw opts.install;
    return opts.install ?? ok("Done");
  });
}

function deps(over: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    repoRoot: "/fake/repo",
    logger,
    hasGitCheckout: () => true,
    platform: "win32",
    execPath: NODE_EXE,
    env: winBase.env,
    fs: fakeFs([PNPM_CJS_PF]),
    run: scripted(),
    ...over,
  };
}

describe("performSelfUpdate - pnpm launcher integration", () => {
  it("runs `node <pnpm.cjs> install` (no shell, nothing interpolated) with the node dir on PATH", async () => {
    const run = scripted();
    const result = await performSelfUpdate(deps({ run }));
    expect(result.updated).toBe(true);
    const call = run.mock.calls.find((c) => c[0] === NODE_EXE)!;
    expect(call[1]).toEqual([PNPM_CJS_PF, "install"]);
    expect(call[4]?.env?.Path?.startsWith("C:\\Program Files\\nodejs;")).toBe(true);
    expect(call[4]?.windowsVerbatimArguments).toBeFalsy();
  });

  it("when pnpm cannot be found: plain actionable message, NOT updated, and nothing is pulled", async () => {
    const run = scripted();
    const result = await performSelfUpdate(deps({ run, fs: fakeFs([]) }));
    expect(result.updated).toBe(false);
    expect(result.reason).toBe("pnpm_not_found");
    expect(result.message).toContain("pnpm was not found on that machine; set PRINTIO_PNPM_PATH in apps/agent/.env");
    expect(run.mock.calls.some((c) => c[0] === "git" && c[1][0] === "pull")).toBe(false);
    expect(run.mock.calls.some((c) => c[0] === "powershell.exe")).toBe(false);
  });

  it("a spawn failure of the discovered pnpm after the pull is reported as not updated, never 'done'", async () => {
    const run = scripted({ install: new Error("spawn EACCES") });
    const result = await performSelfUpdate(deps({ run }));
    expect(result.updated).toBe(false);
    expect(result.reason).toBe("install_failed");
    expect(run.mock.calls.some((c) => c[0] === "powershell.exe")).toBe(false);
  });

  it("works on Linux with a plain pnpm on PATH", async () => {
    const run = scripted();
    const result = await performSelfUpdate(
      deps({ run, platform: "linux", execPath: "/usr/bin/node", env: { PATH: "/usr/bin" }, fs: fakeFs(["/usr/bin/pnpm"]) }),
    );
    expect(result.updated).toBe(true);
    expect(run.mock.calls.find((c) => c[0] === "/usr/bin/pnpm")![1]).toEqual(["install"]);
  });
});
