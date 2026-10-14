import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";

export const TUNNEL_HOST_FAILURE_CODES = [
  "host_failed",
  "visible_console_required",
  "invalid_path",
  "invalid_executable",
  "native_compile_failed",
  "health_listener_failed",
  "health_port_occupied",
  "job_create_failed",
  "job_limits_failed",
  "nul_handle_failed",
  "attribute_list_failed",
  "handle_list_failed",
  "process_create_failed",
  "job_assign_failed",
  "process_resume_failed",
  "control_input_invalid",
  "child_exited",
  "host_spawn_failed",
  "host_protocol_invalid",
  "host_start_timeout",
  "host_status_timeout",
  "host_shutdown_unconfirmed",
] as const;
export type TunnelHostFailureCode = (typeof TUNNEL_HOST_FAILURE_CODES)[number];
export const TUNNEL_HOST_DIAGNOSTIC_SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGBREAK",
  "SIGQUIT",
] as const;
export type TunnelHostDiagnosticSignal = (typeof TUNNEL_HOST_DIAGNOSTIC_SIGNALS)[number];
export type TunnelHostDiagnosticEvent =
  | { kind: "spawned"; hostPid: number; childPid: number }
  | {
      kind: "exit";
      process: "host" | "child";
      exitCode: number | null;
      signal: TunnelHostDiagnosticSignal | null;
    }
  | { kind: "health"; healthy: boolean; ready: boolean }
  | { kind: "failure"; code: TunnelHostFailureCode };
export type TunnelHostDiagnosticObserver = (event: Readonly<TunnelHostDiagnosticEvent>) => void;
function diagnosticExitCode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 4294967295
    ? value
    : null;
}
function diagnosticSignal(value: unknown): TunnelHostDiagnosticSignal | null {
  return typeof value === "string" &&
    (TUNNEL_HOST_DIAGNOSTIC_SIGNALS as readonly string[]).includes(value)
    ? (value as TunnelHostDiagnosticSignal)
    : null;
}
function diagnosticPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4294967295;
}
export class TunnelHostFailure extends Error {
  constructor(readonly code: TunnelHostFailureCode) {
    super(`Tunnel host failed: ${code}.`);
    this.name = "TunnelHostFailure";
  }
}
function hostFailure(
  value: unknown,
  fallback: TunnelHostFailureCode = "host_failed",
): TunnelHostFailure {
  return new TunnelHostFailure(
    typeof value === "string" && (TUNNEL_HOST_FAILURE_CODES as readonly string[]).includes(value)
      ? (value as TunnelHostFailureCode)
      : fallback,
  );
}

export interface TunnelHostHealth {
  healthy: boolean;
  ready: boolean;
}
export interface TunnelHost {
  start(executable: string, profile: string): Promise<void>;
  status(): Promise<TunnelHostHealth>;
  stop(): Promise<void>;
  onExit(callback: () => void): void;
}
/** No inherited credentials, proxies, raw logging or alternate configuration. */
export function tunnelHostEnvironment(
  source: NodeJS.ProcessEnv,
  executable: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ])
    if (source[key]) environment[key] = source[key];
  const root = environment["SystemRoot"];
  if (!root) throw hostFailure("host_spawn_failed");
  environment["PATH"] = [join(root, "System32"), root, dirname(executable)].join(";");
  environment["PSModulePath"] = join(root, "System32", "WindowsPowerShell", "v1.0", "Modules");
  return environment;
}
/** Owns one host ChildProcess. Its Job owns the suspended-before-assignment
 * official client tree. No persisted PID, detached process or raw child output. */
