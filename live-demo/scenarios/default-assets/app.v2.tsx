import {
  buildReviewerSummary,
  isStaleReview,
  sortReviewDrafts
} from "../features/reviews/review-store";
import { loadReviewDrafts } from "../server/review-service";

export async function App(): Promise<string> {
  const drafts = sortReviewDrafts(await loadReviewDrafts());
  const summary = buildReviewerSummary(drafts);
  const nextUp = drafts[0] ?? null;
  const staleDraft = drafts.find((draft) => isStaleReview(draft)) ?? null;

  return [
    "<section>",
    "  <header>",
    "    <h1>Northstar Reviews</h1>",
    `    <p>${summary.ready} ready for review</p>`,
    `    <p>${summary.mergeable} ready to merge</p>`,
    `    <p>${summary.blocked} blocked items</p>`,
    `    <p>${summary.staleReviews} stale review handoffs</p>`,
    "  </header>",
    "  <main>",
    `    <strong>${nextUp?.title ?? "No active drafts"}</strong>`,
    `    <span>${nextUp?.reviewer ?? "Unassigned"}</span>`,
    `    <span>${summary.totalFiles} changed files across active drafts</span>`,
    staleDraft
      ? `    <p>Escalate ${staleDraft.title} before it slips another review cycle.</p>`
      : "    <p>No stale reviews are waiting on triage.</p>",
    "  </main>",
    "</section>"
  ].join("\n");
}
