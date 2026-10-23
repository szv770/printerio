import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectLogs, maskSecrets, MAX_RESULT_BYTES, MAX_LINES_PER_FILE } from "../src/log-collector.js";

const TOKEN = "u-" + "abcdefghijklmnopqrstuvwxyz234567abcdefg".slice(0, 39);

describe("maskSecrets", () => {
  it("masks device tokens (u-<39 chars>) like the gateway logger", () => {
    expect(TOKEN).toHaveLength(41);
    expect(maskSecrets(`host=${TOKEN}.print.example.com`)).toBe("host=u-<token>.print.example.com");
  });

  it("masks Bearer credentials but keeps the word", () => {
    expect(maskSecrets("Authorization: Bearer agent-1.abcDEF123secret")).toBe("Authorization: Bearer ***");
    expect(maskSecrets("authorization: bearer xyz")).toBe("authorization: Bearer ***");
  });

  it("masks long hex strings (>= 32) and long base64-ish secrets, but not short ids", () => {
    const hex = "0123456789abcdef0123456789abcdef01";
    const b64 = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg+/==";
    expect(maskSecrets(`secret ${hex} end`)).toBe("secret *** end");
    expect(maskSecrets(`key=${b64.replace("+/==", "")}`)).toBe("key=***");
    expect(maskSecrets("job 12345678 queue Kyocera_Main")).toBe("job 12345678 queue Kyocera_Main");
  });

  it("keeps UUIDs readable (job ids matter when debugging)", () => {
    const uuid = "3f2a1b9c-8c4d-4e2f-9a1b-0123456789ab";
    expect(maskSecrets(`job ${uuid} failed`)).toBe(`job ${uuid} failed`);
  });

  it("masks Supabase keys: eyJ... JWTs and sb_secret_...", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abc_DEF-123";
    expect(maskSecrets(`SUPABASE_SERVICE_ROLE_KEY=${jwt}`)).toBe("SUPABASE_SERVICE_ROLE_KEY=***");
    expect(maskSecrets("key sb_secret_AbCd1234 here")).toBe("key *** here");
    expect(maskSecrets("eyJshort")).toBe("***");
  });

  it("masks every occurrence on a line", () => {
    expect(maskSecrets(`${TOKEN} and ${TOKEN}`)).toBe("u-<token> and u-<token>");
  });
});

describe("collectLogs", () => {
  let root: string;
  let storage: string;
  const NOW = new Date("2026-10-23T12:00:00.000Z");
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "printio-logs-test-"));
    storage = path.join(root, "storage");
    mkdirSync(path.join(storage, "logs"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
  const daemon = (app: string) => path.join(root, "apps", app, "daemon");

  it("returns the LAST ~300 lines of today's agent log, masked", () => {
    writeFileSync(path.join(storage, "logs", "agent-2026-10-23.log"), lines(500) + `token ${TOKEN}\n`);
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    const f = r.files.find((x) => x.name.includes("agent-2026-10-23.log"))!;
    expect(f.lines).toHaveLength(MAX_LINES_PER_FILE);
    expect(f.lines.at(-1)).toBe("token u-<token>");
    expect(f.lines[0]).toBe("line 202");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("falls back to the newest agent log (with a note) when there is none for today", () => {
    writeFileSync(path.join(storage, "logs", "agent-2026-10-20.log"), "old\n");
    writeFileSync(path.join(storage, "logs", "agent-2026-10-22.log"), "newer\n");
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    expect(r.files[0]!.name).toContain("agent-2026-10-22.log");
    expect(r.notes.join(" ")).toMatch(/no agent log for today/i);
  });

  it("includes the newest daemon *.log of the agent and the gateway, and notes the ones that are missing", () => {
    mkdirSync(daemon("agent"), { recursive: true });
    writeFileSync(path.join(daemon("agent"), "old.out.log"), "old agent\n");
    writeFileSync(path.join(daemon("agent"), "new.err.log"), "new agent err\n");
    utimesSync(path.join(daemon("agent"), "old.out.log"), new Date("2026-10-01"), new Date("2026-10-01"));
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    const names = r.files.map((x) => x.name);
    expect(names.some((n) => n.includes("new.err.log"))).toBe(true);
    expect(names.some((n) => n.includes("old.out.log"))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/gateway/i);
  });

  it("never lists anything outside its fixed locations (a hostile storage path layout cannot be steered by input)", () => {
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    expect(r.files).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("caps the whole result at ~60 KB and each file below that, keeping the newest lines", () => {
    const long = "x".repeat(900);
    const big = Array.from({ length: 3000 }, (_, i) => `${i} ${long}`).join("\n") + "\n";
    writeFileSync(path.join(storage, "logs", "agent-2026-10-23.log"), big);
    mkdirSync(daemon("agent"), { recursive: true });
    mkdirSync(daemon("gateway"), { recursive: true });
    writeFileSync(path.join(daemon("agent"), "a.out.log"), big);
    writeFileSync(path.join(daemon("gateway"), "g.out.log"), big);
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    const total = r.files.reduce((n, f) => n + Buffer.byteLength(f.lines.join("\n")), 0);
    expect(total).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(MAX_RESULT_BYTES + 8 * 1024);
    for (const f of r.files) expect(f.lines.at(-1)).toMatch(/^\d+ x+/);
    expect(r.files.every((f) => f.lines.length > 0)).toBe(true);
    // the newest line of the first file survives
    expect(r.files[0]!.lines.at(-1)!.startsWith("2999 ")).toBe(true);
  });

  it("truncates a single enormous line instead of returning it whole", () => {
    writeFileSync(path.join(storage, "logs", "agent-2026-10-23.log"), "y".repeat(200_000) + "\n");
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    expect(r.files[0]!.lines[0]!.length).toBeLessThan(5000);
  });

  it("reads only the tail of a huge file (does not load it whole)", () => {
    const p = path.join(storage, "logs", "agent-2026-10-23.log");
    writeFileSync(p, "z".repeat(5_000_000) + "\nlast line\n");
    const r = collectLogs({ localStoragePath: storage, repoRoot: root, now: NOW });
    expect(r.files[0]!.lines.at(-1)).toBe("last line");
  });
});