export class WindowsTunnelHost implements TunnelHost {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exited = false;
  private callback: () => void = () => undefined;
  private healthRequest: Promise<TunnelHostHealth> | undefined;
  private reply:
    | { accept(value: Record<string, unknown>): void; reject(code?: TunnelHostFailureCode): void }
    | undefined;
  constructor(
    private readonly script: string,
    private readonly launch: typeof spawn = spawn,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly observer: TunnelHostDiagnosticObserver = () => undefined,
  ) {}
  private observe(event: TunnelHostDiagnosticEvent): void {
    // Only newly projected structural objects reach the diagnostic writer.
    // Diagnostic storage failures must never change process ownership.
    try {
      this.observer(Object.freeze(event));
    } catch {
      /* no raw writer error */
    }
  }
  private failure(
    value: unknown,
    fallback: TunnelHostFailureCode = "host_failed",
  ): TunnelHostFailure {
    const error = hostFailure(value, fallback);
    this.observe({ kind: "failure", code: error.code });
    return error;
  }
  onExit(callback: () => void): void {
    this.callback = callback;
  }
  private request(kind: "started" | "health", send?: string): Promise<Record<string, unknown>> {
    if (this.reply) return Promise.reject(new Error("Tunnel host is busy."));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.reply = undefined;
          reject(this.failure(kind === "started" ? "host_start_timeout" : "host_status_timeout"));
        },
        kind === "started" ? 30000 : 20000,
      );
      this.reply = {
        accept: (value) => {
          if (value["kind"] !== kind && value["kind"] !== "failed") return;
          clearTimeout(timeout);
          this.reply = undefined;
          if (value["kind"] === "failed") {
            if (value["code"] === "child_exited")
              this.observe({
                kind: "exit",
                process: "child",
                exitCode: diagnosticExitCode(value["exitCode"]),
                signal: null,
              });
            reject(this.failure(value["code"], "host_protocol_invalid"));
          } else resolve(value);
        },
        reject: (code = "child_exited") => {
          clearTimeout(timeout);
          this.reply = undefined;
          reject(this.failure(code));
        },
      };
      if (send) this.child?.stdin.write(send);
    });
  }
  async start(executable: string, profile: string): Promise<void> {
    if (this.child) throw new Error("Tunnel host is already owned.");
    let environment: NodeJS.ProcessEnv;
    try {
      environment = tunnelHostEnvironment(this.environment, executable);
    } catch {
      throw this.failure("host_spawn_failed");
    }
    const pending = this.request("started");
    try {
      const child = this.launch(
        join(environment["SystemRoot"]!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.script,
          "-ExecutablePath",
          executable,
          "-ProfilePath",
          profile,
        ],
        { windowsHide: false, detached: false, env: environment, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.child = child;
      this.exited = false;
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        buffer += data;
        if (buffer.length > 2048) {
          this.reply?.reject("host_protocol_invalid");
          void this.stop().catch(() => undefined);
          buffer = "";
          return;
        }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.length > 512) continue;
          try {
            const value: unknown = JSON.parse(line);
            if (value && typeof value === "object" && !Array.isArray(value))
              this.reply?.accept(value as Record<string, unknown>);
          } catch {
            /* discard; never log raw bytes */
          }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      let spawned = Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0;
      child.once("spawn", () => {
        spawned = true;
      });
      const exit = (code: TunnelHostFailureCode) => {
        if (this.child !== child || this.exited) return;
        this.exited = true;
        this.reply?.reject(code);
        this.callback();
      };
      child.on("error", () => {
        if (this.child !== child || this.exited) return;
        // A post-spawn error (including kill failure) does not prove exit.
        // Retain the live handle until the real exit event confirms ownership ended.
        if (!spawned && child.pid === undefined) exit("host_spawn_failed");
        else this.reply?.reject("host_failed");
      });
      child.on("exit", (exitCode: unknown, signal: unknown) => {
        if (this.child !== child || this.exited) return;
        this.observe({
          kind: "exit",
          process: "host",
          exitCode: diagnosticExitCode(exitCode),
          signal: diagnosticSignal(signal),
        });
        exit("child_exited");
      });
      const value = await pending;
      if (!diagnosticPid(value["pid"]) || this.exited) throw this.failure("host_protocol_invalid");
      spawned = true;
      if (diagnosticPid(child.pid))
        this.observe({ kind: "spawned", hostPid: child.pid, childPid: value["pid"] });
    } catch (error) {
      this.reply?.reject(error instanceof TunnelHostFailure ? error.code : "host_spawn_failed");
      await pending.catch(() => undefined);
      await this.stop();
      throw error instanceof TunnelHostFailure ? error : this.failure("host_spawn_failed");
    }
  }
  async status(): Promise<TunnelHostHealth> {
    if (this.healthRequest) return this.healthRequest;
    if (!this.child || this.exited) throw new Error("Tunnel host is inactive.");
    this.healthRequest = this.request("health", "status\n")
      .then((value) => {
        if (typeof value["healthy"] !== "boolean" || typeof value["ready"] !== "boolean")
          throw this.failure("host_protocol_invalid");
        this.observe({ kind: "health", healthy: value["healthy"], ready: value["ready"] });
        return { healthy: value["healthy"], ready: value["ready"] };
      })
      .finally(() => {
        this.healthRequest = undefined;
      });
    return this.healthRequest;
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.reply?.reject();
    if (!this.exited) {
      child.stdin.end("stop\n");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 6000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      if (!this.exited) {
        // Exact live ChildProcess handle only; closing the host kills its Job.
        child.kill();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    }
    if (!this.exited) throw this.failure("host_shutdown_unconfirmed");
    this.child = undefined;
  }
}
