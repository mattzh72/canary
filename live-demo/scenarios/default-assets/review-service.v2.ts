import { fetchJson } from "../lib/http";
import type { ReviewDraft } from "../features/reviews/review-store";

interface ReviewApiDraft {
  id: string;
  title: string;
  reviewer_name: string | null;
  state: string;
  changed_files: number;
  touched_at: string | null;
}

function normalizeStatus(state: string): ReviewDraft["status"] {
  if (state === "blocked") {
    return "blocked";
  }

  if (state === "in_review") {
    return "review";
  }

  if (state === "approved") {
    return "ready_to_merge";
  }

  return "draft";
}

function normalizeTouchedAt(value: string | null): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return new Date(0).toISOString();
}

export async function loadReviewDrafts(): Promise<ReviewDraft[]> {
  const payload = await fetchJson<ReviewApiDraft[]>("/api/reviews");
  return payload.map((draft) => ({
    id: draft.id,
    title: draft.title,
    reviewer: draft.reviewer_name?.trim() || "Unassigned",
    status: normalizeStatus(draft.state),
    changedFiles: draft.changed_files,
    lastTouchedAt: normalizeTouchedAt(draft.touched_at)
  }));
}
