#!/usr/bin/env node
/**
 * CLI entrypoint. Commands:
 *   printos-agent register --code=<enrollmentCode>
 *   printos-agent start
 *   printos-agent install-service
 *   printos-agent uninstall-service
 */

import path from "node:path";
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
import { ConfigError } from "./errors.js";
import { AGENT_VERSION } from "./version.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

function printUsage(): void {
  console.log(`printos-agent v${AGENT_VERSION}

Usage:
  printos-agent register --code=<enrollmentCode>   One-time: exchange an enrollment code for a device credential.
  printos-agent start                              Run the agent (foreground/console mode).
  printos-agent install-service                    Install as a Windows Service (best-effort - see README).
  printos-agent uninstall-service                  Remove the Windows Service.

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
        "Run `printos-agent start`, or `printos-agent install-service`, to begin.",
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
      "No agent credentials found. Run `printos-agent register --code=<enrollmentCode>` first " +
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
