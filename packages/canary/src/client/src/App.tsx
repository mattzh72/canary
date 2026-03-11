import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
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
} from "canary-core";
import {
  fetchOverview,
  replyToThread,
  fetchFileContent,
  searchCanary,
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
  changeType?: "add" | "change" | "unlink";
}

interface AnnotationIndicator {
  type: "thread";
  category?: ThreadRecord["type"];
  count: number;
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
  createdAt: string;
  messages?: { id: string; author: string; body: string; createdAt: string }[];
}

interface PersistedWorkspaceState {
  openTabs: string[];
  activeTab: string | null;
  expandedDirs: string[];
  sidebarTab: "files" | "activity";
}

const WORKSPACE_STATE_STORAGE_PREFIX = "canary.ui.workspace";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function RichTextBody({
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
}

function buildFileTree(
  changedFiles: ChangedFileSummary[],
  threads: ThreadRecord[],
): TreeNode[] {
  const fileMap = new Map<
    string,
    {
      changeType?: ChangedFileSummary["eventType"];
      indicators: Map<string, AnnotationIndicator>;
    }
  >();

  const ensureFile = (fp: string) => {
    if (!fileMap.has(fp)) {
      fileMap.set(fp, { indicators: new Map() });
    }
    return fileMap.get(fp)!;
  };

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
          };
          dirNodes.set(dirPath, dirNode);
          current.push(dirNode);
        }
        current = dirNode!.children;
      }
    }
  }

  return root;
}

