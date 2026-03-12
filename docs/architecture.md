# Canary Architecture

Canary is split into three top-level products inside one workspace:

- `packages/canary`: repo monitor, wrapped agent launcher, and local review UI
- `packages/canaryctl`: direct-to-SQLite review CLI
- `packages/canary-core`: shared schema, migrations, types, and repositories

`canary` owns runtime concerns:

- running `canary serve` as the repo-local monitor
- launching wrapped `canary codex` / `canary claude` sessions
- capturing file changes
- appending runtime events
- minting live actor identities and session tokens
- serving the browser UI

`canaryctl` owns durable review artifacts:

- threads
- file briefs

When `canaryctl` runs inside a wrapped agent session, it resolves authorship from the inherited Canary session token instead of trusting model-supplied names. That lets threads, replies, and file briefs keep stable agent names and avatars for the lifetime of the wrapped run.

Both products resolve the canonical project root first, then read and write the same per-user SQLite database at `~/.canary/projects/<project-hash>/canary.db`.

The `skills/` directory is not executable code. It contains the single canonical instruction bundle agents use so they know when to call `canaryctl`.
