import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerAiDmApiExtension } from "./api-extension-registration.mjs";

const bootstrapStateSymbol = Symbol.for("foundry-ai-dungeon-master.foundry-child-bootstrap.state");

const defaultServerDirectory = fileURLToPath(new globalThis.URL("../server/", import.meta.url));
const defaultServerEntryPoint = fileURLToPath(
  new globalThis.URL("../server/dist/index.js", import.meta.url),
);

/**
 * Start the AI Dungeon Master server as a child owned by the Foundry process.
 * Optional dependencies keep the lifecycle behavior deterministic to test.
 */
export function startFoundryAiDungeonMasterChild({
  hostProcess = globalThis.process,
  spawnChild = spawn,
  entryExists = existsSync,
  serverDirectory = defaultServerDirectory,
  serverEntryPoint = defaultServerEntryPoint,
  logger = globalThis.console,
  publishExtension = publishAiDmApiExtension,
} = {}) {
  if (hostProcess[bootstrapStateSymbol]) {
    return hostProcess[bootstrapStateSymbol].child;
  }

  const state = {
    child: null,
    parentExiting: false,
  };

  Object.defineProperty(hostProcess, bootstrapStateSymbol, {
    configurable: true,
    value: state,
  });

  publishExtension(hostProcess.env, logger);

  if (!entryExists(serverEntryPoint)) {
    logger.error(
      `[foundry-ai-dungeon-master] Built server entry point is missing: ${serverEntryPoint}. Run npm run build in the module directory.`,
    );
    return null;
  }

  let child;
  try {
    child = spawnChild(hostProcess.execPath, [serverEntryPoint], {
      cwd: serverDirectory,
      env: hostProcess.env,
      stdio: "inherit",
      windowsHide: false,
    });
  } catch (error) {
    logger.error(`[foundry-ai-dungeon-master] Failed to start child process: ${error.message}`);
    return null;
  }

  state.child = child;

  // Do not let the AI server keep Foundry alive after Foundry has otherwise
  // finished shutting down. The synchronous exit hook below still terminates
  // the child during a normal exit or handled signal.
  child.unref();

  child.once("spawn", () => {
    logger.log(`[foundry-ai-dungeon-master] Started child process ${child.pid}.`);
  });

  child.once("error", (error) => {
    logger.error(`[foundry-ai-dungeon-master] Failed to start child process: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    if (!state.parentExiting) {
      logger.error(
        `[foundry-ai-dungeon-master] Child process exited while Foundry is still running (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
      );
    }
  });

  hostProcess.once("exit", () => {
    state.parentExiting = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });

  return child;
}

/** Put this module's extension on the process environment before a Local API spawn copies it. */
export function publishAiDmApiExtension(environment, logger = globalThis.console, options) {
  try {
    registerAiDmApiExtension(environment, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "AI_DM_EXTENSION_BUILD_REQUIRED") {
      logger.error(
        "[foundry-ai-dungeon-master] API extension is not built. Local API will not load queue or wake tools until npm run build.",
      );
      return;
    }
    logger.error(`[foundry-ai-dungeon-master] API extension registration failed: ${message}`);
  }
}

startFoundryAiDungeonMasterChild();
