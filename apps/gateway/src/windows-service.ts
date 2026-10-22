/**
 * Windows Service install/uninstall via `node-windows` (same approach as apps/agent/src/windows-service.ts).
 * `node-windows` is an optionalDependency so `pnpm install` never fails on non-Windows machines; it is loaded
 * dynamically only when install-service/uninstall-service runs.
 *
 * UNTESTED on a real Windows machine (this repo's sandbox has none): verify with README "Windows service".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

const SERVICE_NAME = "Printio IPP Gateway";
const SERVICE_DESCRIPTION = "Printio IPP gateway - receives print jobs from Windows/Android print dialogs and hands them to Printio.";

interface NodeWindowsServiceInstance {
  on(event: "install" | "uninstall" | "alreadyinstalled" | "error", cb: (err?: unknown) => void): void;
  install(): void;
  uninstall(): void;
  start(): void;
}

interface NodeWindowsServiceConstructor {
  new (options: { name: string; description: string; script: string }): NodeWindowsServiceInstance;
}

async function loadNodeWindows(): Promise<{ Service: NodeWindowsServiceConstructor }> {
  try {
    // Variable specifier on purpose: node-windows is optional and untyped; a literal import would break typecheck.
    const moduleName = "node-windows";
    return (await import(moduleName)) as unknown as { Service: NodeWindowsServiceConstructor };
  } catch (err) {
    throw new Error(
      "node-windows is not installed or failed to load. On Windows, run `pnpm --filter @printio/gateway add node-windows` " +
        `(or re-run \`pnpm install\` on Windows) first. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function launcherPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "service-launcher.mjs");
}

/** Best-effort: tell the Service Control Manager to restart the service after a crash/exit. */
function configureFailureRecovery(logger: Logger): void {
  try {
    const child = spawn(
      "sc.exe",
      ["failure", SERVICE_NAME, "reset=", "86400", "actions=", "restart/5000/restart/15000/restart/60000"],
      { windowsHide: true },
    );
    child.on("error", (err) => logger.warn("could not configure service failure-recovery (sc.exe failure)", { error: String(err) }));
  } catch (err) {
    logger.warn("could not configure service failure-recovery (sc.exe failure)", { error: String(err) });
  }
}

export async function installService(logger: Logger): Promise<void> {
  const { Service } = await loadNodeWindows();
  const svc = new Service({ name: SERVICE_NAME, description: SERVICE_DESCRIPTION, script: launcherPath() });
  await new Promise<void>((resolve, reject) => {
    svc.on("install", () => {
      logger.info("service installed - starting it now");
      configureFailureRecovery(logger);
      svc.start();
      resolve();
    });
    svc.on("alreadyinstalled", () => {
      logger.warn("service was already installed - not re-installing");
      resolve();
    });
    svc.on("error", (err) => reject(new Error(`node-windows install failed: ${String(err)}`)));
    svc.install();
  });
}

export async function uninstallService(logger: Logger): Promise<void> {
  const { Service } = await loadNodeWindows();
  const svc = new Service({ name: SERVICE_NAME, description: SERVICE_DESCRIPTION, script: launcherPath() });
  await new Promise<void>((resolve, reject) => {
    svc.on("uninstall", () => {
      logger.info("service uninstalled");
      resolve();
    });
    svc.on("error", (err) => reject(new Error(`node-windows uninstall failed: ${String(err)}`)));
    svc.uninstall();
  });
}
