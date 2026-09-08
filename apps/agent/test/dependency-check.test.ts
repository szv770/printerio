import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProbeArgs,
  checkSumatraInvocable,
  classifyProbeFailure,
  formatDependencyFailureBanner,
  isBareExecutableName,
  looksLikeWindowsExecutable,
  readHeadBytes,
  resolveOnPath,
  syntheticProbeQueueName,
  verifyStartupDependencies,
  type ProbeOutcome,
  type SumatraCheckDeps,
} from "../src/dependency-check.js";
import { createLogger, type Logger } from "../src/logger.js";

const silentLogger = createLogger({ level: "error" });

/** A logger that records what it was told, so "was this logged loudly?" is assertable. */
function recordingLogger(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const make = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  const logger = {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

const MZ = Buffer.from([0x4d, 0x5a]);

function makeDeps(overrides: Partial<SumatraCheckDeps> = {}): SumatraCheckDeps {
  return {
    probe: vi.fn(async (): Promise<ProbeOutcome> => ({ started: true, exitCode: 1 })),
    readHeadBytes: () => MZ,
    resolveOnPath: (name) => `C:\\Program Files\\${name}`,
    ...overrides,
  };
}

describe("looksLikeWindowsExecutable", () => {
  it("accepts the DOS/PE 'MZ' magic every Windows .exe starts with", () => {
    expect(looksLikeWindowsExecutable(MZ)).toBe(true);
    expect(looksLikeWindowsExecutable(Buffer.from("MZ\u0090\u0000", "latin1"))).toBe(true);
  });

  it("rejects the things a broken 'download' actually turns out to be", () => {
    // The exact shape of this repo's own SumatraPDF 404 incident: an HTML
    // error page written to disk under an .exe name.
    expect(looksLikeWindowsExecutable(Buffer.from("<!DOCTYPE html>", "utf8"))).toBe(false);
    expect(looksLikeWindowsExecutable(Buffer.alloc(0))).toBe(false);
    expect(looksLikeWindowsExecutable(Buffer.from([0x4d]))).toBe(false);
    expect(looksLikeWindowsExecutable(undefined)).toBe(false);
  });
});

describe("classifyProbeFailure", () => {
  it("maps a missing executable to not_found", () => {
    expect(classifyProbeFailure("ENOENT")).toBe("not_found");
  });

  it("maps Windows' 'not a valid Win32 application' to not_executable, by code or by message", () => {
    expect(classifyProbeFailure("EFTYPE")).toBe("not_executable");
    expect(classifyProbeFailure("ENOEXEC")).toBe("not_executable");
    expect(classifyProbeFailure("UNKNOWN", "%1 is not a valid Win32 application.")).toBe("not_executable");
    expect(classifyProbeFailure("UNKNOWN", "Bad EXE format for foo.exe")).toBe("not_executable");
  });

  it("maps permission problems, and anything unrecognized, to cannot_start rather than guessing", () => {
    expect(classifyProbeFailure("EACCES")).toBe("cannot_start");
    expect(classifyProbeFailure("EPERM")).toBe("cannot_start");
    expect(classifyProbeFailure(undefined)).toBe("cannot_start");
    expect(classifyProbeFailure("ESOMETHINGNEW", "who knows")).toBe("cannot_start");
  });
});

describe("isBareExecutableName", () => {
  it("treats config.ts's default as a PATH lookup and a real path as a path", () => {
    expect(isBareExecutableName("SumatraPDF.exe")).toBe(true);
    expect(isBareExecutableName("C:\\ProgramData\\Printio\\SumatraPDF-64.exe")).toBe(false);
    expect(isBareExecutableName("/usr/bin/sumatra")).toBe(false);
  });
});

describe("the probe argv", () => {
  it("can never print anything: a nonexistent file, -silent, and a queue that isn't real", () => {
    const args = buildProbeArgs("C:\\Temp\\nope.pdf", "printio-startup-probe-abcd1234");
    expect(args).toEqual(["-print-to", "printio-startup-probe-abcd1234", "-silent", "C:\\Temp\\nope.pdf"]);
    // -silent is what keeps a GUI app from popping a modal dialog, which
    // under a Windows Service account is a hang rather than an exit.
    expect(args).toContain("-silent");
  });

  it("uses a fresh synthetic queue name each call, so it can never collide with a real queue", () => {
    const names = new Set(Array.from({ length: 50 }, () => syntheticProbeQueueName()));
    expect(names.size).toBeGreaterThan(45);
    for (const name of names) expect(name).toMatch(/^printio-startup-probe-[a-z0-9]+$/);
  });
});

describe("checkSumatraInvocable", () => {
  it("passes when the process starts, regardless of its exit code", async () => {
    // A non-zero exit is EXPECTED here - the probe deliberately points
    // SumatraPDF at a file that does not exist. Only "did Windows load and
    // run this image" is being tested.
    const result = await checkSumatraInvocable(
      "SumatraPDF.exe",
      makeDeps({ probe: async () => ({ started: true, exitCode: 2 }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.startedProcess).toBe(true);
  });

  it("passes when the process had to be killed on timeout - it still proved it can run", async () => {
    const result = await checkSumatraInvocable(
      "SumatraPDF.exe",
      makeDeps({ probe: async () => ({ started: true, killedAfterTimeoutMs: 10_000 }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.killedAfterTimeoutMs).toBe(10_000);
    expect(result.detail).toMatch(/runnable/i);
  });

  it("reports not_found - without spawning anything - when a bare name isn't on PATH", async () => {
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ started: true }));
    const result = await checkSumatraInvocable(
      "SumatraPDF.exe",
      makeDeps({ resolveOnPath: () => undefined, probe }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_found");
    expect(result.detail).toMatch(/not on this machine's PATH/);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports not_found when an explicit PRINTIO_SUMATRA_PATH points at nothing", async () => {
    const result = await checkSumatraInvocable("C:\\nope\\SumatraPDF.exe", makeDeps());
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_found");
    expect(result.detail).toMatch(/no file exists there/);
  });

  it("catches a corrupt download that a file-existence check would have called 'found'", async () => {
    // This is the whole reason this module is not a Test-Path equivalent.
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-"));
    try {
      const fake = path.join(dir, "SumatraPDF-64.exe");
      writeFileSync(fake, "<!DOCTYPE html><html><body>404 Not Found</body></html>");
      const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ started: true }));
      const result = await checkSumatraInvocable(fake, makeDeps({ readHeadBytes, probe }));
      expect(result.ok).toBe(false);
      expect(result.status).toBe("not_executable");
      expect(result.detail).toMatch(/not a Windows program/);
      // Never try to run something we already know is not an executable.
      expect(probe).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports not_executable when the file has an MZ header but Windows still refuses the image", async () => {
    // A wrong-architecture build (an ARM64 exe on x64, say) has a perfectly
    // good MZ header and only fails at CreateProcess time - so the spawn
    // failure has to be classified too, not just the header.
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-arch-"));
    try {
      const exe = path.join(dir, "SumatraPDF-64.exe");
      writeFileSync(exe, MZ);
      const result = await checkSumatraInvocable(
        exe,
        makeDeps({
          readHeadBytes,
          probe: async () => ({
            started: false,
            errorCode: "UNKNOWN",
            errorMessage: "spawn UNKNOWN: %1 is not a valid Win32 application.",
          }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe("not_executable");
      expect(result.detail).toMatch(/wrong processor architecture|not a valid program/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports cannot_start (not a corrupt-file verdict) when the OS refuses for a permissions reason", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-perm-"));
    try {
      const exe = path.join(dir, "SumatraPDF-64.exe");
      writeFileSync(exe, MZ);
      const result = await checkSumatraInvocable(
        exe,
        makeDeps({
          readHeadBytes,
          probe: async () => ({ started: false, errorCode: "EACCES", errorMessage: "permission denied" }),
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe("cannot_start");
      expect(result.detail).toMatch(/permission denied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the probe itself blows up - it reports cannot_start with the reason", async () => {
    const result = await checkSumatraInvocable(
      "SumatraPDF.exe",
      makeDeps({
        probe: async () => {
          throw new Error("something unexpected");
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("cannot_start");
    expect(result.detail).toMatch(/something unexpected/);
  });
});

describe("readHeadBytes", () => {
  it("reads the first bytes of a real file and reports undefined for a missing one or a directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-head-"));
    try {
      const f = path.join(dir, "x.bin");
      writeFileSync(f, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
      expect(readHeadBytes(f, 2)).toEqual(MZ);
      expect(readHeadBytes(path.join(dir, "missing.bin"), 2)).toBeUndefined();
      expect(readHeadBytes(dir, 2)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a short buffer (not a padded one) for a file smaller than requested", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-short-"));
    try {
      const f = path.join(dir, "one.bin");
      writeFileSync(f, Buffer.from([0x4d]));
      const head = readHeadBytes(f, 2);
      expect(head?.length).toBe(1);
      expect(looksLikeWindowsExecutable(head)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOnPath", () => {
  it("finds an executable across PATH entries", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-path-"));
    try {
      const exe = path.join(dir, "SumatraPDF.exe");
      writeFileSync(exe, MZ);
      const env = { PATH: ["/definitely/not/here", dir].join(path.delimiter) };
      expect(resolveOnPath("SumatraPDF.exe", env, "linux")).toBe(exe);
      expect(resolveOnPath("NotThere.exe", env, "linux")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends PATHEXT extensions on Windows for a name with no extension", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "printio-depcheck-pathext-"));
    try {
      writeFileSync(path.join(dir, "thing.CMD"), "x");
      const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
      expect(resolveOnPath("thing", env, "win32")).toBe(path.join(dir, "thing.CMD"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined instead of throwing when PATH is absent entirely", () => {
    expect(resolveOnPath("SumatraPDF.exe", {}, "win32")).toBeUndefined();
  });
});

describe("formatDependencyFailureBanner", () => {
  it("is a visually distinct block, not a JSON log line, and says what/why/how-to-fix", () => {
    const banner = formatDependencyFailureBanner({
      ok: false,
      status: "not_found",
      configuredPath: "SumatraPDF.exe",
      detail: "nothing was found to run",
      startedProcess: false,
    });
    expect(banner).toContain("======");
    expect(banner).toContain("PRINTIO PRINT AGENT DID NOT START");
    expect(banner).toContain("nothing was found to run");
    expect(banner).toContain("setup-agent.bat");
    expect(banner).toContain("docs/agent-install.md");
    expect(() => JSON.parse(banner)).toThrow();
  });

  it("explains the bare-name case as a PATH lookup rather than printing a bogus 'path'", () => {
    const banner = formatDependencyFailureBanner({
      ok: false,
      status: "not_found",
      configuredPath: "SumatraPDF.exe",
      detail: "x",
      startedProcess: false,
    });
    expect(banner).toMatch(/PRINTIO_SUMATRA_PATH is not set/);
  });

  it("shows the configured path verbatim when one was set", () => {
    const banner = formatDependencyFailureBanner({
      ok: false,
      status: "not_executable",
      configuredPath: "C:\\ProgramData\\Printio\\SumatraPDF-64.exe",
      detail: "x",
      startedProcess: false,
    });
    expect(banner).toContain("PRINTIO_SUMATRA_PATH=C:\\ProgramData\\Printio\\SumatraPDF-64.exe");
  });
});

describe("verifyStartupDependencies", () => {
  it("lets the Agent proceed, and logs the resolved path, when SumatraPDF is invocable", async () => {
    const { logger, lines } = recordingLogger();
    const result = await verifyStartupDependencies({ sumatraPath: "SumatraPDF.exe" }, logger, makeDeps());
    expect(result.ok).toBe(true);
    expect(lines.some((l) => l.level === "info" && /dependency check passed/.test(l.msg))).toBe(true);
    expect(lines.some((l) => l.level === "error")).toBe(false);
  });

  it("refuses (ok:false) and logs at error level when SumatraPDF is not invocable", async () => {
    const { logger, lines } = recordingLogger();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await verifyStartupDependencies(
        { sumatraPath: "SumatraPDF.exe" },
        logger,
        makeDeps({ resolveOnPath: () => undefined }),
      );
      expect(result.ok).toBe(false);
      expect(result.sumatra?.status).toBe("not_found");
      // Loud on the console AND in the structured log file - not one or the other.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("PRINTIO PRINT AGENT DID NOT START");
      expect(lines.some((l) => l.level === "error" && /refusing to start/.test(l.msg))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("honours the documented escape hatch, but says loudly that it did", async () => {
    const { logger, lines } = recordingLogger();
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ started: true }));
    const result = await verifyStartupDependencies(
      { sumatraPath: "SumatraPDF.exe", skip: true },
      logger,
      makeDeps({ resolveOnPath: () => undefined, probe }),
    );
    expect(result.ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(lines.some((l) => l.level === "warn" && /PRINTIO_SKIP_DEPENDENCY_CHECK/.test(l.msg))).toBe(true);
  });

  it("works with the real production deps wiring (no injection) without throwing", async () => {
    // Guards against createSumatraCheckDeps() drifting out of shape - this
    // runs on Linux in CI, where SumatraPDF.exe genuinely is not on PATH, so
    // the expected outcome is a clean, honest refusal rather than a crash.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await verifyStartupDependencies({ sumatraPath: "SumatraPDF.exe" }, silentLogger);
      expect(typeof result.ok).toBe("boolean");
    } finally {
      spy.mockRestore();
    }
  });
});
