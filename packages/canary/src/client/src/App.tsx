import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import type {
  ArtifactFreshness,
  ChangedFileSummary,
  FileBriefRecord,
  LineSide,
  ProjectOverview,
  SearchResult,
  SessionRecord,
  ThreadRecord,
} from "@canaryctl/core";
import {
  fetchProjectTree,
  fetchOverview,
  replyToThread,
  fetchFileContent,
  searchCanary,
  setThreadStatus,
} from "./lib/api";
import { resolveAnnotationCategoriesForLine } from "./lib/annotation-line.js";
import { highlightDiffLine } from "./lib/highlight.js";
import { normalizeRichTextBody } from "./lib/rich-text.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  isFile: boolean;
  indicators: AnnotationIndicator[];
  hasBrief: boolean;
  briefFreshness: ArtifactFreshness | null;
  hasReviewSignal: boolean;
  changeType?: "add" | "change" | "unlink";
}

interface AnnotationIndicator {
  type: "thread";
  category?: ThreadRecord["type"];
  count: number;
}

interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
  isOpen: boolean;
}

interface FileAnnotation {
  id: string;
  type: "thread";
  title: string;
  body: string;
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  category?: ThreadRecord["type"];
  status: string;
  freshness: ArtifactFreshness;
  author: string;
  authorType: ThreadRecord["authorType"];
  authorAvatarSvg: string | null;
  createdAt: string;
  messages?: {
    id: string;
    author: string;
    authorType: ThreadRecord["authorType"];
    authorAvatarSvg: string | null;
    body: string;
    createdAt: string;
  }[];
}

interface ReviewSection {
  filePath: string;
  annotations: FileAnnotation[];
  brief: FileBriefRecord | null;
  change: ChangedFileSummary | null;
  totalThreads: number;
  openThreads: number;
}

interface PersistedWorkspaceState {
  openTabs: string[];
  activeTab: string | null;
  expandedDirs: string[];
  sidebarTab: "files" | "activity";
}

const EMPTY_FILE_ANNOTATIONS: FileAnnotation[] = [];
const WORKSPACE_STATE_STORAGE_PREFIX = "canary.ui.workspace";
const FILE_CONTENT_CACHE_LIMIT = 24;
const FILE_TREE_OVERSCAN = 12;
const FILE_TREE_ROW_HEIGHT = 26;
const OVERVIEW_POLL_INTERVAL_MS = 2000;
const SEARCH_DEBOUNCE_MS = 150;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const RichTextBody = memo(function RichTextBody({
  body,
  className,
}: {
  body: string;
  className: string;
}) {
  const normalizedBody = normalizeRichTextBody(body);

  if (!normalizedBody.trim()) {
    return null;
  }

  return (
    <div className={className}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="m-0 leading-inherit">{children}</p>,
          ul: ({ children }) => (
            <ul className="m-0 list-disc space-y-1.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="m-0 list-decimal space-y-1.5 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          code: ({ children }) => (
            <code className="rounded-[6px] bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 font-mono text-[0.92em] text-[color:inherit]">
              {children}
            </code>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-[color:inherit]">
              {children}
            </strong>
          ),
          h1: ({ children }) => (
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:inherit]">
              {children}
            </p>
          ),
          h2: ({ children }) => (
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:inherit]">
              {children}
            </p>
          ),
          h3: ({ children }) => (
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:inherit]">
              {children}
            </p>
          ),
        }}
      >
        {normalizedBody}
      </ReactMarkdown>
    </div>
  );
});

function avatarValueToSrc(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.trim().startsWith("<svg")
    ? `data:image/svg+xml;utf8,${encodeURIComponent(value)}`
    : value;
}

function authorTone(authorType: ThreadRecord["authorType"]) {
  return authorType === "human"
    ? "bg-[var(--teal-muted)] text-[var(--teal-text)]"
    : "bg-[var(--accent-muted)] text-[var(--accent-text)]";
}

