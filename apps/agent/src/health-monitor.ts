/**
 * Heartbeat loop: reports agent version, discovered printer queues, and this
 * machine's own identifying details on an interval (docs/agent-api.md `POST
 * /api/agents/heartbeat`). Never throws - the cloud being unreachable is an
 * expected, recoverable condition (docs/architecture.md sec 17 /
 * known-limitations.md "an Agent that is offline is invisible, not
 * necessarily broken"), not a crash.
 *
 * The heartbeat is also where the Agent learns it has been paused by an
 * admin, since it is the one call it makes unconditionally on every cycle -
 * see `isPaused()`.
 */

import type { CloudClient } from "./cloud-client.js";
import type { PrinterManager } from "./printer-manager.js";
import type { Logger } from "./logger.js";
import { AGENT_VERSION } from "./version.js";
import { collectMachineInfo } from "./machine-info.js";

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
  /**
   * Whether the cloud said, in the most recent SUCCESSFUL heartbeat, that an
   * admin has this Agent paused (agents.paused). Deliberately sticky across
   * failed heartbeats: a network blip must not silently un-pause a machine
   * an admin deliberately held. Starts `false`, so a fresh Agent that has
   * never completed a heartbeat behaves exactly as it always has.
   *
   * This is an optimization and an honesty signal, not the enforcement
   * point - the cloud refuses a paused Agent's claims regardless (see
   * HeartbeatResponse.paused).
   */
  isPaused(): boolean;
}

export function createHealthMonitor(
  cloudClient: CloudClient,
  printerManager: PrinterManager,
  logger: Logger,
): HealthMonitor {
  let paused = false;

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
          collectMachineInfo(),
        );
        const nowPaused = res.paused === true;
        if (nowPaused !== paused) {
          logger.warn(
            nowPaused
              ? "an administrator has PAUSED this agent - it will stop asking for new print jobs until it is resumed (jobs already in progress finish normally)"
              : "this agent has been resumed by an administrator - it will start asking for new print jobs again",
          );
        }
        paused = nowPaused;
        logger.debug("heartbeat ok", { serverTime: res.serverTime, queueCount: queues.length, paused });
        return true;
      } catch (err) {
        logger.warn("heartbeat failed - will retry next cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    isPaused(): boolean {
      return paused;
    },
  };
}
