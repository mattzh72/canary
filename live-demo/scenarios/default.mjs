export const defaultScenario = {
  name: "default",
  seed: "northstar-review-surface-v4-triage",
  description:
    "Replays a realistic feature branch that adds merge-ready review triage, then lands a follow-up queue-pressure change that leaves stale review artifacts behind.",
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
        "--title",
        "Unknown upstream states still collapse to draft",
        "--body",
        [
          "Keeps the fallback path resilient when upstream sends an unknown state.",
          "",
          "Why it matters:",
          "- the dashboard stays usable instead of dropping the item",
          "- any new provider value is silently mapped to `draft` until we update the mapper",
          "",
          "Please verify:",
          "- `draft` is the safest fallback for triage",
          "- we want an explicit warning or telemetry path for unmapped values"
        ].join("\n")
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
        [
          "## Responsibilities",
          "- sorts the dashboard feed into a stable triage order",
          "- derives summary counts for `blocked`, `stale`, and `merge_ready` work",
          "",
          "## Notes",
          "- keep ranking rules here so the app renders one coherent view",
          "- avoid duplicating triage policy in `src/app/App.tsx`"
        ].join("\n")
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
        "--title",
        "Sort stale review handoffs ahead of fresh review work",
        "--body",
        [
          "Changes the dashboard ranking to surface follow-up pressure before general queue size.",
          "",
          "Why it matters:",
          "- `blocked` work stays first",
          "- stale `in_review` drafts now appear ahead of fresh review work",
          "",
          "Please verify:",
          "- this ordering matches how the team actually triages work",
          "- stale handoffs should outrank newly opened review items"
        ].join("\n")
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
        "--title",
        "Keep triage derivation client-side for now",
        "--body",
        [
          "Keeps the first version of triage derivation in the client.",
          "",
          "Why it matters:",
          "- avoids adding a server-owned summary endpoint while the UX is still moving",
          "- keeps `App.tsx` responsible for the final callout selection in this branch",
          "",
          "Please verify:",
          "- local derivation is acceptable for the current data size",
          "- we do not need a stable backend summary contract yet"
        ].join("\n")
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
        [
          "Follow-up: keeping it client-side still seems like the right tradeoff.",
          "",
          "Why it still works:",
          "- the triage copy and grouping rules are still changing",
          "- the client already has the full draft list in memory",
          "",
          "Watch next:",
          "- move this behind a server contract if more surfaces need the same summary",
          "- revisit if the dashboard starts computing multiple derived buckets"
        ].join("\n")
      ]
    },
    {
      type: "append_event",
      label: "Seed dogfood follow-up",
      kind: "conversation_item",
      source: "observer",
      payload: {
        role: "assistant",
        text: "Dogfood follow-up: one stale handoff is not enough context when the same reviewer already owns multiple items. Pull queue pressure into the dashboard copy before we ship this branch."
      }
    },
    {
      type: "write_file",
      label: "Adjust review store for reviewer load",
      path: "src/features/reviews/review-store.ts",
      asset: "scenarios/default-assets/review-store.v3.ts"
    },
    {
      type: "write_file",
      label: "Highlight reviewer load in app",
      path: "src/app/App.tsx",
      asset: "scenarios/default-assets/app.v3.tsx"
    },
    {
      type: "canaryctl",
      label: "Open queue-pressure callout thread",
      args: [
        "thread",
        "open",
        "src/app/App.tsx",
        "--start",
        "21",
        "--end",
        "32",
        "--type",
        "decision",
        "--title",
        "Keep queue-pressure callouts in the client for this pass",
        "--body",
        [
          "Adds reviewer-load copy in the app instead of waiting for a backend summary contract.",
          "",
          "Why it matters:",
          "- lets the dashboard call out overloaded reviewers in the same pass that makes the older store brief/thread stale",
          "- keeps the new copy coupled to the existing client-derived summary for now",
          "",
          "Please verify:",
          "- the reviewer-load threshold belongs in the client until this view settles",
          "- the callout text is specific enough without another service-owned field"
        ].join("\n")
      ]
    },
    {
      type: "write_file",
      label: "Refresh review store tests for queue pressure",
      path: "src/features/reviews/review-store.test.ts",
      asset: "scenarios/default-assets/review-store.test.v3.ts"
    },
    {
      type: "canaryctl",
      label: "Seed escaped-newline renderer thread",
      args: [
        "thread",
        "open",
        "src/app/App.tsx",
        "--start",
        "21",
        "--end",
        "32",
        "--type",
        "question",
        "--title",
        "Legacy escaped thread body should still render as prose",
        "--body",
        [
          "This demo thread is intentionally stored with escaped newlines.",
          "",
          "Why it matters:",
          "- gives the UI a visible regression case for legacy review content",
          "- lets you confirm the thread body still renders as paragraphs and bullets",
          "",
          "Please verify:",
          "- the body shows real line breaks instead of raw `\\n` text",
          "- the bullets render normally in the thread card"
        ].join("\\n")
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
