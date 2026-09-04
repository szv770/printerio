/**
 * Persists the agent's device secret (docs/architecture.md sec 4) to local
 * disk, surviving process restarts, so `start` doesn't require re-running
 * `register` every time.
 *
 * Strategy (best-effort, both paths documented - see README "Secure
 * storage"):
 *  - On Windows: encrypt with the Windows Data Protection API (DPAPI) via a
 *    tiny embedded PowerShell helper (powershell-scripts.ts
 *    DPAPI_PROTECT_PS1/DPAPI_UNPROTECT_PS1), LocalMachine-scoped. The
 *    plaintext is piped over stdin, never passed as a command-line argument
 *    (argv is visible to other processes on the machine; stdin is not).
 *  - Fallback (DPAPI unavailable, non-Windows dev/test, or the helper
 *    fails for any reason): an AES-256-GCM-encrypted local file, keyed by a
 *    random key file written alongside it with restrictive permissions.
 *    This is clearly weaker than DPAPI - anyone who can read both files as
 *    the same OS user can decrypt the secret - and every code path that uses
 *    it logs a loud one-time warning. It is NOT a substitute for running in
 *    production on Windows.
 *
 * We deliberately did NOT take a dependency on `keytar` (native module,
 * unmaintained, requires a working native build toolchain per-platform -
 * a poor fit for this sandbox and for a lightweight Windows Service
 * installer) - DPAPI via PowerShell needs no native compilation at all and
 * is the mechanism Microsoft itself documents for this exact use case.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ensureScriptFile, runPowerShellFile } from "./ps-runner.js";
import { DPAPI_PROTECT_PS1, DPAPI_UNPROTECT_PS1 } from "./powershell-scripts.js";
import type { Logger } from "./logger.js";

export interface StoredCredentials {
  agentId: string;
  deviceSecret: string;
  organizationId?: string;
}

const CREDENTIALS_FILENAME = "agent-credentials.json";
const FALLBACK_KEY_FILENAME = "agent-credentials.key";

type StoredFile =
  | { version: "dpapi-v1"; ciphertext: string }
  | { version: "fallback-aesgcm-v1"; iv: string; authTag: string; ciphertext: string };

function credentialsPath(localStoragePath: string): string {
  return path.join(localStoragePath, CREDENTIALS_FILENAME);
}

function fallbackKeyPath(localStoragePath: string): string {
  return path.join(localStoragePath, FALLBACK_KEY_FILENAME);
}

async function dpapiProtect(plainText: string, localStoragePath: string, logger: Logger): Promise<string> {
  const scriptPath = ensureScriptFile("dpapi-protect", DPAPI_PROTECT_PS1, localStoragePath);
  const result = await runPowerShellFile(scriptPath, { stdin: plainText, timeoutMs: 15_000 }, logger);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`DPAPI protect failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  return result.stdout.trim();
}

async function dpapiUnprotect(ciphertextB64: string, localStoragePath: string, logger: Logger): Promise<string> {
  const scriptPath = ensureScriptFile("dpapi-unprotect", DPAPI_UNPROTECT_PS1, localStoragePath);
  const result = await runPowerShellFile(scriptPath, { stdin: ciphertextB64, timeoutMs: 15_000 }, logger);
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`DPAPI unprotect failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  return result.stdout;
}

function getOrCreateFallbackKey(localStoragePath: string): Buffer {
  const keyPath = fallbackKeyPath(localStoragePath);
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8"), "base64");
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return key;
}

function fallbackEncrypt(plainText: string, localStoragePath: string): StoredFile {
  const key = getOrCreateFallbackKey(localStoragePath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: "fallback-aesgcm-v1",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function fallbackDecrypt(file: Extract<StoredFile, { version: "fallback-aesgcm-v1" }>, localStoragePath: string): string {
  const key = getOrCreateFallbackKey(localStoragePath);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

export async function saveCredentials(
  localStoragePath: string,
  creds: StoredCredentials,
  logger: Logger,
): Promise<void> {
  mkdirSync(localStoragePath, { recursive: true });
  const plainText = JSON.stringify(creds);

  let stored: StoredFile;
  if (process.platform === "win32") {
    try {
      const ciphertext = await dpapiProtect(plainText, localStoragePath, logger);
      stored = { version: "dpapi-v1", ciphertext };
      logger.info("agent credentials saved (DPAPI, LocalMachine-scoped)");
    } catch (err) {
      logger.warn(
        "DPAPI protect failed - falling back to local encrypted-file storage (weaker; see README 'Secure storage')",
        { error: err instanceof Error ? err.message : String(err) },
      );
      stored = fallbackEncrypt(plainText, localStoragePath);
    }
  } else {
    logger.warn(
      "not running on Windows - using local encrypted-file fallback for credential storage, NOT DPAPI (see README 'Secure storage')",
    );
    stored = fallbackEncrypt(plainText, localStoragePath);
  }

  const filePath = credentialsPath(localStoragePath);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  // Atomic rename - never leaves a partially-written credentials file.
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, filePath);
}

/** Returns null if no credentials have been saved yet, or if decryption fails for any reason (treated as "not registered" - the caller should prompt for `register`). */
export async function loadCredentials(localStoragePath: string, logger: Logger): Promise<StoredCredentials | null> {
  const filePath = credentialsPath(localStoragePath);
  if (!existsSync(filePath)) return null;

  let stored: StoredFile;
  try {
    stored = JSON.parse(readFileSync(filePath, "utf8")) as StoredFile;
  } catch (err) {
    logger.error("credentials file is corrupt/unreadable", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  try {
    const plainText =
      stored.version === "dpapi-v1"
        ? await dpapiUnprotect(stored.ciphertext, localStoragePath, logger)
        : fallbackDecrypt(stored, localStoragePath);
    return JSON.parse(plainText) as StoredCredentials;
  } catch (err) {
    logger.error("failed to decrypt stored credentials - run `register` again", {
      error: err instanceof Error ? err.message : String(err),
      storageVersion: stored.version,
    });
    return null;
  }
}

export function clearCredentials(localStoragePath: string): void {
  for (const p of [credentialsPath(localStoragePath), fallbackKeyPath(localStoragePath)]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}
