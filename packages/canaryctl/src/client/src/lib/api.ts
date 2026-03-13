import type {
  ProjectOverview,
  SearchResult,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadStatus
} from "@canaryctl/core";

interface RequestOptions {
  signal?: AbortSignal;
}

async function parseJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();
  let parsedBody: unknown = null;

  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    const detail =
      parsedBody &&
      typeof parsedBody === "object" &&
      "error" in parsedBody &&
      typeof parsedBody.error === "string"
        ? ` ${parsedBody.error}`
        : "";
    throw new Error(`${fallbackMessage} (${response.status}).${detail}`);
  }

  if (!contentType.includes("application/json") || parsedBody === null) {
    throw new Error(
      `${fallbackMessage}. Expected JSON but received ${contentType || "an unknown content type"}.`
    );
  }

  return parsedBody as T;
}

export async function fetchOverview(
  options: RequestOptions = {}
): Promise<ProjectOverview> {
  const response = await fetch("/api/overview", {
    signal: options.signal
  });
  return parseJsonResponse<ProjectOverview>(response, "Failed to fetch overview");
}

export async function fetchProjectTree(
  options: RequestOptions = {}
): Promise<string[]> {
  const response = await fetch("/api/tree", {
    signal: options.signal
  });
  const data = await parseJsonResponse<{ paths: string[] }>(
    response,
    "Failed to fetch project tree"
  );
  return data.paths;
}

export async function searchCanary(
  query: string,
  options: RequestOptions = {}
): Promise<SearchResult[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
    signal: options.signal
  });
  return parseJsonResponse<SearchResult[]>(response, "Failed to search Canary");
}

export async function fetchFileContent(
  filePath: string,
  options: RequestOptions = {}
): Promise<string> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
    signal: options.signal
  });
  const data = await parseJsonResponse<{ content: string }>(
    response,
    "Failed to fetch file"
  );
  return data.content;
}

export async function replyToThread(
  threadId: string,
  body: string
): Promise<ThreadMessageRecord> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/replies`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ body })
  });

  return parseJsonResponse<ThreadMessageRecord>(response, "Failed to reply to thread");
}

export async function setThreadStatus(
  threadId: string,
  status: ThreadStatus
): Promise<ThreadRecord> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ status })
  });

  return parseJsonResponse<ThreadRecord>(response, "Failed to update thread status");
}
