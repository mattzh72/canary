---
name: canary
description: Use Canary to leave review marks, rationale notes, and file briefs that help the engineer understand generated code.
---

# Canary

Use Canary whenever you make non-obvious implementation decisions and want the engineer to keep a durable mental model of the evolving codebase.

## Goals

- leave line-anchored review marks for code the user should inspect
- add rationale notes that explain why the implementation took a specific shape
- update file briefs when a file's role or invariants materially change
- search existing Canary history before repeating old explanations

## Workflow

1. Before editing, search Canary for relevant context.
2. After making a non-trivial change, add a review mark for the lines the engineer should inspect.
3. Add a rationale note explaining the design decision, assumption, or tradeoff.
4. If the file's current role is now different, update its file brief.

## Commands

```bash
canaryctl search "<query>"
canaryctl mark add path/to/file.ts:10-24 --title "Review title" --category design_decision --severity medium --review-reason "Why the user should look here" --rationale "Why the agent made this choice"
canaryctl note add path/to/file.ts:10-24 --title "Rationale" --kind rationale --body "More context about the change"
canaryctl explain file path/to/file.ts --summary "What this file now owns" --details "Important invariants or design details"
```

Keep marks selective. Only create them where human review is genuinely useful.