function AuthorMeta({
  author,
  authorType,
  authorAvatarSvg,
  createdAt,
}: {
  author: string;
  authorType: ThreadRecord["authorType"];
  authorAvatarSvg: string | null;
  createdAt: string;
}) {
  const avatarSrc = avatarValueToSrc(authorAvatarSvg);

  return (
    <div className="flex items-center gap-1.5">
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt={author}
          className="h-5 w-5 shrink-0 rounded-full border border-[var(--border)]"
        />
      ) : (
        <span
          className={cx(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            authorTone(authorType),
          )}
        >
          {author.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-[12px] font-medium text-white">{author}</span>
      <span className="text-[var(--thread-text-3)]">•</span>
      <span className="text-[11px] text-[var(--thread-text-3)]">{timeAgo(createdAt)}</span>
    </div>
  );
}

function buildFileTree(
  projectPaths: string[],
  changedFiles: ChangedFileSummary[],
  threads: ThreadRecord[],
  fileBriefs: FileBriefRecord[],
): TreeNode[] {
  const fileMap = new Map<
    string,
    {
      changeType?: ChangedFileSummary["eventType"];
      indicators: Map<string, AnnotationIndicator>;
      hasBrief: boolean;
      briefFreshness: ArtifactFreshness | null;
    }
  >();

  const ensureFile = (fp: string) => {
    if (!fileMap.has(fp)) {
      fileMap.set(fp, {
        indicators: new Map(),
        hasBrief: false,
        briefFreshness: null,
      });
    }
    return fileMap.get(fp)!;
  };

  for (const filePath of projectPaths) {
    ensureFile(filePath);
  }

  for (const f of changedFiles) {
    const entry = ensureFile(f.filePath);
    entry.changeType = f.eventType;
  }

  for (const t of threads) {
    if (!t.filePath) continue;
    const entry = ensureFile(t.filePath);
    const ind = entry.indicators.get(t.type) ?? {
      type: "thread" as const,
      category: t.type,
      count: 0,
    };
    ind.count++;
    entry.indicators.set(t.type, ind);
  }

  for (const brief of fileBriefs) {
    const entry = ensureFile(brief.filePath);
    entry.hasBrief = true;
    entry.briefFreshness = brief.freshness;
  }

  const root: TreeNode[] = [];
  const dirNodes = new Map<string, TreeNode>();

  const sortedPaths = [...fileMap.keys()].sort();
  for (const fp of sortedPaths) {
    const entry = fileMap.get(fp)!;
    const parts = fp.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const dirPath = parts.slice(0, i + 1).join("/");

      const partName = parts[i]!;
      if (isLast) {
        current.push({
          name: partName,
          path: fp,
          children: [],
          isFile: true,
          indicators: [...entry.indicators.values()],
          hasBrief: entry.hasBrief,
          briefFreshness: entry.briefFreshness,
          hasReviewSignal:
            Boolean(entry.changeType) ||
            entry.indicators.size > 0 ||
            entry.hasBrief,
          changeType: entry.changeType,
        });
      } else {
        let dirNode = dirNodes.get(dirPath);
        if (!dirNode) {
          dirNode = {
            name: partName,
            path: dirPath,
            children: [],
            isFile: false,
            indicators: [],
            hasBrief: false,
            briefFreshness: null,
            hasReviewSignal: false,
          };
          dirNodes.set(dirPath, dirNode);
          current.push(dirNode);
        }
        current = dirNode!.children;
      }
    }
  }

  const finalizeNodes = (nodes: TreeNode[]): TreeNode[] =>
    [...nodes]
      .map((node) => {
        if (!node.isFile) {
          node.children = finalizeNodes(node.children);
          node.hasReviewSignal = node.children.some((child) => child.hasReviewSignal);
        }
        return node;
      })
      .sort((left, right) => {
        if (left.isFile !== right.isFile) {
          return left.isFile ? 1 : -1;
        }
        if (left.hasReviewSignal !== right.hasReviewSignal) {
          return left.hasReviewSignal ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

  return finalizeNodes(root);
}

function flattenVisibleTree(
  nodes: TreeNode[],
  expanded: Set<string>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const visit = (node: TreeNode, depth: number) => {
    const isOpen = !node.isFile && expanded.has(node.path);
    rows.push({ node, depth, isOpen });

    if (!isOpen) {
      return;
    }

    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };

  for (const node of nodes) {
    visit(node, 0);
  }

  return rows;
}

function mapThreadToAnnotation(thread: ThreadRecord): FileAnnotation {
  return {
    id: thread.id,
    type: "thread",
    title: thread.title,
    body: "",
    startLine: thread.startLine,
    endLine: thread.endLine,
    lineSide: thread.lineSide,
    category: thread.type,
    status: thread.status,
    freshness: thread.freshness,
    author: thread.author,
    authorType: thread.authorType,
    authorAvatarSvg: thread.authorAvatarSvg,
    createdAt: thread.createdAt,
    messages: thread.messages.map((message) => ({
      id: message.id,
      author: message.author,
      authorType: message.authorType,
      authorAvatarSvg: message.authorAvatarSvg,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

function buildAnnotationsByFile(
  threads: ThreadRecord[],
): Map<string, FileAnnotation[]> {
  const annotationsByFile = new Map<string, FileAnnotation[]>();

  for (const thread of threads) {
    if (!thread.filePath) {
      continue;
    }

    const annotations = annotationsByFile.get(thread.filePath);
    if (annotations) {
      annotations.push(mapThreadToAnnotation(thread));
      continue;
    }

    annotationsByFile.set(thread.filePath, [mapThreadToAnnotation(thread)]);
  }

  for (const annotations of annotationsByFile.values()) {
    annotations.sort(
      (left, right) => (left.startLine ?? Infinity) - (right.startLine ?? Infinity),
    );
  }

  return annotationsByFile;
}

function getFirstThreadAnnotation(
  annotations: FileAnnotation[],
): FileAnnotation | null {
  return (
    annotations.find((annotation) => !hasActiveLineAnchor(annotation)) ??
    annotations.find((annotation) => hasActiveLineAnchor(annotation)) ??
    null
  );
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

function fileIcon(name: string, isFile: boolean): string {
  if (!isFile) return "";
  const ext = fileExtension(name);
  const map: Record<string, string> = {
    ts: "TS",
    tsx: "TX",
    js: "JS",
    jsx: "JX",
    css: "CS",
    json: "{}",
    md: "MD",
    html: "<>",
    sql: "SQ",
    yml: "YM",
    yaml: "YM",
    toml: "TM",
    py: "PY",
    rs: "RS",
    go: "GO",
  };
  return map[ext] ?? "··";
}

function normalizeThreadCategory(category?: string): ThreadRecord["type"] | undefined {
  if (category === "assumption") return "question";
  if (category === "scope_extension") return "scope_change";
  return category as ThreadRecord["type"] | undefined;
}

function threadTypeColor(category?: ThreadRecord["type"] | string): string {
  const normalizedCategory = normalizeThreadCategory(category);
  if (normalizedCategory === "risk") return "var(--red)";
  if (normalizedCategory === "question") return "var(--amber)";
  if (normalizedCategory === "scope_change") return "var(--green-scope)";
  return "var(--blue)";
}

function threadTypeRank(category?: ThreadRecord["type"] | string): number {
  const normalizedCategory = normalizeThreadCategory(category);
  if (normalizedCategory === "risk") return 0;
  if (normalizedCategory === "question") return 1;
  if (normalizedCategory === "decision") return 2;
  if (normalizedCategory === "scope_change") return 3;
  return 4;
}

function normalizeThreadCategories(
  categories: Array<ThreadRecord["type"] | string | undefined>,
): ThreadRecord["type"][] {
  const unique = new Set(
    categories
      .map((category) => normalizeThreadCategory(category))
      .filter((category): category is ThreadRecord["type"] => Boolean(category)),
  );
  return [...unique].sort((a, b) => threadTypeRank(a) - threadTypeRank(b));
}

function threadTone(category?: ThreadRecord["type"] | string): {
  restBorderClass?: string;
  hoverBorderClass: string;
  hoverShadowClass: string;
  highlightedCardClass: string;
  connectorClass: string;
  lineHighlightClass: string;
  lineAccentClass: string;
  surfaceClass: string;
  connectorColor: string;
  connectorGlow: string;
} {
  const normalizedCategory = normalizeThreadCategory(category);

  if (normalizedCategory === "risk") {
    return {
      restBorderClass: "border-[var(--red-edge)]",
      hoverBorderClass: "hover:border-[var(--red-edge)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--red-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--red-edge)] shadow-[0_0_0_1px_var(--red-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--red)] before:bg-[var(--red)] before:shadow-[0_0_0_3px_var(--red-muted)]",
      lineHighlightClass: "bg-[var(--red-line)]",
      lineAccentClass: "bg-[var(--red)]",
      surfaceClass: "var(--red-muted)",
      connectorColor: "var(--red)",
      connectorGlow: "var(--red-muted)",
    };
  }

  if (normalizedCategory === "question") {
    return {
      restBorderClass: "border-[var(--amber-edge)]",
      hoverBorderClass: "hover:border-[var(--amber-edge)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--amber-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--amber-edge)] shadow-[0_0_0_1px_var(--amber-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--amber)] before:bg-[var(--amber)] before:shadow-[0_0_0_3px_var(--amber-muted)]",
      lineHighlightClass: "bg-[var(--amber-line)]",
      lineAccentClass: "bg-[var(--amber)]",
      surfaceClass: "var(--amber-muted)",
      connectorColor: "var(--amber)",
      connectorGlow: "var(--amber-muted)",
    };
  }

  if (normalizedCategory === "scope_change") {
    return {
      restBorderClass: "border-[var(--green-edge)]",
      hoverBorderClass: "hover:border-[var(--green-edge)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--green-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--green-edge)] shadow-[0_0_0_1px_var(--green-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--green-scope)] before:bg-[var(--green-scope)] before:shadow-[0_0_0_3px_var(--green-muted)]",
      lineHighlightClass: "bg-[var(--green-line)]",
      lineAccentClass: "bg-[var(--green-scope)]",
      surfaceClass: "var(--green-muted)",
      connectorColor: "var(--green-scope)",
      connectorGlow: "var(--green-muted)",
    };
  }

  if (normalizedCategory === "decision") {
    return {
      restBorderClass: "border-[var(--blue-edge)]",
      hoverBorderClass: "hover:border-[var(--blue-edge)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--blue-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--blue-edge)] shadow-[0_0_0_1px_var(--blue-edge),0_20px_40px_-28px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--blue)] before:bg-[var(--blue)] before:shadow-[0_0_0_3px_var(--blue-muted)]",
      lineHighlightClass: "bg-[var(--blue-line)]",
      lineAccentClass: "bg-[var(--blue)]",
      surfaceClass: "var(--blue-muted)",
      connectorColor: "var(--blue)",
      connectorGlow: "var(--blue-muted)",
    };
  }

  return {
    hoverBorderClass: "hover:border-[var(--blue-edge)]",
    hoverShadowClass:
      "hover:shadow-[0_0_0_1px_var(--blue-edge),0_20px_40px_-28px_var(--thread-shadow)]",
    highlightedCardClass:
      "border-[var(--blue-edge)] shadow-[0_0_0_1px_var(--blue-edge),0_20px_40px_-28px_var(--thread-shadow)]",
    connectorClass:
      "border-t-[var(--blue)] before:bg-[var(--blue)] before:shadow-[0_0_0_3px_var(--blue-muted)]",
    lineHighlightClass: "bg-[var(--blue-line)]",
    lineAccentClass: "bg-[var(--blue)]",
    surfaceClass: "var(--thread-bg)",
    connectorColor: "var(--blue)",
    connectorGlow: "var(--blue-muted)",
  };
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 30) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "1 day ago";
  return `${diffDay} days ago`;
}

const fileBadgeToneByExtension: Record<string, string> = {
  ts: "bg-[var(--blue-muted)] text-[var(--blue)]",
  tsx: "bg-[var(--blue-muted)] text-[var(--blue)]",
  js: "bg-[var(--amber-muted)] text-[var(--amber)]",
  jsx: "bg-[var(--amber-muted)] text-[var(--amber)]",
  css: "bg-[var(--blue-muted)] text-[var(--blue)]",
  json: "bg-[var(--bg-4)] text-[var(--text-3)]",
  md: "bg-[var(--blue-muted)] text-[var(--blue)]",
  sql: "bg-[var(--amber-muted)] text-[var(--amber)]",
  py: "bg-[var(--blue-muted)] text-[var(--blue)]",
};

const changeToneByType = {
  add: "text-[var(--green)]",
  change: "text-[var(--amber)]",
  unlink: "text-[var(--red)]",
} as const;

const activityToneByKind: Record<string, string> = {
  file_diff: "bg-[var(--amber-muted)] text-[var(--amber)]",
  session_status: "bg-[var(--green-muted)] text-[var(--green)]",
  warning: "bg-[var(--red-muted)] text-[var(--red)]",
};

const resultToneByKind: Record<string, string> = {
  thread: "bg-[var(--accent-muted)] text-[var(--accent-text)]",
  file_brief: "bg-[var(--green-muted)] text-[var(--green)]",
};

const dragRegionStyle = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegionStyle = {
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;
const codeFontStyle = {
  fontFamily: "var(--font-mono)",
  fontVariantLigatures: "none",
} as React.CSSProperties;

function fileBadgeClass(name: string): string {
  return cx(
    "inline-flex items-center justify-center rounded-[3px] px-[3px] py-px text-[8px] leading-[1.3] font-semibold tracking-[0.02em] font-[var(--font-mono)]",
    fileBadgeToneByExtension[fileExtension(name)] ??
      "bg-[var(--bg-4)] text-[var(--text-3)]",
  );
}

function getWorkspaceStateStorageKey(
  session: SessionRecord | null,
): string | null {
  if (!session) return null;
  return `${WORKSPACE_STATE_STORAGE_PREFIX}:${session.projectRoot}:${session.id}`;
}

function getPageWorkspaceStateStorageKey(): string | null {
  if (typeof window === "undefined") return null;
  return `${WORKSPACE_STATE_STORAGE_PREFIX}:page:${window.location.origin}${window.location.pathname}`;
}

function readPersistedWorkspaceState(
  storageKey: string,
): PersistedWorkspaceState | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
    const openTabs = Array.isArray(parsed.openTabs)
      ? [
          ...new Set(
            parsed.openTabs.filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        ]
      : [];
    const activeTab =
      typeof parsed.activeTab === "string" &&
      openTabs.includes(parsed.activeTab)
        ? parsed.activeTab
        : (openTabs[0] ?? null);
    const expandedDirs = Array.isArray(parsed.expandedDirs)
      ? [
          ...new Set(
            parsed.expandedDirs.filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        ]
      : [];
    const sidebarTab = parsed.sidebarTab === "activity" ? "activity" : "files";

    return {
      openTabs,
      activeTab,
      expandedDirs,
      sidebarTab,
    };
  } catch {
    return null;
  }
}

function readInitialWorkspaceState(): PersistedWorkspaceState | null {
  const storageKey = getPageWorkspaceStateStorageKey();
  return storageKey ? readPersistedWorkspaceState(storageKey) : null;
}

function writePersistedWorkspaceState(
  storageKey: string,
  state: PersistedWorkspaceState,
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore storage failures and keep the UI functional.
  }
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function getOverviewSnapshotKey(overview: ProjectOverview): string {
  const sessionKey = overview.session
    ? [
        overview.session.id,
        overview.session.status,
        overview.session.endedAt ?? "",
        overview.session.actorId ?? "",
        overview.session.actorName ?? "",
      ].join(":")
    : "no-session";

  const changedFilesKey = overview.changedFiles
    .map(
      (file) =>
        `${file.filePath}:${file.eventType}:${file.added}:${file.removed}:${file.lastUpdatedAt}`,
    )
    .join("|");
  const threadsKey = overview.threads
    .map(
      (thread) =>
        `${thread.id}:${thread.status}:${thread.freshness}:${thread.updatedAt}:${thread.messages.length}`,
    )
    .join("|");
  const briefsKey = overview.fileBriefs
    .map(
      (brief) => `${brief.id}:${brief.freshness}:${brief.updatedAt}`,
    )
    .join("|");
  const eventsKey = overview.recentEvents
    .map((event) => `${event.id}:${event.ts}`)
    .join("|");

  return [
    sessionKey,
    changedFilesKey,
    threadsKey,
    briefsKey,
    eventsKey,
  ].join("||");
}

function getFileContentCacheKey(
  filePath: string,
  change: ChangedFileSummary | null,
): string {
  return `${filePath}:${change?.lastUpdatedAt ?? "stable"}`;
}

function cacheFileContent(
  cache: Map<string, string>,
  cacheKey: string,
  content: string,
): void {
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey);
  }

  cache.set(cacheKey, content);

  while (cache.size > FILE_CONTENT_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function useFileContentState({
  filePath,
  change,
  cacheRef,
  enabled = true,
}: {
  filePath: string | null;
  change: ChangedFileSummary | null;
  cacheRef: React.MutableRefObject<Map<string, string>>;
  enabled?: boolean;
}) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [fileContentError, setFileContentError] = useState<string | null>(null);

  const fileContentCacheKey = useMemo(() => {
    if (!filePath) {
      return null;
    }

    return getFileContentCacheKey(filePath, change);
  }, [change, filePath]);

  useEffect(() => {
    if (!enabled) {
      setFileContentLoading(false);
      return;
    }

    if (!filePath || !fileContentCacheKey) {
      setFileContent(null);
      setFileContentError(null);
      setFileContentLoading(false);
      return;
    }

    const cached = cacheRef.current.get(fileContentCacheKey);
    if (cached !== undefined) {
      cacheRef.current.delete(fileContentCacheKey);
      cacheRef.current.set(fileContentCacheKey, cached);
      setFileContent(cached);
      setFileContentError(null);
      setFileContentLoading(false);
      return;
    }

    const controller = new AbortController();

    setFileContent(null);
    setFileContentError(null);
    setFileContentLoading(true);

    const loadFileContent = async () => {
      try {
        const content = await fetchFileContent(filePath, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }

        cacheFileContent(cacheRef.current, fileContentCacheKey, content);
        setFileContent(content);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setFileContentError(
          error instanceof Error ? error.message : "Failed to fetch file",
        );
        setFileContent(null);
      } finally {
        if (!controller.signal.aborted) {
          setFileContentLoading(false);
        }
      }
    };

    void loadFileContent();

    return () => {
      controller.abort();
    };
  }, [cacheRef, enabled, fileContentCacheKey, filePath]);

  return {
    fileContent,
    fileContentError,
    fileContentLoading,
  };
}

function useMultiFileContent(
  sections: ReviewSection[],
  cacheRef: React.MutableRefObject<Map<string, string>>,
): Map<string, string> {
  const [contents, setContents] = useState<Map<string, string>>(() => new Map());

  const fileKeys = useMemo(() => {
    const keys: Array<{ filePath: string; cacheKey: string }> = [];
    for (const section of sections) {
      const cacheKey = getFileContentCacheKey(section.filePath, section.change);
      keys.push({ filePath: section.filePath, cacheKey });
    }
    return keys;
  }, [sections]);

  useEffect(() => {
    if (fileKeys.length === 0) {
      setContents(new Map());
      return;
    }

    const controller = new AbortController();
    const cache = cacheRef.current;

    // Seed from cache synchronously
    const initial = new Map<string, string>();
    const pending: Array<{ filePath: string; cacheKey: string }> = [];

    for (const { filePath, cacheKey } of fileKeys) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        // Touch LRU
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        initial.set(filePath, cached);
      } else {
        pending.push({ filePath, cacheKey });
      }
    }

    if (initial.size > 0) {
      setContents(initial);
    }

    if (pending.length === 0) return;

    // Fetch uncached files
    let cancelled = false;
    const fetchAll = async () => {
      const results = await Promise.allSettled(
        pending.map(async ({ filePath, cacheKey }) => {
          const content = await fetchFileContent(filePath, { signal: controller.signal });
          if (!cancelled) {
            cacheFileContent(cache, cacheKey, content);
          }
          return { filePath, content };
        }),
      );

      if (cancelled) return;

      setContents((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status === "fulfilled") {
            next.set(result.value.filePath, result.value.content);
          }
        }
        return next;
      });
    };

    void fetchAll();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cacheRef, fileKeys]);

  return contents;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface LineRange {
  start: number;
  end: number;
}

function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [{ ...sorted[0]! }];

  for (const range of sorted.slice(1)) {
    const lastRange = merged[merged.length - 1]!;
    if (range.start > lastRange.end + 1) {
      merged.push({ ...range });
      continue;
    }

    lastRange.end = Math.max(lastRange.end, range.end);
  }

  return merged;
}

function useElementHeight(
  ref: React.RefObject<HTMLElement | null>,
): number {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = element.clientHeight;
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    updateHeight();

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return height;
}

function haveSameMeasuredPositions(
  left: Map<string, { top: number; idealTop: number }>,
  right: Map<string, { top: number; idealTop: number }>,
): boolean {
  if (left === right) {
    return true;
  }

  if (left.size !== right.size) {
    return false;
  }

  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);
    if (
      !rightValue ||
      rightValue.top !== leftValue.top ||
      rightValue.idealTop !== leftValue.idealTop
    ) {
      return false;
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--green)"
      : status === "completed"
        ? "var(--text-3)"
        : "var(--red)";
  return (
    <span
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

const FileBriefHeader = memo(function FileBriefHeader({
  brief,
}: {
  brief: FileBriefRecord;
}) {
  const isOutdated = brief.freshness === "outdated";
  return (
    <section
      className={cx(
        "border-b px-6 py-5 font-[var(--font-sans)]",
        isOutdated
          ? "border-[var(--amber-edge)] bg-[var(--amber-muted)]"
          : "border-[var(--blue-edge)] bg-[var(--blue-muted)]"
      )}
    >
      <div className="flex max-w-[78ch] flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cx(
              "inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]",
              isOutdated
                ? "border-[var(--amber-edge)] bg-[var(--amber-muted)] text-[var(--amber)]"
                : "border-[var(--blue-edge)] bg-[var(--blue-muted)] text-[var(--blue)]"
            )}
          >
            File Brief
          </span>
          {isOutdated && (
            <span className="inline-flex w-fit items-center rounded-full border border-[var(--amber-edge)] bg-[var(--amber-muted)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--amber)]">
              Outdated
            </span>
          )}
        </div>
        <p className="m-0 text-[15px] leading-[1.75] font-normal tracking-[-0.01em] text-[var(--text-1)]">
          {brief.summary}
        </p>
        {brief.details && (
          <div
            className={cx(
              "space-y-2 border-t pt-3",
              isOutdated
                ? "border-[var(--amber-muted)]"
                : "border-[var(--blue-muted)]"
            )}
          >
            <RichTextBody
              body={brief.details}
              className="text-[13px] leading-[1.8] text-[var(--text-2)]"
            />
          </div>
        )}
      </div>
    </section>
  );
});

const FileTreeItem = memo(function CanaryFileTreeItem({
  node,
  depth,
  isOpen,
  onToggle,
  onSelect,
  isActive,
}: {
  node: TreeNode;
  depth: number;
  isOpen: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  isActive: boolean;
}) {
  const isDimmed = !isActive && !node.hasReviewSignal;
  const briefBadgeClass =
    node.briefFreshness === "outdated"
      ? "border-[var(--amber-edge)] bg-[var(--amber-muted)] text-[var(--amber)]"
      : "border-[var(--blue-edge)] bg-[var(--blue-muted)] text-[var(--blue)]";

  return (
    <>
      <button
        className={cx(
          "flex h-[26px] w-full items-center gap-1.5 pr-2.5 text-left text-[12px] text-[var(--text-2)] transition-colors duration-100",
          "hover:bg-[var(--bg-3)]",
          isActive && "bg-[var(--accent-muted)] text-[var(--text-1)]",
          isDimmed && "text-[var(--text-3)] opacity-60",
        )}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (node.isFile) {
            onSelect(node.path);
          } else {
            onToggle(node.path);
          }
        }}
      >
        <span className="flex w-[18px] shrink-0 items-center justify-center">
          {node.isFile ? (
            <span className={fileBadgeClass(node.name)}>
              {fileIcon(node.name, true)}
            </span>
          ) : (
            <span
              className={cx(
                "h-0 w-0 border-y-[3px] border-y-transparent border-l-[4px] border-l-[var(--text-3)] transition-transform duration-150",
                isOpen && "rotate-90",
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">
          {node.name}
        </span>
        {node.changeType && (
          <span
            className={cx(
              "shrink-0 font-[var(--font-mono)] text-[10px] font-semibold",
              changeToneByType[node.changeType],
            )}
          >
            {node.changeType === "add"
              ? "A"
              : node.changeType === "unlink"
                ? "D"
                : "M"}
          </span>
        )}
        <span className="flex shrink-0 gap-[3px]">
          {node.hasBrief && (
            <span
              className={cx(
                "inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-[3px] border px-1 font-[var(--font-mono)] text-[9px] font-semibold uppercase",
                briefBadgeClass,
              )}
              title={
                node.briefFreshness === "outdated"
                  ? "File brief is outdated"
                  : "File brief available"
              }
            >
              {node.briefFreshness === "outdated" ? "!" : "B"}
            </span>
          )}
          {node.indicators.map((ind) => (
            <span
              key={ind.category ?? ind.type}
              className={cx(
                "flex h-3.5 w-3.5 items-center justify-center rounded-[3px] font-[var(--font-mono)] text-[9px] font-semibold text-white",
              )}
              style={{ background: threadTypeColor(ind.category) }}
              title={`${ind.count} ${formatLabel(ind.category ?? ind.type)}${ind.count > 1 ? "s" : ""}`}
            >
              {ind.count}
            </span>
          ))}
        </span>
      </button>
    </>
  );
});

const FileTreeList = memo(function FileTreeList({
  rows,
  activeFile,
  onToggle,
  onSelect,
}: {
  rows: VisibleTreeRow[];
  activeFile: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportHeight = useElementHeight(containerRef);
  const [scrollTop, setScrollTop] = useState(0);

  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / FILE_TREE_ROW_HEIGHT) - FILE_TREE_OVERSCAN,
  );
  const visibleCount =
    Math.ceil(viewportHeight / FILE_TREE_ROW_HEIGHT) + FILE_TREE_OVERSCAN * 2;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const topPadding = startIndex * FILE_TREE_ROW_HEIGHT;
  const bottomPadding = Math.max(
    0,
    (rows.length - endIndex) * FILE_TREE_ROW_HEIGHT,
  );

  return (
    <div
      className="h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      ref={containerRef}
      onScroll={(event) => {
        const nextScrollTop = event.currentTarget.scrollTop;
        setScrollTop((current) =>
          current === nextScrollTop ? current : nextScrollTop,
        );
      }}
    >
      <div
        style={{
          paddingTop: `${topPadding}px`,
          paddingBottom: `${bottomPadding}px`,
        }}
      >
        {rows.slice(startIndex, endIndex).map(({ node, depth, isOpen }) => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={depth}
            isOpen={isOpen}
            onToggle={onToggle}
            onSelect={onSelect}
            isActive={activeFile === node.path}
          />
        ))}
      </div>
    </div>
  );
});

function hasActiveLineAnchor(annotation: FileAnnotation): boolean {
  return (
    annotation.freshness === "active" &&
    annotation.startLine !== null &&
    annotation.endLine !== null
  );
}

const SNIPPET_CONTEXT_PADDING = 3;

const CodeSnippet = memo(function CodeSnippet({
  filePath,
  fileContent,
  startLine,
  endLine,
  categoryColor,
}: {
  filePath: string;
  fileContent: string | undefined;
  startLine: number;
  endLine: number;
  categoryColor: string;
}) {
  const lines = useMemo(() => {
    if (!fileContent) return null;
    const allLines = fileContent.split("\n");
    const first = Math.max(1, startLine - SNIPPET_CONTEXT_PADDING);
    const last = Math.min(allLines.length, endLine + SNIPPET_CONTEXT_PADDING);
    const result: Array<{ num: number; text: string; isAnnotated: boolean }> = [];
    for (let i = first; i <= last; i++) {
      result.push({
        num: i,
        text: allLines[i - 1] ?? "",
        isAnnotated: i >= startLine && i <= endLine,
      });
    }
    return result;
  }, [fileContent, startLine, endLine]);

  if (!lines) {
    return (
      <div className="code-snippet code-snippet-loading">
        <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-[var(--text-3)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--text-3)] border-t-transparent" />
          Loading...
        </div>
      </div>
    );
  }

  const gutterWidth = String(lines[lines.length - 1]?.num ?? 1).length;

  const lineLabel = startLine === endLine ? `:${startLine}` : `:${startLine}–${endLine}`;

  return (
    <div className="code-snippet">
      <div className="code-snippet-file-label">
        {filePath}{lineLabel}
      </div>
      <div className="code-snippet-lines">
        {lines.map((line) => {
          const { html } = highlightDiffLine(line.text, filePath, "diff-context");
          return (
            <div
              key={line.num}
              className={cx(
                "code-snippet-line",
                line.isAnnotated && "code-snippet-annotated",
              )}
              style={line.isAnnotated ? { "--snippet-accent": categoryColor } as React.CSSProperties : undefined}
            >
              <span
                className="code-snippet-gutter"
                style={{ minWidth: `${gutterWidth + 1}ch` }}
              >
                {line.num}
              </span>
              <span
                className="syntax-line code-snippet-code"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

const ThreadCard = memo(function ThreadCard({
  annotation,
  highlighted,
  focusMode,
  onHover,
  onReply,
  onSetStatus,
}: {
  annotation: FileAnnotation;
  highlighted: boolean;
  focusMode: boolean;
  onHover: (id: string | null) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onSetStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isReplying, setIsReplying] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const allMessages: {
    id: string;
    author: string;
    authorType: ThreadRecord["authorType"];
    authorAvatarSvg: string | null;
    body: string;
    createdAt: string;
  }[] = [];
  const isThread = annotation.type === "thread";

  if (annotation.body) {
    allMessages.push({
      id: `${annotation.id}-root`,
      author: annotation.author,
      authorType: annotation.authorType,
      authorAvatarSvg: annotation.authorAvatarSvg,
      body: annotation.body,
      createdAt: annotation.createdAt,
    });
  }

  if (annotation.messages) {
    for (const msg of annotation.messages) {
      allMessages.push(msg);
    }
  }

  const openerMessage = allMessages[0] ?? null;
  const lastReply = allMessages.length > 1 ? allMessages[allMessages.length - 1] : null;
  const middleReplies = allMessages.length > 2 ? allMessages.slice(1, -1) : [];
  const middleReplyCount = middleReplies.length;
  const isOutdated = annotation.freshness === "outdated";
  const normalizedDraft = draft.trim();
  const isBusy = isReplying || isUpdatingStatus;
  const isResolved = annotation.status === "resolved";
  const isResolvedCollapsed = isThread && isResolved && !resolvedExpanded;
  const showConversation = !isResolved || resolvedExpanded;
  const tone = threadTone(annotation.category);
  const nextStatus = isResolved ? "open" : "resolved";
  const statusButtonLabel = isResolved ? "Reopen" : "Resolve";

  useEffect(() => {
    if (annotation.status === "resolved") {
      setResolvedExpanded(false);
      return;
    }

    setResolvedExpanded(false);
  }, [annotation.id, annotation.status]);

  const handleStatusChange = useCallback(async () => {
    if (!isThread || isBusy) {
      return;
    }

    setIsUpdatingStatus(true);
    setError(null);

    try {
      await onSetStatus(annotation.id, nextStatus);
      if (nextStatus === "open") {
        setResolvedExpanded(true);
      }
    } catch (statusError) {
      setError(
        statusError instanceof Error ? statusError.message : String(statusError),
      );
    } finally {
      setIsUpdatingStatus(false);
    }
  }, [annotation.id, isBusy, isThread, nextStatus, onSetStatus]);

  const submitReply = useCallback(async () => {
    if (!isThread || !normalizedDraft || isBusy) {
      return;
    }

    setIsReplying(true);
    setError(null);

    try {
      await onReply(annotation.id, normalizedDraft);
      setDraft("");
    } catch (replyError) {
      setError(
        replyError instanceof Error ? replyError.message : String(replyError),
      );
    } finally {
      setIsReplying(false);
    }
  }, [annotation.id, isBusy, isThread, normalizedDraft, onReply]);

  return (
    <div
      className={cx(
        "overflow-hidden rounded-[14px] border font-[var(--font-sans)] transition-[border-color,box-shadow,transform,opacity] duration-200",
        isResolved && "opacity-50",
        !isResolvedCollapsed && "hover:-translate-y-px",
        !isResolvedCollapsed && tone.hoverBorderClass,
        !isResolvedCollapsed && tone.hoverShadowClass,
        (!isResolved ? tone.restBorderClass : undefined) ?? (
          highlighted
            ? "border-[var(--teal-border)] shadow-[0_0_0_1px_var(--teal-strong),0_24px_56px_-32px_var(--thread-shadow)]"
            : focusMode
              ? "border-[var(--teal-border)] shadow-[0_0_0_1px_var(--teal-muted),0_18px_40px_-28px_var(--thread-shadow)]"
              : "border-[var(--thread-border)] shadow-[0_18px_40px_-28px_var(--thread-shadow)]"
        ),
        isResolvedCollapsed &&
          "shadow-[0_12px_28px_-24px_var(--thread-shadow)]",
      )}
      style={{
        background: !isResolved ? tone.surfaceClass : "var(--thread-bg)",
      }}
      onMouseEnter={() => onHover(annotation.id)}
      onMouseLeave={() => onHover(null)}
    >
      {isResolvedCollapsed ? (
        <>
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex items-center gap-2">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--green-muted)] text-[var(--green)]">
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 8.25 6.5 10.75 12 5.25"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div className="min-w-0">
                <h3 className="m-0 truncate text-[13px] leading-[1.35] font-medium tracking-[-0.01em] text-[var(--thread-text-2)]">
                  {annotation.title}
                </h3>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="inline-flex h-7 min-h-7 items-center justify-center rounded-[8px] border border-[var(--thread-border)] bg-[rgba(255,255,255,0.02)] px-2.5 text-[11px] font-medium text-[var(--thread-text-3)] transition-all duration-150 hover:border-[var(--thread-border-strong)] hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--thread-text-2)]"
                onClick={() => setResolvedExpanded(true)}
              >
                View
              </button>
              <button
                type="button"
                className="inline-flex h-7 min-h-7 items-center gap-1.5 justify-center rounded-[8px] border border-[var(--thread-border-strong)] bg-[rgba(255,255,255,0.04)] px-2.5 text-[11px] font-medium text-[var(--thread-text-2)] transition-all duration-150 hover:border-[var(--border-hover)] hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--text-1)] active:border-[var(--border-active)] active:bg-[rgba(255,255,255,0.12)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleStatusChange()}
                disabled={isBusy}
                aria-label={`${statusButtonLabel} thread`}
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3.25 8h9.5M8 3.25v9.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                {isUpdatingStatus ? "Saving..." : statusButtonLabel}
              </button>
            </div>
          </div>
          {error && (
            <div className="border-t border-[var(--thread-border)] px-3.5 py-2">
              <p className="m-0 text-[12px] leading-[1.5] text-[var(--red)]">
                {error}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          {/* Header */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {annotation.category ? (
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--thread-text-3)]">
                    {formatLabel(annotation.category)}
                  </span>
                ) : (
                  <span />
                )}
                {isOutdated && (
                  <span className="rounded-full border border-[var(--amber-edge)] bg-[var(--amber-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--amber)]">
                    Outdated
                  </span>
                )}
              </div>
              {isThread && (
              <button
                type="button"
                className="inline-flex h-6 min-h-6 shrink-0 items-center gap-1 rounded-[8px] border border-[var(--thread-border-strong)] bg-[rgba(255,255,255,0.04)] px-2.5 text-[11px] font-medium leading-none text-[var(--thread-text-2)] transition-all duration-150 hover:border-[var(--border-hover)] hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--text-1)] active:border-[var(--border-active)] active:bg-[rgba(255,255,255,0.12)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleStatusChange()}
                disabled={isBusy}
                aria-label={`${statusButtonLabel} thread`}
              >
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5"
                    fill="none"
                    aria-hidden="true"
                  >
                    {isResolved ? (
                      <path
                        d="M3.25 8h9.5M8 3.25v9.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    ) : (
                      <path
                        d="M4.5 8.5 6.5 10.5 11.5 4.5"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                  {isUpdatingStatus ? "Saving..." : statusButtonLabel}
                </button>
              )}
            </div>
              <h3 className="m-0 line-clamp-2 text-[13px] leading-[1.4] font-semibold tracking-[-0.01em] text-[var(--thread-text-1)]">
              {annotation.title}
              </h3>
            </div>

          {/* Opener message */}
          {showConversation && openerMessage && (
            <div className="flex flex-col gap-1.5 pt-1">
              <AuthorMeta
                author={openerMessage.author}
                authorType={openerMessage.authorType}
                authorAvatarSvg={openerMessage.authorAvatarSvg}
                createdAt={annotation.createdAt}
              />
              <div className="relative">
                <RichTextBody
                  body={openerMessage.body}
                  className={cx(
                    "text-[11px] leading-[1.6] text-[var(--thread-text-2)]",
                    !bodyExpanded && "line-clamp-3",
                  )}
                />
                {openerMessage.body.length > 180 && (
                  <button
                    type="button"
                    className="mt-1 text-[12px] font-medium text-[var(--thread-text-3)] transition-colors hover:text-[var(--thread-text-2)]"
                    onClick={() => setBodyExpanded((v) => !v)}
                  >
                    {bodyExpanded ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Middle replies (collapsed) */}
          {showConversation && middleReplyCount > 0 && (
            <div className="flex flex-col">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[12px] text-[var(--thread-text-3)] transition-colors hover:text-[var(--thread-text-2)]"
                onClick={() => setRepliesExpanded((v) => !v)}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                  <path
                    d="M2 4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5.5L3 13.5V11H4a2 2 0 0 1-2-2V4Z"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeLinejoin="round"
                  />
                </svg>
                {repliesExpanded ? "Hide" : middleReplyCount} {middleReplyCount === 1 ? "earlier reply" : "earlier replies"}
              </button>
              {repliesExpanded &&
                middleReplies.map((msg) => (
                  <div key={msg.id} className="border-t border-[var(--thread-border)] py-2.5">
                    <div className="flex flex-col gap-1.5">
                      <AuthorMeta
                        author={msg.author}
                        authorType={msg.authorType}
                        authorAvatarSvg={msg.authorAvatarSvg}
                        createdAt={msg.createdAt}
                      />
                      <RichTextBody
                        body={msg.body}
                        className="text-[11px] leading-[1.6] text-[var(--thread-text-2)]"
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}

          {/* Last reply (always visible) */}
          {showConversation && lastReply && (
            <div className="py-2.5">
              <div className="flex flex-col gap-1.5">
                <AuthorMeta
                  author={lastReply.author}
                  authorType={lastReply.authorType}
                  authorAvatarSvg={lastReply.authorAvatarSvg}
                  createdAt={lastReply.createdAt}
                />
                <RichTextBody
                  body={lastReply.body}
                  className="text-[11px] leading-[1.6] text-[var(--thread-text-2)]"
                />
              </div>
            </div>
          )}

          {/* Reply input - always visible */}
          {isThread && !isResolved && (
            <>
              <div className="flex items-center gap-2 pt-2.5">
                <div className="relative flex h-8 min-w-0 flex-1 items-center rounded-[6px] border border-[var(--thread-border)] bg-[rgba(255,255,255,0.02)] px-2.5">
                  <input
                    type="text"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        void submitReply();
                      }
                    }}
                    placeholder={`Reply... ${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}↵ to send`}
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--thread-text-2)] outline-none placeholder:text-[var(--thread-text-3)]"
                    disabled={isBusy}
                  />
                  <button
                    type="button"
                    className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isBusy || normalizedDraft.length === 0}
                    onClick={() => void submitReply()}
                    aria-label="Send reply"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      style={{ color: normalizedDraft.length === 0 ? "var(--thread-text-3)" : "var(--thread-text-2)" }}
                    >
                      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.3" />
                      <path
                        d="M6 8h4M10 8l-2-2M10 8l-2 2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {error && (
                <p className="m-0 text-[12px] leading-[1.5] text-[var(--red)]">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Measure actual pixel offsets for annotated code lines inside a scroll
 * container and lay out thread cards so they align but never overlap.
 *
 * Returns a map of annotationId → { top, idealTop } so the connector can
 * trace back to the real code line when a card gets pushed down.
 */
function useMeasuredLinePositions(
  containerRef: React.RefObject<HTMLDivElement | null>,
  annotations: FileAnnotation[],
  /** Any value whose change means the DOM has re-rendered (content, patch, etc.) */
  renderKey: unknown,
): {
  positions: Map<string, { top: number; idealTop: number }>;
  gutterHeight: number;
} {
  const [positions, setPositions] = useState<
    Map<string, { top: number; idealTop: number }>
  >(() => new Map());
  const [gutterHeight, setGutterHeight] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const gutterEl = container.querySelector<HTMLElement>(".threads-gutter");
    if (!gutterEl) return;

    let frameId: number | null = null;

    const measure = () => {
      // Offset of the gutter column relative to the scroll container top
      const gutterTop = gutterEl.getBoundingClientRect().top;

      // For each annotation with a startLine, find the first matching code-line
      // element and record its vertical position relative to the gutter top.
      const lineLevel = annotations
        .filter((a) => hasActiveLineAnchor(a))
        .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));

      // Key: "side:line" or just "line" for lookups
      const measured = new Map<string, number>();
      for (const a of lineLevel) {
        const line = a.startLine!;
        const side = a.lineSide;
        const key = side ? `${side}:${line}` : `${line}`;
        if (measured.has(key)) continue;

        // Query with side if available, otherwise just by line number
        const selector = side
          ? `[data-line="${line}"][data-line-side="${side}"]`
          : `[data-line="${line}"]`;
        const el =
          container.querySelector<HTMLElement>(selector) ??
          container.querySelector<HTMLElement>(`[data-line="${line}"]`);
        if (el) {
          measured.set(key, el.getBoundingClientRect().top - gutterTop);
        }
      }

      // Lay out cards: ideal position = measured line offset, pushed down to
      // avoid overlapping the previous card.
      const CARD_GAP = 8;
      const result = new Map<string, { top: number; idealTop: number }>();
      let maxBottom = 0;
      let cursor = 0;

      // File-level threads first (no line reference)
      const fileLevel = annotations.filter((a) => !hasActiveLineAnchor(a));
      for (const a of fileLevel) {
        result.set(a.id, { top: cursor, idealTop: cursor });
        const cardEl = gutterEl.querySelector<HTMLElement>(
          `[data-thread-id="${a.id}"]`,
        );
        const cardH = cardEl ? cardEl.offsetHeight : 120;
        cursor += cardH + CARD_GAP;
        maxBottom = Math.max(maxBottom, cursor);
      }

      for (const a of lineLevel) {
        const key = a.lineSide
          ? `${a.lineSide}:${a.startLine!}`
          : `${a.startLine!}`;
        const idealTop = measured.get(key) ?? cursor;
        const top = Math.max(idealTop, cursor);
        result.set(a.id, { top, idealTop });

        // Measure the actual rendered card height if it exists yet, else estimate
        const cardEl = gutterEl.querySelector<HTMLElement>(
          `[data-thread-id="${a.id}"]`,
        );
        const cardH = cardEl ? cardEl.offsetHeight : 120;
        cursor = top + cardH + CARD_GAP;
        maxBottom = Math.max(maxBottom, cursor);
      }

      // Keep gutter tall enough for pushed cards so its background/border follows the last card.
      const bottomPadding = 24;
      setPositions((current) =>
        haveSameMeasuredPositions(current, result) ? current : result,
      );
      setGutterHeight((current) => {
        const next = Math.max(0, Math.ceil(maxBottom + bottomPadding));
        return current === next ? current : next;
      });
    };

    const scheduleMeasure = () => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        measure();
      });
    };

    measure();

    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure();
    });
    resizeObserver.observe(container);
    resizeObserver.observe(gutterEl);
    for (const cardEl of gutterEl.querySelectorAll<HTMLElement>("[data-thread-id]")) {
      resizeObserver.observe(cardEl);
    }
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [containerRef, annotations, renderKey]);

  return { positions, gutterHeight };
}

/** SVG connector that traces from the card back up to its anchored code line. */
function ThreadConnector({
  top,
  idealTop,
  category,
}: {
  top: number;
  idealTop: number;
  category: ThreadRecord["type"] | undefined;
}) {
  const tone = threadTone(category);
  const color = tone.connectorColor;
  const glowColor = tone.connectorGlow;

  const offset = top - idealTop;
  const isOffset = offset > 2;

  if (!isOffset) {
    // Straight horizontal connector (original behavior)
    return (
      <span
        className={cx(
          "pointer-events-none absolute left-[-1px] top-[18px] h-0 w-4 border-t opacity-100 max-[960px]:hidden",
          "before:absolute before:left-[-2px] before:top-[-3px] before:h-[5px] before:w-[5px] before:rounded-full before:content-['']",
          tone.connectorClass,
        )}
      />
    );
  }

  // SVG connector: dot at ideal line → right → down → right to card.
  // SVG is absolutely positioned above the card, covering the vertical gap.
  const ATTACH_Y = 18; // vertical center of card header
  const r = Math.min(6, offset / 2); // corner radius
  const svgW = 20;
  const svgH = offset + 24;
  const svgTop = -offset;

  // In SVG coords: dot sits at top (the ideal line), path descends to card
  const dotX = 2;
  const dotY = ATTACH_Y;
  const cardY = offset + ATTACH_Y;
  const turnX = dotX + 4; // x where the vertical run happens

  const d = [
    `M ${dotX},${dotY}`,
    `H ${turnX - r}`,
    `Q ${turnX},${dotY} ${turnX},${dotY + r}`,
    `V ${cardY - r}`,
    `Q ${turnX},${cardY} ${turnX + r},${cardY}`,
    `H ${svgW - 2}`,
  ].join(" ");

  return (
    <span
      className="pointer-events-none absolute left-[-1px] max-[960px]:hidden"
      style={{ top: svgTop, width: svgW, height: svgH }}
    >
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        fill="none"
        className="absolute left-0 top-0"
        aria-hidden="true"
      >
        {/* Connector path */}
        <path
          d={d}
          stroke={color}
          strokeWidth="1"
          fill="none"
          opacity="0.7"
        />
        {/* Dot at the anchored line */}
        <circle
          cx={dotX}
          cy={dotY}
          r="2.5"
          fill={color}
        />
        <circle
          cx={dotX}
          cy={dotY}
          r="4.5"
          fill={glowColor}
        />
      </svg>
    </span>
  );
}

const ThreadsPanel = memo(function ThreadsPanel({
  annotations,
  highlightedThread,
  focusMode,
  onHoverThread,
  onReplyThread,
  onSetThreadStatus,
  positions,
  gutterHeight,
}: {
  annotations: FileAnnotation[];
  highlightedThread: string | null;
  focusMode: boolean;
  onHoverThread: (id: string | null) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  onSetThreadStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
  positions: Map<string, { top: number; idealTop: number }>;
  gutterHeight: number;
}) {
  const fileLevel = annotations.filter((a) => !hasActiveLineAnchor(a));
  const lineLevel = annotations
    .filter((a) => hasActiveLineAnchor(a))
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  const ordered = [...fileLevel, ...lineLevel];

  if (ordered.length === 0) {
    return (
      <div className="threads-gutter relative border-l border-[var(--border)] bg-[var(--bg-1)] px-0 pt-3 pb-6 max-[960px]:border-l-0 max-[960px]:border-t max-[960px]:px-4">
        <div className="sticky top-[40%] p-4 text-center text-[12px] text-[var(--text-3)]">
          No threads
        </div>
      </div>
    );
  }

  return (
    <div
      className="threads-gutter relative border-l border-[var(--border)] bg-[var(--bg-1)] px-0 pt-3 pb-6 max-[960px]:border-l-0 max-[960px]:border-t max-[960px]:px-4"
      style={{ minHeight: `${gutterHeight}px` }}
    >
      {ordered.map((a) => {
        const pos = positions.get(a.id);
        return (
          <div
            key={a.id}
            data-thread-id={a.id}
            className="thread-card-positioned group left-0 right-0 pl-4 max-[960px]:pl-0"
            style={
              pos !== undefined ? { position: "absolute", top: pos.top } : undefined
            }
          >
            {hasActiveLineAnchor(a) && pos && (
              <ThreadConnector
                top={pos.top}
                idealTop={pos.idealTop}
                category={a.category}
              />
            )}
            <ThreadCard
              annotation={a}
              highlighted={highlightedThread === a.id}
              focusMode={focusMode}
              onHover={onHoverThread}
              onReply={onReplyThread}
              onSetStatus={onSetThreadStatus}
            />
          </div>
        );
      })}
    </div>
  );
});

const CodeView = memo(function CodeView({
  filePath,
  patch,
  fileBrief,
  fileContent,
  fileContentLoading,
  fileContentError,
  annotations,
  focusMode,
  highlightedThreadId,
  layout = "file",
  autoScrollToFirstThread = true,
  showThreadsPane = true,
  onReplyThread,
  onSetThreadStatus,
}: {
  filePath: string;
  patch: string | null;
  fileBrief: FileBriefRecord | null;
  fileContent: string | null;
  fileContentLoading: boolean;
  fileContentError: string | null;
  annotations: FileAnnotation[];
  focusMode: boolean;
  highlightedThreadId?: string | null;
  layout?: "file" | "embedded";
  autoScrollToFirstThread?: boolean;
  showThreadsPane?: boolean;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  onSetThreadStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const pendingInitialFocusScrollFileRef = useRef<string | null>(null);
  const embedded = layout === "embedded";
  const lineFocusMode = focusMode && !embedded;
  const activeThreadId = highlightedThreadId ?? hoveredThread;
  const hasLineAnnotations = useMemo(
    () => annotations.some((annotation) => hasActiveLineAnchor(annotation)),
    [annotations],
  );
  const hasThreadAnnotations = useMemo(
    () => annotations.some((annotation) => annotation.type === "thread"),
    [annotations],
  );

  // Side-aware map: keys are "new:8", "old:10", or just "8" (legacy/no side).
  // The value stores all thread categories touching that rendered line.
  const annotatedLineCategories = useMemo(() => {
    const map = new Map<string, ThreadRecord["type"][]>();
    for (const a of annotations) {
      if (!hasActiveLineAnchor(a)) continue;
      const start = a.startLine!;
      const end = a.endLine ?? start;
      const prefix = a.lineSide ? `${a.lineSide}:` : "";
      const applyCategory = (key: string) => {
        const current = map.get(key) ?? [];
        if (a.category) {
          current.push(a.category);
        }
        map.set(key, current);

        // Keep a fallback key for legacy/no-side consumers so a single visual
        // marker can render even when we only know a side-specific anchor.
        if (key.includes(":")) {
          const fallbackSplit = key.split(":");
          const fallbackKey = fallbackSplit[1];
          if (fallbackKey === undefined) {
            return;
          }
          const fallback = map.get(fallbackKey) ?? [];
          if (a.category) {
            fallback.push(a.category);
          }
          map.set(fallbackKey, fallback);
        }
      };
      for (let l = start; l <= end; l++) {
        applyCategory(`${prefix}${l}`);
        if (!a.lineSide) {
          applyCategory(`new:${l}`);
          applyCategory(`old:${l}`);
        }
      }
    }
    return new Map(
      [...map.entries()].map(([key, categories]) => [
        key,
        normalizeThreadCategories(categories),
      ]),
    );
  }, [annotations]);

  const highlightedLineRange = useMemo(() => {
    if (!activeThreadId) return null;
    const a = annotations.find((ann) => ann.id === activeThreadId);
    if (!a || !hasActiveLineAnchor(a)) return null;
    const start = a.startLine!;
    return {
      start,
      end: a.endLine ?? start,
      side: a.lineSide,
    };
  }, [activeThreadId, annotations]);

  useEffect(() => {
    setHoveredThread(null);
  }, [filePath]);

  useLayoutEffect(() => {
    pendingInitialFocusScrollFileRef.current =
      autoScrollToFirstThread && focusMode ? filePath : null;
  }, [autoScrollToFirstThread, filePath, focusMode]);

  const handleHoverThread = useCallback((id: string | null) => {
    setHoveredThread(id);
  }, []);

  const renderKey = [
    filePath,
    patch?.length ?? 0,
    fileContent?.length ?? 0,
    fileBrief?.id ?? "",
    annotations.length,
  ].join(":");
  const { positions, gutterHeight } = useMeasuredLinePositions(
    containerRef,
    annotations,
    renderKey,
  );

  useLayoutEffect(() => {
    if (pendingInitialFocusScrollFileRef.current !== filePath) {
      return;
    }

    const firstThread = getFirstThreadAnnotation(annotations);
    if (!firstThread) {
      return;
    }
    if (!positions.has(firstThread.id)) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const target = showThreadsPane
      ? container.querySelector<HTMLElement>(`[data-thread-id="${firstThread.id}"]`)
      : hasActiveLineAnchor(firstThread)
        ? container.querySelector<HTMLElement>(
            `[data-line="${firstThread.startLine}"][data-line-side="${firstThread.lineSide ?? "new"}"]`,
          ) ??
          container.querySelector<HTMLElement>(
            `[data-line="${firstThread.startLine}"]`,
          )
        : container.querySelector<HTMLElement>("[data-line]");
    if (!target) {
      return;
    }

    const targetTop =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      16;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "auto",
    });
    pendingInitialFocusScrollFileRef.current = null;
  }, [annotations, autoScrollToFirstThread, filePath, positions, showThreadsPane]);

  if (patch) {
    return (
      <DiffViewWithThreads
        containerRef={containerRef}
        patch={patch}
        filePath={filePath}
        fileBrief={fileBrief}
        fileContent={fileContent}
        fileContentLoading={fileContentLoading}
        fileContentError={fileContentError}
        annotations={annotations}
        annotatedLineCategories={annotatedLineCategories}
        highlightedLineRange={highlightedLineRange}
        highlightedThread={activeThreadId}
        focusMode={focusMode}
        lineFocusMode={lineFocusMode}
        layout={layout}
        showThreadsPane={showThreadsPane}
        hasLineAnnotations={hasLineAnnotations}
        hasThreadAnnotations={hasThreadAnnotations}
        onHoverThread={handleHoverThread}
        onReplyThread={onReplyThread}
        onSetThreadStatus={onSetThreadStatus}
        positions={positions}
        gutterHeight={gutterHeight}
      />
    );
  }

  return (
    <div
      className={cx(
        "code-and-threads",
        embedded
          ? "overflow-visible"
          : "min-h-0 flex-1 overflow-auto",
        showThreadsPane
          ? "grid grid-cols-[minmax(0,1fr)_340px] max-[1200px]:grid-cols-[minmax(0,1fr)_300px] max-[960px]:grid-cols-1"
          : "flex",
      )}
      ref={containerRef}
    >
      <div
        className={cx(
          "flex flex-1 flex-col gap-4 p-8 transition-opacity duration-200",
          !embedded && lineFocusMode && !hasThreadAnnotations && "opacity-[0.22]",
        )}
      >
        {fileBrief && <FileBriefHeader brief={fileBrief} />}
        {fileContentError && (
          <p className="m-0 rounded-[8px] border border-[var(--red-edge)] bg-[var(--red-muted)] px-3 py-2 text-[12px] text-[var(--red)]">
            {fileContentError}
          </p>
        )}
        {fileContentLoading && (
          <p className="m-0 text-[12px] text-[var(--text-3)]">
            Loading file for context...
          </p>
        )}
        <p className="text-[13px] text-[var(--text-3)]">
          No current-run diff. Showing the full file.
        </p>
        {fileContent && (
          <SourceContextView
            filePath={filePath}
            sourceContent={fileContent}
            annotations={annotations}
            annotatedLineCategories={annotatedLineCategories}
            focusMode={lineFocusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            filterLineNumbers={null}
            focusedLineRange={highlightedLineRange}
            showAllLines
          />
        )}
      </div>
      {showThreadsPane && (
        <ThreadsPanel
          annotations={annotations}
          highlightedThread={activeThreadId}
          focusMode={focusMode}
          onHoverThread={handleHoverThread}
          onReplyThread={onReplyThread}
          onSetThreadStatus={onSetThreadStatus}
          positions={positions}
          gutterHeight={gutterHeight}
        />
      )}
    </div>
  );
});

const DiffViewWithThreads = memo(function DiffViewWithThreads({
  containerRef,
  patch,
  filePath,
  fileBrief,
  fileContent,
  fileContentLoading,
  fileContentError,
  annotations,
  annotatedLineCategories,
  highlightedLineRange,
  highlightedThread,
  focusMode,
  lineFocusMode,
  layout,
  showThreadsPane,
  hasLineAnnotations,
  hasThreadAnnotations,
  onHoverThread,
  onReplyThread,
  onSetThreadStatus,
  positions,
  gutterHeight,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  patch: string;
  filePath: string;
  fileBrief: FileBriefRecord | null;
  fileContent: string | null;
  fileContentLoading: boolean;
  fileContentError: string | null;
  annotations: FileAnnotation[];
  annotatedLineCategories: Map<string, string[]>;
  highlightedLineRange: {
    start: number;
    end: number;
    side: string | null;
  } | null;
  highlightedThread: string | null;
  focusMode: boolean;
  lineFocusMode: boolean;
  layout: "file" | "embedded";
  showThreadsPane: boolean;
  hasLineAnnotations: boolean;
  hasThreadAnnotations: boolean;
  onHoverThread: (id: string | null) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  onSetThreadStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
  positions: Map<string, { top: number; idealTop: number }>;
  gutterHeight: number;
}) {
  const embedded = layout === "embedded";
  const rawLines = patch.split("\n");
  const hunkHeaderRegex =
    /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  const { parsedLines, hunks } = useMemo(() => {
    let curNew = 0;
    let curOld = 0;
    const parsed: Array<{
      raw: string;
      lineClass: string;
      displayLineNum: number | null;
      oldLineNum: number | null;
    }> = [];
    const nextHunks: Array<{
      startIndex: number;
      endIndex: number;
      newStart: number;
      newEnd: number;
    }> = [];
    let activeHunk:
      | {
          startIndex: number;
          endIndex: number;
          newStart: number;
          newEnd: number;
        }
      | null = null;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const hunkMatch = line.match(hunkHeaderRegex);
      if (hunkMatch?.[1] && hunkMatch[3]) {
        curOld = parseInt(hunkMatch[1], 10) - 1;
        curNew = parseInt(hunkMatch[3], 10) - 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newCount = parseInt(hunkMatch[4] ?? "1", 10);
        activeHunk = {
          startIndex: i,
          endIndex: i,
          newStart,
          newEnd: newCount === 0 ? newStart - 1 : newStart + newCount - 1,
        };
        nextHunks.push(activeHunk);
      }

      let lineClass = "diff-context";
      let displayLineNum: number | null = null;
      let oldLineNum: number | null = null;

      if (
        line.startsWith("Index:") ||
        line.startsWith("===") ||
        line.startsWith("---") ||
        line.startsWith("+++")
      ) {
        lineClass = "diff-meta";
      } else if (line.startsWith("+")) {
        lineClass = "diff-add";
        curNew++;
        displayLineNum = curNew;
      } else if (line.startsWith("-")) {
        lineClass = "diff-remove";
        curOld++;
        oldLineNum = curOld;
      } else if (hunkMatch) {
        lineClass = "diff-hunk";
      } else if (line.startsWith("\\")) {
        lineClass = "diff-meta";
      } else {
        curNew++;
        curOld++;
        displayLineNum = curNew;
        oldLineNum = curOld;
      }

      parsed.push({ raw: line, lineClass, displayLineNum, oldLineNum });

      if (activeHunk) {
        activeHunk.endIndex = i;
      }
    }

    return { parsedLines: parsed, hunks: nextHunks };
  }, [rawLines]);

  const highlightedLines = useMemo(
    () =>
      parsedLines.map((line) =>
        highlightDiffLine(line.raw, filePath, line.lineClass),
      ),
    [filePath, parsedLines],
  );

  const sourceLines = useMemo(
    () =>
      fileContent
        ? fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
        : [],
    [fileContent],
  );

  const orderedContextSections = useMemo(() => {
    if (!fileContent) {
      return [];
    }

    if (hunks.length === 0) {
      return [
        {
          key: "context-full-file",
          start: 1,
          end: sourceLines.length,
        },
      ];
    }

    const sections: Array<{ key: string; start: number; end: number }> = [];
    const pushSection = (key: string, start: number, end: number) => {
      const boundedStart = Math.max(1, start);
      const boundedEnd = Math.min(sourceLines.length, end);
      if (boundedStart > boundedEnd) {
        return;
      }
      sections.push({ key, start: boundedStart, end: boundedEnd });
    };

    const firstHunk = hunks[0]!;
    pushSection("context-before-first-hunk", 1, firstHunk.newStart - 1);

    hunks.forEach((hunk, index) => {
      const nextHunk = hunks[index + 1];
      if (nextHunk) {
        pushSection(
          `context-between-hunks-${index}`,
          hunk.newEnd + 1,
          nextHunk.newStart - 1,
        );
        return;
      }

      pushSection(
        "context-after-last-hunk",
        hunk.newEnd + 1,
        sourceLines.length,
      );
    });

    return sections;
  }, [fileContent, hunks, sourceLines.length]);

  const renderDiffRow = (
    p: (typeof parsedLines)[number],
    index: number,
  ): React.ReactNode => {
    if (p.lineClass === "diff-meta" || p.lineClass === "diff-hunk") {
      return null;
    }

    const highlightedLine = highlightedLines[index]!;
    const isOldSide = p.oldLineNum !== null && p.displayLineNum === null;
    const effectiveLine = p.displayLineNum ?? p.oldLineNum;
    const lineSide = isOldSide ? "old" : "new";

    const annotationCategories = effectiveLine
      ? resolveAnnotationCategoriesForLine(
          annotatedLineCategories,
          effectiveLine,
          lineSide,
          { allowSideFallback: false },
        )
      : undefined;
    const hasAnnotation = Boolean(
      annotationCategories && annotationCategories.length > 0,
    );

    const isHighlighted =
      highlightedLineRange && effectiveLine
        ? effectiveLine >= highlightedLineRange.start &&
          effectiveLine <= highlightedLineRange.end &&
          (!highlightedLineRange.side || highlightedLineRange.side === lineSide)
        : false;
    const isDimmed = lineFocusMode
      ? hasThreadAnnotations
        ? hasLineAnnotations
          ? !hasAnnotation
          : false
        : true
      : false;

    return (
        <div
          key={`diff-line-${index}`}
          data-line={effectiveLine ?? undefined}
          data-line-side={effectiveLine ? lineSide : undefined}
          className={cx(
            "code-line relative flex min-h-[21px] items-start px-4 transition-[opacity,background-color] duration-200 hover:bg-[rgba(255,255,255,0.02)]",
            p.lineClass === "diff-add" && "bg-[var(--green-muted)]",
            p.lineClass === "diff-remove" && "bg-[var(--red-muted)]",
            hasAnnotation &&
              p.lineClass !== "diff-add" &&
            p.lineClass !== "diff-remove" &&
            "bg-[var(--teal-muted)]",
          isHighlighted && "bg-[var(--teal-strong)]",
          isDimmed && !isHighlighted && "opacity-[0.22]",
        )}
      >
        {hasAnnotation && (
          <div className="pointer-events-none absolute left-0 top-0.5 bottom-0.5 flex">
            {annotationCategories!.map((category, categoryIndex) => {
              const tone = threadTone(category);
              return (
                <span
                  key={`${category}-${categoryIndex}`}
                  className={cx(
                    "h-full rounded-r-[2px] transition-[background-color,opacity] duration-150",
                    tone.lineAccentClass,
                    isHighlighted ? "opacity-100" : "opacity-90",
                  )}
                  style={{ width: "3px", marginLeft: `${categoryIndex * 3}px` }}
                />
              );
            })}
          </div>
        )}
        <span className="w-12 shrink-0 select-none pr-4 text-right text-[var(--text-3)] opacity-50">
          {p.displayLineNum ?? p.oldLineNum ?? ""}
        </span>
        <span
          className={cx(
            "relative min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-2)]",
          )}
        >
          {highlightedLine.prefix !== null && (
            <span
              className={cx(
                p.lineClass === "diff-add" && "text-[var(--green)]",
                p.lineClass === "diff-remove" && "text-[var(--red)]",
                p.lineClass !== "diff-add" &&
                  p.lineClass !== "diff-remove" &&
                  "text-[var(--text-3)]",
              )}
            >
              {highlightedLine.prefix}
            </span>
          )}
          <span
            className="syntax-line"
            dangerouslySetInnerHTML={{ __html: highlightedLine.html }}
          />
        </span>
      </div>
    );
  };

  const renderedDiffBlocks: React.ReactNode[] = [];
  if (hunks.length === 0) {
    renderedDiffBlocks.push(
      ...parsedLines.map((line, index) => renderDiffRow(line, index)),
    );
    if (fileContent && orderedContextSections.length > 0) {
      renderedDiffBlocks.push(
        <SourceContextView
          key="context-without-hunks"
          filePath={filePath}
          sourceContent={fileContent}
          annotations={annotations}
          annotatedLineCategories={annotatedLineCategories}
          focusedLineRange={highlightedLineRange}
          filterLineNumbers={null}
          focusMode={lineFocusMode}
          hasLineAnnotations={hasLineAnnotations}
          hasThreadAnnotations={hasThreadAnnotations}
          lineStart={1}
          lineEnd={sourceLines.length}
          showAllLines
        />,
      );
    }
  } else {
    let renderedIndex = 0;
    const firstHunk = hunks[0]!;
    if (firstHunk.startIndex > 0) {
      renderedDiffBlocks.push(
        ...parsedLines
          .slice(0, firstHunk.startIndex)
          .map((line, index) => renderDiffRow(line, index)),
      );
      renderedIndex = firstHunk.startIndex;
    }

    orderedContextSections
      .filter((section) => section.end < firstHunk.newStart)
      .forEach((section) => {
        renderedDiffBlocks.push(
          <SourceContextView
            key={section.key}
            filePath={filePath}
            sourceContent={fileContent!}
            annotations={annotations}
            annotatedLineCategories={annotatedLineCategories}
            focusedLineRange={highlightedLineRange}
            filterLineNumbers={null}
            focusMode={lineFocusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            lineStart={section.start}
            lineEnd={section.end}
            showAllLines
          />,
        );
      });

    hunks.forEach((hunk, hunkIndex) => {
      if (renderedIndex < hunk.startIndex) {
        renderedDiffBlocks.push(
          ...parsedLines
            .slice(renderedIndex, hunk.startIndex)
            .map((line, index) =>
              renderDiffRow(line, renderedIndex + index),
            ),
        );
      }

      renderedDiffBlocks.push(
        ...parsedLines
          .slice(hunk.startIndex, hunk.endIndex + 1)
          .map((line, index) => renderDiffRow(line, hunk.startIndex + index)),
      );
      renderedIndex = hunk.endIndex + 1;

      const nextHunk = hunks[hunkIndex + 1];
      const sectionStart = hunk.newEnd + 1;
      const sectionEnd = nextHunk ? nextHunk.newStart - 1 : sourceLines.length;
      const matchingSection = orderedContextSections.find(
        (section) =>
          section.start === Math.max(1, sectionStart) &&
          section.end === Math.min(sourceLines.length, sectionEnd),
      );

      if (matchingSection && fileContent) {
        renderedDiffBlocks.push(
          <SourceContextView
            key={matchingSection.key}
            filePath={filePath}
            sourceContent={fileContent}
            annotations={annotations}
            annotatedLineCategories={annotatedLineCategories}
            focusedLineRange={highlightedLineRange}
            filterLineNumbers={null}
            focusMode={lineFocusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            lineStart={matchingSection.start}
            lineEnd={matchingSection.end}
            showAllLines
          />,
        );
      }
    });

    if (renderedIndex < parsedLines.length) {
      renderedDiffBlocks.push(
        ...parsedLines
          .slice(renderedIndex)
          .map((line, index) => renderDiffRow(line, renderedIndex + index)),
      );
    }
  }

  return (
    <div
      className={cx(
        "code-and-threads",
        embedded
          ? "overflow-visible"
          : "min-h-0 flex-1 overflow-auto",
        showThreadsPane
          ? "grid grid-cols-[minmax(0,1fr)_340px] max-[1200px]:grid-cols-[minmax(0,1fr)_300px] max-[960px]:grid-cols-1"
          : "flex",
      )}
      ref={containerRef}
    >
      <div
        className={cx(
          "code-view flex-1 text-[12px] leading-[1.65]",
          embedded ? "overflow-visible" : "overflow-auto",
        )}
        style={codeFontStyle}
      >
        <div className="flex flex-col">
          {fileBrief && <FileBriefHeader brief={fileBrief} />}
          {fileContentError && (
            <p className="m-0 rounded-[8px] border border-[var(--red-edge)] bg-[var(--red-muted)] px-3 py-2 text-[12px] text-[var(--red)]">
              {fileContentError}
            </p>
          )}
          {fileContentLoading && (
            <p className="m-0 border-b border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-3)]">
              Loading file for context...
            </p>
          )}
          {renderedDiffBlocks}
        </div>
      </div>
      {showThreadsPane && (
        <ThreadsPanel
          annotations={annotations}
          highlightedThread={highlightedThread}
          focusMode={focusMode}
          onHoverThread={onHoverThread}
          onReplyThread={onReplyThread}
          onSetThreadStatus={onSetThreadStatus}
          positions={positions}
          gutterHeight={gutterHeight}
        />
      )}
    </div>
  );
});

const SearchResultsList = memo(function SearchResultsList({
  results,
  onSelectFile,
}: {
  results: SearchResult[];
  onSelectFile: (path: string) => void;
}) {
  const sortedNumbers = useMemo(
    () =>
      [...results].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [results],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-2.5">
        <span className="text-[12px] font-medium text-[var(--text-3)]">
          {sortedNumbers.length} results
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sortedNumbers.map((r) => (
          <button
            key={`${r.kind}-${r.id}`}
            className="flex w-full flex-col gap-1 border-b border-[var(--border)] px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[var(--bg-3)]"
            onClick={() => r.filePath && onSelectFile(r.filePath)}
          >
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  "shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]",
                  resultToneByKind[r.kind] ??
                    "bg-[var(--bg-4)] text-[var(--text-2)]",
                )}
              >
                {r.kind.replace("_", " ")}
              </span>
              <span className="text-[13px] font-medium text-[var(--text-1)]">
                {r.title}
              </span>
            </div>
            <span className="line-clamp-2 overflow-hidden text-[12px] text-[var(--text-3)]">
              {r.excerpt}
            </span>
            {r.filePath && (
              <span className="font-[var(--font-mono)] text-[11px] text-[var(--text-3)] opacity-70">
                {r.filePath}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
});

const SourceContextView = memo(function SourceContextView({
  filePath,
  sourceContent,
  annotations,
  filterLineNumbers,
  annotatedLineCategories,
  focusedLineRange,
  focusMode,
  hasLineAnnotations,
  hasThreadAnnotations,
  lineStart,
  lineEnd,
  showAllLines,
  title,
}: {
  filePath: string;
  sourceContent: string;
  annotations: FileAnnotation[];
  filterLineNumbers: Set<number> | null;
  annotatedLineCategories: Map<string, string[]>;
  focusedLineRange: {
    start: number;
    end: number;
    side: string | null;
  } | null;
  focusMode: boolean;
  hasLineAnnotations: boolean;
  hasThreadAnnotations: boolean;
  lineStart?: number;
  lineEnd?: number;
  showAllLines?: boolean;
  title?: string;
}) {
  const linePadding = 3;
  const fullViewEdgeLines = 24;
  const fullViewExpandThreshold = 120;
  const lines = useMemo(
    () =>
      sourceContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"),
    [sourceContent],
  );

  const boundedLineStart = Math.max(1, lineStart ?? 1);
  const boundedLineEnd = Math.min(lines.length, lineEnd ?? lines.length);

  const targetRanges = useMemo(() => {
    const ranges: LineRange[] = [];
    for (const annotation of annotations) {
      if (!hasActiveLineAnchor(annotation)) continue;
      if (annotation.lineSide === "old") continue;
      const start = annotation.startLine!;
      const end = annotation.endLine ?? start;
      const clampedStart = Math.max(start, boundedLineStart);
      const clampedEnd = Math.min(end, boundedLineEnd);
      if (clampedStart > clampedEnd) {
        continue;
      }

      const filteredLines: number[] = [];
      for (let line = clampedStart; line <= clampedEnd; line++) {
        if (line < 1 || line > lines.length) {
          continue;
        }
        if (!filterLineNumbers || filterLineNumbers.has(line)) {
          filteredLines.push(line);
        }
      }

      if (filteredLines.length === 0) {
        continue;
      }

      ranges.push({
        start: filteredLines[0]!,
        end: filteredLines[filteredLines.length - 1]!,
      });
    }

    return mergeLineRanges(ranges);
  }, [annotations, boundedLineEnd, boundedLineStart, filterLineNumbers, lines.length]);

  const baseVisibleRanges = useMemo(() => {
    const paddedTargetRanges = targetRanges.map((range) => ({
      start: Math.max(boundedLineStart, range.start - linePadding),
      end: Math.min(boundedLineEnd, range.end + linePadding),
    }));

    if (!showAllLines) {
      return mergeLineRanges(paddedTargetRanges);
    }

    const sectionLength = boundedLineEnd - boundedLineStart + 1;
    if (sectionLength <= fullViewExpandThreshold) {
      return [{ start: boundedLineStart, end: boundedLineEnd }];
    }

    const edgeRanges: LineRange[] = [
      {
        start: boundedLineStart,
        end: Math.min(boundedLineEnd, boundedLineStart + fullViewEdgeLines - 1),
      },
      {
        start: Math.max(boundedLineStart, boundedLineEnd - fullViewEdgeLines + 1),
        end: boundedLineEnd,
      },
    ];

    const focusedRange =
      focusedLineRange &&
      (focusedLineRange.side === null || focusedLineRange.side === "new")
        ? [
            {
              start: Math.max(
                boundedLineStart,
                focusedLineRange.start - linePadding,
              ),
              end: Math.min(
                boundedLineEnd,
                focusedLineRange.end + linePadding,
              ),
            },
          ]
        : [];

    return mergeLineRanges([
      ...edgeRanges,
      ...paddedTargetRanges,
      ...focusedRange,
    ]);
  }, [
    boundedLineEnd,
    boundedLineStart,
    focusedLineRange,
    fullViewEdgeLines,
    fullViewExpandThreshold,
    linePadding,
    showAllLines,
    targetRanges,
  ]);

  const [revealedRanges, setRevealedRanges] = useState<LineRange[]>([]);
  const revealResetKey = useMemo(
    () =>
      [
        filePath,
        boundedLineStart,
        boundedLineEnd,
        linePadding,
        showAllLines ? "full" : "anchored",
        sourceContent.length,
        targetRanges.map((range) => `${range.start}-${range.end}`).join(","),
      ].join(":"),
    [
      boundedLineEnd,
      boundedLineStart,
      filePath,
      linePadding,
      showAllLines,
      sourceContent.length,
      targetRanges,
    ],
  );

  useEffect(() => {
    setRevealedRanges([]);
  }, [revealResetKey]);

  const visibleRanges = useMemo(
    () => mergeLineRanges([...baseVisibleRanges, ...revealedRanges]),
    [baseVisibleRanges, revealedRanges],
  );

  const rows = useMemo(() => {
    const rows: Array<
      | { kind: "line"; line: number; key: string }
      | { kind: "gap"; from: number; to: number; key: string }
    > = [];

    if (visibleRanges.length === 0) {
      return rows;
    }

    let cursor = boundedLineStart;
    visibleRanges.forEach((range) => {
      if (cursor < range.start) {
        rows.push({
          kind: "gap",
          from: cursor,
          to: range.start - 1,
          key: `gap-${cursor}-${range.start - 1}`,
        });
      }

      for (let line = range.start; line <= range.end; line++) {
        rows.push({
          kind: "line",
          line,
          key: `line-${line}`,
        });
      }

      cursor = range.end + 1;
    });

    if (cursor <= boundedLineEnd) {
      rows.push({
        kind: "gap",
        from: cursor,
        to: boundedLineEnd,
        key: `gap-${cursor}-${boundedLineEnd}`,
      });
    }

    return rows;
  }, [boundedLineEnd, boundedLineStart, visibleRanges]);

  const highlightedSourceLines = useMemo(() => {
    const highlighted = new Map<
      number,
      ReturnType<typeof highlightDiffLine>
    >();

    for (const row of rows) {
      if (row.kind !== "line") {
        continue;
      }

      highlighted.set(
        row.line,
        highlightDiffLine(
          lines[row.line - 1] ?? "",
          filePath,
          "diff-context",
        ),
      );
    }

    return highlighted;
  }, [filePath, lines, rows]);

  const hasHiddenRanges = rows.some((row) => row.kind === "gap");

  if (
    boundedLineStart > boundedLineEnd ||
    (!showAllLines && targetRanges.length === 0)
  ) {
    return null;
  }

  const revealRange = (start: number, end: number) => {
    setRevealedRanges((current) => {
      if (current.some((range) => range.start === start && range.end === end)) {
        return current;
      }
      return [...current, { start, end }];
    });
  };

  const expandStep = 8;

  const revealGapTop = (start: number, end: number) => {
    const count = Math.min(expandStep, end - start + 1);
    revealRange(start, start + count - 1);
  };

  const revealGapBottom = (start: number, end: number) => {
    const count = Math.min(expandStep, end - start + 1);
    revealRange(end - count + 1, end);
  };

  const revealAll = () => {
    revealRange(boundedLineStart, boundedLineEnd);
  };

  return (
    <div className="border-y border-[var(--border)] bg-[rgba(255,255,255,0.02)]">
      {title && (
        <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-1)] px-4 py-2 text-[11px] text-[var(--text-3)]">
          <span>{title}</span>
          {hasHiddenRanges && (
            <button
              type="button"
              className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] transition-colors duration-150 hover:border-[var(--text-3)] hover:text-[var(--text-1)]"
              onClick={revealAll}
            >
              Show all context
            </button>
          )}
        </div>
      )}
      <div className="relative">
        {rows.map((row) => {
          if (row.kind === "gap") {
            const hiddenCount = row.to - row.from + 1;
            const expandChunk = Math.min(expandStep, hiddenCount);
            const canExpandTop = row.from > boundedLineStart;
            const canExpandBottom = row.to < boundedLineEnd;
            const label =
              row.from === boundedLineStart
                ? `Show ${hiddenCount} earlier line${hiddenCount === 1 ? "" : "s"}`
                : row.to === boundedLineEnd
                  ? `Show ${hiddenCount} later line${hiddenCount === 1 ? "" : "s"}`
                  : `Show ${hiddenCount} hidden line${hiddenCount === 1 ? "" : "s"}`;

            return (
              <div
                key={row.key}
                className="code-line flex w-full items-center px-4 py-1.5 text-left text-[11px] text-[var(--accent-text)]"
              >
                <span className="w-12 shrink-0 pr-4 text-right text-[var(--text-3)] opacity-50">
                  ...
                </span>
                <span>{label}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {canExpandTop && (
                    <button
                      type="button"
                      className="inline-flex h-6 min-w-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-3)] px-2 text-[11px] leading-none text-[var(--text-2)] transition-colors duration-150 hover:border-[var(--text-3)]"
                      onClick={() => revealGapTop(row.from, row.to)}
                      aria-label={`Show ${expandChunk} lines above`}
                    >
                      ↑{expandChunk}
                    </button>
                  )}
                  {canExpandBottom && (
                    <button
                      type="button"
                      className="inline-flex h-6 min-w-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-3)] px-2 text-[11px] leading-none text-[var(--text-2)] transition-colors duration-150 hover:border-[var(--text-3)]"
                      onClick={() => revealGapBottom(row.from, row.to)}
                      aria-label={`Show ${expandChunk} lines below`}
                    >
                      ↓{expandChunk}
                    </button>
                  )}
                </span>
              </div>
            );
          }

          const line = row.line;
          const highlightedLine = highlightedSourceLines.get(line);
          if (!highlightedLine) {
            return null;
          }
          const annotationCategories = resolveAnnotationCategoriesForLine(
            annotatedLineCategories,
            line,
            "new",
          );
          const hasAnnotation = Boolean(
            annotationCategories && annotationCategories.length > 0,
          );

          const isHighlighted =
            focusedLineRange !== null &&
            (focusedLineRange.side === null ||
              focusedLineRange.side === "new") &&
            line >= focusedLineRange.start &&
            line <= focusedLineRange.end;

          const isDimmed = focusMode
            ? hasThreadAnnotations
              ? hasLineAnnotations
                ? !hasAnnotation
                : false
              : true
            : false;

          return (
            <div
              key={row.key}
              data-line={line}
              data-line-side="new"
              className={cx(
                "code-line relative flex min-h-[21px] items-start px-4 transition-[opacity,background-color] duration-200 hover:bg-[rgba(255,255,255,0.02)]",
                hasAnnotation && "bg-[var(--teal-muted)]",
                isHighlighted && "bg-[var(--teal-strong)]",
                isDimmed && !isHighlighted && "opacity-[0.22]",
              )}
            >
              {hasAnnotation && (
                <div className="pointer-events-none absolute left-0 top-0.5 bottom-0.5 flex">
                  {annotationCategories!.map((category, index) => {
                    const tone = threadTone(category);
                    return (
                      <span
                        key={`${category}-${index}`}
                        className={cx(
                          "h-full rounded-r-[2px] transition-[background-color,opacity] duration-150",
                          tone.lineAccentClass,
                          isHighlighted ? "opacity-100" : "opacity-90",
                        )}
                        style={{ width: "3px", marginLeft: `${index * 3}px` }}
                      />
                    );
                  })}
                </div>
              )}
              <span className="w-12 shrink-0 select-none pr-4 text-right text-[var(--text-3)] opacity-50">
                {line}
              </span>
              <span className="relative min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-2)]">
                {highlightedLine.prefix !== null && (
                  <span className="text-[var(--text-3)]">
                    {highlightedLine.prefix}
                  </span>
                )}
                <span
                  className="syntax-line"
                  dangerouslySetInnerHTML={{ __html: highlightedLine.html }}
                />
              </span>
            </div>
          );
        })}
      </div>
      {!title && hasHiddenRanges && (
        <div className="border-t border-[var(--border)] px-4 py-1.5 text-right">
          <button
            type="button"
            className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] transition-colors duration-150 hover:border-[var(--text-3)] hover:text-[var(--text-1)]"
            onClick={revealAll}
          >
            Show all context
          </button>
        </div>
      )}
    </div>
  );
});

const UnifiedReviewPane = memo(function UnifiedReviewPane({
  sections,
  activeFile,
  requestedFilePath,
  onRequestedFileHandled,
  onSelectFile,
  onSyncActiveFile,
  onHoverThread,
  onReplyThread,
  onSetThreadStatus,
}: {
  sections: ReviewSection[];
  activeFile: string | null;
  requestedFilePath: string | null;
  onRequestedFileHandled: () => void;
  onSelectFile: (filePath: string) => void;
  onSyncActiveFile: (filePath: string) => void;
  onHoverThread: (threadId: string | null) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  onSetThreadStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const summary = useMemo(() => {
    let totalThreads = 0;
    let openThreads = 0;
    for (const section of sections) {
      totalThreads += section.annotations.length;
      openThreads += section.openThreads;
    }
    return { files: sections.length, totalThreads, openThreads };
  }, [sections]);

  const syncVisibleSection = useCallback(() => {
    const container = containerRef.current;
    if (!container || sections.length === 0) {
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const focusLine = containerTop + clamp(container.clientHeight * 0.25, 96, 220);
    let bestFilePath: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const section of sections) {
      const element = sectionRefs.current.get(section.filePath);
      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.bottom < focusLine - 24) {
        continue;
      }

      const distance = Math.abs(rect.top - focusLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestFilePath = section.filePath;
      }
    }

    if (!bestFilePath) {
      bestFilePath = sections[sections.length - 1]?.filePath ?? null;
    }

    if (bestFilePath && bestFilePath !== activeFile) {
      onSyncActiveFile(bestFilePath);
    }
  }, [activeFile, onSyncActiveFile, sections]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncVisibleSection();
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    handleScroll();

    return () => {
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [syncVisibleSection]);

  useLayoutEffect(() => {
    if (!requestedFilePath) {
      return;
    }

    const container = containerRef.current;
    const section = sectionRefs.current.get(requestedFilePath);
    if (!container || !section) {
      onRequestedFileHandled();
      return;
    }

    const nextTop = Math.max(0, section.offsetTop - 16);
    container.scrollTo({
      top: nextTop,
      behavior: "smooth",
    });
    onRequestedFileHandled();
  }, [onRequestedFileHandled, requestedFilePath]);

  if (sections.length === 0) {
    return (
      <aside className="review-stream flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--bg-1)] max-[1180px]:border-l-0 max-[1180px]:border-t">
        <div className="border-b border-[var(--border)] px-5 py-3">
          <span className="text-[12px] font-semibold text-[var(--text-1)]">
            Focus Review
          </span>
          <p className="mt-2 mb-0 text-[13px] leading-[1.6] text-[var(--text-3)]">
            No review items yet.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="review-stream flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--bg-1)] max-[1180px]:border-l-0 max-[1180px]:border-t">
      <div className="border-b border-[var(--border)] bg-[var(--bg-2)] px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-[var(--text-1)]">
              Focus Review
            </span>
            <span className="text-[12px] tabular-nums text-[var(--text-3)]">
              <span className="font-medium text-[var(--text-2)]">{summary.openThreads}</span>
              <span className="mx-px">/</span>
              {summary.totalThreads} open
            </span>
          </div>
          <span className="text-[12px] tabular-nums text-[var(--text-3)]">
            {summary.files} {summary.files === 1 ? "file" : "files"}
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="review-stream-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="flex flex-col gap-4">
          {sections.map((section) => {
            const fileName = section.filePath.split("/").pop() ?? section.filePath;
            const isActive = activeFile === section.filePath;

            return (
              <section
                key={section.filePath}
                ref={(node) => {
                  if (node) {
                    sectionRefs.current.set(section.filePath, node);
                    return;
                  }
                  sectionRefs.current.delete(section.filePath);
                }}
                className={cx(
                  "scroll-mt-4 rounded-[18px] border px-3 py-3 transition-[border-color,background-color,box-shadow] duration-200",
                  isActive
                    ? "border-[var(--teal-border)] bg-[var(--teal-muted)] shadow-[0_20px_48px_-34px_rgba(0,0,0,0.72)]"
                    : "border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)]",
                )}
              >
                <div className="sticky top-0 z-[1] -mx-1 mb-3 rounded-[14px] border border-transparent bg-[var(--bg-3)] px-1 pb-2 pt-1 backdrop-blur">
                  <button
                    type="button"
                    className={cx(
                      "flex w-full items-start justify-between gap-3 rounded-[12px] border px-3 py-2 text-left transition-colors duration-150",
                      isActive
                        ? "border-[var(--teal-border)] bg-[var(--teal-muted)]"
                        : "border-[var(--border)] bg-[rgba(255,255,255,0.02)] hover:border-[var(--border-hover)] hover:bg-[rgba(255,255,255,0.04)]",
                    )}
                    onClick={() => onSelectFile(section.filePath)}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={fileBadgeClass(fileName)}>
                          {fileIcon(fileName, true)}
                        </span>
                        <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-1)]">
                          {fileName}
                        </span>
                        {isActive && (
                          <span className="rounded-full border border-[var(--teal-border)] bg-[var(--teal-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--teal-text)]">
                            Current
                          </span>
                        )}
                      </div>
                      <p className="mt-1 mb-0 truncate font-[var(--font-mono)] text-[11px] text-[var(--text-3)]">
                        {section.filePath}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      {section.change && (
                        <span
                          className={cx(
                            "font-[var(--font-mono)] text-[11px] font-semibold",
                            changeToneByType[section.change.eventType],
                          )}
                        >
                          {section.change.eventType === "add"
                            ? "A"
                            : section.change.eventType === "unlink"
                              ? "D"
                              : "M"}
                        </span>
                      )}
                      <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[rgba(255,255,255,0.03)] px-2.5 py-0.5 text-[11px] text-[var(--text-2)]">
                        <span className="font-medium text-[var(--text-1)]">{section.openThreads}</span>
                        <span className="text-[var(--text-3)]">open</span>
                        {section.totalThreads > section.openThreads && (
                          <>
                            <span className="text-[var(--text-3)]">&middot;</span>
                            <span className="text-[var(--text-3)]">{section.totalThreads - section.openThreads} resolved</span>
                          </>
                        )}
                      </span>
                    </div>
                  </button>
                </div>

                {section.brief && (
                  <div className="mb-3 rounded-[14px] border border-[var(--blue-edge)] bg-[var(--bg-3)] px-3.5 py-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--blue-edge)] bg-[var(--blue-muted)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--blue)]">
                        File brief
                      </span>
                      {section.brief.freshness === "outdated" && (
                        <span className="rounded-full border border-[var(--amber-edge)] bg-[var(--amber-muted)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--amber)]">
                          Outdated
                        </span>
                      )}
                    </div>
                    <p className="m-0 text-[13px] leading-[1.65] text-[var(--text-1)]">
                      {section.brief.summary}
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-3">
                  {section.annotations.map((annotation) => (
                    <ThreadCard
                      key={annotation.id}
                      annotation={annotation}
                      highlighted={false}
                      focusMode
                      onHover={(threadId) => {
                        onHoverThread(threadId);
                        if (threadId) {
                          onSyncActiveFile(section.filePath);
                        }
                      }}
                      onReply={onReplyThread}
                      onSetStatus={onSetThreadStatus}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </aside>
  );
});

const FocusReviewStream = memo(function FocusReviewStream({
  sections,
  activeFile,
  requestedFilePath,
  onRequestedFileHandled,
  onSelectFile,
  onSyncActiveFile,
  onReplyThread,
  onSetThreadStatus,
  cacheRef,
}: {
  sections: ReviewSection[];
  activeFile: string | null;
  requestedFilePath: string | null;
  onRequestedFileHandled: () => void;
  onSelectFile: (filePath: string) => void;
  onSyncActiveFile: (filePath: string) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  onSetThreadStatus: (threadId: string, status: "open" | "resolved") => Promise<void>;
  cacheRef: React.MutableRefObject<Map<string, string>>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const fileContents = useMultiFileContent(sections, cacheRef);

  const summary = useMemo(() => {
    let totalThreads = 0;
    let openThreads = 0;
    for (const s of sections) {
      totalThreads += s.annotations.length;
      openThreads += s.openThreads;
    }
    return { files: sections.length, totalThreads, openThreads };
  }, [sections]);

  // Scroll-sync: detect which file section is visible and sync sidebar
  const syncVisibleSection = useCallback(() => {
    const container = containerRef.current;
    if (!container || sections.length === 0) return;

    const containerTop = container.getBoundingClientRect().top;
    const focusLine = containerTop + clamp(container.clientHeight * 0.25, 96, 220);
    let bestFilePath: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const section of sections) {
      const el = sectionRefs.current.get(section.filePath);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < focusLine - 24) continue;
      const distance = Math.abs(rect.top - focusLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestFilePath = section.filePath;
      }
    }

    if (!bestFilePath) {
      bestFilePath = sections[sections.length - 1]?.filePath ?? null;
    }

    if (bestFilePath && bestFilePath !== activeFile) {
      onSyncActiveFile(bestFilePath);
    }
  }, [activeFile, onSyncActiveFile, sections]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncVisibleSection();
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    handleScroll();

    return () => {
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [syncVisibleSection]);

  // Scroll to requested file section
  useLayoutEffect(() => {
    if (!requestedFilePath) return;
    const container = containerRef.current;
    const section = sectionRefs.current.get(requestedFilePath);
    if (!container || !section) {
      onRequestedFileHandled();
      return;
    }
    container.scrollTo({ top: Math.max(0, section.offsetTop - 16), behavior: "smooth" });
    onRequestedFileHandled();
  }, [onRequestedFileHandled, requestedFilePath]);

  const noopHover = useCallback(() => {}, []);

  if (sections.length === 0) {
    return (
      <div className="focus-stream focus-stream-empty">
        <div className="mx-auto max-w-[820px] px-6 py-16 text-center">
          <p className="m-0 text-[12px] font-semibold text-[var(--text-1)]">
            Focus Review
          </p>
          <p className="mt-2 mb-0 text-[13px] leading-[1.6] text-[var(--text-3)]">
            No review items yet. Browse the repository in the sidebar.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="focus-stream" ref={containerRef}>
      {/* Summary header + TOC */}
      <div className="focus-stream-header">
        <div className="mx-auto max-w-[820px] px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-semibold text-[var(--text-1)]">
                Focus Review
              </span>
              <span className="text-[12px] tabular-nums text-[var(--text-3)]">
                <span className="font-medium text-[var(--text-2)]">{summary.openThreads}</span>
                <span className="mx-px">/</span>
                {summary.totalThreads} open
              </span>
            </div>
            <span className="text-[12px] tabular-nums text-[var(--text-3)]">
              {summary.files} {summary.files === 1 ? "file" : "files"}
            </span>
          </div>
          <div className="focus-stream-toc">
            {sections.map((section) => {
              const name = section.filePath.split("/").pop() ?? section.filePath;
              const isCurrent = activeFile === section.filePath;
              return (
                <button
                  key={section.filePath}
                  type="button"
                  className={cx(
                    "focus-stream-toc-chip",
                    isCurrent && "focus-stream-toc-chip-active",
                  )}
                  onClick={() => {
                    const el = sectionRefs.current.get(section.filePath);
                    const container = containerRef.current;
                    if (el && container) {
                      container.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: "smooth" });
                    }
                    onSelectFile(section.filePath);
                  }}
                >
                  <span className={fileBadgeClass(name)} style={{ fontSize: 9, padding: "1px 4px" }}>
                    {fileIcon(name, true)}
                  </span>
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[820px] px-6 pb-16">
        {sections.map((section) => {
          const lineAnchored = section.annotations.filter((a) => hasActiveLineAnchor(a));
          const fileLevel = section.annotations.filter((a) => !hasActiveLineAnchor(a));

          return (
            <div
              key={section.filePath}
              ref={(node) => {
                if (node) {
                  sectionRefs.current.set(section.filePath, node);
                } else {
                  sectionRefs.current.delete(section.filePath);
                }
              }}
              className="focus-stream-section"
            >
              {/* File brief */}
              {section.brief && (
                <div className="mb-4 rounded-[12px] border border-[var(--blue-edge)] bg-[var(--bg-3)] px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="rounded-full border border-[var(--blue-edge)] bg-[var(--blue-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--blue)]">
                      Brief
                    </span>
                    {section.brief.freshness === "outdated" && (
                      <span className="rounded-full border border-[var(--amber-edge)] bg-[var(--amber-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--amber)]">
                        Outdated
                      </span>
                    )}
                  </div>
                  <p className="m-0 text-[13px] leading-[1.65] text-[var(--text-2)]">
                    {section.brief.summary}
                  </p>
                </div>
              )}

              {/* Line-anchored threads: code snippet + thread card as unified block */}
              {lineAnchored.map((annotation) => (
                <div key={annotation.id} className="review-item">
                  <CodeSnippet
                    filePath={section.filePath}
                    fileContent={fileContents.get(section.filePath)}
                    startLine={annotation.startLine!}
                    endLine={annotation.endLine!}
                    categoryColor={threadTypeColor(annotation.category)}
                  />
                  <ThreadCard
                    annotation={annotation}
                    highlighted={false}
                    focusMode
                    onHover={noopHover}
                    onReply={onReplyThread}
                    onSetStatus={onSetThreadStatus}
                  />
                </div>
              ))}

              {/* File-level threads (no code snippet) */}
              {fileLevel.map((annotation) => (
                <div key={annotation.id} className="review-item review-item-standalone">
                  <ThreadCard
                    annotation={annotation}
                    highlighted={false}
                    focusMode
                    onHover={noopHover}
                    onReply={onReplyThread}
                    onSetStatus={onSetThreadStatus}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

const ActivityPanel = memo(function ActivityPanel({
  overview,
}: {
  overview: ProjectOverview | null;
}) {
  const events = overview?.recentEvents ?? [];
  const recentEvents = events.slice(-20);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex items-center gap-2 bg-[var(--bg-1)] px-3 py-2.5 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">
          Activity
        </span>
        <span className="rounded-[4px] bg-[var(--bg-3)] px-[5px] py-px font-[var(--font-mono)] text-[10px] text-[var(--text-3)]">
          {events.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col">
        {recentEvents.map((event) => (
          <div
            key={event.id}
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-[var(--text-3)] transition-colors duration-100 hover:bg-[var(--bg-3)]"
          >
            <span
              className={cx(
                "shrink-0 rounded-[3px] px-[5px] py-px font-[var(--font-mono)] text-[10px]",
                activityToneByKind[event.kind] ??
                  "bg-[var(--bg-4)] text-[var(--text-2)]",
              )}
            >
              {event.kind === "file_diff"
                ? "diff"
                : event.kind === "session_status"
                  ? "session"
                  : event.kind}
            </span>
            <span className="flex-1 text-[var(--text-2)]">{event.source}</span>
            <span className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--text-3)]">
              {event.ts.slice(11, 19)}
            </span>
          </div>
        ))}
        {recentEvents.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-3)]">
            No events yet
          </div>
        )}
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export function App() {
  const [initialWorkspaceState] = useState<PersistedWorkspaceState | null>(() =>
    readInitialWorkspaceState(),
  );
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [projectPaths, setProjectPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const deferredSearchText = useDeferredValue(searchText);

  const [openTabs, setOpenTabs] = useState<string[]>(
    () => initialWorkspaceState?.openTabs ?? [],
  );
  const [activeTab, setActiveTab] = useState<string | null>(
    () => initialWorkspaceState?.activeTab ?? null,
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(initialWorkspaceState?.expandedDirs ?? []),
  );
  const [sidebarTab, setSidebarTab] = useState<"files" | "activity">(
    () => initialWorkspaceState?.sidebarTab ?? "files",
  );
  const [focusMode, setFocusMode] = useState(true);
  const [focusReviewTargetFile, setFocusReviewTargetFile] = useState<string | null>(null);
  const [focusReviewHoveredThreadId, setFocusReviewHoveredThreadId] = useState<string | null>(null);
  const [showResolvedThreads, setShowResolvedThreads] = useState(true);
  const [hasPersistedWorkspaceState, setHasPersistedWorkspaceState] = useState(
    () => initialWorkspaceState !== null,
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const hydratedWorkspaceStateKeyRef = useRef<string | null>(null);
  const overviewRequestRef = useRef<Promise<void> | null>(null);
  const overviewAbortRef = useRef<AbortController | null>(null);
  const overviewSnapshotKeyRef = useRef<string>("");
  const activeFileContentCacheRef = useRef<Map<string, string>>(new Map());
  const pageWorkspaceStateStorageKey = getPageWorkspaceStateStorageKey();
  const workspaceStateStorageKey = getWorkspaceStateStorageKey(
    overview?.session ?? null,
  );

  const loadOverview = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!force && overviewRequestRef.current) {
        return overviewRequestRef.current;
      }

      if (force) {
        overviewAbortRef.current?.abort();
      }

      const controller = new AbortController();
      overviewAbortRef.current = controller;

      let request: Promise<void> | null = null;
      request = (async () => {
        try {
          const next = await fetchOverview({ signal: controller.signal });
          const nextSnapshotKey = getOverviewSnapshotKey(next);

          if (nextSnapshotKey !== overviewSnapshotKeyRef.current) {
            overviewSnapshotKeyRef.current = nextSnapshotKey;
            startTransition(() => {
              setOverview(next);
            });
          }
          setError((current) => (current === null ? current : null));
        } catch (loadError) {
          if (controller.signal.aborted) {
            return;
          }

          const message =
            loadError instanceof Error ? loadError.message : String(loadError);
          setError((current) => (current === message ? current : message));
        } finally {
          if (overviewAbortRef.current === controller) {
            overviewAbortRef.current = null;
          }
          if (overviewRequestRef.current === request) {
            overviewRequestRef.current = null;
          }
        }
      })();

      overviewRequestRef.current = request;
      return request;
    },
    [],
  );

  const loadProjectTree = useCallback(
    async ({ signal }: { signal?: AbortSignal } = {}) => {
      try {
        const next = await fetchProjectTree({ signal });
        startTransition(() => {
          setProjectPaths((current) =>
            areStringArraysEqual(current, next) ? current : next,
          );
        });
        setError((current) => (current === null ? current : null));
      } catch (loadError) {
        if (signal?.aborted) {
          return;
        }

        const message =
          loadError instanceof Error ? loadError.message : String(loadError);
        setError((current) => (current === message ? current : message));
      }
    },
    [],
  );

  useEffect(() => {
    const projectTreeController = new AbortController();

    void loadProjectTree({ signal: projectTreeController.signal });
    void loadOverview({ force: true });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadOverview();
    }, OVERVIEW_POLL_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadOverview({ force: true });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      projectTreeController.abort();
      overviewAbortRef.current?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [loadOverview, loadProjectTree]);

  useEffect(() => {
    const query = deferredSearchText.trim();

    if (!query) {
      setSearchResults((current) => (current.length === 0 ? current : []));
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void searchCanary(query, { signal: controller.signal })
        .then((results) => {
          if (!controller.signal.aborted) {
            startTransition(() => {
              setSearchResults(results);
            });
          }
        })
        .catch(() => {
          // Ignore search failures so the rest of the UI stays responsive.
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [deferredSearchText]);

  // Keyboard shortcut: Cmd+P / Ctrl+P for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!workspaceStateStorageKey) {
      hydratedWorkspaceStateKeyRef.current = null;
      return;
    }

    if (hydratedWorkspaceStateKeyRef.current === workspaceStateStorageKey) {
      return;
    }

    const restored = readPersistedWorkspaceState(workspaceStateStorageKey);
    if (restored) {
      setOpenTabs(restored.openTabs);
      setActiveTab(restored.activeTab);
      setExpandedDirs(new Set(restored.expandedDirs));
      setSidebarTab(restored.sidebarTab);
      setHasPersistedWorkspaceState(true);
    }

    hydratedWorkspaceStateKeyRef.current = workspaceStateStorageKey;
  }, [workspaceStateStorageKey]);

  useEffect(() => {
    const state = {
      openTabs,
      activeTab: activeTab && openTabs.includes(activeTab) ? activeTab : null,
      expandedDirs: [...expandedDirs],
      sidebarTab,
    };

    if (pageWorkspaceStateStorageKey) {
      writePersistedWorkspaceState(pageWorkspaceStateStorageKey, state);
    }

    if (workspaceStateStorageKey) {
      writePersistedWorkspaceState(workspaceStateStorageKey, state);
    }
  }, [
    activeTab,
    expandedDirs,
    openTabs,
    pageWorkspaceStateStorageKey,
    sidebarTab,
    workspaceStateStorageKey,
  ]);

  const openFile = useCallback((filePath: string) => {
    setOpenTabs((prev) =>
      prev.includes(filePath) ? prev : [...prev, filePath],
    );
    setActiveTab(filePath);
  }, []);

  const syncFocusReviewFile = useCallback((filePath: string) => {
    setActiveTab((current) => (current === filePath ? current : filePath));
  }, []);

  const handleReplyThread = useCallback(
    async (threadId: string, body: string) => {
      await replyToThread(threadId, body);
      await loadOverview({ force: true });
    },
    [loadOverview],
  );

  const handleSetThreadStatus = useCallback(
    async (threadId: string, status: "open" | "resolved") => {
      await setThreadStatus(threadId, status);
      await loadOverview({ force: true });
    },
    [loadOverview],
  );

  const closeTab = useCallback(
    (filePath: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setOpenTabs((prev) => prev.filter((t) => t !== filePath));
      if (activeTab === filePath) {
        const idx = openTabs.indexOf(filePath);
        const next = openTabs[idx - 1] ?? openTabs[idx + 1] ?? null;
        setActiveTab(next);
      }
    },
    [activeTab, openTabs],
  );

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allKnownPaths = useMemo(() => {
    const paths = new Set(projectPaths);

    for (const file of overview?.changedFiles ?? []) {
      paths.add(file.filePath);
    }
    for (const thread of overview?.threads ?? []) {
      if (thread.filePath) {
        paths.add(thread.filePath);
      }
    }
    for (const brief of overview?.fileBriefs ?? []) {
      paths.add(brief.filePath);
    }

    return [...paths].sort((left, right) => left.localeCompare(right));
  }, [overview, projectPaths]);

  const fileTree = useMemo(
    () =>
      buildFileTree(
        allKnownPaths,
        overview?.changedFiles ?? [],
        overview?.threads ?? [],
        overview?.fileBriefs ?? [],
      ),
    [allKnownPaths, overview],
  );

  const visibleFileTreeRows = useMemo(
    () => flattenVisibleTree(fileTree, expandedDirs),
    [expandedDirs, fileTree],
  );

  // Auto-expand top-level dirs
  useEffect(() => {
    if (
      !hasPersistedWorkspaceState &&
      fileTree.length > 0 &&
      expandedDirs.size === 0
    ) {
      const topDirs = fileTree
        .filter((n) => !n.isFile && n.hasReviewSignal)
        .map((n) => n.path);
      if (topDirs.length > 0) {
        setExpandedDirs(new Set(topDirs));
      }
    }
  }, [expandedDirs.size, fileTree, hasPersistedWorkspaceState]);

  const preferredFile = useMemo(() => {
    if (!overview || allKnownPaths.length === 0) {
      return allKnownPaths[0] ?? null;
    }

    const changedFiles = new Set(overview.changedFiles.map((file) => file.filePath));
    const openThreadFiles = new Set(
      overview.threads
        .filter((thread) => thread.status === "open" && thread.filePath)
        .map((thread) => thread.filePath!),
    );
    const briefFiles = new Set(overview.fileBriefs.map((brief) => brief.filePath));

    return [...allKnownPaths].sort((left, right) => {
      const score = (filePath: string) =>
        (changedFiles.has(filePath) ? 4 : 0) +
        (openThreadFiles.has(filePath) ? 2 : 0) +
        (briefFiles.has(filePath) ? 1 : 0);
      return score(right) - score(left) || left.localeCompare(right);
    })[0] ?? null;
  }, [allKnownPaths, overview]);

  useEffect(() => {
    if (activeTab || openTabs.length > 0 || !preferredFile) {
      return;
    }

    setOpenTabs([preferredFile]);
    setActiveTab(preferredFile);
  }, [activeTab, openTabs.length, preferredFile]);

  useEffect(() => {
    if (focusMode || !activeTab) {
      return;
    }

    setOpenTabs((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab, focusMode]);

  const stats = useMemo(() => {
    if (!overview) {
      return {
        files: 0,
        briefs: 0,
        threads: 0,
      };
    }

    const openThreads = overview.threads.filter(
      (t) => t.status === "open",
    ).length;
    return {
      files: overview.changedFiles.length,
      briefs: overview.fileBriefs.length,
      threads: openThreads,
    };
  }, [overview]);

  const changedFilesByPath = useMemo(() => {
    const files = new Map<string, ChangedFileSummary>();
    for (const file of overview?.changedFiles ?? []) {
      files.set(file.filePath, file);
    }
    return files;
  }, [overview?.changedFiles]);

  const fileBriefsByPath = useMemo(() => {
    const briefs = new Map<string, FileBriefRecord>();
    for (const brief of overview?.fileBriefs ?? []) {
      briefs.set(brief.filePath, brief);
    }
    return briefs;
  }, [overview?.fileBriefs]);

  const annotationsByFile = useMemo(
    () => buildAnnotationsByFile(overview?.threads ?? []),
    [overview?.threads],
  );

  const visibleAnnotationsByFile = useMemo(() => {
    const visible = new Map<string, FileAnnotation[]>();

    for (const [filePath, annotations] of annotationsByFile) {
      const nextAnnotations = showResolvedThreads
        ? annotations
        : annotations.filter((annotation) => annotation.status !== "resolved");

      if (nextAnnotations.length > 0) {
        visible.set(filePath, nextAnnotations);
      }
    }

    return visible;
  }, [annotationsByFile, showResolvedThreads]);

  const reviewSections = useMemo(() => {
    const pathOrder = new Map(
      allKnownPaths.map((filePath, index) => [filePath, index] as const),
    );

    return [...visibleAnnotationsByFile.entries()]
      .map(([filePath, annotations]) => {
        const openThreads = annotations.filter(
          (annotation) => annotation.status !== "resolved",
        ).length;
        const change = changedFilesByPath.get(filePath) ?? null;
        const brief = fileBriefsByPath.get(filePath) ?? null;

        return {
          filePath,
          annotations,
          brief,
          change,
          totalThreads: annotations.length,
          openThreads,
        } satisfies ReviewSection;
      })
      .sort((left, right) => {
        const score = (section: ReviewSection) =>
          section.openThreads * 100 +
          section.totalThreads * 10 +
          (section.change ? 3 : 0) +
          (section.brief ? 1 : 0);

        return (
          score(right) - score(left) ||
          (pathOrder.get(left.filePath) ?? Number.MAX_SAFE_INTEGER) -
            (pathOrder.get(right.filePath) ?? Number.MAX_SAFE_INTEGER) ||
          left.filePath.localeCompare(right.filePath)
        );
      });
  }, [allKnownPaths, changedFilesByPath, fileBriefsByPath, visibleAnnotationsByFile]);
  const reviewSectionFilePaths = useMemo(
    () => new Set(reviewSections.map((section) => section.filePath)),
    [reviewSections],
  );

  useEffect(() => {
    if (!focusMode) {
      setFocusReviewHoveredThreadId(null);
      setFocusReviewTargetFile(null);
      return;
    }

    const firstReviewFile = reviewSections[0]?.filePath ?? null;
    if (!firstReviewFile) {
      return;
    }

    const isReviewFile = reviewSections.some(
      (section) => section.filePath === activeTab,
    );

    if (!activeTab || !isReviewFile) {
      setActiveTab(firstReviewFile);
    }
  }, [activeTab, focusMode, reviewSections]);

  const handleSelectFile = useCallback(
    (filePath: string) => {
      const isReviewFile = reviewSectionFilePaths.has(filePath);

      openFile(filePath);

      if (!focusMode) {
        return;
      }

      if (isReviewFile) {
        setFocusReviewTargetFile(filePath);
        return;
      }

      setFocusMode(false);
    },
    [focusMode, openFile, reviewSectionFilePaths],
  );

  const handleFocusModeToggle = useCallback(() => {
    if (focusMode) {
      setFocusMode(false);
      return;
    }

    const nextReviewTarget =
      (activeTab && reviewSectionFilePaths.has(activeTab) ? activeTab : null) ??
      reviewSections[0]?.filePath ??
      null;

    if (nextReviewTarget) {
      setFocusReviewTargetFile(nextReviewTarget);
    }

    setFocusMode(true);
  }, [activeTab, focusMode, reviewSectionFilePaths, reviewSections]);

  const activeFileChange = useMemo(() => {
    if (!activeTab) {
      return null;
    }

    return changedFilesByPath.get(activeTab) ?? null;
  }, [activeTab, changedFilesByPath]);

  const { fileContent: activeFileContent, fileContentLoading: activeFileContentLoading, fileContentError: activeFileContentError } =
    useFileContentState({
      filePath: activeTab,
      change: activeFileChange,
      cacheRef: activeFileContentCacheRef,
      enabled: activeTab !== null,
    });

  const activeFilePatch = useMemo(() => {
    return activeFileChange?.patch ?? null;
  }, [activeFileChange]);

  const activeFileAnnotations = useMemo(() => {
    if (!activeTab) {
      return EMPTY_FILE_ANNOTATIONS;
    }

    return annotationsByFile.get(activeTab) ?? EMPTY_FILE_ANNOTATIONS;
  }, [activeTab, annotationsByFile]);

  const visibleFileAnnotations = useMemo(
    () =>
      showResolvedThreads
        ? activeFileAnnotations
        : activeFileAnnotations.filter((annotation) => annotation.status !== "resolved"),
    [activeFileAnnotations, showResolvedThreads],
  );

  const activeFileBrief = useMemo(() => {
    if (!activeTab) return null;
    return fileBriefsByPath.get(activeTab) ?? null;
  }, [activeTab, fileBriefsByPath]);

  const activeVisibleThreadCount = showResolvedThreads
    ? activeFileAnnotations.length
    : visibleFileAnnotations.length;
  const isSearching = deferredSearchText.trim().length > 0;
  const shouldShowFocusReview = focusMode && !isSearching;

  return (
    <div className="grid h-full overflow-hidden [grid-template-rows:44px_minmax(0,1fr)_26px]">
      <header
        className="grid h-[44px] select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-1)] px-3.5"
        style={dragRegionStyle}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-[var(--bg-3)] text-[13px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
              aria-hidden="true"
            >
              🐤
            </span>
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-2)]">
              canary
            </span>
          </div>
          {overview?.session && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
              <StatusDot status={overview.session.status} />
              <span className="font-medium text-[var(--text-2)]">
                {overview.session.actorName ?? overview.session.agentKind}
              </span>
              <span>{overview.session.status}</span>
            </div>
          )}
        </div>
        <div className="flex justify-center" style={noDragRegionStyle}>
          <div className="flex h-7 w-[320px] items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--bg-3)] px-2.5 transition-colors duration-150 focus-within:border-[var(--border-active)] focus-within:bg-[var(--bg-4)] max-[768px]:w-[200px]">
            <span className="flex shrink-0 text-[var(--text-3)]">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="6.5"
                  cy="6.5"
                  r="5.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M10.5 10.5L15 15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search review artifacts..."
              className="min-w-0 flex-1 text-[12px] text-[var(--text-1)] placeholder:text-[var(--text-3)]"
            />
            <kbd className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--bg-2)] px-[5px] py-px text-[10px] leading-[1.4] text-[var(--text-3)]">
              {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}P
            </kbd>
          </div>
        </div>
        <div
          className="flex items-center justify-end gap-2.5 max-[768px]:hidden max-[960px]:gap-1.5"
          style={noDragRegionStyle}
        >
          <button
            className={cx(
              "inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 pl-1.5 text-[var(--text-2)] transition-colors duration-150",
              focusMode
                ? "border-[var(--teal-border)] bg-[var(--teal-muted)] text-[var(--teal-text)]"
                : "border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--border-active)] hover:text-[var(--text-1)]",
            )}
            type="button"
            aria-pressed={focusMode}
            onClick={handleFocusModeToggle}
          >
            <span
              className={cx(
                "relative h-4 w-7 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors duration-150",
                focusMode ? "bg-[var(--teal-strong)]" : "bg-[var(--bg-4)]",
              )}
              aria-hidden="true"
            >
              <span
                className={cx(
                  "absolute top-0.5 left-0.5 h-3 w-3 rounded-full transition-[transform,background-color] duration-150",
                  focusMode
                    ? "translate-x-3 bg-[var(--teal)]"
                    : "bg-[var(--text-3)]",
                )}
              />
            </span>
            Focus mode
          </button>
          <div className="flex items-center gap-1">
            <span className="rounded-[4px] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
              <span className="mr-0.5 font-semibold text-[var(--text-2)]">
                {stats.files}
              </span>{" "}
              files
            </span>
            <span className="rounded-[4px] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
              <span className="mr-0.5 font-semibold text-[var(--green)]">
                {stats.briefs}
              </span>{" "}
              briefs
            </span>
            <span className="rounded-[4px] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
              <span className="mr-0.5 font-semibold text-[var(--accent-text)]">
                {stats.threads}
              </span>{" "}
              threads
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="border-b border-[var(--red-edge)] bg-[var(--red-muted)] px-3.5 py-1.5 text-[12px] text-[var(--red)]">
          {error}
        </div>
      )}

      <div className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)] overflow-hidden">
        <aside className="grid w-[260px] overflow-hidden border-r border-[var(--border)] bg-[var(--bg-1)] [grid-template-columns:40px_minmax(0,1fr)] max-[768px]:w-[200px]">
          <div className="flex flex-col items-center gap-0.5 border-r border-[var(--border)] bg-[var(--bg-0)] pt-2">
            <button
              className={cx(
                "flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors duration-150",
                sidebarTab === "files"
                  ? "bg-[var(--bg-3)] text-[var(--text-1)]"
                  : "hover:bg-[var(--bg-3)] hover:text-[var(--text-2)]",
              )}
              onClick={() => setSidebarTab("files")}
              title="Explorer"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <path
                  d="M1.5 1.5h5l1.5 2H14.5v11h-13z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className={cx(
                "flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-3)] transition-colors duration-150",
                sidebarTab === "activity"
                  ? "bg-[var(--bg-3)] text-[var(--text-1)]"
                  : "hover:bg-[var(--bg-3)] hover:text-[var(--text-2)]",
              )}
              onClick={() => setSidebarTab("activity")}
              title="Activity"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <polyline
                  points="1,8 4,8 6,3 8,13 10,6 12,8 15,8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>

          <div className="sidebar-content flex min-h-0 overflow-hidden">
            {sidebarTab === "files" ? (
              <div className="flex h-full min-h-0 flex-1 flex-col">
                <div className="shrink-0 bg-[var(--bg-1)] px-3 py-2.5 pb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">
                    Repository
                  </span>
                </div>
                {fileTree.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-4 py-6 text-center text-[12px] text-[var(--text-3)]">
                    <span>Loading repository...</span>
                  </div>
                ) : (
                  <FileTreeList
                    rows={visibleFileTreeRows}
                    activeFile={activeTab}
                    onToggle={toggleDir}
                    onSelect={handleSelectFile}
                  />
                )}
              </div>
            ) : (
              <ActivityPanel overview={overview} />
            )}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden bg-[var(--bg-2)]">
          {isSearching && searchResults.length > 0 ? (
            <SearchResultsList
              results={searchResults}
              onSelectFile={handleSelectFile}
            />
          ) : (
            <>
              {!shouldShowFocusReview && openTabs.length > 0 && (
                <div className="tab-bar flex h-[36px] shrink-0 overflow-x-auto overflow-y-hidden border-b border-[var(--border)] bg-[var(--bg-1)]">
                  {openTabs.map((tab) => {
                    const name = tab.split("/").pop() ?? tab;
                    const change = changedFilesByPath.get(tab);
                    return (
                      <button
                        key={tab}
                        className={cx(
                          "group flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-[var(--border)] px-3.5 text-[12px] transition-colors duration-100",
                          activeTab === tab
                            ? "border-b-2 border-b-[var(--accent)] bg-[var(--bg-2)] text-[var(--text-1)]"
                            : "text-[var(--text-3)] hover:bg-[var(--bg-2)] hover:text-[var(--text-2)]",
                        )}
                        onClick={() => openFile(tab)}
                      >
                        <span className={fileBadgeClass(name)}>
                          {fileIcon(name, true)}
                        </span>
                        <span className="font-medium">{name}</span>
                        {change && (
                          <span
                            className={cx(
                              "font-[var(--font-mono)] text-[10px] font-semibold",
                              changeToneByType[change.eventType],
                            )}
                          >
                            {change.eventType === "add"
                              ? "A"
                              : change.eventType === "unlink"
                                ? "D"
                                : "M"}
                          </span>
                        )}
                        <span
                          className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] opacity-0 transition-[opacity,background-color,color] duration-100 group-hover:opacity-100 hover:bg-[var(--bg-4)] hover:text-[var(--text-1)]"
                          onClick={(e) => closeTab(tab, e)}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                          >
                            <path
                              d="M3 3l6 6M9 3l-6 6"
                              stroke="currentColor"
                              strokeWidth="1.2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {shouldShowFocusReview ? (
                <FocusReviewStream
                  sections={reviewSections}
                  activeFile={activeTab}
                  requestedFilePath={focusReviewTargetFile}
                  onRequestedFileHandled={() => setFocusReviewTargetFile(null)}
                  onSelectFile={handleSelectFile}
                  onSyncActiveFile={syncFocusReviewFile}
                  onReplyThread={handleReplyThread}
                  onSetThreadStatus={handleSetThreadStatus}
                  cacheRef={activeFileContentCacheRef}
                />
              ) : activeTab ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-2)] px-4 py-1.5">
                    <div className="min-w-0">
                      <span className="truncate whitespace-nowrap font-[var(--font-mono)] text-[12px] text-[var(--text-3)]">
                        {activeTab}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      {activeFileChange && (
                        <span className="flex gap-1.5 font-[var(--font-mono)] text-[11px]">
                          <span className="text-[var(--green)]">
                            +{activeFileChange.added}
                          </span>
                          <span className="text-[var(--red)]">
                            -{activeFileChange.removed}
                          </span>
                        </span>
                      )}
                      {activeFileAnnotations.length > 0 && (
                        <span className="rounded-[4px] bg-[var(--accent-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent-text)]">
                          {activeVisibleThreadCount} thread
                          {activeVisibleThreadCount !== 1 ? "s" : ""}
                          {showResolvedThreads ? "" : " open"}
                        </span>
                      )}
                      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-[var(--border)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--text-3)] transition-colors duration-150 hover:border-[var(--border-hover)] hover:text-[var(--text-2)]">
                        <input
                          type="checkbox"
                          checked={showResolvedThreads}
                          onChange={(event) =>
                            setShowResolvedThreads(event.target.checked)
                          }
                          style={{ accentColor: "var(--teal)" }}
                          className="h-3.5 w-3.5 cursor-pointer"
                        />
                        Show resolved
                      </label>
                    </div>
                  </div>

                  <CodeView
                    filePath={activeTab}
                    patch={activeFilePatch}
                    fileBrief={activeFileBrief}
                    fileContent={activeFileContent}
                    fileContentLoading={activeFileContentLoading}
                    fileContentError={activeFileContentError}
                    annotations={visibleFileAnnotations}
                    focusMode={focusMode}
                    onReplyThread={handleReplyThread}
                    onSetThreadStatus={handleSetThreadStatus}
                  />
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <div className="max-w-[440px] px-8 py-8 text-center">
                    <h1 className="mb-2 text-[36px] font-semibold tracking-[-0.04em] text-[var(--text-1)]">
                      canary
                    </h1>
                    <p className="mb-8 text-[14px] text-[var(--text-3)]">
                      Inspect the repository, current-run diffs, file briefs,
                      and review threads across runs.
                    </p>
                    <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-3)] px-2 py-3.5">
                        <span className="font-[var(--font-mono)] text-[24px] font-semibold text-[var(--text-1)]">
                          {stats.files}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
                          Changed Files
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-3)] px-2 py-3.5">
                        <span className="font-[var(--font-mono)] text-[24px] font-semibold text-[var(--text-1)]">
                          {stats.briefs}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
                          File Briefs
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--bg-3)] px-2 py-3.5">
                        <span className="font-[var(--font-mono)] text-[24px] font-semibold text-[var(--text-1)]">
                          {stats.threads}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3)]">
                          Open Threads
                        </span>
                      </div>
                    </div>
                    <p className="text-[12px] text-[var(--text-3)]">
                      Select a file from the repository tree to begin
                      reviewing.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <footer className="flex h-[26px] items-center justify-between border-t border-[var(--border)] bg-[var(--bg-1)] px-3 text-[11px] text-[var(--text-3)]">
        <div className="flex items-center gap-2">
          {overview?.session && (
            <>
              <StatusDot status={overview.session.status} />
              <span>
                {(overview.session.actorName ?? overview.session.agentKind)} session {overview.session.status}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeTab && <span>{activeTab}</span>}
          <span>canary</span>
        </div>
      </footer>
    </div>
  );
}
