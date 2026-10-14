type Source = Record<string, unknown>;
function record(value: unknown): Source | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Source : undefined;
}
function preparationId(source: Source | undefined): unknown {
  const flags = record(source?.["flags"]);
  return record(flags?.["foundry-ai-dungeon-master"])?.["preparationId"];
}

/** AI DM preparation policy, invoked synchronously immediately before the
 * generic document dispatcher writes. Legacy request fields remain supported. */
export function validatePreparedScene(context: unknown): void {
  const value = record(context), input = record(value?.["input"]);
  const guard = record(input?.["preparationGuard"]);
  const sceneId = guard?.["sceneId"], id = guard?.["preparationId"];
  if (typeof sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sceneId) || typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid preparation guard");
  const family = input?.["family"], operation = input?.["operation"];
  if (typeof family !== "string" || (family !== "scenes" && !family.startsWith("scene-"))) throw new Error("Preparation guard requires scene document");
  if ((input?.["parentId"] ?? input?.["targetId"]) !== sceneId) throw new Error("Preparation scene scope mismatch");
  const data = record(value?.["data"]) ?? {};
  if (family === "scenes" && operation === "create") {
    const ownership = record(data["ownership"]);
    if (data["active"] !== false || data["navigation"] !== false || ownership?.["default"] !== 0 || preparationId(data) !== id) throw new Error("Preparation scene must remain inactive");
  } else {
    const source = record(value?.["source"]);
    if (source?.["active"] !== false || preparationId(source) !== id) throw new Error("Preparation scene changed or became active");
    if (family === "scenes" && (data["active"] === true || data["navigation"] === true)) throw new Error("Preparation cannot activate scene");
  }
}
