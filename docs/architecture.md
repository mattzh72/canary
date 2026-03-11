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

Both products resolve the canonical project root first, then read and write the same per-user SQLite database at `~/.canary/projects/<project-hash>/canary.db`.

The `skills/` directory is not executable code. It contains the single canonical instruction bundle agents use so they know when to call `canaryctl`.