function getAnnotationsForFile(
  filePath: string,
  threads: ThreadRecord[],
): FileAnnotation[] {
  const annotations: FileAnnotation[] = [];

  for (const t of threads) {
    if (t.filePath !== filePath) continue;
    annotations.push({
      id: t.id,
      type: "thread",
      title: t.title,
      body: "",
      startLine: t.startLine,
      endLine: t.endLine,
      lineSide: t.lineSide,
      category: t.type,
      status: t.status,
      freshness: t.freshness,
      author: t.author,
      createdAt: t.createdAt,
      messages: t.messages.map((msg) => ({
        id: msg.id,
        author: msg.author,
        body: msg.body,
        createdAt: msg.createdAt,
      })),
    });
  }

  return annotations.sort(
    (a, b) => (a.startLine ?? Infinity) - (b.startLine ?? Infinity),
  );
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
  if (normalizedCategory === "scope_change") return "#49b675";
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
      restBorderClass: "border-[var(--thread-edge-high)]",
      hoverBorderClass: "hover:border-[var(--thread-edge-high)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--thread-edge-high),0_24px_56px_-32px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--thread-edge-high)] shadow-[0_0_0_1px_var(--thread-edge-high),0_24px_56px_-32px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--thread-rail-high)] before:bg-[var(--thread-rail-high)] before:shadow-[0_0_0_4px_var(--thread-glow-high)]",
      lineHighlightClass: "bg-[var(--thread-line-high)]",
      lineAccentClass: "bg-[var(--thread-rail-high)]",
      surfaceClass: "var(--thread-surface-high)",
      connectorColor: "#ff4242",
      connectorGlow: "var(--thread-glow-high)",
    };
  }

  if (normalizedCategory === "question") {
    return {
      restBorderClass: "border-[var(--thread-edge-medium)]",
      hoverBorderClass: "hover:border-[var(--thread-edge-medium)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--thread-edge-medium),0_24px_56px_-32px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--thread-edge-medium)] shadow-[0_0_0_1px_var(--thread-edge-medium),0_24px_56px_-32px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--thread-rail-medium)] before:bg-[var(--thread-rail-medium)] before:shadow-[0_0_0_4px_var(--thread-glow-medium)]",
      lineHighlightClass: "bg-[var(--thread-line-medium)]",
      lineAccentClass: "bg-[var(--thread-rail-medium)]",
      surfaceClass: "var(--thread-surface-medium)",
      connectorColor: "#ffd84d",
      connectorGlow: "var(--thread-glow-medium)",
    };
  }

  if (normalizedCategory === "scope_change") {
    return {
      restBorderClass: "border-[#49b675]",
      hoverBorderClass: "hover:border-[#49b675]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_#49b675,0_24px_56px_-32px_rgba(73,182,117,0.28)]",
      highlightedCardClass:
        "border-[#49b675] shadow-[0_0_0_1px_#49b675,0_24px_56px_-32px_rgba(73,182,117,0.28)]",
      connectorClass:
        "border-t-[#49b675] before:bg-[#49b675] before:shadow-[0_0_0_4px_rgba(73,182,117,0.18)]",
      lineHighlightClass: "bg-[rgba(73,182,117,0.14)]",
      lineAccentClass: "bg-[#49b675]",
      surfaceClass: "rgba(73, 182, 117, 0.1)",
      connectorColor: "#49b675",
      connectorGlow: "rgba(73, 182, 117, 0.18)",
    };
  }

  if (normalizedCategory === "decision") {
    return {
      restBorderClass: "border-[var(--thread-edge-low)]",
      hoverBorderClass: "hover:border-[var(--thread-edge-low)]",
      hoverShadowClass:
        "hover:shadow-[0_0_0_1px_var(--thread-edge-low),0_24px_56px_-32px_var(--thread-shadow)]",
      highlightedCardClass:
        "border-[var(--thread-edge-low)] shadow-[0_0_0_1px_var(--thread-edge-low),0_24px_56px_-32px_var(--thread-shadow)]",
      connectorClass:
        "border-t-[var(--thread-rail-low)] before:bg-[var(--thread-rail-low)] before:shadow-[0_0_0_4px_var(--thread-glow-low)]",
      lineHighlightClass: "bg-[var(--thread-line-low)]",
      lineAccentClass: "bg-[var(--thread-rail-low)]",
      surfaceClass: "var(--thread-surface-low)",
      connectorColor: "#69b3ff",
      connectorGlow: "var(--thread-glow-low)",
    };
  }

  return {
    hoverBorderClass: "hover:border-[var(--thread-edge-low)]",
    hoverShadowClass:
      "hover:shadow-[0_0_0_1px_var(--thread-edge-low),0_24px_56px_-32px_var(--thread-shadow)]",
    highlightedCardClass:
      "border-[var(--thread-edge-low)] shadow-[0_0_0_1px_var(--thread-edge-low),0_24px_56px_-32px_var(--thread-shadow)]",
    connectorClass:
      "border-t-[var(--thread-rail-low)] before:bg-[var(--thread-rail-low)] before:shadow-[0_0_0_4px_var(--thread-glow-low)]",
    lineHighlightClass: "bg-[var(--thread-line-low)]",
    lineAccentClass: "bg-[var(--thread-rail-low)]",
    surfaceClass: "var(--thread-bg)",
    connectorColor: "#69b3ff",
    connectorGlow: "var(--thread-glow-low)",
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
  ts: "bg-[rgba(49,120,198,0.2)] text-[#6db3f2]",
  tsx: "bg-[rgba(49,120,198,0.2)] text-[#6db3f2]",
  js: "bg-[rgba(240,200,57,0.15)] text-[#f0c839]",
  jsx: "bg-[rgba(240,200,57,0.15)] text-[#f0c839]",
  css: "bg-[rgba(86,156,214,0.15)] text-[#569cd6]",
  json: "bg-[rgba(150,150,150,0.12)] text-[#999999]",
  md: "bg-[rgba(91,156,245,0.12)] text-[#5b9cf5]",
  sql: "bg-[rgba(255,140,56,0.15)] text-[#ff8c38]",
  py: "bg-[rgba(79,139,201,0.15)] text-[#4f8bc9]",
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

function FileBriefHeader({ brief }: { brief: FileBriefRecord }) {
  const isOutdated = brief.freshness === "outdated";
  return (
    <section
      className={cx(
        "border-b px-6 py-5 font-[var(--font-sans)]",
        isOutdated
          ? "border-[rgba(255,184,77,0.16)] bg-[linear-gradient(180deg,rgba(255,184,77,0.14),rgba(255,184,77,0.05))]"
          : "border-[rgba(91,156,245,0.16)] bg-[linear-gradient(180deg,rgba(91,156,245,0.14),rgba(91,156,245,0.05))]"
      )}
    >
      <div className="flex max-w-[78ch] flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cx(
              "inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]",
              isOutdated
                ? "border-[rgba(255,184,77,0.24)] bg-[rgba(255,184,77,0.12)] text-[var(--amber)]"
                : "border-[rgba(91,156,245,0.24)] bg-[rgba(91,156,245,0.12)] text-[var(--blue)]"
            )}
          >
            File Brief
          </span>
          {isOutdated && (
            <span className="inline-flex w-fit items-center rounded-full border border-[rgba(255,184,77,0.24)] bg-[rgba(255,184,77,0.12)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--amber)]">
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
                ? "border-[rgba(255,184,77,0.10)]"
                : "border-[rgba(91,156,245,0.10)]"
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
}

function FileTreeItem({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
  activeFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  activeFile: string | null;
}) {
  const isOpen = expanded.has(node.path);
  const isActive = activeFile === node.path;

  return (
    <>
      <button
        className={cx(
          "flex h-[26px] w-full items-center gap-1.5 pr-2.5 text-left text-[12px] text-[var(--text-2)] transition-colors duration-100",
          "hover:bg-[var(--bg-3)]",
          isActive && "bg-[var(--accent-muted)] text-[var(--text-1)]",
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
      {!node.isFile && isOpen
        ? node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              activeFile={activeFile}
            />
          ))
        : null}
    </>
  );
}

function hasActiveLineAnchor(annotation: FileAnnotation): boolean {
  return (
    annotation.freshness === "active" &&
    annotation.startLine !== null &&
    annotation.endLine !== null
  );
}

function ThreadCard({
  annotation,
  highlighted,
  focusMode,
  onHover,
  onReply,
}: {
  annotation: FileAnnotation;
  highlighted: boolean;
  focusMode: boolean;
  onHover: (id: string | null) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isReplying, setIsReplying] = useState(false);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const allMessages: { id: string; author: string; body: string; createdAt: string }[] = [];
  const isThread = annotation.type === "thread";

  if (annotation.body) {
    allMessages.push({
      id: `${annotation.id}-root`,
      author: annotation.author,
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
  const isBusy = isReplying;
  const isResolved = annotation.status === "resolved";
  const isResolvedCollapsed = isThread && isResolved && !resolvedExpanded;
  const showConversation = !isResolved || resolvedExpanded;
  const tone = threadTone(annotation.category);

  useEffect(() => {
    if (annotation.status === "resolved") {
      setResolvedExpanded(false);
      return;
    }

    setResolvedExpanded(false);
  }, [annotation.id, annotation.status]);

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
            ? "border-[var(--thread-highlight-border)] shadow-[0_0_0_1px_rgba(107,188,167,0.18),0_24px_56px_-32px_var(--thread-shadow)]"
            : focusMode
              ? "border-[var(--thread-highlight-border)] shadow-[0_0_0_1px_rgba(107,188,167,0.12),0_18px_40px_-28px_var(--thread-shadow)]"
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
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(61,214,140,0.14)] text-[#9ff0c3]">
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
            <button
              type="button"
              className="shrink-0 text-[11px] font-medium text-[var(--thread-text-3)] transition-colors duration-150 hover:text-[var(--thread-text-1)]"
              onClick={() => setResolvedExpanded(true)}
            >
              View
            </button>
          </div>
          {error && (
            <div className="border-t border-[var(--thread-border)] px-3.5 py-2">
              <p className="m-0 text-[12px] leading-[1.5] text-[#ffb2b2]">
                {error}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          {/* Header */}
          <div className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {annotation.category ? (
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--thread-text-3)]">
                    {formatLabel(annotation.category)}
                  </span>
                ) : (
                  <span />
                )}
                {isOutdated && (
                  <span className="rounded-full border border-[rgba(255,184,77,0.24)] bg-[rgba(255,184,77,0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--amber)]">
                    Outdated
                  </span>
                )}
              </div>
            </div>
              <h3 className="m-0 line-clamp-2 text-[13px] leading-[1.4] font-semibold tracking-[-0.01em] text-[var(--thread-text-1)]">
              {annotation.title}
              </h3>
            </div>

          {/* Opener message */}
          {showConversation && openerMessage && (
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={cx(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                    openerMessage.author === "agent"
                      ? "bg-[rgba(124,106,239,0.2)] text-[var(--accent-text)]"
                      : "bg-[rgba(107,188,167,0.2)] text-[var(--thread-highlight-text)]",
                  )}
                >
                  {openerMessage.author.charAt(0).toUpperCase()}
                </span>
                <span className="text-[12px] font-medium text-white">
                  {openerMessage.author}
                </span>
                <span className="text-[var(--thread-text-3)]">•</span>
                <span className="text-[11px] text-[var(--thread-text-3)]">
                  {timeAgo(annotation.createdAt)}
                </span>
              </div>
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
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cx(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                            msg.author === "agent"
                              ? "bg-[rgba(124,106,239,0.2)] text-[var(--accent-text)]"
                              : "bg-[rgba(107,188,167,0.2)] text-[var(--thread-highlight-text)]",
                          )}
                        >
                          {msg.author.charAt(0).toUpperCase()}
                        </span>
                        <span className="text-[12px] font-medium text-white">
                          {msg.author}
                        </span>
                        <span className="text-[var(--thread-text-3)]">•</span>
                        <span className="text-[11px] text-[var(--thread-text-3)]">
                          {timeAgo(msg.createdAt)}
                        </span>
                      </div>
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
                <div className="flex items-center gap-1.5">
                  <span
                    className={cx(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                      lastReply.author === "agent"
                        ? "bg-[rgba(124,106,239,0.2)] text-[var(--accent-text)]"
                        : "bg-[rgba(107,188,167,0.2)] text-[var(--thread-highlight-text)]",
                    )}
                  >
                    {lastReply.author.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-[12px] font-medium text-white">
                    {lastReply.author}
                  </span>
                  <span className="text-[var(--thread-text-3)]">•</span>
                  <span className="text-[11px] text-[var(--thread-text-3)]">
                    {timeAgo(lastReply.createdAt)}
                  </span>
                </div>
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
                <p className="m-0 text-[12px] leading-[1.5] text-[#ffb2b2]">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
    setPositions(result);
    setGutterHeight(Math.max(0, Math.ceil(maxBottom + bottomPadding)));
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

function ThreadsPanel({
  annotations,
  highlightedThread,
  focusMode,
  onHoverThread,
  onReplyThread,
  positions,
  gutterHeight,
}: {
  annotations: FileAnnotation[];
  highlightedThread: string | null;
  focusMode: boolean;
  onHoverThread: (id: string | null) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
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
            />
          </div>
        );
      })}
    </div>
  );
}

function CodeView({
  filePath,
  patch,
  fileBrief,
  fileContent,
  fileContentLoading,
  fileContentError,
  annotations,
  focusMode,
  onReplyThread,
}: {
  filePath: string;
  patch: string | null;
  fileBrief: FileBriefRecord | null;
  fileContent: string | null;
  fileContentLoading: boolean;
  fileContentError: string | null;
  annotations: FileAnnotation[];
  focusMode: boolean;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const pendingInitialFocusScrollFileRef = useRef<string | null>(null);
  const activeThreadId = hoveredThread;
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
    pendingInitialFocusScrollFileRef.current = focusMode ? filePath : null;
  }, [filePath, focusMode]);

  const handleHoverThread = useCallback((id: string | null) => {
    setHoveredThread(id);
  }, []);

  const renderKey = `${filePath}:${patch?.length ?? ""}:${annotations.length}`;
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

    const target = container.querySelector<HTMLElement>(
      `[data-thread-id="${firstThread.id}"]`,
    );
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
  }, [annotations, filePath, positions]);

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
        hasLineAnnotations={hasLineAnnotations}
        hasThreadAnnotations={hasThreadAnnotations}
        onHoverThread={handleHoverThread}
        onReplyThread={onReplyThread}
        positions={positions}
        gutterHeight={gutterHeight}
      />
    );
  }

  return (
    <div
      className="code-and-threads grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] overflow-auto max-[1200px]:grid-cols-[minmax(0,1fr)_300px] max-[960px]:grid-cols-1"
      ref={containerRef}
    >
      <div
        className={cx(
          "flex flex-1 flex-col gap-4 p-8 transition-opacity duration-200",
          focusMode && !hasThreadAnnotations && "opacity-[0.22]",
        )}
      >
        {fileBrief && <FileBriefHeader brief={fileBrief} />}
        {fileContentError && (
          <p className="m-0 rounded-[8px] border border-[rgba(239,90,90,0.2)] bg-[var(--red-muted)] px-3 py-2 text-[12px] text-[var(--red)]">
            {fileContentError}
          </p>
        )}
        {fileContentLoading && (
          <p className="m-0 text-[12px] text-[var(--text-3)]">
            Loading file for context...
          </p>
        )}
        <p className="text-[13px] text-[var(--text-3)]">
          No diff available for this file.
        </p>
        {fileContent && (
          <SourceContextView
            filePath={filePath}
            sourceContent={fileContent}
            annotations={annotations}
            annotatedLineCategories={annotatedLineCategories}
            focusMode={focusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            filterLineNumbers={null}
            focusedLineRange={highlightedLineRange}
            title="Lines in this file that have thread anchors:"
          />
        )}
      </div>
      <ThreadsPanel
        annotations={annotations}
        highlightedThread={activeThreadId}
        focusMode={focusMode}
        onHoverThread={handleHoverThread}
        onReplyThread={onReplyThread}
        positions={positions}
        gutterHeight={gutterHeight}
      />
    </div>
  );
}

