import type { JsonObject } from "../types/models.js";

export function parseJsonObject(value: string | null | undefined): JsonObject {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return {};
  }

  return {};
}

export function stringifyJson(value: JsonObject): string {
  return JSON.stringify(value);
}
