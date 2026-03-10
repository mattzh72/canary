import type { ProjectOverview, SearchResult } from "canary-core";

export async function fetchOverview(): Promise<ProjectOverview> {
  const response = await fetch("/api/overview");
  if (!response.ok) {
    throw new Error(`Failed to fetch overview (${response.status}).`);
  }
  return response.json() as Promise<ProjectOverview>;
}

export async function searchCanary(query: string): Promise<SearchResult[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error(`Failed to search Canary (${response.status}).`);
  }
  return response.json() as Promise<SearchResult[]>;
}

export async function fetchFileContent(filePath: string): Promise<string> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch file (${response.status}).`);
  }
  const data = (await response.json()) as { content: string };
  return data.content;
}
