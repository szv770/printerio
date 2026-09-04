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
  sendHeartbeat(): Promise<void>;
}

export function createHealthMonitor(
  cloudClient: CloudClient,
  printerManager: PrinterManager,
  logger: Logger,
): HealthMonitor {
  return {
    async sendHeartbeat(): Promise<void> {
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
      } catch (err) {
        logger.warn("heartbeat failed - will retry next cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
