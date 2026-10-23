import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LATEST_AGENT_VERSION } from "@printio/shared";
import {
  isGitCheckout,
  performSelfUpdate,
  pnpmExecutable,
  resolveRepoRoot,
  type SelfUpdateFs,
  type CommandOutcome,
  type SelfUpdateDeps,
} from "../src/self-update.js";
import { AGENT_VERSION } from "../src/version.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function ok(stdout = ""): CommandOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}

const GATEWAY_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  'Restart-Service -DisplayName "Printio IPP Gateway" -ErrorAction Stop',
];

/** Dispatches by argv, like the real world: rev-parse reports a hash, pull/install/powershell as configured. */
function scripted(opts: {
  pull?: CommandOutcome;
  install?: CommandOutcome;
  gateway?: CommandOutcome | Error;
}) {
  const hashes = ["3f2a1b9", "8c4d0e2"];
  return vi.fn<SelfUpdateDeps["run"]>(async (command: string, args: readonly string[]) => {
    if (command === "git" && args[0] === "rev-parse") return ok(`${hashes.shift() ?? "8c4d0e2"}\n`);
    if (command === "git") return opts.pull ?? ok("Updating 3f2a1b9..8c4d0e2\nFast-forward\n");
    if (command === "powershell.exe") {
      const g = opts.gateway ?? ok();
      if (g instanceof Error) throw g;
      return g;
    }
    return opts.install ?? ok("Done");
  });
}

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const PNPM_CJS_PF = "C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs";

/** In-memory filesystem: a set of existing absolute paths + directory listings. */
function fakeFs(files: string[], dirs: Record<string, string[]> = {}): SelfUpdateFs {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    exists: (p) => set.has(p.toLowerCase()),
    listDir: (p) => dirs[p] ?? [],
  };
}

function makeDeps(overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    repoRoot: "/fake/repo",
    logger,
    hasGitCheckout: () => true,
    platform: "win32",
    execPath: NODE_EXE,
    env: { ProgramFiles: "C:\\Program Files", SystemDrive: "C:", Path: "C:\\Windows\\System32" },
    fs: fakeFs([PNPM_CJS_PF]),
    run: scripted({ pull: ok("Already up to date.\n") }),
    ...overrides,
  };
}

const callsOf = (run: ReturnType<typeof scripted>, command: string) => run.mock.calls.filter((c) => c[0] === command);

