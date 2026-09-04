/**
 * Printer/queue discovery via the PowerShell PrintManagement module
 * (Get-Printer/Get-PrinterPort/Get-PrinterDriver - here folded into one
 * Get-Printer call plus its own PortName/DriverName properties, which avoids
 * three separate round trips for the same information). Used by
 * health-monitor.ts to populate the `queues` field of every heartbeat
 * (docs/agent-api.md `POST /api/agents/heartbeat`).
 */

import { ensureScriptFile, runPowerShellFile, parseScriptJson } from "./ps-runner.js";
import { DISCOVER_PRINTERS_PS1, RESTART_SPOOLER_PS1 } from "./powershell-scripts.js";
import type { Logger } from "./logger.js";
import { SpoolerError } from "./errors.js";

export interface DiscoveredQueue {
  windowsQueueName: string;
  driverName: string;
  portName: string;
  /** Normalized from Windows' PrinterStatus enum - "unknown" if a value we don't recognize shows up. */
  status: "ready" | "offline" | "error" | "paper_out" | "paused" | "unknown";
  /** The raw PrinterStatus string, for logging/debugging - never assumed stable across Windows versions. */
  rawStatus: string;
}

interface DiscoverPrintersResult {
  ok: boolean;
  printers: Array<{
    windowsQueueName: string;
    driverName: string;
    portName: string;
    printerStatus: string;
    shared: boolean;
  }>;
  error?: string;
}

function normalizeStatus(raw: string): DiscoveredQueue["status"] {
  const s = raw.trim().toLowerCase();
  if (s === "normal" || s === "ok" || s === "idle") return "ready";
  if (s === "offline") return "offline";
  if (s.includes("error")) return "error";
  if (s.includes("paperout") || s.includes("paper out") || s.includes("noPaper")) return "paper_out";
  if (s.includes("paused")) return "paused";
  return "unknown";
}

export interface PrinterManager {
  /** Never throws - returns an empty list and logs a warning on any PowerShell failure, so a heartbeat can still go out with an empty `queues` array. */
  discoverQueues(): Promise<DiscoveredQueue[]>;
  /**
   * Restarts the Windows Print Spooler service. WHOLE-MACHINE operation -
   * every queue on this machine is affected (docs/architecture.md sec 11).
   * Only ever called from the RESTART_PRINT_QUEUE remote command handler
   * (commands.ts), never as routine per-job recovery. Throws SpoolerError
   * on failure - the caller is expected to log loudly and re-check status.
   */
  restartSpooler(): Promise<void>;
}

export function createPrinterManager(localStoragePath: string, logger: Logger): PrinterManager {
  return {
    async discoverQueues(): Promise<DiscoveredQueue[]> {
      try {
        const scriptPath = ensureScriptFile("discover-printers", DISCOVER_PRINTERS_PS1, localStoragePath);
        const result = await runPowerShellFile(scriptPath, {}, logger);
        const parsed = parseScriptJson<DiscoverPrintersResult>(result, "discover-printers");
        if (!parsed.ok) {
          throw new SpoolerError("Get-Printer failed", { error: parsed.error });
        }
        return parsed.printers.map((p) => ({
          windowsQueueName: p.windowsQueueName,
          driverName: p.driverName,
          portName: p.portName,
          status: normalizeStatus(p.printerStatus),
          rawStatus: p.printerStatus,
        }));
      } catch (err) {
        logger.warn("printer discovery failed - reporting empty queue list this cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },

    async restartSpooler(): Promise<void> {
      logger.warn("restarting Windows Print Spooler service - this affects EVERY queue on this machine");
      const scriptPath = ensureScriptFile("restart-spooler", RESTART_SPOOLER_PS1, localStoragePath);
      const result = await runPowerShellFile(scriptPath, { timeoutMs: 60_000 }, logger);
      const parsed = parseScriptJson<{ ok: boolean; error?: string }>(result, "restart-spooler");
      if (!parsed.ok) {
        throw new SpoolerError("Restart-Service Spooler failed", { error: parsed.error });
      }
      logger.warn("Windows Print Spooler service restarted successfully");
    },
  };
}
