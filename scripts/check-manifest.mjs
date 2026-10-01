import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "module.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

if (manifest.id !== "foundry-ai-dungeon-master") {
  throw new Error("module.json must use module ID foundry-ai-dungeon-master.");
}
if (manifest.title !== "AI Dungeon Master") {
  throw new Error("The user-facing module title must be AI Dungeon Master.");
}
if (manifest.version !== packageJson.version) {
  throw new Error("module.json and package.json versions are not synchronized.");
}
if (manifest.compatibility?.minimum !== "14" || manifest.compatibility?.verified !== "14") {
  throw new Error("Foundry compatibility must remain minimum/verified v14.");
}

process.stdout.write("AI Dungeon Master manifest is synchronized.\n");
