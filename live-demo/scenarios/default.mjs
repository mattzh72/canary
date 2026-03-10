export const defaultScenario = {
  name: "default",
  seed: "northstar-review-surface-v4-triage",
  description:
    "Replays a realistic feature branch that adds merge-ready review triage and leaves focused agent review threads behind the non-obvious choices.",
  steps: [
    {
      type: "append_event",
      label: "Seed planning event",
      kind: "conversation_item",
      source: "observer",
      payload: {
        role: "assistant",
        text: "Extending the review dashboard to surface merge-ready work and stale handoffs without waiting on a backend aggregation endpoint."
      }
    },
    {
      type: "write_file",
      label: "Normalize review service payloads",
      path: "src/server/review-service.ts",
      asset: "scenarios/default-assets/review-service.v2.ts"
    },
    {
      type: "canaryctl",
      label: "Open service mapping risk thread",
      args: [
        "thread",
        "open",
        "src/server/review-service.ts",
        "--start",
        "13",
        "--end",
        "27",
        "--type",
        "risk",
        "--severity",
        "high",
        "--title",
        "Unknown upstream states still collapse to draft",
        "--body",
        "The fallback path keeps the dashboard resilient, but it will silently bucket any new upstream state under draft until the mapper is updated."
      ]
    },
    {
      type: "write_file",
      label: "Refine review store triage rules",
      path: "src/features/reviews/review-store.ts",
      asset: "scenarios/default-assets/review-store.v2.ts"
    },
    {
      type: "canaryctl",
      label: "Explain review store",
      args: [
        "explain",
        "file",
        "src/features/reviews/review-store.ts",
        "--summary",
        "Owns review-draft sorting and dashboard summary counters for the triage surface.",
        "--details",
        "The branch now prioritizes blocked work first, lifts stale review handoffs, and keeps merge-ready counts in the same model so the app can render one coherent dashboard."
      ]
    },
    {
      type: "canaryctl",
      label: "Open triage ordering thread",
      args: [
        "thread",
        "open",
        "src/features/reviews/review-store.ts",
        "--start",
        "38",
        "--end",
        "67",
        "--type",
        "decision",
        "--severity",
        "medium",
        "--title",
        "Sort stale review handoffs ahead of fresh review work",
        "--body",
        "I biased the ordering toward blocked work first and then stale in-review drafts so the dashboard surfaces follow-up pressure before general queue size."
      ]
    },
    {
      type: "write_file",
      label: "Wire triage view into app",
      path: "src/app/App.tsx",
      asset: "scenarios/default-assets/app.v2.tsx"
    },
    {
      type: "canaryctl",
      label: "Open app-level triage thread",
      args: [
        "thread",
        "open",
        "src/app/App.tsx",
        "--start",
        "8",
        "--end",
        "13",
        "--type",
        "decision",
        "--severity",
        "medium",
        "--title",
        "Keep triage derivation client-side for now",
        "--body",
        "The app derives the next-up draft and stale handoff callout from the same local draft list instead of adding a server-owned summary endpoint in this branch."
      ],
      capture: {
        kind: "id",
        as: "triageThreadId"
      }
    },
    {
      type: "write_file",
      label: "Extend review store tests",
      path: "src/features/reviews/review-store.test.ts",
      asset: "scenarios/default-assets/review-store.test.v2.ts"
    },
    {
      type: "canaryctl",
      label: "Reply to app-level triage thread",
      threadIdFrom: "triageThreadId",
      args: [
        "thread",
        "reply",
        "--body",
        "Keeping it client-side shortens the loop while the triage copy is still changing. If this view hardens, the server can own the summary contract later."
      ]
    },
    {
      type: "append_event",
      label: "Seed warning event",
      kind: "warning",
      source: "observer",
      payload: {
        message: "demo_follow_up",
        text: "Status normalization still assumes a closed set of upstream values."
      }
    }
  ]
};
