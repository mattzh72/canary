export interface ReviewDraft {
  id: string;
  title: string;
  reviewer: string;
  status: "draft" | "review" | "blocked" | "ready_to_merge";
  changedFiles: number;
  lastTouchedAt: string;
}

export interface ReviewerSummary {
  ready: number;
  blocked: number;
  mergeable: number;
  staleReviews: number;
  totalFiles: number;
}

const STATUS_PRIORITY: Record<ReviewDraft["status"], number> = {
  blocked: 0,
  review: 1,
  ready_to_merge: 2,
  draft: 3
};

const STALE_REVIEW_WINDOW_MS = 1000 * 60 * 60 * 48;

export function isStaleReview(
  draft: ReviewDraft,
  now = Date.now()
): boolean {
  if (draft.status !== "review") {
    return false;
  }

  return now - Date.parse(draft.lastTouchedAt) > STALE_REVIEW_WINDOW_MS;
}

function compareDrafts(
  left: ReviewDraft,
  right: ReviewDraft,
  now: number
): number {
  const leftPriority = STATUS_PRIORITY[left.status];
  const rightPriority = STATUS_PRIORITY[right.status];
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftIsStale = isStaleReview(left, now);
  const rightIsStale = isStaleReview(right, now);
  if (leftIsStale !== rightIsStale) {
    return leftIsStale ? -1 : 1;
  }

  if (left.changedFiles !== right.changedFiles) {
    return right.changedFiles - left.changedFiles;
  }

  return left.title.localeCompare(right.title);
}

export function sortReviewDrafts(
  drafts: ReviewDraft[],
  now = Date.now()
): ReviewDraft[] {
  return [...drafts].sort((left, right) => compareDrafts(left, right, now));
}

export function buildReviewerSummary(
  drafts: ReviewDraft[],
  now = Date.now()
): ReviewerSummary {
  return drafts.reduce(
    (summary, draft) => {
      summary.totalFiles += draft.changedFiles;

      if (draft.status === "blocked") {
        summary.blocked += 1;
        return summary;
      }

      if (draft.status === "review") {
        summary.ready += 1;
        if (isStaleReview(draft, now)) {
          summary.staleReviews += 1;
        }
      } else if (draft.status === "ready_to_merge") {
        summary.mergeable += 1;
      }

      return summary;
    },
    {
      ready: 0,
      blocked: 0,
      mergeable: 0,
      staleReviews: 0,
      totalFiles: 0
    }
  );
}
