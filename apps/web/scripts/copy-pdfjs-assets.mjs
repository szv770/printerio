// Copies the files pdf.js needs in the BROWSER into public/pdfjs (gitignored, rebuilt on every dev/build run).
// Without them pdf.js 6 cannot decode JBIG2 / JPEG 2000 scans or ICC-profiled images, and such pages draw as blank
// white (the booklet preview and the first-page thumbnail). It also needs the standard font data for documents that
// do not embed Helvetica/Times/Courier. See lib/pdf/pdfjs-options.ts for the URLs.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../package.json"));
const pkg = path.dirname(require.resolve("pdfjs-dist/package.json"));
const out = path.join(here, "../public/pdfjs");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "wasm"), { recursive: true });
for (const f of ["jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js", "qcms_bg.wasm"]) {
  const from = path.join(pkg, "wasm", f);
  if (!existsSync(from)) throw new Error(`pdfjs-dist is missing wasm/${f}; update scripts/copy-pdfjs-assets.mjs for this version`);
  cpSync(from, path.join(out, "wasm", f));
}
cpSync(path.join(pkg, "iccs"), path.join(out, "iccs"), { recursive: true });
cpSync(path.join(pkg, "standard_fonts"), path.join(out, "standard_fonts"), { recursive: true });
console.log("pdfjs assets copied to public/pdfjs");