function DiffViewWithThreads({
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
  hasLineAnnotations,
  hasThreadAnnotations,
  onHoverThread,
  onReplyThread,
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
  hasLineAnnotations: boolean;
  hasThreadAnnotations: boolean;
  onHoverThread: (id: string | null) => void;
  onReplyThread: (threadId: string, body: string) => Promise<void>;
  positions: Map<string, { top: number; idealTop: number }>;
  gutterHeight: number;
}) {
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

  const renderedLineNumbersBySide = useMemo(
    () => {
      const newLines = new Set<number>();
      const oldLines = new Set<number>();

      for (const line of parsedLines) {
        if (line.displayLineNum !== null) {
          newLines.add(line.displayLineNum);
        }
        if (line.oldLineNum !== null) {
          oldLines.add(line.oldLineNum);
        }
      }

      return { new: newLines, old: oldLines };
    },
    [parsedLines],
  );

  const sourceLines = useMemo(
    () =>
      fileContent
        ? fileContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
        : [],
    [fileContent],
  );

  const outOfDiffAnchorLines = useMemo(() => {
    const lines = new Set<number>();
    if (!fileContent) return lines;

    for (const annotation of annotations) {
      if (!hasActiveLineAnchor(annotation)) continue;
      if (annotation.lineSide === "old") continue;
      const start = annotation.startLine!;
      const end = annotation.endLine ?? start;

      for (let line = start; line <= end; line++) {
        if (line < 1 || line > sourceLines.length) {
          continue;
        }

        const presentOnSide = renderedLineNumbersBySide.new.has(line);
        if (!presentOnSide) {
          lines.add(line);
        }
      }
    }

    return lines;
  }, [annotations, fileContent, sourceLines.length, renderedLineNumbersBySide]);

  const outOfDiffAnchorNumbers = useMemo(
    () => [...outOfDiffAnchorLines].sort((a, b) => a - b),
    [outOfDiffAnchorLines],
  );

  const orderedContextSections = useMemo(() => {
    if (!fileContent || outOfDiffAnchorNumbers.length === 0) {
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
      if (
        !outOfDiffAnchorNumbers.some(
          (lineNumber) =>
            lineNumber >= boundedStart && lineNumber <= boundedEnd,
        )
      ) {
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
  }, [fileContent, hunks, outOfDiffAnchorNumbers, sourceLines.length]);

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
    const isDimmed = focusMode
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
          "code-line relative flex min-h-[21px] px-4 transition-[opacity,background-color] duration-200 hover:bg-[rgba(255,255,255,0.02)]",
          p.lineClass === "diff-add" && "bg-[var(--green-muted)]",
          p.lineClass === "diff-remove" && "bg-[var(--red-muted)]",
          hasAnnotation &&
            p.lineClass !== "diff-add" &&
            p.lineClass !== "diff-remove" &&
            "bg-[var(--thread-highlight-soft)]",
          isHighlighted && "bg-[var(--thread-highlight-strong)]",
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
            "relative min-w-0 flex-1 whitespace-pre text-[var(--text-2)]",
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
          filterLineNumbers={outOfDiffAnchorLines}
          focusMode={focusMode}
          hasLineAnnotations={hasLineAnnotations}
          hasThreadAnnotations={hasThreadAnnotations}
          lineStart={1}
          lineEnd={sourceLines.length}
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
            filterLineNumbers={outOfDiffAnchorLines}
            focusMode={focusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            lineStart={section.start}
            lineEnd={section.end}
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
            filterLineNumbers={outOfDiffAnchorLines}
            focusMode={focusMode}
            hasLineAnnotations={hasLineAnnotations}
            hasThreadAnnotations={hasThreadAnnotations}
            lineStart={matchingSection.start}
            lineEnd={matchingSection.end}
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
      className="code-and-threads grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] overflow-auto max-[1200px]:grid-cols-[minmax(0,1fr)_300px] max-[960px]:grid-cols-1"
      ref={containerRef}
    >
      <div
        className="code-view flex-1 overflow-auto text-[12px] leading-[1.65]"
        style={codeFontStyle}
      >
        <div className="flex flex-col">
          {fileBrief && <FileBriefHeader brief={fileBrief} />}
          {fileContentError && (
            <p className="m-0 rounded-[8px] border border-[rgba(239,90,90,0.2)] bg-[var(--red-muted)] px-3 py-2 text-[12px] text-[var(--red)]">
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
      <ThreadsPanel
        annotations={annotations}
        highlightedThread={highlightedThread}
        focusMode={focusMode}
        onHoverThread={onHoverThread}
        onReplyThread={onReplyThread}
        positions={positions}
        gutterHeight={gutterHeight}
      />
    </div>
  );
}

function SearchResultsList({
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
}

function SourceContextView({
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
  title?: string;
}) {
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

  const baseVisibleRanges = useMemo(
    () =>
      mergeLineRanges(
        targetRanges.map((range) => ({
          start: Math.max(boundedLineStart, range.start - 3),
          end: Math.min(boundedLineEnd, range.end + 3),
        })),
      ),
    [boundedLineEnd, boundedLineStart, targetRanges],
  );

  const [revealedRanges, setRevealedRanges] = useState<LineRange[]>([]);
  const revealResetKey = useMemo(
    () =>
      [
        filePath,
        boundedLineStart,
        boundedLineEnd,
        sourceContent.length,
        targetRanges.map((range) => `${range.start}-${range.end}`).join(","),
      ].join(":"),
    [boundedLineEnd, boundedLineStart, filePath, sourceContent.length, targetRanges],
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

  const hasHiddenRanges = rows.some((row) => row.kind === "gap");

  if (targetRanges.length === 0 || boundedLineStart > boundedLineEnd) {
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
            const label =
              row.from === boundedLineStart
                ? `Show ${hiddenCount} earlier line${hiddenCount === 1 ? "" : "s"}`
                : row.to === boundedLineEnd
                  ? `Show ${hiddenCount} later line${hiddenCount === 1 ? "" : "s"}`
                  : `Show ${hiddenCount} hidden line${hiddenCount === 1 ? "" : "s"}`;

            return (
              <button
                key={row.key}
                type="button"
                className="code-line flex w-full items-center px-4 py-1.5 text-left text-[11px] text-[var(--accent-text)] transition-colors duration-150 hover:bg-[var(--bg-3)]"
                onClick={() => revealRange(row.from, row.to)}
              >
                <span className="w-12 shrink-0 pr-4 text-right text-[var(--text-3)] opacity-50">
                  ...
                </span>
                <span>{label}</span>
              </button>
            );
          }

          const line = row.line;
          const lineText = lines[line - 1] ?? "";
          const highlightedLine = highlightDiffLine(
            lineText,
            filePath,
            "diff-context",
          );
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
                "code-line relative flex min-h-[21px] px-4 transition-[opacity,background-color] duration-200 hover:bg-[rgba(255,255,255,0.02)]",
                hasAnnotation && "bg-[var(--thread-highlight-soft)]",
                isHighlighted && "bg-[var(--thread-highlight-strong)]",
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
              <span className="relative min-w-0 flex-1 whitespace-pre text-[var(--text-2)]">
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
}

function ActivityPanel({ overview }: { overview: ProjectOverview | null }) {
  const events = overview?.recentEvents ?? [];
  const recentEvents = events.slice(-20);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-[1] flex items-center gap-2 bg-[var(--bg-1)] px-3 py-2.5 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">
          Activity
        </span>
        <span className="rounded-[4px] bg-[var(--bg-3)] px-[5px] py-px font-[var(--font-mono)] text-[10px] text-[var(--text-3)]">
          {events.length}
        </span>
      </div>
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
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export function App() {
  const [initialWorkspaceState] = useState<PersistedWorkspaceState | null>(() =>
    readInitialWorkspaceState(),
  );
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
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
  const [hasPersistedWorkspaceState, setHasPersistedWorkspaceState] = useState(
    () => initialWorkspaceState !== null,
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const hydratedWorkspaceStateKeyRef = useRef<string | null>(null);
  const pageWorkspaceStateStorageKey = getPageWorkspaceStateStorageKey();
  const workspaceStateStorageKey = getWorkspaceStateStorageKey(
    overview?.session ?? null,
  );

  const loadOverview = useEffectEvent(async () => {
    try {
      const next = await fetchOverview();
      setOverview(next);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  });

  useEffect(() => {
    void loadOverview();
    const interval = window.setInterval(() => {
      void loadOverview();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [loadOverview]);

  useEffect(() => {
    if (!deferredSearchText.trim()) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    void searchCanary(deferredSearchText).then((results) => {
      if (!cancelled) setSearchResults(results);
    });

    return () => {
      cancelled = true;
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

  const openFile = useCallback(
    (filePath: string) => {
      if (!openTabs.includes(filePath)) {
        setOpenTabs((prev) => [...prev, filePath]);
      }
      setActiveTab(filePath);
    },
    [openTabs],
  );

  const handleReplyThread = useCallback(
    async (threadId: string, body: string) => {
      await replyToThread(threadId, body);
      await loadOverview();
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

  const fileTree = useMemo(
    () =>
      buildFileTree(
        overview?.changedFiles ?? [],
        overview?.threads ?? [],
      ),
    [overview],
  );

  // Auto-expand top-level dirs
  useEffect(() => {
    if (
      !hasPersistedWorkspaceState &&
      fileTree.length > 0 &&
      expandedDirs.size === 0
    ) {
      const topDirs = fileTree.filter((n) => !n.isFile).map((n) => n.path);
      if (topDirs.length > 0) {
        setExpandedDirs(new Set(topDirs));
      }
    }
  }, [expandedDirs.size, fileTree, hasPersistedWorkspaceState]);

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

  const [activeFileContent, setActiveFileContent] = useState<string | null>(null);
  const [activeFileContentLoading, setActiveFileContentLoading] = useState(false);
  const [activeFileContentError, setActiveFileContentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!activeTab) {
      setActiveFileContent(null);
      setActiveFileContentError(null);
      setActiveFileContentLoading(false);
      return;
    }

    const loadFileContent = async () => {
      setActiveFileContentLoading(true);
      setActiveFileContentError(null);
      try {
        const content = await fetchFileContent(activeTab);
        if (!cancelled) {
          setActiveFileContent(content);
        }
      } catch (error) {
        if (!cancelled) {
          setActiveFileContentError(
            error instanceof Error ? error.message : "Failed to fetch file",
          );
          setActiveFileContent(null);
        }
      } finally {
        if (!cancelled) {
          setActiveFileContentLoading(false);
        }
      }
    };

    void loadFileContent();

    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const activeFilePatch = useMemo(() => {
    if (!activeTab || !overview) return null;
    return (
      overview.changedFiles.find((f) => f.filePath === activeTab)?.patch ?? null
    );
  }, [activeTab, overview]);

  const activeFileAnnotations = useMemo(() => {
    if (!activeTab || !overview) return [];
    return getAnnotationsForFile(
      activeTab,
      overview.threads,
    );
  }, [activeTab, overview]);

  const activeFileBrief = useMemo(() => {
    if (!activeTab || !overview) return null;
    return overview.fileBriefs.find((b) => b.filePath === activeTab) ?? null;
  }, [activeTab, overview]);

  const activeFileChange = useMemo(() => {
    if (!activeTab || !overview) return null;
    return overview.changedFiles.find((f) => f.filePath === activeTab) ?? null;
  }, [activeTab, overview]);

  const isSearching = deferredSearchText.trim().length > 0;

  return (
    <div className="grid h-full overflow-hidden [grid-template-rows:44px_minmax(0,1fr)_26px]">
      <header
        className="grid h-[44px] select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-1)] px-3.5"
        style={dragRegionStyle}
      >
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-2)]">
            canary
          </span>
          {overview?.session && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
              <StatusDot status={overview.session.status} />
              <span className="font-medium text-[var(--text-2)]">
                {overview.session.agentKind}
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
                ? "border-[var(--thread-highlight-border)] bg-[rgba(107,188,167,0.10)] text-[var(--thread-highlight-text)]"
                : "border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--border-active)] hover:text-[var(--text-1)]",
            )}
            type="button"
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
          >
            <span
              className={cx(
                "relative h-4 w-7 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-colors duration-150",
                focusMode ? "bg-[rgba(107,188,167,0.18)]" : "bg-[var(--bg-4)]",
              )}
              aria-hidden="true"
            >
              <span
                className={cx(
                  "absolute top-0.5 left-0.5 h-3 w-3 rounded-full transition-[transform,background-color] duration-150",
                  focusMode
                    ? "translate-x-3 bg-[var(--thread-highlight-solid)]"
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
        <div className="border-b border-[rgba(239,90,90,0.2)] bg-[var(--red-muted)] px-3.5 py-1.5 text-[12px] text-[var(--red)]">
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

          <div className="sidebar-content overflow-x-hidden overflow-y-auto">
            {sidebarTab === "files" ? (
              <div className="flex flex-col">
                <div className="sticky top-0 z-[1] bg-[var(--bg-1)] px-3 py-2.5 pb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">
                    Explorer
                  </span>
                </div>
                <div className="flex flex-col">
                  {fileTree.map((node) => (
                    <FileTreeItem
                      key={node.path}
                      node={node}
                      depth={0}
                      expanded={expandedDirs}
                      onToggle={toggleDir}
                      onSelect={openFile}
                      activeFile={activeTab}
                    />
                  ))}
                  {fileTree.length === 0 && (
                    <div className="px-4 py-6 text-center text-[12px] text-[var(--text-3)]">
                      <span>Waiting for file changes...</span>
                    </div>
                  )}
                </div>
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
              onSelectFile={openFile}
            />
          ) : (
            <>
              {openTabs.length > 0 && (
                <div className="tab-bar flex h-[36px] shrink-0 overflow-x-auto overflow-y-hidden border-b border-[var(--border)] bg-[var(--bg-1)]">
                  {openTabs.map((tab) => {
                    const name = tab.split("/").pop() ?? tab;
                    const change = overview?.changedFiles.find(
                      (f) => f.filePath === tab,
                    );
                    return (
                      <button
                        key={tab}
                        className={cx(
                          "group flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-[var(--border)] px-3.5 text-[12px] transition-colors duration-100",
                          activeTab === tab
                            ? "border-b-2 border-b-[var(--accent)] bg-[var(--bg-2)] text-[var(--text-1)]"
                            : "text-[var(--text-3)] hover:bg-[var(--bg-2)] hover:text-[var(--text-2)]",
                        )}
                        onClick={() => setActiveTab(tab)}
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

              {activeTab ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-2)] px-4 py-1.5">
                    <span className="truncate whitespace-nowrap font-[var(--font-mono)] text-[12px] text-[var(--text-3)]">
                      {activeTab}
                    </span>
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
                          {activeFileAnnotations.length} thread
                          {activeFileAnnotations.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <CodeView
                    filePath={activeTab}
                    patch={activeFilePatch}
                    fileBrief={activeFileBrief}
                    fileContent={activeFileContent}
                    fileContentLoading={activeFileContentLoading}
                    fileContentError={activeFileContentError}
                    annotations={activeFileAnnotations}
                    focusMode={focusMode}
                    onReplyThread={handleReplyThread}
                  />
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <div className="max-w-[440px] px-8 py-8 text-center">
                    <h1 className="mb-2 text-[36px] font-semibold tracking-[-0.04em] text-[var(--text-1)]">
                      canary
                    </h1>
                    <p className="mb-8 text-[14px] text-[var(--text-3)]">
                      Inspect diffs, file briefs, and the review threads your
                      agent opened.
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
                      Select a file from the explorer to begin reviewing.
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
                {overview.session.agentKind} session {overview.session.status}
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
