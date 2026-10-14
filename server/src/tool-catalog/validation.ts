import type { AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";

function isObject(value: AiDmJsonValue): value is Record<string, AiDmJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: AiDmJsonValue, right: AiDmJsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A deliberately small fail-closed JSON Schema validator for dynamically
 * loaded MCP argument schemas. Unsupported schema constructs are rejected,
 * not ignored. The transport/provider must still perform its own validation.
 */
export function validateArguments(schema: AiDmJsonValue, value: AiDmJsonValue): string[] {
  const errors: string[] = [];

  const visit = (currentSchema: AiDmJsonValue, current: AiDmJsonValue, path: string): void => {
    if (typeof currentSchema === "boolean") {
      if (!currentSchema) errors.push(`${path} is forbidden by the schema.`);
      return;
    }
    if (!isObject(currentSchema)) {
      errors.push(`${path} has an invalid schema.`);
      return;
    }

    const allowedKeywords = new Set([
      "$schema",
      "title",
      "description",
      "default",
      "examples",
      "$id",
      "type",
      "properties",
      "propertyNames",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "const",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minProperties",
      "maxProperties",
      "pattern",
      "format",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "uniqueItems",
      "anyOf",
      "oneOf",
      "allOf",
    ]);
    for (const keyword of Object.keys(currentSchema)) {
      if (!allowedKeywords.has(keyword)) {
        errors.push(`${path} uses unsupported schema keyword '${keyword}'.`);
        return;
      }
    }

    for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = currentSchema[combinator];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length === 0) {
        errors.push(`${path}.${combinator} must be a non-empty array.`);
        return;
      }
      const matches = branches.filter((branch) => validateArguments(branch, current).length === 0);
      const valid =
        combinator === "allOf"
          ? matches.length === branches.length
          : combinator === "oneOf"
            ? matches.length === 1
            : matches.length > 0;
      if (!valid) errors.push(`${path} does not satisfy ${combinator}.`);
      return;
    }

    if ("const" in currentSchema && !sameJson(currentSchema["const"], current)) {
      errors.push(`${path} does not match the required constant.`);
    }
    const enumValues = currentSchema["enum"];
    if (Array.isArray(enumValues) && !enumValues.some((entry) => sameJson(entry, current))) {
      errors.push(`${path} is not an allowed value.`);
    }

    const type = currentSchema["type"];
    const typeMatches = (candidate: AiDmJsonValue): boolean =>
      (type === "object" && isObject(current)) ||
      (type === "array" && Array.isArray(current)) ||
      (type === "string" && typeof current === "string") ||
      (type === "number" && typeof current === "number" && Number.isFinite(current)) ||
      (type === "integer" && typeof current === "number" && Number.isInteger(current)) ||
      (type === "boolean" && typeof current === "boolean") ||
      (type === "null" && candidate === null);
    if (typeof type === "string") {
      if (!typeMatches(current)) {
        errors.push(`${path} must be ${type}.`);
        return;
      }
    } else if (Array.isArray(type) && type.every((entry) => typeof entry === "string")) {
      const matches = type.some((entry) => {
        const narrowedSchema = { ...currentSchema, type: entry } as AiDmJsonValue;
        return validateArguments(narrowedSchema, current).length === 0;
      });
      if (!matches) {
        errors.push(`${path} must match one of the declared types.`);
        return;
      }
    } else if (type !== undefined) {
      errors.push(`${path} uses an unsupported type declaration.`);
      return;
    }

    if (isObject(current)) {
      const rawProperties = currentSchema["properties"];
      const properties = isObject(rawProperties as AiDmJsonValue)
        ? (rawProperties as Record<string, AiDmJsonValue>)
        : {};
      const required = currentSchema["required"];
      if (required !== undefined && !Array.isArray(required)) {
        errors.push(`${path}.required must be an array.`);
        return;
      }
      for (const requiredName of required ?? []) {
        if (typeof requiredName !== "string") {
          errors.push(`${path}.required contains a non-string name.`);
        } else if (!(requiredName in current)) {
          errors.push(`${path}.${requiredName} is required.`);
        }
      }
      for (const [key, child] of Object.entries(current)) {
        const childSchema = properties[key];
        if (childSchema !== undefined) {
          visit(childSchema, child, `${path}.${key}`);
        } else if (currentSchema["additionalProperties"] === false) {
          errors.push(`${path}.${key} is not allowed.`);
        } else if (isObject(currentSchema["additionalProperties"] as AiDmJsonValue)) {
          visit(currentSchema["additionalProperties"]!, child, `${path}.${key}`);
        }
      }
      const propertyNames = currentSchema["propertyNames"];
      if (propertyNames !== undefined) {
        for (const key of Object.keys(current)) visit(propertyNames, key, `${path} property name`);
      }
      const minProperties = currentSchema["minProperties"];
      const maxProperties = currentSchema["maxProperties"];
      if (typeof minProperties === "number" && Object.keys(current).length < minProperties)
        errors.push(`${path} has too few properties.`);
      if (typeof maxProperties === "number" && Object.keys(current).length > maxProperties)
        errors.push(`${path} has too many properties.`);
    }

    if (Array.isArray(current)) {
      const items = currentSchema["items"];
      if (items !== undefined) {
        current.forEach((child, index) => visit(items, child, `${path}[${index}]`));
      }
      const minItems = currentSchema["minItems"];
      const maxItems = currentSchema["maxItems"];
      if (typeof minItems === "number" && current.length < minItems)
        errors.push(`${path} has too few items.`);
      if (typeof maxItems === "number" && current.length > maxItems)
        errors.push(`${path} has too many items.`);
      if (currentSchema["uniqueItems"] === true) {
        const serialized = current.map((item) => JSON.stringify(item));
        if (new Set(serialized).size !== serialized.length)
          errors.push(`${path} must contain unique items.`);
      }
    }

    if (typeof current === "string") {
      const minLength = currentSchema["minLength"];
      const maxLength = currentSchema["maxLength"];
      if (typeof minLength === "number" && current.length < minLength)
        errors.push(`${path} is too short.`);
      if (typeof maxLength === "number" && current.length > maxLength)
        errors.push(`${path} is too long.`);
      const pattern = currentSchema["pattern"];
      if (typeof pattern === "string") {
        try {
          if (!new RegExp(pattern, "u").test(current))
            errors.push(`${path} has an invalid format.`);
        } catch {
          errors.push(`${path} contains an invalid schema pattern.`);
        }
      }
    }
    if (typeof current === "number") {
      const minimum = currentSchema["minimum"];
      const maximum = currentSchema["maximum"];
      if (typeof minimum === "number" && current < minimum)
        errors.push(`${path} is below the minimum.`);
      if (typeof maximum === "number" && current > maximum)
        errors.push(`${path} is above the maximum.`);
      const exclusiveMinimum = currentSchema["exclusiveMinimum"];
      const exclusiveMaximum = currentSchema["exclusiveMaximum"];
      const multipleOf = currentSchema["multipleOf"];
      if (typeof exclusiveMinimum === "number" && current <= exclusiveMinimum)
        errors.push(`${path} is not above the exclusive minimum.`);
      if (typeof exclusiveMaximum === "number" && current >= exclusiveMaximum)
        errors.push(`${path} is not below the exclusive maximum.`);
      if (typeof multipleOf === "number" && multipleOf !== 0 && current % multipleOf !== 0)
        errors.push(`${path} is not a valid multiple.`);
    }
  };

  visit(schema, value, "$arguments");
  return errors;
}
