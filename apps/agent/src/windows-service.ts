/**
 * Windows Service install/uninstall via `node-windows`. Declared as an
 * `optionalDependency` in package.json (see NOTE there) precisely so that a
 * failure to install/build it on a non-Windows machine (this sandbox
 * included) never breaks `pnpm install` for the rest of the workspace - it
 * is loaded dynamically, only when `install-service`/`uninstall-service` is
 * actually invoked, with a clear error if it's unavailable.
 *
 * UNTESTED: this repo's sandbox has no Windows machine to run against. See
 * README.md "Testing status" - treat this module as best-effort and verify
 * on a real Windows box before relying on it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

const SERVICE_NAME = "PrintOS Print Agent";
const SERVICE_DESCRIPTION =
  "PrintOS on-premises Windows print agent - claims approved print jobs from the PrintOS cloud and submits them to local print queues.";

// Minimal shape of the parts of node-windows' Service API this module uses.
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
    // Dynamic import via a variable specifier (not a string literal) - see
    // file header. This is deliberate: `node-windows` is an
    // optionalDependency with no bundled type declarations, and it may not
    // be installed at all on a non-Windows machine (this sandbox included).
    // A literal `import("node-windows")` would make `tsc` try to resolve
    // its types and fail the whole package's typecheck; routing the
    // specifier through a variable keeps this an untyped `Promise<any>`
    // from TypeScript's point of view, resolved purely at runtime.
    const moduleName = "node-windows";
    const mod = (await import(moduleName)) as unknown as { Service: NodeWindowsServiceConstructor };
    return mod;
  } catch (err) {
    throw new Error(
      "node-windows is not installed or failed to load. It is an optionalDependency - on Windows, run " +
        "`pnpm --filter @printos/agent add node-windows` (or re-run `pnpm install` on a Windows machine) " +
        `before using install-service/uninstall-service. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function entryScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `here` is src/ (dev, via tsx) or dist/ (built) - service-launcher.mjs
  // lives at the package root either way, one directory up. See
  // service-launcher.mjs for why the service runs through it (not
  // dist/index.js directly) and its own tsx registration.
  return path.join(here, "..", "service-launcher.mjs");
}

/** Best-effort: configures the Windows Service Control Manager to restart the service automatically after a crash/exit, which is what makes the RESTART_AGENT_SERVICE remote command (commands.ts) actually effective. */
function configureFailureRecovery(logger: Logger): void {
  try {
    const child = spawn(
      "sc.exe",
      [
        "failure",
        SERVICE_NAME,
        "reset=",
        "86400",
        "actions=",
        "restart/60000/restart/60000/restart/60000",
      ],
      { windowsHide: true },
    );
    child.on("error", (err) => logger.warn("could not configure service failure-recovery (sc.exe failure)", { error: String(err) }));
  } catch (err) {
    logger.warn("could not configure service failure-recovery (sc.exe failure)", { error: String(err) });
  }
}

export async function installService(logger: Logger): Promise<void> {
  const { Service } = await loadNodeWindows();
  const svc = new Service({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    script: entryScriptPath(),
  });

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
  const svc = new Service({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    script: entryScriptPath(),
  });

  await new Promise<void>((resolve, reject) => {
    svc.on("uninstall", () => {
      logger.info("service uninstalled");
      resolve();
    });
    svc.on("error", (err) => reject(new Error(`node-windows uninstall failed: ${String(err)}`)));
    svc.uninstall();
  });
}