describe("performSelfUpdate", () => {
  it("refuses, with an actionable message, when the Agent is not a git checkout - and runs nothing at all", async () => {
    const run = vi.fn(async () => ok());
    const result = await performSelfUpdate(makeDeps({ hasGitCheckout: () => false, run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("not_a_git_checkout");
    expect(result.message).toMatch(/setup-agent/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports 'already up to date' without reinstalling dependencies or restarting the gateway", async () => {
    const run = scripted({ pull: ok("Already up to date.\n") });
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("already_up_to_date");
    expect(callsOf(run, "powershell.exe")).toHaveLength(0);
    expect(callsOf(run, NODE_EXE)).toHaveLength(0);
  });

  it("uses a hardcoded, fast-forward-only git argv in the Agent's own checkout directory", async () => {
    const run = scripted({ pull: ok("Already up to date.\n") });
    await performSelfUpdate(makeDeps({ repoRoot: "/opt/printio", run }));

    const pull = callsOf(run, "git").find((c) => c[1][0] === "pull")!;
    // --ff-only specifically: an unattended update must never invent a merge
    // commit on a machine nobody is watching.
    expect(pull[1]).toEqual(["pull", "--ff-only"]);
    expect(pull[2]).toBe("/opt/printio");
    const revParse = callsOf(run, "git").find((c) => c[1][0] === "rev-parse")!;
    expect(revParse[1]).toEqual(["rev-parse", "--short", "HEAD"]);
  });

  it("pulls, reinstalls dependencies, then restarts the gateway, and says which versions", async () => {
    const run = scripted({});
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(true);
    expect(result.reason).toBe("updated");
    expect(result.gatewayRestarted).toBe(true);
    expect(result.message).toBe(
      "Updated 3f2a1b9 -> 8c4d0e2. Restarted the gateway. The print server is restarting and will be back in about a minute.",
    );
    const order = run.mock.calls.map((c) => (c[0] === "git" ? `git ${c[1][0]}` : c[0]));
    expect(order).toEqual(["git rev-parse", "git pull", "git rev-parse", NODE_EXE, "powershell.exe"]);
    expect(callsOf(run, NODE_EXE)[0]![1]).toEqual([PNPM_CJS_PF, "install"]);
  });

  it("restarts the gateway with one fixed argv and a timeout, nothing variable in it", async () => {
    const run = scripted({});
    await performSelfUpdate(makeDeps({ repoRoot: "/evil; calc", run }));

    const ps = callsOf(run, "powershell.exe");
    expect(ps).toHaveLength(1);
    expect(ps[0]![1]).toEqual(GATEWAY_ARGS);
    expect(ps[0]![3]).toBeGreaterThan(0);
    expect(JSON.stringify(ps[0]![1])).not.toContain("evil");
  });

  it("does NOT restart the gateway when the install fails after a successful pull", async () => {
    const run = scripted({ install: { exitCode: 1, stdout: "", stderr: "ERR_PNPM_LOCKFILE_MISMATCH" } });
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("install_failed");
    expect(result.message).toMatch(/NOT restarted/);
    expect(callsOf(run, "powershell.exe")).toHaveLength(0);
  });

  it("does NOT restart the gateway when git pull fails or git is missing", async () => {
    const failed = scripted({ pull: { exitCode: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting." } });
    const r1 = await performSelfUpdate(makeDeps({ run: failed }));
    expect(r1.reason).toBe("git_failed");
    expect(r1.message).toContain("fast-forward");
    expect(callsOf(failed, "powershell.exe")).toHaveLength(0);
    expect(callsOf(failed, NODE_EXE)).toHaveLength(0);

    const missing = vi.fn(async () => {
      throw new Error("spawn git ENOENT");
    });
    const r2 = await performSelfUpdate(makeDeps({ run: missing }));
    expect(r2.updated).toBe(false);
    expect(r2.reason).toBe("git_unavailable");
    expect(r2.message).toMatch(/git isn't available/i);
  });

  it("still reports a successful update, with a plain note, when the gateway service is not installed", async () => {
    const run = scripted({
      gateway: {
        exitCode: 1,
        stdout: "",
        stderr: "Restart-Service : Cannot find any service with display name 'Printio IPP Gateway'.",
      },
    });
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(true);
    expect(result.reason).toBe("updated");
    expect(result.gatewayRestarted).toBe(false);
    expect(result.message).toContain("Updated 3f2a1b9 -> 8c4d0e2.");
    expect(result.message).toContain("The phone/print-dialog gateway was not restarted: it is not installed on this machine");
    expect(result.message).toContain("The print server is restarting");
  });

  it("still reports a successful update when the gateway restart fails, times out, or cannot be started", async () => {
    for (const gateway of [
      { exitCode: 1, stdout: "", stderr: "Service cannot be stopped" } satisfies CommandOutcome,
      { exitCode: null, stdout: "", stderr: "[timed out after 60000ms]" } satisfies CommandOutcome,
      new Error("spawn powershell.exe ENOENT"),
    ]) {
      const result = await performSelfUpdate(makeDeps({ run: scripted({ gateway }) }));
      expect(result.updated).toBe(true);
      expect(result.gatewayRestarted).toBe(false);
      expect(result.message).toContain("The phone/print-dialog gateway was not restarted:");
    }
  });

  it("skips the gateway restart entirely on non-Windows, and says so", async () => {
    const run = scripted({});
    const result = await performSelfUpdate(
      makeDeps({ run, platform: "linux", execPath: "/usr/bin/node", env: { PATH: "/usr/bin" }, fs: fakeFs(["/usr/bin/pnpm"]) }),
    );

    expect(callsOf(run, "powershell.exe")).toHaveLength(0);
    expect(result.updated).toBe(true);
    expect(result.gatewayRestarted).toBe(false);
    expect(result.message).toContain("The phone/print-dialog gateway was not restarted: only Windows");
  });

  it("falls back to 'unknown' for a version it cannot read, rather than failing the update", async () => {
    const run = vi.fn<SelfUpdateDeps["run"]>(async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { exitCode: 128, stdout: "", stderr: "fatal" };
      if (command === "git") return ok("Fast-forward\n");
      return ok();
    });
    const result = await performSelfUpdate(makeDeps({ run }));
    expect(result.updated).toBe(true);
    expect(result.message).toContain("Updated unknown -> unknown.");
  });
});

describe("isGitCheckout", () => {
  it("is false for a plain directory (the extracted-ZIP case) and true once a .git entry exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-selfupdate-test-"));
    try {
      expect(isGitCheckout(dir)).toBe(false);
      mkdirSync(path.join(dir, ".git"));
      expect(isGitCheckout(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoRoot", () => {
  it("resolves two levels above the apps/agent package, in both src/ and dist/ layouts", () => {
    expect(resolveRepoRoot("file:///srv/printio/apps/agent/src/self-update.js")).toBe("/srv/printio");
    expect(resolveRepoRoot("file:///srv/printio/apps/agent/dist/self-update.js")).toBe("/srv/printio");
  });
});

describe("pnpmExecutable", () => {
  it("uses the .cmd shim on Windows, since spawn() with shell:false cannot run a bare 'pnpm' there", () => {
    expect(pnpmExecutable("win32")).toBe("pnpm.cmd");
    expect(pnpmExecutable("linux")).toBe("pnpm");
  });
});

describe("agent version manifest", () => {
  it("keeps @printio/shared's LATEST_AGENT_VERSION in step with this package's own version", () => {
    // The admin console compares an Agent's reported version against
    // LATEST_AGENT_VERSION to say "this Agent is on X, latest is Y". If the
    // two ever drift, that comparison silently starts lying - so the build
    // fails here instead. Bump both in the same commit.
    expect(LATEST_AGENT_VERSION).toBe(AGENT_VERSION);
  });
});
