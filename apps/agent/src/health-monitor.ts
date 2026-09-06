/**
 * Heartbeat loop: reports agent version + discovered printer queues on an
 * interval (docs/agent-api.md `POST /api/agents/heartbeat`). Never throws -
 * the cloud being unreachable is an expected, recoverable condition (docs/
 * architecture.md sec 17 / known-limitations.md "an Agent that is offline is
 * invisible, not necessarily broken"), not a crash.
 */

import type { CloudClient } from "./cloud-client.js";
import type { PrinterManager } from "./printer-manager.js";
import type { Logger } from "./logger.js";
import { AGENT_VERSION } from "./version.js";

export interface HealthMonitor {
  /**
   * Returns `true` if the heartbeat reached the cloud successfully this
   * call, `false` if it didn't (network error, 5xx after cloud-client.ts's
   * own retries, etc) - never throws either way. orchestrator.ts's runOnce()
   * uses this to decide whether the cycle counts as a full-cycle failure for
   * outer-loop backoff purposes (see orchestrator.ts computeNextPollDelayMs
   * doc comment); it does not change what this method does on the wire.
   */
  sendHeartbeat(): Promise<boolean>;
}

export function createHealthMonitor(
  cloudClient: CloudClient,
  printerManager: PrinterManager,
  logger: Logger,
): HealthMonitor {
  return {
    async sendHeartbeat(): Promise<boolean> {
      const queues = await printerManager.discoverQueues();
      try {
        const res = await cloudClient.heartbeat(
          AGENT_VERSION,
          queues.map((q) => ({
            windowsQueueName: q.windowsQueueName,
            driverName: q.driverName,
            portName: q.portName,
            status: q.status,
          })),
        );
        logger.debug("heartbeat ok", { serverTime: res.serverTime, queueCount: queues.length });
        return true;
      } catch (err) {
        logger.warn("heartbeat failed - will retry next cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}
