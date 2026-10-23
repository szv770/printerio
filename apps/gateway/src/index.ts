/**
 * Printio IPP gateway entry point.
 *
 *   printio-gateway start              Run in the foreground (default).
 *   printio-gateway install-service    Install as an auto-restarting Windows Service.
 *   printio-gateway uninstall-service  Remove the Windows Service.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { JobRegistry } from "./job-registry.js";
import { createGatewayServer } from "./server.js";
import { createSupabaseStorage } from "./storage.js";
import { createWebClient } from "./web-client.js";
import { UploadGuard } from "./upload-guard.js";
import { installService, uninstallService } from "./windows-service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function start(): Promise<void> {
  // .env next to the package, whether running from src/ (tsx) or dist/.
  loadDotEnv({ path: path.join(here, "..", ".env"), quiet: true });
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const registry = new JobRegistry();
  const web = createWebClient({
    baseUrl: config.webBaseUrl,
    secret: config.sharedSecret,
    onWarn: (m, f) => logger.warn(m, f),
  });
  const storage = createSupabaseStorage(config.supabaseUrl, config.supabaseServiceRoleKey);
  const server = createGatewayServer({
    deps: { web, storage, logger, printerName: config.printerName, registry, startedAt: Date.now() },
    baseDomain: config.baseDomain,
    maxBodyBytes: config.maxBodyBytes,
    limits: config.limits,
    trustedProxies: config.trustedProxies,
    guard: new UploadGuard({ maxInflightBytes: config.maxInflightUploadBytes, maxPerKey: config.maxUploadsPerDevice }),
  });

  // The process must not die on a stray error: log it and keep serving (the service wrapper also restarts us if we do exit).
  process.on("uncaughtException", (err) => logger.error("uncaught exception", { error: err.stack ?? String(err) }));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { error: String(reason) }));

  const sweeper = setInterval(() => registry.sweep(), 60_000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => resolve());
  });
  logger.info("gateway listening", { port: config.port, baseDomain: config.baseDomain });

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    clearInterval(sweeper);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const logger = createLogger("info");
  switch (command) {
    case "start":
      return start();
    case "install-service":
      return installService(logger);
    case "uninstall-service":
      return uninstallService(logger);
    default:
      console.error(`Unknown command "${command}". Use: start | install-service | uninstall-service`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
