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
  type CommandOutcome,
  type SelfUpdateDeps,
} from "../src/self-update.js";
import { AGENT_VERSION } from "../src/version.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error" });

function ok(stdout = ""): CommandOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}

function makeDeps(overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    repoRoot: "/fake/repo",
    logger,
    hasGitCheckout: () => true,
    run: vi.fn(async () => ok("Already up to date.\n")),
    ...overrides,
  };
}

describe("performSelfUpdate", () => {
  it("refuses, with an actionable message, when the Agent is not a git checkout - and runs nothing at all", async () => {
    const run = vi.fn(async () => ok());
    const result = await performSelfUpdate(makeDeps({ hasGitCheckout: () => false, run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("not_a_git_checkout");
    expect(result.message).toMatch(/setup-agent/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports 'already up to date' without reinstalling dependencies or restarting", async () => {
    const run = vi.fn<SelfUpdateDeps["run"]>(async () => ok("Already up to date.\n"));
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("already_up_to_date");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses a hardcoded, fast-forward-only git argv in the Agent's own checkout directory", async () => {
    const run = vi.fn<SelfUpdateDeps["run"]>(async () => ok("Already up to date.\n"));
    await performSelfUpdate(makeDeps({ repoRoot: "/opt/printio", run }));

    const [command, args, cwd] = run.mock.calls[0]!;
    expect(command).toBe("git");
    // --ff-only specifically: an unattended update must never invent a merge
    // commit on a machine nobody is watching.
    expect(args).toEqual(["pull", "--ff-only"]);
    expect(cwd).toBe("/opt/printio");
  });

  it("pulls, then reinstalls dependencies, and only then reports an update that warrants a restart", async () => {
    const run = vi.fn<SelfUpdateDeps["run"]>(async (command: string) =>
      command === "git" ? ok("Updating a1b2c3d..e4f5g6h\nFast-forward\n") : ok("Done"),
    );
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(true);
    expect(result.reason).toBe("updated");
    expect(run).toHaveBeenCalledTimes(2);
    const [installCommand, installArgs] = run.mock.calls[1]!;
    expect(installCommand).toBe(pnpmExecutable());
    expect(installArgs).toEqual(["install"]);
  });

  it("does NOT report an update (so nothing restarts) when the dependency install fails after a successful pull", async () => {
    const run = vi.fn<SelfUpdateDeps["run"]>(async (command: string) =>
      command === "git"
        ? ok("Fast-forward\n")
        : ({ exitCode: 1, stdout: "", stderr: "ERR_PNPM_LOCKFILE_MISMATCH" } satisfies CommandOutcome),
    );
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("install_failed");
    expect(result.message).toMatch(/NOT restarted/);
  });

  it("reports git_failed, changing nothing, when the pull itself is rejected (e.g. local commits block a fast-forward)", async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "fatal: Not possible to fast-forward, aborting.",
    }));
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("git_failed");
    expect(result.message).toContain("fast-forward");
    // The pull failed, so the install must never have been attempted.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports git_unavailable rather than throwing when git cannot be started at all", async () => {
    const run = vi.fn(async () => {
      throw new Error("spawn git ENOENT");
    });
    const result = await performSelfUpdate(makeDeps({ run }));

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("git_unavailable");
    expect(result.message).toMatch(/git isn't available/i);
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
