---
name: tracking-agent-changes-with-canary
description: Tracks and presents the agent's file changes and durable review context for the user through Canary. Use in repositories with Canary when generated code introduces a non-obvious decision, question, risk, scope change, or file ownership update that should stay visible in diffs, threads, file briefs, and the todo queue, and when canaryctl should be used to keep that context current.
---

# Canary

Canary has two surfaces:

- `canary`: the app the user sees. It automatically tracks file changes during the session and shows diffs, threads, and file briefs in the local review UI.
- `canaryctl`: the tool the agent uses to create and update that context.

The user can:

- inspect what files changed
- read the agent's threads and file briefs
- reply to threads in the UI

Canary's durable artifacts are:

- `threads`: focused review discussions for one issue, usually tied to a file and line range
- `file briefs`: durable notes about what a file owns and what future editors should know

Use Canary when the user should be able to review a non-obvious change after the chat, not just read about it in the transcript.

Use these commands:

- `canaryctl todo list --json` to see the agent's current cleanup queue. It can return items like threads waiting for an agent reply, threads waiting on the user, outdated thread anchors, and outdated file briefs.
- `canaryctl thread list --file <path> --json` before opening a new thread
- `canaryctl thread reply <thread-id> --body "<text>"` to continue an existing discussion
- `canaryctl thread open <file> --start <line> --end <line> --type <decision|question|risk|scope_change> --title "<title>" --body "<text>"` for one concrete review-worthy issue
- `canaryctl explain file <file> --summary "<summary>" [--details "<details>"]` when a file's role, boundary, or invariants changed
- `canaryctl brief list --file <path> --json` to inspect file-brief state for a touched file

Guidance:

- Use `canaryctl` incrementally and often so the user can proactively see and respond to your design decisions.
- Prefer one issue per thread.
- Open threads only for changes a human should review deliberately.
- Use briefs for durable file-level context, not diff summaries.
- Check `canaryctl todo list --json` often while working, not just at the end.
- Keep titles and bodies concise and specific.

IMPORTANT:

- Later edits can make existing context stale.
- A thread becomes `outdated` when its old anchor can no longer be trusted.
- A file brief becomes `outdated` when later edits may have made it stale.
- Outdated items stay visible to the user.
- If a thread is `outdated`, add a reply with the new context or open a new thread on the current lines.
- If a file brief is `outdated`, run `canaryctl explain file ...` again with updated text.
- If you are not fixing an outdated item now, leave it clearly pending; do not ignore it.
