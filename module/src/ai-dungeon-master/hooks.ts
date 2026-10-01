import { AiDungeonMasterApplication } from "./application.js";
import type { ChatKitTrigger } from "./chatkit-context.js";

export interface SceneControlTool {
  name: string;
  title: string;
  icon: string;
  button: true;
  order: number;
  onChange: () => void;
}
export function addAiDungeonMasterSceneControl(controls: unknown): void {
  if (!game.user.isGM) return;
  const tool: SceneControlTool = {
    name: "ai-dungeon-master",
    title: "AI Dungeon Master",
    icon: "fas fa-dragon",
    button: true,
    order: 90,
    onChange: () => void AiDungeonMasterApplication.open(),
  };
  if (Array.isArray(controls)) {
    const token = (controls as Array<{ name?: string; tools?: SceneControlTool[] }>).find(
      (c) => c.name === "token",
    );
    if (token?.tools && !token.tools.some((t) => t.name === tool.name)) token.tools.push(tool);
  } else if (controls && typeof controls === "object") {
    const token = (
      controls as Record<string, { tools?: Record<string, unknown> | SceneControlTool[] }>
    )["tokens"];
    if (Array.isArray(token?.tools)) {
      if (!token.tools.some((t) => t.name === tool.name)) token.tools.push(tool);
    } else if (token?.tools) token.tools[tool.name] = tool;
  }
}
let registered = false;
export function registerAiDungeonMasterHooks(): void {
  if (registered) return;
  registered = true;
  Hooks.on("getSceneControlButtons", addAiDungeonMasterSceneControl);
  Hooks.on("chatMessage", (_chatLog: unknown, message: string) => {
    const match = message.match(/^\/ai(?:\s+([\s\S]+))?$/i);
    if (!match) return true;
    if (!game.user.isGM) {
      ui.notifications.warn("AI Dungeon Master currently requires a GM.");
      return false;
    }
    const application = AiDungeonMasterApplication.open();
    if (match[1])
      void application
        .trigger({ prompt: match[1] })
        .catch((error) =>
          ui.notifications.error(
            error instanceof Error ? error.message : "ChatKit request failed.",
          ),
        );
    return false;
  });
  // One explicit application event; no inferred game-event loops or automatic retries.
  Hooks.on("foundry-ai-dungeon-master.trigger", (request: ChatKitTrigger) => {
    void AiDungeonMasterApplication.open()
      .trigger(request)
      .catch((error) =>
        ui.notifications.error(error instanceof Error ? error.message : "ChatKit trigger failed."),
      );
  });
}
