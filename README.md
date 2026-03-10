# Canary

Canary is being rewritten as a workspace with three coordinated products:

- `canary`: the runtime wrapper that launches Codex or Claude Code, captures project changes, persists review state, and serves the browser UI
- `canaryctl`: the local review CLI that writes typed review threads and file briefs directly into SQLite
- `skills`: agent instructions that teach Codex and Claude how to use `canaryctl`

## Workspace

```text
packages/
  canary/            runtime wrapper + React/Vite UI
  canaryctl/         review CLI
  canary-core/       schema, migrations, repositories, shared types
  canary-observers/  agent adapter definitions
skills/              canonical agent skill bundle
```

## Stack

- `pnpm` workspaces
- `TypeScript` on Node.js 20+
- `better-sqlite3` for project-local persistence
- `React + Vite` for the review UI
- `commander` for the CLIs

Project state lives in `.canary/canary.db`.

## Development

```bash
corepack enable
pnpm install
pnpm build
```

The current rewrite pass is focused on the shared SQLite model and the separation between the runtime wrapper and `canaryctl`.
