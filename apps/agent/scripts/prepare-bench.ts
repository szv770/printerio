/**
 * Times the print server's PDF preparation on REAL files (docs/PREPARE-JOBS-DESIGN.md, step 7). Nothing here touches the website, the database or a printer:
 * it reads PDFs from a folder, runs the same `preparePdf` the print server runs for a prepare job, and prints a table.
 *
 *   pnpm --filter @printio/agent exec tsx scripts/prepare-bench.ts <folder-with-pdfs> [--out <folder-for-results>]
 *
 * Per file it runs: plain, pages 1-3, booklet (left binding), booklet (right binding). The clock is frozen, so a result's fingerprint (sha256) is the same
 * every run and on every machine: send the table to compare this server against another machine. `--out` also saves each prepared file so you can open it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { preparePdf } from "@printio/pdf/prepare";

// pdf-lib writes the current time into every file it saves; freezing it makes the fingerprints comparable.
const FIXED = new Date("2026-01-01T00:00:00.000Z").getTime();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    // @ts-expect-error spreading into the Date constructor is fine here
    super(...(args.length === 0 ? [FIXED] : args));
  }
  static override now() {
    return FIXED;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
const folder = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
if (!folder) {
  console.error("Usage: tsx scripts/prepare-bench.ts <folder-with-pdfs> [--out <folder>]");
  process.exit(2);
}
if (outDir) mkdirSync(outDir, { recursive: true });

const scenarios = [
  { name: "plain", pageRangeText: null as string | null, booklet: false, side: "left" as const },
  { name: "pages 1-3", pageRangeText: "1-3", booklet: false, side: "left" as const },
  { name: "booklet L", pageRangeText: null, booklet: true, side: "left" as const },
  { name: "booklet R", pageRangeText: null, booklet: true, side: "right" as const },
];

const logger = { warn: () => undefined, error: (m: string) => console.error("  ! " + m) };
const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
if (files.length === 0) {
  console.error(`No .pdf files in ${folder}`);
  process.exit(2);
}

console.log(`Node ${process.versions.node}, ${process.platform}. Clock frozen for the fingerprints.\n`);
const rows: string[][] = [["file", "size", "run", "seconds", "result", "fingerprint"]];
let slowest = 0;
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(folder, f)));
  const size = `${(statSync(join(folder, f)).size / 1024 / 1024).toFixed(1)} MB`;
  for (const s of scenarios) {
    const t0 = performance.now();
    let result;
    try {
      result = await preparePdf({
        originalBytes: bytes,
        maxUploadBytes: 200 * 1024 * 1024,
        colorMode: "bw",
        heldReason: null,
        pageRangeText: s.pageRangeText,
        booklet: s.booklet,
        bookletOptions: { paperSize: "letter", bindingSide: s.side, fit: "fill", sheet: "letter" },
        confirmBookletPadding: true,
        stamp: null,
        allowType3Fonts: false,
        logContext: {},
        logger,
      });
    } catch (err) {
      rows.push([f, size, s.name, ((performance.now() - t0) / 1000).toFixed(1), `CRASH: ${err instanceof Error ? err.message : String(err)}`, "-"]);
      continue;
    }
    const secs = (performance.now() - t0) / 1000;
    slowest = Math.max(slowest, secs);
    let summary: string;
    let print = "-";
    if (result.ok) {
      summary = `${result.sourcePages} pages${result.pictureCopy ? ", picture copy" : ""}${result.held ? ", held" : ""}, ${result.derivedBytes ? `${(result.derivedBytes.length / 1024).toFixed(0)} KB prepared` : "original as is"}`;
      if (result.derivedBytes) {
        print = createHash("sha256").update(result.derivedBytes).digest("hex").slice(0, 12);
        if (outDir) writeFileSync(join(outDir, `${f.replace(/\.pdf$/i, "")} - ${s.name}.pdf`), result.derivedBytes);
      }
    } else {
      summary = result.kind === "error" ? `error: ${result.error}` : "asks to confirm blank pages";
    }
    rows.push([f, size, s.name, secs.toFixed(1), summary, print]);
  }
}

const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  "));
console.log(`\nSlowest single run: ${slowest.toFixed(1)} s. The print server's limit is 60 s per file; the target is about 10 s.`);
