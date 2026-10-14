import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const hostPath = fileURLToPath(new URL("./foundry-dot-tunnel-host.ps1", import.meta.url));
const source = readFileSync(hostPath, "utf8");
const nativeSource = source.match(/\$nativeSource = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const windows = process.platform === "win32";

// Parse and compile definitions only. Never invoke the host, its constructor,
// the tunnel binary, a listener, a profile, or any credential storage.
function definitionsOnly(script) {
  const directory = mkdtempSync(join(tmpdir(), "foundry-host-script-fixture-"));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  try {
    const path = join(directory, "fixture.ps1");
    writeFileSync(path, "\uFEFF" + script, "utf8");
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    assert.equal(result.error?.code, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  "Windows PowerShell parses the production host without executing it",
  { skip: !windows },
  () => {
    const encodedPath = Buffer.from(hostPath, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'
    $ProgressPreference='SilentlyContinue'
    $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    @{ errors=$errors.Count; parameters=@($ast.ParamBlock.Parameters.Name.VariablePath.UserPath) } | ConvertTo-Json -Compress
  `);
    assert.equal(report.errors, 0);
    assert.deepEqual(report.parameters, ["ExecutablePath", "ProfilePath"]);
  },
);

test(
  "native declarations compile on the supported Windows PowerShell runtime with correct ABI layout",
  { skip: !windows },
  () => {
    const encodedPath = Buffer.from(hostPath, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'
    $ProgressPreference='SilentlyContinue'
    $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
    $text=[IO.File]::ReadAllText($path)
    $native=[regex]::Match($text,"(?s)\u0024nativeSource = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
    Add-Type -TypeDefinition $native
    $sizes=@{}
    foreach($name in @('SecurityAttributes','StartupInfo','StartupInfoEx','ProcessInformation','BasicLimit','ExtendedLimit')) {
      $type=[FoundryOwnedTunnel].GetNestedType($name,[Reflection.BindingFlags]::NonPublic)
      $sizes[$name]=[Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($type))
    }
    @{ pointerSize=[IntPtr]::Size; sizes=$sizes; quotes=@(
      [FoundryOwnedTunnel]::QuoteArgument(''),
      [FoundryOwnedTunnel]::QuoteArgument('C:\synthetic folder\client.exe'),
      [FoundryOwnedTunnel]::QuoteArgument('C:\synthetic\'),
      [FoundryOwnedTunnel]::QuoteArgument('a"b'),
      [FoundryOwnedTunnel]::QuoteArgument('a\"b')
    ) } | ConvertTo-Json -Compress
  `);
    assert.equal(
      report.pointerSize,
      8,
      "The reviewed host requires the installed 64-bit Windows runtime",
    );
    assert.deepEqual(report.sizes, {
      SecurityAttributes: 24,
      StartupInfo: 104,
      StartupInfoEx: 112,
      ProcessInformation: 24,
      BasicLimit: 64,
      ExtendedLimit: 144,
    });
    assert.deepEqual(report.quotes, [
      '""',
      '"C:\\synthetic folder\\client.exe"',
      '"C:\\synthetic\\\\"',
      '"a\\"b"',
      '"a\\\\\\"b"',
    ]);
  },
);

test(
  "synthetic suspended child receives supported info logging, inherits only NUL handles and dies with its owning Job",
  { skip: !windows },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "foundry-host-native-fixture-"));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // Override visibility only in this isolated native fixture: execution tools
    // have no desktop console. The production host retains its visible guard.
    const fixtureNative = nativeSource.replace(
      "return window!=IntPtr.Zero && IsWindowVisible(window);",
      "return true;",
    );
    assert.notEqual(fixtureNative, nativeSource);
    const encodedNative = Buffer.from(fixtureNative, "utf8").toString("base64");
    const encodedDirectory = Buffer.from(directory, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
    $native=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNative}'))
    Add-Type -TypeDefinition $native
    $executable=Join-Path $directory 'synthetic-child.exe'
    $profile=Join-Path $directory 'synthetic-profile.fixture'
    [IO.File]::WriteAllText($profile,'synthetic fixture only')
    Add-Type -OutputAssembly $executable -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class SyntheticChild {
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  public static void Main(string[] args) {
    string profile=args[Array.IndexOf(args,"--profile-file")+1];
    int logFlag=Array.IndexOf(args,"--log.level");
    string logLevel=logFlag>=0 && logFlag+1<args.Length ? args[logFlag+1] : "missing";
    File.WriteAllText(profile+".started", GetFileType(GetStdHandle(-10))+","+GetFileType(GetStdHandle(-11))+","+GetFileType(GetStdHandle(-12))+","+logLevel);
    Thread.Sleep(30000);
  }
}
'@
    $owned=$null
    try {
      $owned=[FoundryOwnedTunnel]::new($executable,$profile)
      $deadline=[DateTime]::UtcNow.AddSeconds(3)
      while(-not [IO.File]::Exists($profile+'.started') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
      $alive=$owned.Alive(); $exitCode=$owned.ExitCode(); $handles=if([IO.File]::Exists($profile+'.started')) {[IO.File]::ReadAllText($profile+'.started')} else {'missing'}
      $owned.Dispose()
      @{alive=$alive;exitCode=$exitCode;afterStop=$owned.Alive();handles=$handles} | ConvertTo-Json -Compress
    } finally { if($null -ne $owned) {$owned.Dispose()} }
  `);
    assert.equal(report.alive, true);
    assert.equal(report.exitCode, null);
    assert.equal(report.afterStop, false);
    // v0.0.16 rejects warn before health; validate the real native argv boundary.
    assert.equal(report.handles, "2,2,2,info");
  },
);

test(
  "native child exit diagnostics read the exit code from the exact signaled owned handle",
  { skip: !windows },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "foundry-host-exit-fixture-"));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixtureNative = nativeSource.replace(
      "return window!=IntPtr.Zero && IsWindowVisible(window);",
      "return true;",
    );
    assert.notEqual(fixtureNative, nativeSource);
    const encodedNative = Buffer.from(fixtureNative, "utf8").toString("base64");
    const encodedDirectory = Buffer.from(directory, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
    Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNative}')))
    $executable=Join-Path $directory 'synthetic-exit-child.exe'
    $profile=Join-Path $directory 'synthetic-profile.fixture'
    [IO.File]::WriteAllText($profile,'synthetic fixture only')
    Add-Type -OutputAssembly $executable -OutputType ConsoleApplication -TypeDefinition @'
using System;
public static class SyntheticExitChild {
  public static int Main(string[] args) {
    Console.Out.WriteLine("synthetic-secret-stdout-must-be-discarded");
    Console.Error.WriteLine("synthetic-secret-stderr-must-be-discarded");
    return 17;
  }
}
'@
    $owned=$null
    try {
      $owned=[FoundryOwnedTunnel]::new($executable,$profile)
      $deadline=[DateTime]::UtcNow.AddSeconds(3)
      while($owned.Alive() -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
      @{alive=$owned.Alive();exitCode=$owned.ExitCode();childPid=$owned.Pid} | ConvertTo-Json -Compress
    } finally { if($null -ne $owned) {$owned.Dispose()} }
  `);
    assert.equal(report.alive, false);
    assert.equal(report.exitCode, 17);
    assert.ok(Number.isInteger(report.childPid) && report.childPid > 0);
    assert.doesNotMatch(JSON.stringify(report), /synthetic-secret/);
  },
);

