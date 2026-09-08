#!/usr/bin/env node
/**
 * CLI entrypoint. Commands:
 *   printio-agent register --code=<enrollmentCode>
 *   printio-agent start
 *   printio-agent install-service
 *   printio-agent uninstall-service
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { CloudClient } from "./cloud-client.js";
import { saveCredentials, loadCredentials } from "./secure-storage.js";
import { createJobQueue } from "./job-queue.js";
import { createPrinterManager } from "./printer-manager.js";
import { createSpoolerMonitor } from "./spooler-monitor.js";
import { createHealthMonitor } from "./health-monitor.js";
import { createOrchestrator } from "./orchestrator.js";
import { installService, uninstallService } from "./windows-service.js";
import { verifyStartupDependencies } from "./dependency-check.js";
import { ConfigError } from "./errors.js";
import { AGENT_VERSION } from "./version.js";

// Load a `.env` file sitting next to this package (apps/agent/.env), if one
// exists - resolved relative to this file's own location (not process.cwd(),
// which differs depending on how this was invoked: `pnpm --filter` vs a
// packaged `node dist/index.js`), so it works the same way regardless of
// invocation. dotenv's default behavior never overrides a variable already
// present in process.env, so a real Windows Service environment variable
// still wins - a .env file is purely a console-mode/dev convenience, exactly
// as already documented (docs/agent-install.md sec 4, apps/agent/.env.example),
// and silently does nothing if the file doesn't exist (the normal case for a
// Windows Service, which sets real environment variables instead). Must run
// before loadConfig() is ever called, but after the other imports above -
// none of them read process.env at import time, only loadConfig() does, and
// only when a command handler actually calls it.
loadDotEnv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

function printUsage(): void {
  console.log(`printio-agent v${AGENT_VERSION}

Usage:
  printio-agent register --code=<enrollmentCode>   One-time: exchange an enrollment code for a device credential.
  printio-agent start                              Run the agent (foreground/console mode).
  printio-agent install-service                    Install as a Windows Service (best-effort - see README).
  printio-agent uninstall-service                  Remove the Windows Service.

Configuration is read from environment variables - see .env.example.
`);
}

async function runRegister(args: Record<string, string>): Promise<void> {
  const code = args.code;
  if (!code) {
    console.error("Missing --code=<enrollmentCode>. See docs/agent-api.md POST /api/agents/register.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, logDir: path.join(config.localStoragePath, "logs") });
  const cloudClient = new CloudClient({ apiUrl: config.apiUrl, logger });

  try {
    const res = await cloudClient.register(code);
    await saveCredentials(config.localStoragePath, {
      agentId: res.agentId,
      deviceSecret: res.deviceSecret,
      organizationId: res.organizationId,
    }, logger);
    console.log(
      `Registered successfully.\n  agentId: ${res.agentId}\n  organizationId: ${res.organizationId}\n` +
        "Device credentials were stored securely (see README 'Secure storage'). " +
        "Run `printio-agent start`, or `printio-agent install-service`, to begin.",
    );
  } catch (err) {
    logger.error("registration failed", { error: err instanceof Error ? err.message : String(err) });
    console.error(`Registration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runStart(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, logDir: path.join(config.localStoragePath, "logs") });

  // Verify the dependencies the Agent cannot do its job without BEFORE it
  // starts polling for work - see dependency-check.ts for why this runs here
  // (earliest possible moment, needs nothing but config) and why a failure
  // refuses to start rather than starting in a degraded mode that would
  // claim real jobs it is guaranteed to fail. This is also the installed
  // Windows Service's path: service-launcher.mjs forces the `start` command
  // and imports this same entry point, so there is exactly one place this
  // check can be bypassed from, and it isn't a second code path.
  const dependencyCheck = await verifyStartupDependencies(
    { sumatraPath: config.sumatraPath, skip: config.skipDependencyCheck },
    logger,
  );
  if (!dependencyCheck.ok) {
    process.exitCode = 1;
    return;
  }

  let agentId = config.agentId;
  let deviceSecret = config.deviceSecret;
  if (!agentId || !deviceSecret) {
    const stored = await loadCredentials(config.localStoragePath, logger);
    if (stored) {
      agentId = stored.agentId;
      deviceSecret = stored.deviceSecret;
    }
  }
  if (!agentId || !deviceSecret) {
    console.error(
      "No agent credentials found. Run `printio-agent register --code=<enrollmentCode>` first " +
        "(see docs/agent-api.md POST /api/agents/register).",
    );
    process.exitCode = 1;
    return;
  }

  const cloudClient = new CloudClient({ apiUrl: config.apiUrl, agentId, deviceSecret, logger });
  const jobQueue = createJobQueue(config.localStoragePath, logger);
  const printerManager = createPrinterManager(config.localStoragePath, logger);
  const spoolerMonitor = createSpoolerMonitor(config.localStoragePath, logger);
  const healthMonitor = createHealthMonitor(cloudClient, printerManager, logger);

  const orchestrator = createOrchestrator({
    config,
    cloudClient,
    jobQueue,
    printerManager,
    spoolerMonitor,
    healthMonitor,
    logger,
  });

  const shutdown = (signal: string) => {
    logger.info(`received ${signal} - shutting down`);
    orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A truly unexpected top-level failure here is a startup/process-level
  // condition (not a per-job one - those are all caught inside
  // orchestrator.ts per docs/architecture.md sec 17), so it is allowed to
  // exit the process; the Windows Service Recovery options (README) are
  // what bring it back.
  await orchestrator.start();
}

async function runInstallService(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, logDir: path.join(config.localStoragePath, "logs") });
  await installService(logger);
}

async function runUninstallService(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, logDir: path.join(config.localStoragePath, "logs") });
  await uninstallService(logger);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    switch (command) {
      case "register":
        await runRegister(args);
        return;
      case "start":
        await runStart();
        return;
      case "install-service":
        await runInstallService();
        return;
      case "uninstall-service":
        await runUninstallService();
        return;
      default:
        printUsage();
        process.exitCode = command ? 1 : 0;
        return;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
    } else {
      console.error(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

main();
