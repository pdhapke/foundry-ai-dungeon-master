import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { DotMcpError } from "./contract.js";
import type { EventSecretCodec as DotSecretCodec } from "../../../../foundry-local-api/server/events-core.js";

export type PrivatePowerShell = (script: string, input: string) => string;
export type PrivateStorageVerifier = ((path: string) => void) & { verifyMany?: (paths: readonly string[]) => void };
export type AsyncPrivateStorageVerifier = (paths: readonly string[]) => Promise<void>;
const failure = () => new DotMcpError(-32603, "Protected dot storage is unavailable; operator setup is required.");
/** No secrets in argv, logs or error text. No ACL mutation or directory creation. */
export const runPrivatePowerShell: PrivatePowerShell = (script, input) => {
  if (process.platform !== "win32") throw failure();
  const environment = { ...process.env }; delete environment["PSModulePath"];
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input, encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true, env: environment,
  });
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length > 65536) throw failure();
  return result.stdout.trim();
};

const aclScript = String.raw`$ErrorActionPreference='Stop';
$value=([Console]::In.ReadToEnd() | ConvertFrom-Json); $root=[IO.Path]::GetFullPath($value.root);
$targets=@(); if ($null -ne $value.path) { $targets=@($value.path) } else { $targets=@($value.paths) };
if ($targets.Count -lt 1 -or $targets.Count -gt 16) { throw 'PATH_REFUSED' };
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$rootItem=Get-Item -LiteralPath $root -Force;
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PATH_REFUSED' };
# Inspect every ancestor for reparse traversal without changing its permissions.
$ancestor=$rootItem.Parent; while ($null -ne $ancestor) { if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PATH_REFUSED' }; $ancestor=$ancestor.Parent };
$paths=@($root); foreach ($rawTarget in $targets) {
  $target=[IO.Path]::GetFullPath($rawTarget); if ([IO.Path]::GetDirectoryName($target) -ne $root) { throw 'PATH_REFUSED' };
  if (Test-Path -LiteralPath $target) { $item=Get-Item -LiteralPath $target -Force; if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PATH_REFUSED' }; $paths+=@($target) }
};
foreach($path in $paths) {
  $acl=Get-Acl -LiteralPath $path; $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
  if ($owner -ne $sid -or $rules.Count -lt 1 -or ($path -eq $root -and -not $acl.AreAccessRulesProtected)) { throw 'PRIVATE_ACL_REQUIRED' };
  foreach($rule in $rules) { if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { throw 'PRIVATE_ACL_REQUIRED' } };
}; [Console]::Out.Write('private-storage-v1');`;

export function createWindowsPrivateStorageVerifier(root: string, run: PrivatePowerShell = runPrivatePowerShell): PrivateStorageVerifier {
  if (!isAbsolute(root)) throw failure();
  const absoluteRoot = resolve(root);
  const checked = (path: string): string => {
    if (!isAbsolute(path) || dirname(resolve(path)).toLowerCase() !== absoluteRoot.toLowerCase()) throw failure();
    return resolve(path);
  };
  const verify: PrivateStorageVerifier = path => {
    checked(path);
    try { if (run(aclScript, JSON.stringify({ root: absoluteRoot, path: resolve(path) })) !== "private-storage-v1") throw failure(); }
    catch { throw failure(); }
  };
  verify.verifyMany = paths => {
    if (paths.length < 1 || paths.length > 16) throw failure();
    const targets = [...new Set(paths.map(checked))];
    try { if (run(aclScript, JSON.stringify({ root: absoluteRoot, paths: targets })) !== "private-storage-v1") throw failure(); }
    catch { throw failure(); }
  };
  return verify;
}

/** Diagnostic IO never blocks the event loop or delays route revocation and
 * owned-process cleanup. This uses the same exact ACL/reparse policy, with no
 * output/error text exposed and no ACL mutation or credential input. */
export function createAsyncWindowsPrivateStorageVerifier(root: string, launch: typeof spawn = spawn): AsyncPrivateStorageVerifier {
  if (!isAbsolute(root)) throw failure();
  const absoluteRoot = resolve(root);
  return async paths => {
    if (process.platform !== "win32" || paths.length < 1 || paths.length > 16 || paths.some(path => !isAbsolute(path) || dirname(resolve(path)).toLowerCase() !== absoluteRoot.toLowerCase())) throw failure();
    await new Promise<void>((accept, reject) => {
      let output = "", settled = false;
      const environment = { ...process.env }; delete environment["PSModulePath"];
      const child = launch("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], { windowsHide: true, env: environment, stdio: ["pipe", "pipe", "ignore"] });
      const finish = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timeout); if (ok) accept(); else { child.kill(); reject(failure()); } };
      const timeout = setTimeout(() => { child.kill(); finish(false); }, 10000);
      child.once("error", () => { finish(false); }); child.stdin.once("error", () => { finish(false); });
      child.stdout.on("data", (bytes: Buffer) => { if (output.length + bytes.length > 65536) { child.kill(); finish(false); } else output += bytes.toString("utf8"); });
      child.once("close", code => { finish(code === 0 && output.trim() === "private-storage-v1"); });
      child.stdin.end(JSON.stringify({ root: absoluteRoot, paths: [...new Set(paths.map(path => resolve(path)))] }));
    });
  };
}

const dpapiScript = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
$value=([Console]::In.ReadToEnd() | ConvertFrom-Json);
$bytes=[Convert]::FromBase64String($value.data); $entropy=[Text.Encoding]::UTF8.GetBytes('foundry-local-api.dot.webhook-secret.v1');
if ($value.operation -eq 'seal') { $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
elseif ($value.operation -eq 'unseal') { $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
else { throw 'OPERATION_REFUSED' }; [Console]::Out.Write([Convert]::ToBase64String($result));`;

export class WindowsDpapiCodec implements DotSecretCodec {
  constructor(private readonly run: PrivatePowerShell = runPrivatePowerShell) {}
  seal(secret: string): string {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length > 128) throw failure();
    try {
      const encoded = this.run(dpapiScript, JSON.stringify({ operation: "seal", data: Buffer.from(secret, "utf8").toString("base64") }));
      this.decode(encoded); return `dpapi-current-user-v1:${encoded}`;
    } catch { throw failure(); }
  }
  unseal(encoded: string): string {
    if (!encoded.startsWith("dpapi-current-user-v1:")) throw failure();
    try {
      const payload = encoded.slice("dpapi-current-user-v1:".length); this.decode(payload);
      const plaintext = this.decode(this.run(dpapiScript, JSON.stringify({ operation: "unseal", data: payload }))).toString("utf8");
      if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(plaintext) || plaintext.length > 128) throw failure();
      return plaintext;
    } catch { throw failure(); }
  }
  private decode(value: string): Buffer {
    if (value.length < 4 || value.length > 16300 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure();
    const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw failure(); return bytes;
  }
}
