import { describe, expect, it, vi } from "vitest";
import { buildIcaclsArgs, restrictStorageAcl } from "../src/storage-acl.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;

describe("buildIcaclsArgs", () => {
  it("removes inheritance and grants only SYSTEM and Administrators (by SID, so it works on any language of Windows)", () => {
    const args = buildIcaclsArgs("C:/ProgramData/Printio/Agent");
    expect(args[0]).toBe("C:/ProgramData/Printio/Agent");
    expect(args).toContain("/inheritance:r");
    expect(args).toContain("*S-1-5-18:(OI)(CI)F");
    expect(args).toContain("*S-1-5-32-544:(OI)(CI)F");
    // Users, Everyone, Authenticated Users are stripped.
    expect(args.join(" ")).toMatch(/\/remove:g \*S-1-5-32-545 \*S-1-1-0 \*S-1-5-11/);
  });
  it("also keeps the interactive user (dev runs) but never a machine account", () => {
    const u = "SCHOOL" + String.fromCharCode(92) + "teacher";
    expect(buildIcaclsArgs("D", u).join(" ")).toContain(`${u}:(OI)(CI)F`);
    expect(buildIcaclsArgs("D", "PRINTSRV$").join(" ")).not.toContain("PRINTSRV$");
  });
  it("refuses user names that could smuggle icacls syntax", () => {
    expect(buildIcaclsArgs("D", "a:(F) /grant x").join(" ")).not.toContain("a:(F)");
  });
});

describe("restrictStorageAcl", () => {
  it("does nothing off Windows", async () => {
    const run = vi.fn();
    expect(await restrictStorageAcl("/tmp/x", log, { platform: "linux", run })).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });
  it("runs icacls on Windows and reports applied", async () => {
    const run = vi.fn(async () => {});
    expect(await restrictStorageAcl("C:/x", log, { platform: "win32", run, user: "SYSTEM$" })).toBe("applied");
    expect(run).toHaveBeenCalledWith("icacls", expect.arrayContaining(["/inheritance:r"]));
  });
  it("never throws: a failing icacls is a warning, the agent keeps starting", async () => {
    const run = vi.fn(async () => {
      throw new Error("access denied");
    });
    expect(await restrictStorageAcl("C:/x", log, { platform: "win32", run })).toBe("failed");
  });
});
