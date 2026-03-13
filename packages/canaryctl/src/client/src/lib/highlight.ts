import Prism from "prismjs";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-python.js";

const languageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  md: "markdown",
  sql: "sql",
  py: "python"
};

const HIGHLIGHT_CACHE_LIMIT = 4000;
const highlightCache = new Map<string, { prefix: string | null; html: string }>();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function languageForFile(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return languageByExtension[filePath.slice(dot + 1)] ?? null;
}

function cacheHighlightedLine(
  cacheKey: string,
  value: { prefix: string | null; html: string }
): { prefix: string | null; html: string } {
  if (highlightCache.has(cacheKey)) {
    highlightCache.delete(cacheKey);
  }
  highlightCache.set(cacheKey, value);

  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldestKey = highlightCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    highlightCache.delete(oldestKey);
  }

  return value;
}

export function highlightDiffLine(
  raw: string,
  filePath: string,
  lineClass: string
): { prefix: string | null; html: string } {
  const cacheKey = `${filePath}\u0000${lineClass}\u0000${raw}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }

  if (lineClass === "diff-hunk" || lineClass === "diff-meta") {
    return cacheHighlightedLine(cacheKey, {
      prefix: null,
      html: escapeHtml(raw || "\u00a0")
    });
  }

  let prefix: string | null = null;
  let content = raw;

  if (lineClass === "diff-add" || lineClass === "diff-remove") {
    prefix = raw.slice(0, 1);
    content = raw.slice(1);
  } else if (raw.startsWith(" ")) {
    prefix = " ";
    content = raw.slice(1);
  }

  const language = languageForFile(filePath);
  const grammar = language ? Prism.languages[language] : undefined;
  const html = language && grammar
    ? Prism.highlight(content || " ", grammar, language)
    : escapeHtml(content || "\u00a0");

  return cacheHighlightedLine(cacheKey, { prefix, html });
}
