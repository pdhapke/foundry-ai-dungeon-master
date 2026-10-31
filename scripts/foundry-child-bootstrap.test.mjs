import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const bootstrapStateSymbol = Symbol.for("foundry-ai-dungeon-master.foundry-child-bootstrap.state");
const testRuntime = globalThis.process;

// Suppress the module's production auto-start while loading its exported,
// dependency-injected lifecycle function in this isolated test process.
const previousProcessState = Object.getOwnPropertyDescriptor(testRuntime, bootstrapStateSymbol);
Object.defineProperty(testRuntime, bootstrapStateSymbol, {
  configurable: true,
  value: { child: null },
});
const { publishAiDmApiExtension, startFoundryAiDungeonMasterChild } = await import(
  `./foundry-child-bootstrap.mjs?test=${Date.now()}`
);
if (previousProcessState) {
  Object.defineProperty(testRuntime, bootstrapStateSymbol, previousProcessState);
} else {
  delete testRuntime[bootstrapStateSymbol];
}

class FakeHostProcess extends EventEmitter {
  constructor() {
    super();
    this.execPath = "C:\\Foundry\\node.exe";
    this.env = { TEST_SENTINEL: "inherited" };
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.unrefCalls = 0;
    this.killCalls = 0;
  }

  unref() {
    this.unrefCalls += 1;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }
}

function createLogger() {
  const logs = [];
  const errors = [];
  return {
    errors,
    logger: {
      error(message) {
        errors.push(message);
      },
      log(message) {
        logs.push(message);
      },
    },
    logs,
  };
}

test("missing build output is diagnosed without spawning or throwing", () => {
  const hostProcess = new FakeHostProcess();
  const { errors, logger } = createLogger();
  let spawnCalls = 0;

  const result = startFoundryAiDungeonMasterChild({
    entryExists: () => false,
    hostProcess,
    logger,
    publishExtension() {},
    serverEntryPoint: "C:\\module\\server\\dist\\index.js",
    spawnChild: () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });

  assert.equal(result, null);
  assert.equal(spawnCalls, 0);
  assert.equal(hostProcess.listenerCount("exit"), 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Built server entry point is missing/);
  assert.match(errors[0], /server\\dist\\index\.js/);
});

test("a synchronous spawn failure is visible and isolated from the host", () => {
  const hostProcess = new FakeHostProcess();
  const { errors, logger } = createLogger();

  const result = startFoundryAiDungeonMasterChild({
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    spawnChild: () => {
      throw new Error("synthetic spawn failure");
    },
  });

  assert.equal(result, null);
  assert.equal(hostProcess.listenerCount("exit"), 0);
  assert.deepEqual(errors, [
    "[foundry-ai-dungeon-master] Failed to start child process: synthetic spawn failure",
  ]);
});

test("duplicate evaluation guard starts one child with the Foundry runtime contract", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const { logger, logs } = createLogger();
  const spawnCalls = [];
  const options = {
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    serverDirectory: "C:\\module\\server",
    serverEntryPoint: "C:\\module\\server\\dist\\index.js",
    spawnChild(executable, args, spawnOptions) {
      spawnCalls.push({ args, executable, spawnOptions });
      return child;
    },
  };

  const first = startFoundryAiDungeonMasterChild(options);
  const second = startFoundryAiDungeonMasterChild(options);

  assert.equal(first, child);
  assert.equal(second, child);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], {
    args: ["C:\\module\\server\\dist\\index.js"],
    executable: hostProcess.execPath,
    spawnOptions: {
      cwd: "C:\\module\\server",
      env: hostProcess.env,
      stdio: "inherit",
      windowsHide: false,
    },
  });
  assert.equal(child.unrefCalls, 1);
  assert.equal(hostProcess.listenerCount("exit"), 1);

  child.emit("spawn");
  assert.deepEqual(logs, ["[foundry-ai-dungeon-master] Started child process 4242."]);
});

test("an asynchronous child spawn error is reported without restarting", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const { errors, logger } = createLogger();
  let spawnCalls = 0;
  const options = {
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    spawnChild: () => {
      spawnCalls += 1;
      return child;
    },
  };

  startFoundryAiDungeonMasterChild(options);
  child.emit("error", new Error("synthetic asynchronous failure"));
  const duplicate = startFoundryAiDungeonMasterChild(options);

  assert.equal(duplicate, child);
  assert.equal(spawnCalls, 1);
  assert.deepEqual(errors, [
    "[foundry-ai-dungeon-master] Failed to start child process: synthetic asynchronous failure",
  ]);
});

test("an early child exit is diagnosed and does not create a restart loop", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const { errors, logger } = createLogger();
  let spawnCalls = 0;
  const options = {
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    spawnChild: () => {
      spawnCalls += 1;
      return child;
    },
  };

  startFoundryAiDungeonMasterChild(options);
  child.exitCode = 17;
  child.emit("exit", 17, null);
  startFoundryAiDungeonMasterChild(options);

  assert.equal(spawnCalls, 1);
  assert.deepEqual(errors, [
    "[foundry-ai-dungeon-master] Child process exited while Foundry is still running (code=17, signal=none).",
  ]);
});

test("parent shutdown terminates a live child and suppresses an expected exit error", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const { errors, logger } = createLogger();

  startFoundryAiDungeonMasterChild({
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    spawnChild: () => child,
  });

  hostProcess.emit("exit", 0);
  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");

  assert.equal(child.killCalls, 1);
  assert.deepEqual(errors, []);
});

test("parent shutdown does not kill a child that already exited", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const { logger } = createLogger();

  startFoundryAiDungeonMasterChild({
    entryExists: () => true,
    hostProcess,
    logger,
    publishExtension() {},
    spawnChild: () => child,
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  hostProcess.emit("exit", 0);

  assert.equal(child.killCalls, 0);
});

test("startup publishes the API extension before the child inherits the environment", () => {
  const hostProcess = new FakeHostProcess();
  const child = new FakeChildProcess();
  const entry = new globalThis.URL("file:///C:/synthetic/ai/server/dist/dot-extension.js");
  startFoundryAiDungeonMasterChild({
    entryExists: () => true,
    hostProcess,
    publishExtension(environment) {
      environment.FOUNDRY_API_EXTENSIONS = JSON.stringify([entry.href]);
    },
    spawnChild: () => child,
  });
  assert.deepEqual(JSON.parse(hostProcess.env.FOUNDRY_API_EXTENSIONS), [entry.href]);
});

test("a missing extension build is reported and does not change the environment", () => {
  const environment = { KEEP: "yes" };
  const errors = [];
  publishAiDmApiExtension(
    environment,
    {
      error(message) {
        errors.push(message);
      },
    },
    { entryExists: () => false },
  );
  assert.deepEqual(environment, { KEEP: "yes" });
  assert.match(errors[0], /API extension is not built/);
});
