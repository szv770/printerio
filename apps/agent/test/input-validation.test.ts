import { describe, expect, it } from "vitest";
import { buildRawJob, sanitizePjlText } from "@printio/shared";
import {
  isSafeJobId,
  MAX_DOWNLOAD_BYTES,
  sanitizeLocalFileName,
  validateDownloadUrl,
  validateQueueName,
} from "../src/input-validation.js";
import { checkRawTarget } from "../src/raw-host-policy.js";

const UEL = "\x1b%-12345X";
const hostile = [
  "a\r\n@PJL SET COPIES=999",
  `${UEL}@PJL RDYMSG DISPLAY="pwn"`,
  "x\x1b%-12345Xy",
  '"\n@PJL JOB NAME="evil',
  "..\u005c..\u005cwindows\u005csystem32\u005cevil.pdf",
  "../../etc/passwd",
  "\u202Efdp.exe",
  "doc\u0000.pdf",
  "a".repeat(100_000),
  "ｆｕｌｌｗｉｄｔｈ\uFF0F..\uFF0F",
];

describe("PJL text (job names / user codes)", () => {
  it.each(hostile)("never lets control characters or PJL syntax through: %#", (h) => {
    const s = sanitizePjlText(h);
    expect(s).toMatch(/^[A-Za-z0-9 ._-]{1,60}$/);
    expect(s).not.toMatch(/[\r\n\x00-\x1f"=%]/);
  });
  it.each(hostile)("a hostile job name / user cannot add PJL lines to the raw job: %#", (h) => {
    const r = buildRawJob(
      { jobName: h, colorMode: "bw", copies: 1, duplex: false },
      new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = Buffer.from(r.bytes).toString("latin1");
    const pdfAt = text.indexOf("%PDF-");
    const head = text.slice(0, pdfAt);
    // The only ESC bytes are the two legitimate UELs the builder writes.
    expect(head.split("\x1b").length - 1).toBeLessThanOrEqual(2);
    for (const line of head.split(/\r?\n/)) {
      if (line.startsWith("\x1b%-12345X")) continue;
      expect(line === "" || line.startsWith("@PJL")).toBe(true);
    }
    expect((head.match(/@PJL/g) ?? []).length).toBeLessThan(20);
  });
});

describe("copies", () => {
  it.each([0, -1, 1.5, 1000, 1e9, NaN])("refuses copies=%s", (copies) => {
    expect(buildRawJob({ jobName: "x", colorMode: "bw", copies, duplex: false }, new TextEncoder().encode("%PDF-1.4")).ok).toBe(false);
  });
});

describe("isSafeJobId", () => {
  it.each(["3f2b8c1e-9d4a-4e6f-8a1b-2c3d4e5f6a7b", "job-1", "a".repeat(64)])("accepts %s", (id) => expect(isSafeJobId(id)).toBe(true));
  it.each(["", "../x", "a/b", "a\u005cb", "a b", "a\r\nb", "a".repeat(65), "x\u0000", ".", "..", "CON:", "é"])("rejects %j", (id) =>
    expect(isSafeJobId(id)).toBe(false),
  );
});

describe("sanitizeLocalFileName", () => {
  it.each(hostile)("always yields one safe path segment: %#", (h) => {
    const s = sanitizeLocalFileName(h);
    expect(s).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
    expect(s).not.toMatch(/^\.+$/);
    expect(s.endsWith(".")).toBe(false);
  });
  it("neutralises Windows reserved device names and traversal", () => {
    expect(sanitizeLocalFileName("CON")).not.toMatch(/^con(\.|$)/i);
    expect(sanitizeLocalFileName("nul.pdf")).not.toMatch(/^nul(\.|$)/i);
    expect(sanitizeLocalFileName("..")).toBe("job.pdf");
    expect(sanitizeLocalFileName("C:\u005cx\u005cy.pdf")).toBe("y.pdf");
    expect(sanitizeLocalFileName("")).toBe("job.pdf");
  });
});

describe("validateQueueName", () => {
  it.each(["Kyocera TASKalfa", "\\PRINTSRV\Kyocera MZ8500i", "Printio-Mono_1"])("accepts %s", (q) => expect(validateQueueName(q)).toBe(true));
  it.each(["-print-to-default", "--x", "a\r\nb", "a\x00b", "", "   ", "a".repeat(300), "q\x1b[0m"])("rejects %j", (q) =>
    expect(validateQueueName(q)).toBe(false),
  );
});

describe("validateDownloadUrl", () => {
  const ok = "https://qkaharfvjsrxdumazufe.supabase.co/storage/v1/object/sign/print-jobs/x.pdf?token=abc";
  it("accepts a normal https storage URL", () => expect(validateDownloadUrl(ok).ok).toBe(true));
  it.each([
    "http://qkaharfvjsrxdumazufe.supabase.co/x",
    "file:///C:/Windows/win.ini",
    "ftp://x/y",
    "https://user:pw@qkaharfvjsrxdumazufe.supabase.co/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.100.168/x",
    "https://10.0.0.1/x",
    "https://[::1]/x",
    "https://[::ffff:192.168.0.1]/x",
    "https://2130706433/x",
    "https://0x7f.1/x",
    "https://printer.local/x",
    "https://intranet/x",
    "not a url",
    "",
  ])("rejects %s", (u) => expect(validateDownloadUrl(u).ok).toBe(false));
  it("can be pinned to configured hosts", () => {
    expect(validateDownloadUrl(ok, { allowedHosts: ["qkaharfvjsrxdumazufe.supabase.co"] }).ok).toBe(true);
    expect(validateDownloadUrl("https://evil.example/x", { allowedHosts: ["qkaharfvjsrxdumazufe.supabase.co"] }).ok).toBe(false);
  });
  it("allows loopback http only when explicitly enabled (tests/dev)", () => {
    expect(validateDownloadUrl("http://127.0.0.1:8080/f.pdf", { allowLocal: true }).ok).toBe(true);
  });
  it("caps the download size at 120 MB", () => expect(MAX_DOWNLOAD_BYTES).toBe(120 * 1024 * 1024));
});

describe("raw host policy resists numeric-IP and rebinding tricks (no DNS needed for literal forms)", () => {
  const real = async (h: string) => {
    // Use the real resolver path: numeric forms are parsed by the OS, never reaching the network.
    const dns = await import("node:dns/promises");
    return (await dns.lookup(h, { all: true })).map((r) => r.address);
  };
  it.each(["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1", "017700000001", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "::1", "fe80::1", "[::1]"])(
    "refuses %s",
    async (host) => {
      expect((await checkRawTarget({ host, port: 9100 }, { lookup: real })).ok).toBe(false);
    },
  );
  it("a numeric form of a private address is connected to as its canonical dotted form", async () => {
    const r = await checkRawTarget({ host: "0xC0A80001", port: 9100 }, { lookup: real });
    if (r.ok) expect(r.host).toBe("192.168.0.1");
  });
  it("DNS rebinding: a name with one public and one private answer is refused; the checked address is what gets used", async () => {
    expect((await checkRawTarget({ host: "p.lan", port: 9100 }, { lookup: async () => ["192.168.1.5", "8.8.8.8"] })).ok).toBe(false);
    const r = await checkRawTarget({ host: "p.lan", port: 9100 }, { lookup: async () => ["192.168.1.5"] });
    expect(r).toEqual({ ok: true, host: "192.168.1.5", port: 9100 });
  });
  it.each([0, -1, 65536, 1.5, NaN])("refuses port %s", async (port) => {
    expect((await checkRawTarget({ host: "192.168.1.5", port }, {})).ok).toBe(false);
  });
});
