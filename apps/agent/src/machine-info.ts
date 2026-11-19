/**
 * What this Agent can honestly say about the machine it is running on,
 * reported on every heartbeat (docs/agent-api.md `POST
 * /api/agents/heartbeat`, `machine`).
 *
 * This exists for one reason: until now the only thing the admin console
 * could say about a registered Agent was its display name, its status, its
 * package version, and when it was last seen - none of which answers "which
 * physical machine in this building is that?" when something needs checking
 * on. Hostname, OS, and the machine's own IP addresses answer it.
 *
 * Deliberately narrow. Everything here is (a) already known to the Agent
 * process without asking Windows anything privileged, (b) cheap enough to
 * recompute on every heartbeat, and (c) not sensitive: no usernames, no
 * paths, no serials, no MAC addresses, nothing that could be replayed as a
 * credential. Loopback and internal interfaces are filtered out, so this
 * reports the addresses that actually place the machine on a network, not
 * 127.0.0.1. Nothing in the cloud ever *trusts* these values - they are
 * displayed, never used for authentication, authorization, or routing
 * (docs/architecture.md sec 3.2), which is exactly why self-reporting them
 * is safe.
 */

import os from "node:os";
import { isGitCheckout, resolveRepoRoot, runCommand, type CommandOutcome } from "./self-update.js";

export interface MachineInfo {
  hostname: string;
  osVersion: string;
  ipAddresses: string[];
  /** Whether a CHECK_FOR_UPDATE would have anything to pull - see self-update.ts. */
  isGitCheckout: boolean;
  /**
   * The full git commit this process was started from (`git rev-parse HEAD`, read once), or null when it is not known
   * (no git, not a checkout, not read yet). Lets the website tell "restarted on the new code" from "restarted on old code".
   */
  runningCommit: string | null;
}

type RunFn = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<CommandOutcome>;

const COMMIT_LOOKUP_TIMEOUT_MS = 5_000;
const FULL_COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * `git rev-parse HEAD` with a fixed argv (no shell), 5 s timeout. Resolves to null on ANY problem (git missing, not a
 * checkout, timeout, odd output); never rejects.
 */
export async function readRunningCommit(run: RunFn = runCommand, cwd?: string): Promise<string | null> {
  try {
    const dir = cwd ?? resolveRepoRoot();
    const out = await run("git", ["rev-parse", "HEAD"], dir, COMMIT_LOOKUP_TIMEOUT_MS);
    if (out.exitCode !== 0) return null;
    const hash = out.stdout.trim().toLowerCase();
    return FULL_COMMIT.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

let cachedCommit: string | null = null;
let commitLookupStarted = false;

/** Starts the one-time commit lookup in the background (never awaited by a heartbeat). Later calls do nothing. */
export function primeRunningCommit(run: RunFn = runCommand, cwd?: string): Promise<void> {
  if (commitLookupStarted) return Promise.resolve();
  commitLookupStarted = true;
  return readRunningCommit(run, cwd).then((hash) => {
    cachedCommit = hash;
  });
}

/** Test hook: forget the cached lookup. */
export function resetRunningCommitForTests(): void {
  cachedCommit = null;
  commitLookupStarted = false;
}

// Start reading at process start so the value is ready well before the first heartbeat (skipped under test runners).
if (!process.env.VITEST) void primeRunningCommit();

/** Non-internal (non-loopback) IPv4/IPv6 addresses across every interface, deduplicated and stably ordered. */
export function collectIpAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (!entry.address) continue;
      found.add(entry.address);
    }
  }
  return [...found].sort();
}

/** e.g. "Windows_NT 10.0.19045 (x64)" - assembled rather than taken from a single field, since no one os.* call gives a readable answer on its own. */
export function describeOs(
  type: string = os.type(),
  release: string = os.release(),
  arch: string = os.arch(),
): string {
  return `${type} ${release} (${arch})`;
}

/**
 * Never throws: a machine-info failure must not be able to stop a heartbeat
 * from going out (a heartbeat is how the cloud knows this Agent is alive at
 * all - docs/architecture.md sec 17). Any individual field that can't be
 * determined falls back to a plainly-wrong-looking placeholder rather than
 * an exception.
 */
export function collectMachineInfo(): MachineInfo {
  let hostname = "unknown";
  try {
    hostname = os.hostname();
  } catch {
    // keep the placeholder
  }

  let osVersion = "unknown";
  try {
    osVersion = describeOs();
  } catch {
    // keep the placeholder
  }

  let ipAddresses: string[] = [];
  try {
    ipAddresses = collectIpAddresses();
  } catch {
    ipAddresses = [];
  }

  let gitCheckout = false;
  try {
    gitCheckout = isGitCheckout(resolveRepoRoot());
  } catch {
    gitCheckout = false;
  }

  void primeRunningCommit(); // no-op after the first call; the answer is cached, so this never delays a heartbeat

  return { hostname, osVersion, ipAddresses, isGitCheckout: gitCheckout, runningCommit: cachedCommit };
}
