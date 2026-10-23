import { describe, expect, it, vi } from "vitest";
import {
  performSelfUpdate,
  performUpdateCheck,
  type CommandOutcome,
  type SelfUpdateDeps,
  type SelfUpdateFs,
  type UpdateProgress,
} from "../src/self-update.js";
import { handleCommand, type CommandHandlerDeps } from "../src/commands.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });
const ok = (stdout = ""): CommandOutcome => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandOutcome => ({ exitCode: 1, stdout: "", stderr });
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const PNPM = "C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs";
const fs: SelfUpdateFs = { exists: (p) => p.toLowerCase() === PNPM.toLowerCase(), listDir: () => [] };

function deps(run: SelfUpdateDeps["run"], extra: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    repoRoot: "/repo",
    logger,
    hasGitCheckout: () => true,
    platform: "win32",
    execPath: NODE_EXE,
    env: { ProgramFiles: "C:\\Program Files", Path: "C:\\Windows" },
    fs,
    run,
    ...extra,
  };
}

describe("performUpdateCheck (check only: fetch + compare, nothing is installed)", () => {
  function scripted(opts: { behind?: string; fetch?: CommandOutcome; head?: string; upstream?: string; subject?: string }) {
    return vi.fn<SelfUpdateDeps["run"]>(async (command, args) => {
      expect(command).toBe("git");
      const a = args.join(" ");
      if (a === "fetch --quiet") return opts.fetch ?? ok();
      if (a === "rev-parse --short HEAD") return ok(`${opts.head ?? "3f2a1b9"}\n`);
      if (a === "rev-parse --short @{u}") return ok(`${opts.upstream ?? "8c4d0e2"}\n`);
      if (a === "rev-list --count HEAD..@{u}") return ok(`${opts.behind ?? "2"}\n`);
      if (a === "log -1 --format=%s @{u}") return ok(`${opts.subject ?? "Faster booklets"}\n`);
      throw new Error(`unexpected git call: ${a}`);
    });
  }

  it("reports an available update with the new version and its message", async () => {
    const run = scripted({});
    const r = await performUpdateCheck(deps(run));
    expect(r).toMatchObject({ mode: "check_only", updateAvailable: true, current: "3f2a1b9", latest: "8c4d0e2", latestMessage: "Faster booklets", behind: 2 });
  });
  it("reports up to date when not behind", async () => {
    const r = await performUpdateCheck(deps(scripted({ behind: "0", upstream: "3f2a1b9" })));
    expect(r).toMatchObject({ updateAvailable: false, current: "3f2a1b9" });
  });
  it("only ever runs git with fixed, read-only arguments - never pull, merge, checkout, or pnpm", async () => {
    const run = scripted({});
    await performUpdateCheck(deps(run));
    const allowed = ["fetch --quiet", "rev-parse --short HEAD", "rev-parse --short @{u}", "rev-list --count HEAD..@{u}", "log -1 --format=%s @{u}"];
    for (const [command, args] of run.mock.calls) {
      expect(command).toBe("git");
      expect(allowed).toContain(args.join(" "));
    }
  });
  it("refuses plainly when this is not a git checkout, and runs nothing", async () => {
    const run = vi.fn(async () => ok());
    const r = await performUpdateCheck(deps(run, { hasGitCheckout: () => false }));
    expect(r.reason).toBe("not_a_git_checkout");
    expect(r.updateAvailable).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("a failing fetch becomes a plain could-not-check, not an exception", async () => {
    const r = await performUpdateCheck(deps(scripted({ fetch: fail("Could not resolve host: github.com") })));
    expect(r.reason).toBe("git_failed");
    expect(r.message).toMatch(/github/i);
  });
  it("git missing entirely is a plain answer", async () => {
    const r = await performUpdateCheck(deps(vi.fn(async () => { throw new Error("spawn git ENOENT"); })));
    expect(r.reason).toBe("git_unavailable");
  });
  it("trims and bounds a hostile commit message", async () => {
    const r = await performUpdateCheck(deps(scripted({ subject: "x".repeat(500) })));
    expect(r.latestMessage!.length).toBeLessThanOrEqual(140);
  });
});

describe("performSelfUpdate progress reporting", () => {
  function scripted(pull: CommandOutcome, install: CommandOutcome = ok()) {
    const hashes = ["3f2a1b9", "8c4d0e2"];
    return vi.fn<SelfUpdateDeps["run"]>(async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return ok(`${hashes.shift() ?? "8c4d0e2"}\n`);
      if (command === "git") return pull;
      if (command === "powershell.exe") return ok();
      return install;
    });
  }
  const collect = () => {
    const seen: UpdateProgress[] = [];
    return { seen, onProgress: (p: UpdateProgress) => void seen.push(p) };
  };

  it("reports checking, downloading, installing in order, then returns the versions", async () => {
    const { seen, onProgress } = collect();
    const r = await performSelfUpdate(deps(scripted(ok("Updating 3f2a1b9..8c4d0e2\nFast-forward"), ok()), { onProgress }));
    expect(seen.map((p) => p.step)).toEqual(["checking", "downloading", "installing"]);
    expect(r).toMatchObject({ updated: true, from: "3f2a1b9", to: "8c4d0e2" });
  });
  it("an already-up-to-date run stops after downloading and never reports installing", async () => {
    const { seen, onProgress } = collect();
    await performSelfUpdate(deps(scripted(ok("Already up to date.")), { onProgress }));
    expect(seen.map((p) => p.step)).toEqual(["checking", "downloading"]);
  });
  it("a failed install says which step failed", async () => {
    const r = await performSelfUpdate(deps(scripted(ok("Fast-forward"), fail("ERR_PNPM")), {}));
    expect(r.reason).toBe("install_failed");
    expect(r.failedStep).toBe("installing");
  });
  it("a failed pull says it failed while downloading", async () => {
    const r = await performSelfUpdate(deps(scripted(fail("fatal: Not possible to fast-forward"))));
    expect(r.failedStep).toBe("downloading");
  });
  it("a progress report that throws or rejects never breaks the update", async () => {
    const r = await performSelfUpdate(deps(scripted(ok("Fast-forward")), { onProgress: () => { throw new Error("network down"); } }));
    expect(r.updated).toBe(true);
    const r2 = await performSelfUpdate(deps(scripted(ok("Fast-forward")), { onProgress: async () => { throw new Error("network down"); } }));
    expect(r2.updated).toBe(true);
  });
});

describe("CHECK_FOR_UPDATE command handling", () => {
  const base = (extra: Partial<CommandHandlerDeps> = {}) =>
    ({
      localStoragePath: "/tmp",
      logger,
      scheduleServiceRestart: vi.fn(),
      runSelfUpdate: vi.fn(async () => ({ updated: false, reason: "already_up_to_date" as const, message: "Already up to date.", repoRoot: "/r" })),
      runUpdateCheck: vi.fn(async () => ({ mode: "check_only" as const, updateAvailable: true, reason: "update_available" as const, message: "m", current: "a", latest: "b", behind: 1 })),
      reportProgress: vi.fn(async () => undefined),
      ...extra,
    }) as unknown as CommandHandlerDeps;

  it("payload mode check_only runs the check, never the update, and never restarts", async () => {
    const d = base();
    const r = await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: { mode: "check_only" } }, d);
    expect(r.status).toBe("completed");
    expect(r.result).toMatchObject({ mode: "check_only", updateAvailable: true });
    expect(d.runSelfUpdate).not.toHaveBeenCalled();
    expect(d.scheduleServiceRestart).not.toHaveBeenCalled();
  });
  it("any other payload (empty, hostile, wrong type) is the full update, exactly as before", async () => {
    for (const payload of [{}, { mode: "pull --force" }, { mode: 1 }, null]) {
      const d = base();
      await handleCommand({ id: "c1", command: "CHECK_FOR_UPDATE", payload: payload as never }, d);
      expect(d.runSelfUpdate).toHaveBeenCalledTimes(1);
      expect(d.runUpdateCheck).not.toHaveBeenCalled();
    }
  });
  it("the full update forwards progress to the cloud for this command id, and its final result carries the step and versions", async () => {
    const reportProgress = vi.fn(async () => undefined);
    const d = base({
      reportProgress,
      runSelfUpdate: vi.fn(async (onProgress?: (p: UpdateProgress) => void) => {
        onProgress?.({ step: "downloading", message: "Downloading" });
        return { updated: true, reason: "updated" as const, message: "Updated.", repoRoot: "/r", from: "a", to: "b" };
      }),
    });
    const r = await handleCommand({ id: "cmd-9", command: "CHECK_FOR_UPDATE", payload: {} }, d);
    expect(reportProgress).toHaveBeenCalledWith("cmd-9", expect.objectContaining({ step: "downloading" }));
    expect(r.result).toMatchObject({ updated: true, from: "a", to: "b", step: "restarting" });
    expect(d.scheduleServiceRestart).toHaveBeenCalled();
  });
});
