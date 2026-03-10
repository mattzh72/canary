import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  ChangedFileSummary,
  LineSide,
  NoteRecord,
  ProjectOverview,
  ReviewMarkRecord,
  SearchResult,
  SessionRecord,
  ThreadRecord
} from "canary-core";
import { fetchOverview, searchCanary } from "./lib/api";

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
  type: "mark" | "note" | "thread";
  severity?: string;
  count: number;
}

interface FileAnnotation {
  id: string;
  type: "mark" | "note" | "thread";
  title: string;
  body: string;
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  severity?: string;
  category?: string;
  kind?: string;
  status: string;
  author: string;
  messages?: { id: string; author: string; body: string }[];
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

function buildFileTree(
  changedFiles: ChangedFileSummary[],
  marks: ReviewMarkRecord[],
  notes: NoteRecord[],
  threads: ThreadRecord[]
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

  for (const m of marks) {
    if (!m.filePath) continue;
    const entry = ensureFile(m.filePath);
    const ind = entry.indicators.get("mark") ?? {
      type: "mark" as const,
      severity: m.severity,
      count: 0
    };
    ind.count++;
    if (m.severity === "high") ind.severity = "high";
    else if (m.severity === "medium" && ind.severity !== "high")
      ind.severity = "medium";
    entry.indicators.set("mark", ind);
  }

  for (const n of notes) {
    if (!n.filePath) continue;
    const entry = ensureFile(n.filePath);
    const ind = entry.indicators.get("note") ?? {
      type: "note" as const,
      count: 0
    };
    ind.count++;
    entry.indicators.set("note", ind);
  }

  for (const t of threads) {
    if (!t.filePath) continue;
    const entry = ensureFile(t.filePath);
    const ind = entry.indicators.get("thread") ?? {
      type: "thread" as const,
      severity: t.severity,
      count: 0
    };
    ind.count++;
    if (t.severity === "high") ind.severity = "high";
    else if (t.severity === "medium" && ind.severity !== "high")
      ind.severity = "medium";
    entry.indicators.set("thread", ind);
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
          changeType: entry.changeType
        });
      } else {
        let dirNode = dirNodes.get(dirPath);
        if (!dirNode) {
          dirNode = {
            name: partName,
            path: dirPath,
            children: [],
            isFile: false,
            indicators: []
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
  marks: ReviewMarkRecord[],
  notes: NoteRecord[],
  threads: ThreadRecord[]
): FileAnnotation[] {
  const annotations: FileAnnotation[] = [];

  for (const m of marks) {
    if (m.filePath !== filePath) continue;
    annotations.push({
      id: m.id,
      type: "mark",
      title: m.title,
      body: m.reviewReason + (m.rationale ? `\n${m.rationale}` : ""),
      startLine: m.startLine,
      endLine: m.endLine,
      lineSide: m.lineSide,
      severity: m.severity,
      category: m.category,
      status: m.status,
      author: m.author
    });
  }

  for (const n of notes) {
    if (n.filePath !== filePath) continue;
    annotations.push({
      id: n.id,
      type: "note",
      title: n.title,
      body: n.body,
      startLine: n.startLine,
      endLine: n.endLine,
      lineSide: n.lineSide,
      kind: n.kind,
      status: n.status,
      author: n.author
    });
  }

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
      severity: t.severity,
      category: t.type,
      status: t.status,
      author: t.author,
      messages: t.messages.map((msg) => ({
        id: msg.id,
        author: msg.author,
        body: msg.body
      }))
    });
  }

  return annotations.sort(
    (a, b) => (a.startLine ?? Infinity) - (b.startLine ?? Infinity)
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
    go: "GO"
  };
  return map[ext] ?? "··";
}