test(
  "native process creation refuses a synthetic invalid executable with a fixed stage code",
  { skip: !windows },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "foundry-host-refusal-fixture-"));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixtureNative = nativeSource.replace(
      "return window!=IntPtr.Zero && IsWindowVisible(window);",
      "return true;",
    );
    const encodedNative = Buffer.from(fixtureNative, "utf8").toString("base64");
    const encodedDirectory = Buffer.from(directory, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
    Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNative}')))
    $executable=Join-Path $directory 'invalid-synthetic-child.exe'
    $profile=Join-Path $directory 'synthetic-profile.fixture'
    [IO.File]::WriteAllText($executable,'This is a synthetic non-executable fixture.')
    [IO.File]::WriteAllText($profile,'synthetic fixture only')
    $owned=$null; $code='unexpected_success'
    try { $owned=[FoundryOwnedTunnel]::new($executable,$profile) }
    catch { $exception=$_.Exception; while($null -ne $exception.InnerException) {$exception=$exception.InnerException}; $code=$exception.Message }
    finally { if($null -ne $owned) {$owned.Dispose()} }
    @{code=$code} | ConvertTo-Json -Compress
  `);
    assert.equal(report.code, "process_create_failed");
  },
);

test("child ownership and diagnostics use the reviewed bounded native contract", () => {
  assert.ok(
    nativeSource.indexOf("AssignProcessToJobObject(job,child.Process)") <
      nativeSource.indexOf("ResumeThread(child.Thread)"),
  );
  assert.ok(nativeSource.includes("limits.Basic.Flags=0x00002000"));
  assert.ok(nativeSource.includes("new IntPtr(0x00020002)"));
  assert.ok(nativeSource.includes("true,0x00080004,IntPtr.Zero"));
  assert.ok(nativeSource.includes("TerminateProcess(child.Process,1)"));
  assert.ok(source.includes("GetConsoleWindow()") && source.includes("IsWindowVisible(window)"));
  assert.ok(source.includes("$control.Length -gt 6"));
  assert.ok(
    source.includes("$request.Proxy = $null") &&
      source.includes("$request.AllowAutoRedirect = $false"),
  );
  assert.ok(source.includes("$listeners[0].OwningProcess -ne $ChildPid"));
  assert.ok(source.includes("$listeners[0].LocalAddress -ne '127.0.0.1'"));
  assert.doesNotMatch(
    source,
    /taskkill|Stop-Process|Get-Content|ReadAllText|ReadAllBytes|GetResponseStream|Set-Content|WriteAll/i,
  );
  assert.doesNotMatch(source, /Write-(?:Error|Host)|(?:WriteLine|Write-ControlLine)[^\n]*\$_/);
});

test(
  "health guards reject absent, foreign, wildcard and multiple listener fixtures before any HTTP request",
  { skip: !windows },
  () => {
    const encodedPath = Buffer.from(hostPath, "utf8").toString("base64");
    const report = definitionsOnly(String.raw`
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    $function=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-OwnedHealth'},$true)
    Invoke-Expression $function.Extent.Text
    function Get-HealthListeners { $script:listeners }
    $results=@()
    $script:listeners=@(); $results+=Test-OwnedHealth 123 'healthz'
    $script:listeners=@([pscustomobject]@{OwningProcess=456;LocalAddress='127.0.0.1'}); $results+=Test-OwnedHealth 123 'healthz'
    $script:listeners=@([pscustomobject]@{OwningProcess=123;LocalAddress='0.0.0.0'}); $results+=Test-OwnedHealth 123 'healthz'
    $script:listeners=@([pscustomobject]@{OwningProcess=123;LocalAddress='127.0.0.1'},[pscustomobject]@{OwningProcess=456;LocalAddress='127.0.0.1'}); $results+=Test-OwnedHealth 123 'healthz'
    @{results=$results} | ConvertTo-Json -Compress
  `);
    assert.deepEqual(report.results, [false, false, false, false]);
  },
);
