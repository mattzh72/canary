import { describe, expect, it } from "vitest";
import { normalizeRichTextBody } from "./rich-text.js";

describe("normalizeRichTextBody", () => {
  it("preserves bodies that already contain real newlines", () => {
    const body = [
      "Why it matters:",
      "- keeps the existing markdown layout intact",
      "- avoids rewriting already-correct data"
    ].join("\n");

    expect(normalizeRichTextBody(body)).toBe(body);
  });

  it("decodes repeated escaped newlines for markdown rendering", () => {
    const body =
      "Why it matters:\\n- stale threads stay visible\\n- markdown bullets should render";

    expect(normalizeRichTextBody(body)).toBe(
      [
        "Why it matters:",
        "- stale threads stay visible",
        "- markdown bullets should render"
      ].join("\n")
    );
  });

  it("leaves a single literal newline escape alone", () => {
    const body = "Use \\\\n in the parser example.";

    expect(normalizeRichTextBody(body)).toBe(body);
  });
});