function severityColor(severity?: string): string {
  if (severity === "high") return "var(--red)";
  if (severity === "medium") return "var(--amber)";
  return "var(--blue)";
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function getWorkspaceStateStorageKey(session: SessionRecord | null): string | null {
  if (!session) return null;
  return `${WORKSPACE_STATE_STORAGE_PREFIX}:${session.projectRoot}:${session.id}`;
}

function getPageWorkspaceStateStorageKey(): string | null {
  if (typeof window === "undefined") return null;
  return `${WORKSPACE_STATE_STORAGE_PREFIX}:page:${window.location.origin}${window.location.pathname}`;
}

function readPersistedWorkspaceState(
  storageKey: string
): PersistedWorkspaceState | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
    const openTabs = Array.isArray(parsed.openTabs)
      ? [...new Set(parsed.openTabs.filter((value): value is string => typeof value === "string"))]
      : [];
    const activeTab =
      typeof parsed.activeTab === "string" && openTabs.includes(parsed.activeTab)
        ? parsed.activeTab
        : openTabs[0] ?? null;
    const expandedDirs = Array.isArray(parsed.expandedDirs)
      ? [...new Set(parsed.expandedDirs.filter((value): value is string => typeof value === "string"))]
      : [];
    const sidebarTab = parsed.sidebarTab === "activity" ? "activity" : "files";

    return {
      openTabs,
      activeTab,
      expandedDirs,
      sidebarTab
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
  state: PersistedWorkspaceState
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore storage failures and keep the UI functional.
  }
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
  return <span className="status-dot" style={{ background: color }} />;
}

