import type { SearchResult } from "@canaryctl/core";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printRecord(id: string, title: string, detail: string): void {
  process.stdout.write(`${id}  ${title}\n${detail}\n`);
}

export function printSearchResults(results: SearchResult[]): void {
  if (results.length === 0) {
    process.stdout.write("No matches.\n");
    return;
  }

  for (const result of results) {
    process.stdout.write(
      `${result.kind.padEnd(10)} ${result.title} (${result.filePath ?? "project"})\n${result.excerpt}\n\n`
    );
  }
}
