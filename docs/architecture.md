# Canary Architecture

Canary is split into three top-level products inside one workspace:

- `packages/canary`: runtime wrapper and local review UI
- `packages/canaryctl`: direct-to-SQLite review CLI
- `packages/canary-core`: shared schema, migrations, types, and repositories

`canary` owns runtime concerns:

- launching Codex or Claude Code
- capturing file changes
- appending runtime events
- serving the browser UI

`canaryctl` owns durable review artifacts:

- threads
- file briefs

Both products read and write the same project-local SQLite database at `.canary/canary.db`.

The `skills/` directory is not executable code. It contains the single canonical instruction bundle agents use so they know when to call `canaryctl`.
