#!/usr/bin/env node
/**
 * Launcher used ONLY by the installed Windows Service (see src/windows-service.ts).
 *
 * Same reason as apps/agent/service-launcher.mjs: `@printio/shared` ships raw TypeScript, which plain
 * `node dist/index.js` cannot import, and node-windows forks this exact file with no extra flags. So tsx is
 * registered programmatically (tsx/esm/api) and the TypeScript entry is imported. Always forces "start".
 */
import { register } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entryUrl } from "./service-entry.mjs";

register();

process.argv[2] = "start";
const here = path.dirname(fileURLToPath(import.meta.url));
await import(entryUrl(here));
