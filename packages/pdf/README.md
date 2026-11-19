# @printio/pdf

Portable PDF processing for Printio: preflight and sanitize, active-content and Type 3 font checks, page ranges,
booklet imposition and cropping, the user-code stamp, and the text-fidelity safeguard (Hebrew and other non-Latin text
must come out unchanged). Also the bundled booklet fonts (`src/fonts`) and test fixtures (`src/test-support`).

**Why a separate package:** the website will run on Cloudflare's free plan, which cannot do heavy PDF work, so this
code has to run on each organization's print server (the Agent) as well as in the website. It therefore imports no
framework, no database and no `server-only` marker (see `docs/SAAS-LAUNCH-PLAN.md`, work packages P0-P4).

- Consumed as TypeScript source, like `@printio/shared` (`"./*": "./src/*.ts"`): `import { preflightPdf } from "@printio/pdf/preflight"`.
- Browser-only PDF helpers (`render-page`, `client-precheck`, `direct-upload`, `pdfjs-options`) stay in `apps/web/lib/pdf`.
- Tests: `pnpm --filter @printio/pdf test`. Test PDFs that compare bytes must freeze `Date` (pdf-lib stamps the time).
- Moved here with `git mv`, so `git log --follow` still shows each file's history.
