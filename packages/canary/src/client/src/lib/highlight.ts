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

export function highlightDiffLine(
  raw: string,
  filePath: string,
  lineClass: string
): { prefix: string | null; html: string } {
  if (lineClass === "diff-hunk" || lineClass === "diff-meta") {
    return {
      prefix: null,
      html: escapeHtml(raw || "\u00a0")
    };
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

  return { prefix, html };
}
