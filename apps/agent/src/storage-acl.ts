// F12: the agent's storage folder holds the device secret (DPAPI LocalMachine blob or an AES key file next to its
// ciphertext) and the .ps1 helpers that run as SYSTEM. Any local account that can read or write it can steal the
// secret or escalate. At startup the folder is locked to SYSTEM + Administrators (plus the interactive user for dev).
import { execFile } from "node:child_process";
import type { Logger } from "./logger.js";

const NAME_PART = /^[A-Za-z0-9 ._-]+$/;
function isPlainAccount(u: string): boolean {
  const parts = u.split(String.fromCharCode(92));
  return parts.length <= 2 && parts.every((x) => NAME_PART.test(x));
}
const SYSTEM = "*S-1-5-18";
const ADMINS = "*S-1-5-32-544";
const STRIP = ["*S-1-5-32-545", "*S-1-1-0", "*S-1-5-11"]; // Users, Everyone, Authenticated Users

export function buildIcaclsArgs(dir: string, currentUser?: string): string[] {
  const args = [dir, "/inheritance:r", "/grant:r", `${SYSTEM}:(OI)(CI)F`, `${ADMINS}:(OI)(CI)F`];
  // An elevated-token-less admin would otherwise lock itself out during development. Machine accounts (SYSTEM runs
  // as HOST$) are already covered; anything that is not a plain account name is ignored.
  if (currentUser && !currentUser.endsWith("$") && isPlainAccount(currentUser)) {
    args.push(`${currentUser}:(OI)(CI)F`);
  }
  args.push("/remove:g", ...STRIP);
  return args;
}

export interface AclOptions {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => Promise<void>;
  user?: string;
}

const defaultRun = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
  });

export async function restrictStorageAcl(dir: string, logger: Logger, opts: AclOptions = {}): Promise<"applied" | "skipped" | "failed"> {
  if ((opts.platform ?? process.platform) !== "win32") return "skipped";
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME;
  const user = opts.user ?? (name ? (domain ? `${domain}\${name}` : name) : undefined);
  try {
    await (opts.run ?? defaultRun)("icacls", buildIcaclsArgs(dir, user));
    logger.info("storage folder access restricted to SYSTEM and Administrators", { dir });
    return "applied";
  } catch (err) {
    logger.warn("could not restrict the storage folder ACL (run the agent as a service/administrator, or fix it with icacls)", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}
