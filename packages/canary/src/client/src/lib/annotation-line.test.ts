import { describe, expect, it } from "vitest";
import { resolveAnnotationCategoriesForLine } from "./annotation-line.js";

describe("resolveAnnotationCategoriesForLine", () => {
  it("prefers the side-specific key when present", () => {
    const annotatedLineSeverity = new Map<string, string[]>([
      ["new:17", ["high"]],
      ["17", ["low"]],
    ]);

    expect(
      resolveAnnotationCategoriesForLine(annotatedLineSeverity, 17, "new"),
    ).toEqual(["high"]);
  });

  it("can fall back to a side-less key for source context rows", () => {
    const annotatedLineSeverity = new Map<string, string[]>([["17", ["medium"]]]);

    expect(
      resolveAnnotationCategoriesForLine(annotatedLineSeverity, 17, "new"),
    ).toEqual(["medium"]);
  });

  it("does not leak side-less fallback onto the wrong diff side", () => {
    const annotatedLineSeverity = new Map<string, string[]>([
      ["new:17", ["high"]],
      ["17", ["high"]],
    ]);

    expect(
      resolveAnnotationCategoriesForLine(annotatedLineSeverity, 17, "old", {
        allowSideFallback: false,
      }),
    ).toBeUndefined();
  });
});
