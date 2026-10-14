import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import {
  TunnelHostFailure,
  WindowsTunnelHost,
  tunnelHostEnvironment,
  type TunnelHostDiagnosticEvent,
} from "./tunnel-host.js";

void test("host environment removes credentials, proxy, configuration and unsafe logging overrides", () => {
  const environment = tunnelHostEnvironment(
    {
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\synthetic",
      API_KEY: "secret",
      CONTROL_PLANE_API_KEY: "secret",
      OPENAI_ADMIN_KEY: "secret",
      HTTP_PROXY: "untrusted",
      LOG_HTTP_RAW_UNSAFE: "true",
      TUNNEL_CLIENT_CONFIG: "untrusted",
      PATH: "untrusted",
    },
    "C:\\pinned\\tunnel-client.exe",
  );
  for (const name of [
    "API_KEY",
    "CONTROL_PLANE_API_KEY",
    "OPENAI_ADMIN_KEY",
    "HTTP_PROXY",
    "LOG_HTTP_RAW_UNSAFE",
    "TUNNEL_CLIENT_CONFIG",
  ])
    assert.equal(environment[name], undefined);
  assert.ok(!environment["PATH"]!.includes("untrusted"));
  assert.equal(environment["USERPROFILE"], "C:\\Users\\synthetic");
});
void test("synthetic child confirms owned start/status/stop; no shell, detached process or secret argv", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.emit("exit", 0);
      return true;
    },
  });
  let options: Record<string, unknown> | undefined,
    argumentsReceived: readonly string[] = [];
  const launch = ((_command: string, args: readonly string[], input: Record<string, unknown>) => {
    options = input;
    argumentsReceived = args;
    queueMicrotask(() => {
      child.stdout.write('{"kind":"started","pid":123}\n');
      child.stderr.write("synthetic raw secret must be discarded");
    });
    return child;
  }) as unknown as typeof spawn;
  let exitCount = 0;
  const host = new WindowsTunnelHost("C:\\source\\host.ps1", launch, {
    SystemRoot: "C:\\Windows",
    API_KEY: "synthetic-secret",
  });
  host.onExit(() => {
    exitCount++;
  });
  child.stdin.on("data", (bytes: Buffer) => {
    if (bytes.toString() === "status\n")
      queueMicrotask(() => child.stdout.write('{"kind":"health","healthy":true,"ready":false}\n'));
    if (bytes.toString() === "stop\n") queueMicrotask(() => child.emit("exit", 0));
  });
  await host.start("C:\\pinned\\tunnel-client.exe", "C:\\private\\profile.yaml");
  assert.equal(options!["windowsHide"], false);
  assert.equal(options!["detached"], false);
  assert.equal(options!["shell"], undefined);
  assert.ok(
    argumentsReceived.includes("-ProfilePath") &&
      !JSON.stringify(argumentsReceived).includes("synthetic-secret"),
  );
  const statuses = await Promise.all([host.status(), host.status()]);
  assert.deepEqual(statuses[0], { healthy: true, ready: false });
  await host.stop();
  assert.equal(exitCount, 1);
  await assert.rejects(host.status(), /inactive/);
});

void test("startup preserves only fixed host failure codes and discards unknown code and stderr", async () => {
  for (const [provided, expected] of [
    ["visible_console_required", "visible_console_required"],
    ["native_compile_failed", "native_compile_failed"],
    ["job_assign_failed", "job_assign_failed"],
    ["process_create_failed", "process_create_failed"],
    ["synthetic raw secret value", "host_protocol_invalid"],
  ]) {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        child.emit("exit", 0);
        return true;
      },
    });
    const launch = (() => {
      queueMicrotask(() => {
        child.stderr.write("synthetic raw secret stderr");
        child.stdout.write(JSON.stringify({ kind: "failed", code: provided }) + "\n");
        child.emit("exit", 1);
      });
      return child;
    }) as unknown as typeof spawn;
    const host = new WindowsTunnelHost("C:\\source\\host.ps1", launch, {
      SystemRoot: "C:\\Windows",
    });
    await assert.rejects(
      host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture"),
      (error) => {
        assert.ok(error instanceof TunnelHostFailure);
        assert.equal(error.code, expected);
        assert.ok(!error.message.includes("synthetic raw secret"));
        return true;
      },
    );
    await host.stop();
  }
});

void test("a raw synchronous launch failure is reduced to a fixed spawn failure", async () => {
  const events: Readonly<TunnelHostDiagnosticEvent>[] = [];
  const launch = (() => {
    throw new Error("synthetic raw secret spawn error");
  }) as unknown as typeof spawn;
  const host = new WindowsTunnelHost(
    "C:\\source\\host.ps1",
    launch,
    { SystemRoot: "C:\\Windows" },
    (event) => events.push(event),
  );
  await assert.rejects(
    host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture"),
    (error) => {
      assert.ok(error instanceof TunnelHostFailure);
      assert.equal(error.code, "host_spawn_failed");
      assert.ok(!error.message.includes("synthetic raw secret"));
      return true;
    },
  );
  assert.ok(events.length > 0);
  assert.ok(
    events.every((event) => event.kind === "failure" && event.code === "host_spawn_failed"),
  );
});