function FileTreeItem({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
  activeFile
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
        className={`tree-item ${isActive ? "active" : ""} ${node.isFile ? "file" : "dir"}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (node.isFile) {
            onSelect(node.path);
          } else {
            onToggle(node.path);
          }
        }}
      >
        <span className="tree-icon">
          {node.isFile ? (
            <span className={`file-badge ext-${fileExtension(node.name)}`}>
              {fileIcon(node.name, true)}
            </span>
          ) : (
            <span className={`chevron ${isOpen ? "open" : ""}`} />
          )}
        </span>
        <span className="tree-label">{node.name}</span>
        {node.changeType && (
          <span className={`change-badge ${node.changeType}`}>
            {node.changeType === "add"
              ? "A"
              : node.changeType === "unlink"
                ? "D"
                : "M"}
          </span>
        )}
        <span className="tree-indicators">
          {node.indicators.map((ind) => (
            <span
              key={ind.type}
              className={`indicator indicator-${ind.type}`}
              style={
                ind.type === "mark" || ind.type === "thread"
                  ? { background: severityColor(ind.severity) }
                  : undefined
              }
              title={`${ind.count} ${ind.type}${ind.count > 1 ? "s" : ""}`}
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

function formatLineRange(annotation: FileAnnotation): string | null {
  if (annotation.startLine === null) return null;
  const prefix = annotation.lineSide ? `${annotation.lineSide} ` : "";
  if (annotation.endLine !== null && annotation.endLine !== annotation.startLine) {
    return `${prefix}L${annotation.startLine}\u2013${annotation.endLine}`;
  }
  return `${prefix}L${annotation.startLine}`;
}

function ThreadCard({
  annotation,
  highlighted,
  focusMode,
  onHover
}: {
  annotation: FileAnnotation;
  highlighted: boolean;
  focusMode: boolean;
  onHover: (id: string | null) => void;
}) {
  const allMessages: { id: string; author: string; body: string }[] = [];

  if (annotation.body) {
    allMessages.push({
      id: `${annotation.id}-root`,
      author: annotation.author,
      body: annotation.body
    });
  }

  if (annotation.messages) {
    for (const msg of annotation.messages) {
      allMessages.push(msg);
    }
  }

  const lineRange = formatLineRange(annotation);
  const locationLabel = lineRange ?? "File discussion";
  const messageCountLabel = `${allMessages.length} message${allMessages.length === 1 ? "" : "s"}`;

  return (
    <div
      className={`thread-card${highlighted ? " thread-card-highlighted" : ""}${focusMode ? " thread-card-focus-mode" : ""}`}
      onMouseEnter={() => onHover(annotation.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="thread-card-header">
        <div className="thread-card-kicker">
          <span className="thread-line-badge">{locationLabel}</span>
          <span className={`thread-tag thread-tag-status status-${annotation.status}`}>
            {formatLabel(annotation.status)}
          </span>
        </div>
        <h3 className="thread-card-title">{annotation.title}</h3>
        {(annotation.category || annotation.severity) && (
          <div className="thread-card-tags">
            {annotation.category && (
              <span className="thread-tag">
                {formatLabel(annotation.category)}
              </span>
            )}
            {annotation.severity && (
              <span className={`thread-tag severity-${annotation.severity}`}>
                {formatLabel(annotation.severity)}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="thread-card-messages">
        {allMessages.map((msg, i) => (
          <div key={msg.id} className="thread-message">
            <div className="thread-message-content">
              <div className="thread-message-meta">
                <span className="thread-message-author">{msg.author}</span>
                <span className="thread-message-kind">
                  {i === 0 ? "Opened thread" : "Reply"}
                </span>
              </div>
              <p className="thread-message-body">{msg.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="thread-card-footer">
        <span className="thread-card-footer-count">{messageCountLabel}</span>
      </div>
    </div>
  );
}

/**
 * Measure actual pixel offsets for annotated code lines inside a scroll
 * container and lay out thread cards so they align but never overlap.
 */
function useMeasuredLinePositions(
  containerRef: React.RefObject<HTMLDivElement | null>,
  annotations: FileAnnotation[],
  /** Any value whose change means the DOM has re-rendered (content, patch, etc.) */
  renderKey: unknown
): Map<string, number> {
  const [positions, setPositions] = useState<Map<string, number>>(
    () => new Map()
  );

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
      .filter((a) => a.startLine !== null)
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
      const el = container.querySelector<HTMLElement>(selector);
      if (el) {
        measured.set(key, el.getBoundingClientRect().top - gutterTop);
      }
    }

    // Lay out cards: ideal position = measured line offset, pushed down to
    // avoid overlapping the previous card.
    const CARD_GAP = 8;
    const result = new Map<string, number>();
    let cursor = 0;

    // File-level threads first (no line reference)
    const fileLevel = annotations.filter((a) => a.startLine === null);
    for (const a of fileLevel) {
      result.set(a.id, cursor);
      // We don't know the card height yet so use an estimate; the browser
      // will render them in order and the next card's ideal position will
      // push it further down anyway.
      cursor += 0; // they'll stack naturally via DOM order before line-level
    }

    for (const a of lineLevel) {
      const key = a.lineSide ? `${a.lineSide}:${a.startLine!}` : `${a.startLine!}`;
      const idealTop = measured.get(key) ?? cursor;
      const top = Math.max(idealTop, cursor);
      result.set(a.id, top);

      // Measure the actual rendered card height if it exists yet, else estimate
      const cardEl = gutterEl.querySelector<HTMLElement>(
        `[data-thread-id="${a.id}"]`
      );
      const cardH = cardEl ? cardEl.offsetHeight : 120;
      cursor = top + cardH + CARD_GAP;
    }

    setPositions(result);
  }, [containerRef, annotations, renderKey]);

  return positions;
}

function ThreadsPanel({
  annotations,
  highlightedThread,
  focusMode,
  onHoverThread,
  positions
}: {
  annotations: FileAnnotation[];
  highlightedThread: string | null;
  focusMode: boolean;
  onHoverThread: (id: string | null) => void;
  positions: Map<string, number>;
}) {
  const fileLevel = annotations.filter((a) => a.startLine === null);
  const lineLevel = annotations
    .filter((a) => a.startLine !== null)
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  const ordered = [...fileLevel, ...lineLevel];

  if (ordered.length === 0) {
    return (
      <div className="threads-gutter">
        <div className="threads-gutter-empty">No threads</div>
      </div>
    );
  }

  return (
    <div className="threads-gutter">
      {ordered.map((a) => {
        const top = positions.get(a.id);
        return (
          <div
            key={a.id}
            data-thread-id={a.id}
            className="thread-card-positioned"
            style={top !== undefined ? { position: "absolute", top } : undefined}
          >
            {a.startLine !== null && <span className="thread-connector" />}
            <ThreadCard
              annotation={a}
              highlighted={highlightedThread === a.id}
              focusMode={focusMode}
              onHover={onHoverThread}
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
  annotations,
  focusMode
}: {
  filePath: string;
  patch: string | null;
  annotations: FileAnnotation[];
  focusMode: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const activeThreadId = hoveredThread;
  const hasLineAnnotations = useMemo(
    () => annotations.some((annotation) => annotation.startLine !== null),
    [annotations]
  );

  // Side-aware set: keys are "new:8", "old:10", or just "8" (legacy/no side)
  const annotatedLineSet = useMemo(() => {
    const set = new Set<string>();
    for (const a of annotations) {
      if (a.startLine === null) continue;
      const end = a.endLine ?? a.startLine;
      const prefix = a.lineSide ? `${a.lineSide}:` : "";
      for (let l = a.startLine; l <= end; l++) {
        set.add(`${prefix}${l}`);
        if (!a.lineSide) {
          set.add(`new:${l}`);
          set.add(`old:${l}`);
        }
      }
    }
    return set;
  }, [annotations]);

  const highlightedLineRange = useMemo(() => {
    if (!activeThreadId) return null;
    const a = annotations.find((ann) => ann.id === activeThreadId);
    if (!a || a.startLine === null) return null;
    return { start: a.startLine, end: a.endLine ?? a.startLine, side: a.lineSide };
  }, [activeThreadId, annotations]);

  useEffect(() => {
    setHoveredThread(null);
  }, [filePath]);

  const handleHoverThread = useCallback((id: string | null) => {
    setHoveredThread(id);
  }, []);

  const renderKey = `${filePath}:${patch?.length ?? ""}:${annotations.length}`;
  const positions = useMeasuredLinePositions(containerRef, annotations, renderKey);

  if (patch) {
    return (
      <DiffViewWithThreads
        containerRef={containerRef}
        patch={patch}
        filePath={filePath}
        annotations={annotations}
        annotatedLineSet={annotatedLineSet}
        highlightedLineRange={highlightedLineRange}
        highlightedThread={activeThreadId}
        focusMode={focusMode}
        hasLineAnnotations={hasLineAnnotations}
        onHoverThread={handleHoverThread}
        positions={positions}
      />
    );
  }

  return (
    <div className="code-and-threads" ref={containerRef}>
      <div className="empty-editor">
        <p className="empty-label">No diff available for this file.</p>
      </div>
      <ThreadsPanel
        annotations={annotations}
        highlightedThread={activeThreadId}
        focusMode={focusMode}
        onHoverThread={handleHoverThread}
        positions={positions}
      />
    </div>
  );
}

function DiffViewWithThreads({
  containerRef,
  patch,
  filePath,
  annotations,
  annotatedLineSet,
  highlightedLineRange,
  highlightedThread,
  focusMode,
  hasLineAnnotations,
  onHoverThread,
  positions
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  patch: string;
  filePath: string;
  annotations: FileAnnotation[];
  annotatedLineSet: Set<string>;
  highlightedLineRange: { start: number; end: number; side: string | null } | null;
  highlightedThread: string | null;
  focusMode: boolean;
  hasLineAnnotations: boolean;
  onHoverThread: (id: string | null) => void;
  positions: Map<string, number>;
}) {
  const rawLines = patch.split("\n");
  const hunkHeaderRegex = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

  const parsedLines = useMemo(() => {
    let curNew = 0;
    let curOld = 0;
    const parsed: {
      raw: string;
      lineClass: string;
      displayLineNum: number | null;
      oldLineNum: number | null;
    }[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const hunkMatch = line.match(hunkHeaderRegex);
      if (hunkMatch?.[1] && hunkMatch[2]) {
        curOld = parseInt(hunkMatch[1], 10) - 1;
        curNew = parseInt(hunkMatch[2], 10) - 1;
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
    }

    return parsed;
  }, [rawLines]);

  return (
    <div className="code-and-threads" ref={containerRef}>
      <div className={`code-view diff-view${focusMode ? " focus-mode" : ""}`}>
        <div className="diff-file-header">
          <span className="diff-file-path">{filePath}</span>
        </div>
        <div className="code-lines">
          {parsedLines.map((p, i) => {
            // Determine which side this rendered line belongs to
            const isOldSide = p.oldLineNum !== null && p.displayLineNum === null;
            const effectiveLine = p.displayLineNum ?? p.oldLineNum;
            const lineSide = isOldSide ? "old" : "new";

            const hasAnnotation = effectiveLine
              ? annotatedLineSet.has(`${lineSide}:${effectiveLine}`) ||
                annotatedLineSet.has(`${effectiveLine}`)
              : false;

            const isHighlighted = highlightedLineRange && effectiveLine
              ? effectiveLine >= highlightedLineRange.start &&
                effectiveLine <= highlightedLineRange.end &&
                (!highlightedLineRange.side || highlightedLineRange.side === lineSide)
              : false;
            const isDimmed = focusMode && hasLineAnnotations ? !hasAnnotation : false;

            return (
              <div
                key={i}
                data-line={effectiveLine ?? undefined}
                data-line-side={effectiveLine ? lineSide : undefined}
                className={`code-line ${p.lineClass}${hasAnnotation ? " annotated-line" : ""}${isHighlighted ? " highlighted-line" : ""}${isDimmed ? " dimmed-line" : ""}`}
              >
                {hasAnnotation && <span className="line-thread-pip" />}
                <span className="line-number">
                  {p.displayLineNum ?? p.oldLineNum ?? ""}
                </span>
                <span className="line-content">
                  {p.raw || "\u00a0"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <ThreadsPanel
        annotations={annotations}
        highlightedThread={highlightedThread}
        focusMode={focusMode}
        onHoverThread={onHoverThread}
        positions={positions}
      />
    </div>
  );
}

function SearchResultsList({
  results,
  onSelectFile
}: {
  results: SearchResult[];
  onSelectFile: (path: string) => void;
}) {
  return (
    <div className="search-results-panel">
      <div className="search-results-header">
        <span className="search-results-count">{results.length} results</span>
      </div>
      <div className="search-results-list">
        {results.map((r) => (
          <button
            key={`${r.kind}-${r.id}`}
            className="search-result-item"
            onClick={() => r.filePath && onSelectFile(r.filePath)}
          >
            <div className="search-result-top">
              <span className={`result-kind-badge kind-${r.kind}`}>
                {r.kind.replace("_", " ")}
              </span>
              <span className="result-title">{r.title}</span>
            </div>
            <span className="result-excerpt">{r.excerpt}</span>
            {r.filePath && (
              <span className="result-path">{r.filePath}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ActivityPanel({ overview }: { overview: ProjectOverview | null }) {
  const events = overview?.recentEvents ?? [];
  const recentEvents = events.slice(-20);

  return (
    <div className="activity-panel">
      <div className="activity-header">
        <span className="panel-label">Activity</span>
        <span className="activity-count">{events.length}</span>
      </div>
      <div className="activity-list">
        {recentEvents.map((event) => (
          <div key={event.id} className="activity-item">
            <span className={`activity-kind kind-${event.kind}`}>
              {event.kind === "file_diff"
                ? "diff"
                : event.kind === "session_status"
                  ? "session"
                  : event.kind}
            </span>
            <span className="activity-source">{event.source}</span>
            <span className="activity-time">
              {event.ts.slice(11, 19)}
            </span>
          </div>
        ))}
        {recentEvents.length === 0 && (
          <div className="activity-empty">No events yet</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export function App() {
  const [initialWorkspaceState] = useState<PersistedWorkspaceState | null>(
    () => readInitialWorkspaceState()
  );
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const deferredSearchText = useDeferredValue(searchText);

  const [openTabs, setOpenTabs] = useState<string[]>(
    () => initialWorkspaceState?.openTabs ?? []
  );
  const [activeTab, setActiveTab] = useState<string | null>(
    () => initialWorkspaceState?.activeTab ?? null
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(initialWorkspaceState?.expandedDirs ?? [])
  );
  const [sidebarTab, setSidebarTab] = useState<"files" | "activity">(
    () => initialWorkspaceState?.sidebarTab ?? "files"
  );
  const [focusMode, setFocusMode] = useState(false);
  const [hasPersistedWorkspaceState, setHasPersistedWorkspaceState] = useState(
    () => initialWorkspaceState !== null
  );

  const searchInputRef = useRef<HTMLInputElement>(null);
  const hydratedWorkspaceStateKeyRef = useRef<string | null>(null);
  const pageWorkspaceStateStorageKey = getPageWorkspaceStateStorageKey();
  const workspaceStateStorageKey = getWorkspaceStateStorageKey(
    overview?.session ?? null
  );

  const loadOverview = useEffectEvent(async () => {
    try {
      const next = await fetchOverview();
      setOverview(next);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
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
      sidebarTab
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
    workspaceStateStorageKey
  ]);

  const openFile = useCallback(
    (filePath: string) => {
      if (!openTabs.includes(filePath)) {
        setOpenTabs((prev) => [...prev, filePath]);
      }
      setActiveTab(filePath);
    },
    [openTabs]
  );

  const closeTab = useCallback(
    (filePath: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setOpenTabs((prev) => prev.filter((t) => t !== filePath));
      if (activeTab === filePath) {
        const idx = openTabs.indexOf(filePath);
        const next =
          openTabs[idx - 1] ?? openTabs[idx + 1] ?? null;
        setActiveTab(next);
      }
    },
    [activeTab, openTabs]
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
        overview?.marks ?? [],
        overview?.notes ?? [],
        overview?.threads ?? []
      ),
    [overview]
  );

  // Auto-expand top-level dirs
  useEffect(() => {
    if (
      !hasPersistedWorkspaceState &&
      fileTree.length > 0 &&
      expandedDirs.size === 0
    ) {
      const topDirs = fileTree
        .filter((n) => !n.isFile)
        .map((n) => n.path);
      if (topDirs.length > 0) {
        setExpandedDirs(new Set(topDirs));
      }
    }
  }, [
    expandedDirs.size,
    fileTree,
    hasPersistedWorkspaceState
  ]);

  const stats = useMemo(() => {
    if (!overview) {
      return {
        files: 0,
        briefs: 0,
        reviewItems: 0,
        threads: 0
      };
    }

    const openThreads = overview.threads.filter((t) => t.status === "open").length;
    return {
      files: overview.changedFiles.length,
      briefs: overview.fileBriefs.length,
      reviewItems:
        overview.marks.filter((m) => m.status === "current").length +
        overview.notes.length +
        openThreads,
      threads: openThreads
    };
  }, [overview]);

  const activeFilePatch = useMemo(() => {
    if (!activeTab || !overview) return null;
    return (
      overview.changedFiles.find((f) => f.filePath === activeTab)?.patch ??
      null
    );
  }, [activeTab, overview]);

  const activeFileAnnotations = useMemo(() => {
    if (!activeTab || !overview) return [];
    return getAnnotationsForFile(
      activeTab,
      overview.marks,
      overview.notes,
      overview.threads
    );
  }, [activeTab, overview]);

  const activeFileBrief = useMemo(() => {
    if (!activeTab || !overview) return null;
    return (
      overview.fileBriefs.find((b) => b.filePath === activeTab) ?? null
    );
  }, [activeTab, overview]);

  const activeFileChange = useMemo(() => {
    if (!activeTab || !overview) return null;
    return (
      overview.changedFiles.find((f) => f.filePath === activeTab) ?? null
    );
  }, [activeTab, overview]);

  const isSearching = deferredSearchText.trim().length > 0;

  return (
    <div className="ide-shell">
      {/* Title bar */}
      <header className="title-bar">
        <div className="title-left">
          <span className="app-name">canary</span>
          {overview?.session && (
            <div className="session-info">
              <StatusDot status={overview.session.status} />
              <span className="session-agent">
                {overview.session.agentKind}
              </span>
              <span className="session-status">{overview.session.status}</span>
            </div>
          )}
        </div>
        <div className="title-center">
          <div className="search-box">
            <span className="search-icon">
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
              className="search-input"
            />
            <kbd className="search-shortcut">
              {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}P
            </kbd>
          </div>
        </div>
        <div className="title-right">
          <button
            className={`focus-mode-toggle title-focus-toggle${focusMode ? " active" : ""}`}
            type="button"
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
          >
            <span className="focus-mode-switch" aria-hidden="true">
              <span className="focus-mode-thumb" />
            </span>
            Focus mode
          </button>
          <div className="stat-pills">
            <span className="stat-pill">
              <span className="stat-count">{stats.files}</span> files
            </span>
            <span className="stat-pill stat-briefs">
              <span className="stat-count">{stats.briefs}</span> briefs
            </span>
            <span className="stat-pill stat-review-items">
              <span className="stat-count">{stats.reviewItems}</span> review items
            </span>
            <span className="stat-pill stat-threads">
              <span className="stat-count">{stats.threads}</span> threads
            </span>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="ide-body">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === "files" ? "active" : ""}`}
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
              className={`sidebar-tab ${sidebarTab === "activity" ? "active" : ""}`}
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

          <div className="sidebar-content">
            {sidebarTab === "files" ? (
              <div className="file-tree">
                <div className="tree-header">
                  <span className="panel-label">Explorer</span>
                </div>
                <div className="tree-list">
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
                    <div className="tree-empty">
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

        {/* Main editor area */}
        <main className="editor-area">
          {isSearching && searchResults.length > 0 ? (
            <SearchResultsList
              results={searchResults}
              onSelectFile={openFile}
            />
          ) : (
            <>
              {/* Tab bar */}
              {openTabs.length > 0 && (
                <div className="tab-bar">
                  {openTabs.map((tab) => {
                    const name = tab.split("/").pop() ?? tab;
                    const change = overview?.changedFiles.find(
                      (f) => f.filePath === tab
                    );
                    return (
                      <button
                        key={tab}
                        className={`tab ${activeTab === tab ? "active" : ""}`}
                        onClick={() => setActiveTab(tab)}
                      >
                        <span
                          className={`tab-badge ext-${fileExtension(name)}`}
                        >
                          {fileIcon(name, true)}
                        </span>
                        <span className="tab-name">{name}</span>
                        {change && (
                          <span className={`tab-change ${change.eventType}`}>
                            {change.eventType === "add"
                              ? "A"
                              : change.eventType === "unlink"
                                ? "D"
                                : "M"}
                          </span>
                        )}
                        <span
                          className="tab-close"
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

              {/* Editor content */}
              {activeTab ? (
                <div className="editor-content">
                  {/* File info bar */}
                  <div className="file-info-bar">
                    <span className="file-breadcrumb">{activeTab}</span>
                    <div className="file-info-actions">
                      {activeFileChange && (
                        <span className="file-stats">
                          <span className="stat-add">
                            +{activeFileChange.added}
                          </span>
                          <span className="stat-remove">
                            -{activeFileChange.removed}
                          </span>
                        </span>
                      )}
                      {activeFileAnnotations.length > 0 && (
                        <span className="annotation-count-badge">
                          {activeFileAnnotations.length} annotation
                          {activeFileAnnotations.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* File brief */}
                  {activeFileBrief && (
                    <div className="file-brief-bar">
                      <span className="brief-label">Brief</span>
                      <span className="brief-summary">
                        {activeFileBrief.summary}
                      </span>
                      {activeFileBrief.details && (
                        <span className="brief-details">
                          {activeFileBrief.details}
                        </span>
                      )}
                    </div>
                  )}

                  <CodeView
                    filePath={activeTab}
                    patch={activeFilePatch}
                    annotations={activeFileAnnotations}
                    focusMode={focusMode}
                  />
                </div>
              ) : (
                <div className="welcome-panel">
                  <div className="welcome-content">
                    <h1 className="welcome-title">canary</h1>
                    <p className="welcome-subtitle">
                      Inspect diffs, file briefs, and the review threads your agent opened.
                    </p>
                    <div className="welcome-stats">
                      <div className="welcome-stat">
                        <span className="welcome-stat-value">
                          {stats.files}
                        </span>
                        <span className="welcome-stat-label">
                          Changed Files
                        </span>
                      </div>
                      <div className="welcome-stat">
                        <span className="welcome-stat-value">
                          {stats.briefs}
                        </span>
                        <span className="welcome-stat-label">
                          File Briefs
                        </span>
                      </div>
                      <div className="welcome-stat">
                        <span className="welcome-stat-value">
                          {stats.reviewItems}
                        </span>
                        <span className="welcome-stat-label">Review Items</span>
                      </div>
                      <div className="welcome-stat">
                        <span className="welcome-stat-value">
                          {stats.threads}
                        </span>
                        <span className="welcome-stat-label">
                          Open Threads
                        </span>
                      </div>
                    </div>
                    <p className="welcome-hint">
                      Select a file from the explorer to begin reviewing.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Status bar */}
      <footer className="status-bar">
        <div className="status-left">
          {overview?.session && (
            <>
              <StatusDot status={overview.session.status} />
              <span>
                {overview.session.agentKind} session{" "}
                {overview.session.status}
              </span>
            </>
          )}
        </div>
        <div className="status-right">
          {activeTab && <span>{activeTab}</span>}
          <span>canary</span>
        </div>
      </footer>
    </div>
  );
}
