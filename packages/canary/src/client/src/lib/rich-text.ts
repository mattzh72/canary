const ESCAPED_NEWLINE_PATTERN = /\\r\\n|\\n|\\r/g;

export function normalizeRichTextBody(body: string): string {
  if (body.includes("\n") || body.includes("\r")) {
    return body;
  }

  const trimmed = body.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to escaped newline normalization.
    }
  }

  const escapedNewlines = body.match(ESCAPED_NEWLINE_PATTERN);
  if (!escapedNewlines || escapedNewlines.length < 2) {
    return body;
  }

  return body
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}
