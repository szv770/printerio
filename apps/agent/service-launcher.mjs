#!/usr/bin/env node
/**
 * Launcher used ONLY by the installed Windows Service (see
 * src/windows-service.ts). Plain hand-written JS, not compiled - node-windows
 * (`fork(script, args, opts)` in its bundled wrapper.js) always forks this
 * exact file directly with the same `node` binary and no extra CLI flags,
 * so it has to be runnable with zero prior setup.
 *
 * Why this exists: `@printio/shared` (packages/shared/package.json) ships
 * its raw TypeScript source with no build step (`"exports": {".":
 * "./src/index.ts"}`) - `tsx` (and Vite/vitest, which is how `pnpm dev` and
 * `pnpm test` already work) transparently transforms that at import time,
 * but plain `node dist/index.js` cannot: Node's own ESM resolver has no
 * knowledge of TypeScript and fails trying to import a literal `.ts` file
 * (verified: `node dist/index.js` throws ERR_MODULE_NOT_FOUND resolving
 * `@printio/shared`'s own internal `./job-state.js` relative import, which
 * only has a `.ts` sibling on disk).
 *
 * node-windows' Service also offers a `nodeOptions` field (e.g. to pass
 * `--import tsx` to the outer node process), but that would only affect the
 * node-windows wrapper process itself - it forks the actual script via
 * plain `child_process.fork(script, args, { env })` with no `execArgv`
 * propagation (verified against the installed node-windows@1.0.0-beta.8
 * source), so a `--import` flag applied to the wrapper is NOT inherited by
 * our script. Registering tsx programmatically in-process, via tsx's own
 * `tsx/esm/api` (designed for exactly this "not launched via the tsx CLI"
 * case), sidesteps that entirely - verified working in this sandbox.
 *
 * Always forces the "start" command - a Windows Service should never
 * attempt register/install/uninstall.
 */
import { register } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath } from "node:url";

register();

process.argv[2] = "start";
const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "src", "index.ts"));
