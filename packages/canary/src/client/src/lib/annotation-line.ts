import type { LineSide } from "canary-core";

export function resolveAnnotationCategoriesForLine(
  annotatedLineCategories: Map<string, string[]>,
  line: number,
  lineSide: LineSide,
  options?: {
    allowSideFallback?: boolean;
  }
): string[] | undefined {
  const sideSpecific = annotatedLineCategories.get(`${lineSide}:${line}`);
  if (sideSpecific) {
    return sideSpecific;
  }

  if (options?.allowSideFallback === false) {
    return undefined;
  }

  return annotatedLineCategories.get(`${line}`);
}
