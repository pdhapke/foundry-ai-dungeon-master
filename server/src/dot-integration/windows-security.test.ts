import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncWindowsPrivateStorageVerifier, createWindowsPrivateStorageVerifier, WindowsDpapiCodec } from "./windows-security.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";

void test("private storage verifier checks direct paths and uses only read-only ACL inspection", () => {
  let calls = 0;
  const verify = createWindowsPrivateStorageVerifier("C:\\synthetic-private", (script, input) => {
    calls++; assert.match(script, /Get-Acl/); assert.match(script, /AreAccessRulesProtected/); assert.match(script, /ReparsePoint/);
    assert.doesNotMatch(script, /Set-Acl|New-Item|Remove-Item|icacls/i);
    assert.deepEqual(JSON.parse(input), { root: "C:\\synthetic-private", path: "C:\\synthetic-private\\dot-events.json" }); return "private-storage-v1";
  });
  verify("C:\\synthetic-private\\dot-events.json"); assert.equal(calls, 1);
  assert.throws(() => verify("C:\\elsewhere\\dot-events.json")); assert.throws(() => verify("C:\\synthetic-private\\nested\\dot-events.json"));
  assert.throws(() => verify("relative.json")); assert.equal(calls, 1);
  assert.throws(() => createWindowsPrivateStorageVerifier("relative"));
  assert.throws(() => createWindowsPrivateStorageVerifier("C:\\synthetic-private", () => "wrong marker")("C:\\synthetic-private\\dot-events.json"));
});
void test("DPAPI adapter uses CurrentUser and fixed entropy with secrets only in stdin", () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`, protectedData = Buffer.from("synthetic protected bytes").toString("base64");
  const calls: string[] = [];
  const codec = new WindowsDpapiCodec((script, input) => {
    assert.match(script, /DataProtectionScope\]::CurrentUser/); assert.match(script, /foundry-local-api\.dot\.webhook-secret\.v1/); assert.ok(!script.includes(secret));
    const value = JSON.parse(input) as { operation: string; data: string }; calls.push(value.operation);
    if (value.operation === "seal") { assert.equal(Buffer.from(value.data, "base64").toString(), secret); return protectedData; }
    assert.equal(value.data, protectedData); return Buffer.from(secret).toString("base64");
  });
  const sealed = codec.seal(secret); assert.ok(!sealed.includes(secret)); assert.equal(codec.unseal(sealed), secret); assert.deepEqual(calls, ["seal", "unseal"]);
});
void test("DPAPI corruption or unavailable provider fails closed with redacted errors", () => {
  const codec = new WindowsDpapiCodec(() => { throw new Error("synthetic sensitive value"); });
  const secret = `whsec_${Buffer.alloc(32).toString("base64")}`;
  assert.throws(() => codec.seal(secret), error => error instanceof Error && /operator setup/.test(error.message) && !error.message.includes("sensitive"));
  assert.throws(() => codec.unseal("plaintext:secret")); assert.throws(() => codec.unseal("dpapi-current-user-v1:!!!!"));
  assert.throws(() => new WindowsDpapiCodec(() => "not-base64!").seal(secret));
  assert.throws(() => new WindowsDpapiCodec(() => Buffer.from("invalid plaintext").toString("base64")).unseal("dpapi-current-user-v1:YWJjZA=="));
});
void test("batch ACL attestation checks bounded direct targets afresh without caching authority", () => {
  let calls = 0, refused = false;
  const verify = createWindowsPrivateStorageVerifier("C:\\synthetic-private", (script, input) => {
    calls++; const value = JSON.parse(input) as { root: string; paths: string[] };
    assert.equal(value.root, "C:\\synthetic-private"); assert.equal(value.paths.length, 2);
    assert.match(script, /Get-Acl/); assert.match(script, /GetDirectoryName/); assert.match(script, /ReparsePoint/);
    assert.doesNotMatch(script, /Set-Acl|New-Item|Remove-Item|icacls/i);
    if (refused) throw new Error("synthetic sensitive ACL failure"); return "private-storage-v1";
  });
  const paths = ["C:\\synthetic-private\\dot-config.json", "C:\\synthetic-private\\configuration.lock"];
  verify.verifyMany!(paths); verify.verifyMany!(paths); assert.equal(calls, 2);
  assert.throws(() => verify.verifyMany!([])); assert.throws(() => verify.verifyMany!([...paths, "C:\\elsewhere\\file"])); assert.equal(calls, 2);
  refused = true; assert.throws(() => verify.verifyMany!(paths), /operator setup/); assert.equal(calls, 3);
});

void test("asynchronous ACL attestation uses the same fixed private policy and redacts malformed stdout and process errors", async () => {
  for (const mode of ["valid", "invalid", "oversized", "error"] as const) {
    let calls = 0, killed = false, input = "";
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(),
      kill: (): boolean => { killed = true; return true; },
    }) as unknown as ChildProcessWithoutNullStreams;
    child.stdin.on("data", (bytes: Buffer) => { input += bytes.toString("utf8"); });
    const launch = ((file: string, args: string[], options: { windowsHide: boolean; stdio: string[] }) => {
      calls++; assert.equal(file, "powershell.exe"); assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
      assert.match(args.at(-1)!, /Get-Acl/); assert.match(args.at(-1)!, /AreAccessRulesProtected/); assert.doesNotMatch(args.at(-1)!, /Set-Acl|icacls|New-Item|Remove-Item/i);
      setImmediate(() => {
        if (mode === "error") child.emit("error", new Error("sk-secret-process-error"));
        else { stdout.write(mode === "valid" ? "private-storage-v1" : mode === "oversized" ? "s".repeat(65537) : "sk-secret-parser-error"); child.emit("close", 0); }
      }); return child;
    }) as unknown as typeof spawn;
    const verify = createAsyncWindowsPrivateStorageVerifier("C:\\synthetic-private", launch);
    await assert.rejects(verify(["C:\\elsewhere\\file"])); assert.equal(calls, 0);
    await assert.rejects(verify([])); await assert.rejects(verify(Array.from({ length: 17 }, () => "C:\\synthetic-private\\file"))); assert.equal(calls, 0);
    const checking = verify(["C:\\synthetic-private\\diagnostic-attempt-11111111-1111-1111-1111-111111111111.json"]);
    if (mode === "valid") { await checking; assert.equal(killed, false); }
    else await assert.rejects(checking, error => error instanceof Error && /operator setup/.test(error.message) && !error.message.includes("sk-secret"));
    assert.equal(calls, 1); assert.ok(!input.includes("sk-secret")); assert.match(input, /synthetic-private/);
  }
});