void test("post-spawn errors and failed kill never release an unconfirmed owned host", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = Object.assign(new EventEmitter(), {
    pid: 456,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.emit("error", new Error("synthetic kill failure"));
      return false;
    },
  });
  const launch = (() => {
    queueMicrotask(() => child.stdout.write('{"kind":"started","pid":123}\n'));
    return child;
  }) as unknown as typeof spawn;
  const host = new WindowsTunnelHost("C:\\source\\host.ps1", launch, { SystemRoot: "C:\\Windows" });
  let exits = 0;
  host.onExit(() => {
    exits++;
  });
  await host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture");
  child.emit("error", new Error("synthetic post-spawn error"));
  assert.equal(exits, 0);
  const stopping = host.stop();
  const rejected = assert.rejects(stopping, (error) => {
    assert.ok(error instanceof TunnelHostFailure);
    assert.equal(error.code, "host_shutdown_unconfirmed");
    return true;
  });
  t.mock.timers.tick(6000);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(3000);
  await rejected;
  assert.equal(exits, 0);
  await assert.rejects(
    host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture"),
    /already owned/,
  );
  child.emit("exit", 0);
  assert.equal(exits, 1);
  await host.stop();
  await assert.rejects(host.status(), /inactive/);
});

void test("an error before successful spawn confirms that no host process was created", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  const launch = (() => {
    queueMicrotask(() => child.emit("error", new Error("synthetic spawn refusal")));
    return child;
  }) as unknown as typeof spawn;
  const host = new WindowsTunnelHost("C:\\source\\host.ps1", launch, { SystemRoot: "C:\\Windows" });
  await assert.rejects(
    host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture"),
    (error) => {
      assert.ok(error instanceof TunnelHostFailure);
      assert.equal(error.code, "host_spawn_failed");
      return true;
    },
  );
  await host.stop();
});

void test("diagnostic observer projects process identity, health and separate native and wrapper exits without raw output", async () => {
  const secret = "synthetic-secret-must-not-enter-diagnostics";
  const events: Readonly<TunnelHostDiagnosticEvent>[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 456,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.emit("exit", 1, null);
      return true;
    },
  });
  const launch = (() => {
    queueMicrotask(() => {
      child.stdout.write(secret + "\n" + '{"malformed":"' + secret + "\n");
      child.stderr.write(secret);
      child.stdout.write(
        JSON.stringify({ kind: "started", pid: 123, argv: secret, environment: secret }) + "\n",
      );
    });
    return child;
  }) as unknown as typeof spawn;
  const host = new WindowsTunnelHost(
    "C:\\source\\host.ps1",
    launch,
    { SystemRoot: "C:\\Windows", API_KEY: secret },
    (event) => {
      assert.ok(Object.isFrozen(event));
      events.push(event);
    },
  );
  let statuses = 0;
  child.stdin.on("data", (bytes: Buffer) => {
    if (bytes.toString() !== "status\n") return;
    queueMicrotask(() => {
      if (++statuses === 1)
        child.stdout.write(
          JSON.stringify({ kind: "health", healthy: true, ready: false, body: secret }) + "\n",
        );
      else {
        child.stdout.write(
          JSON.stringify({
            kind: "failed",
            code: "child_exited",
            exitCode: 3221225477,
            error: secret,
          }) + "\n",
        );
        child.emit("exit", 1, null);
      }
    });
  });
  await host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture");
  assert.deepEqual(await host.status(), { healthy: true, ready: false });
  await assert.rejects(
    host.status(),
    (error) => error instanceof TunnelHostFailure && error.code === "child_exited",
  );
  await host.stop();
  assert.deepEqual(events, [
    { kind: "spawned", hostPid: 456, childPid: 123 },
    { kind: "health", healthy: true, ready: false },
    { kind: "exit", process: "child", exitCode: 3221225477, signal: null },
    { kind: "failure", code: "child_exited" },
    { kind: "exit", process: "host", exitCode: 1, signal: null },
  ]);
  assert.ok(!JSON.stringify(events).includes(secret));
});

void test("unknown failure strings, invalid exit details and throwing diagnostic writers cannot leak or affect ownership", async () => {
  const secret = "synthetic-secret-unknown-error";
  const events: Readonly<TunnelHostDiagnosticEvent>[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 456,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  const launch = (() => {
    queueMicrotask(() => child.stdout.write('{"kind":"started","pid":123}\n'));
    return child;
  }) as unknown as typeof spawn;
  const host = new WindowsTunnelHost(
    "C:\\source\\host.ps1",
    launch,
    { SystemRoot: "C:\\Windows" },
    (event) => {
      events.push(event);
      throw new Error(secret);
    },
  );
  await host.start("C:\\synthetic\\child.exe", "C:\\synthetic\\profile.fixture");
  child.stdin.on("data", (bytes: Buffer) => {
    if (bytes.toString() === "status\n")
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({ kind: "failed", code: secret, exitCode: secret }) + "\n",
        );
        child.emit("exit", Number.MAX_SAFE_INTEGER, secret);
      });
  });
  await assert.rejects(
    host.status(),
    (error) => error instanceof TunnelHostFailure && error.code === "host_protocol_invalid",
  );
  await host.stop();
  assert.deepEqual(events, [
    { kind: "spawned", hostPid: 456, childPid: 123 },
    { kind: "failure", code: "host_protocol_invalid" },
    { kind: "exit", process: "host", exitCode: null, signal: null },
  ]);
  assert.ok(!JSON.stringify(events).includes(secret));
});
