import {
  buildReviewerSummary,
  isStaleReview,
  sortReviewDrafts
} from "./review-store";

describe("review store", () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");

  it("sorts blocked work first and then stale review handoffs", () => {
    const drafts = sortReviewDrafts([
      {
        id: "a",
        title: "Follow-up cleanup",
        reviewer: "Kai",
        status: "review",
        changedFiles: 2,
        lastTouchedAt: "2026-03-06T08:00:00.000Z"
      },
      {
        id: "b",
        title: "Schema drift fix",
        reviewer: "Kai",
        status: "blocked",
        changedFiles: 7,
        lastTouchedAt: "2026-03-10T09:00:00.000Z"
      },
      {
        id: "c",
        title: "Polish sidebar",
        reviewer: "Mina",
        status: "review",
        changedFiles: 5,
        lastTouchedAt: "2026-03-10T10:30:00.000Z"
      }
    ], now);

    expect(drafts.map((draft) => draft.title)).toEqual([
      "Schema drift fix",
      "Follow-up cleanup",
      "Polish sidebar"
    ]);
  });

  it("tracks mergeable, stale, and changed file totals", () => {
    expect(
      buildReviewerSummary([
        {
          id: "a",
          title: "Sidebar polish",
          reviewer: "Mina",
          status: "review",
          changedFiles: 3,
          lastTouchedAt: "2026-03-07T09:00:00.000Z"
        },
        {
          id: "b",
          title: "State normalization",
          reviewer: "Kai",
          status: "ready_to_merge",
          changedFiles: 4,
          lastTouchedAt: "2026-03-09T09:05:00.000Z"
        },
        {
          id: "c",
          title: "Schema drift fix",
          reviewer: "Iris",
          status: "blocked",
          changedFiles: 6,
          lastTouchedAt: "2026-03-09T09:15:00.000Z"
        }
      ], now)
    ).toEqual({
      ready: 1,
      blocked: 1,
      mergeable: 1,
      staleReviews: 1,
      totalFiles: 13
    });
  });

  it("flags stale review handoffs after forty-eight hours", () => {
    expect(
      isStaleReview(
        {
          id: "a",
          title: "Queue flake fix",
          reviewer: "Iris",
          status: "review",
          changedFiles: 2,
          lastTouchedAt: "2026-03-07T11:59:59.000Z"
        },
        now
      )
    ).toBe(true);
  });
});
