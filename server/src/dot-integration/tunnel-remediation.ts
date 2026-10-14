import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createWindowsPrivateStorageVerifier } from "./windows-security.js";

/** Read-only runtime proof, never an initialization/rotation operation. A
 * manually replaced legacy .env key is not proof that all clients migrated. */
export function managedCredentialRemediated(directory: string, activeAdministrativeSha256: string,
  verify = createWindowsPrivateStorageVerifier(directory), read = (path: string): Buffer => readFileSync(path)): boolean {
  let bytes: Buffer | undefined;
  try {
    if (!/^[a-f0-9]{64}$/.test(activeAdministrativeSha256) || !existsSync(`${directory}.required`) || existsSync(join(directory, "..", ".managed-credential.lock"))) return false;
    const file = join(directory, "current.json"); verify(file);
    const stat = statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) return false;
    bytes = read(file);
    const record = JSON.parse(bytes.toString("utf8")) as { version?: unknown; generation?: unknown; key?: unknown };
    try {
      if (record.version !== 1 || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || typeof record.key !== "string" || !/^[a-f0-9]{64}$/.test(record.key)) return false;
      return timingSafeEqual(Buffer.from(activeAdministrativeSha256, "hex"), createHash("sha256").update(record.key).digest());
    } finally { delete record.key; }
  } catch { return false; }
  finally { bytes?.fill(0); }
}
