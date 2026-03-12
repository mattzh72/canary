# Canary

Canary is being rewritten as a workspace with three coordinated products:

- `canary`: the local monitor and wrapped-agent launcher that serves the browser UI, watches repo changes, and starts attributed Codex or Claude sessions
- `canaryctl`: the local review CLI that writes typed review threads and file briefs directly into SQLite
- `skills`: agent instructions that teach Codex and Claude how to use `canaryctl`

## Workspace

```text
packages/
  canary/            monitor + wrapped agent launcher + React/Vite UI
  canaryctl/         review CLI
  canary-core/       schema, migrations, repositories, shared types
  canary-observers/  agent adapter definitions
skills/              canonical agent skill bundle
```

## Stack

- `pnpm` workspaces
- `TypeScript` on Node.js 20+
- `better-sqlite3` for per-user SQLite persistence
- `React + Vite` for the review UI
- `commander` for the CLIs

Project state lives under `~/.canary/projects/<project-hash>/canary.db`.

## Development

```bash
corepack enable
pnpm install
pnpm build
```

The current rewrite pass is focused on the shared SQLite model, actor-backed authorship, and the separation between the monitor, wrapped agent sessions, and `canaryctl`.

## Local Install

To install the local `canary` and `canaryctl` commands plus the Canary Codex skill from a source checkout, run:

```bash
pnpm install:local
```

This script:

- builds the workspace
- links `canary` and `canaryctl` into `~/.local/bin` by default
- links the Canary skill into `$CODEX_HOME/skills/canary` or `~/.codex/skills/canary`

Overrides:

- set `CANARY_BIN_DIR` to install the commands into a different bin directory
- set `CODEX_HOME` to install the skill into a different Codex home

After installation:

- ensure your bin directory is on `PATH`
- restart Codex so it picks up the new skill

To install just the canonical Canary skill through `canaryctl`, run one of:

```bash
canaryctl skill setup --codex
canaryctl skill setup --claude-code
```

Verification:

```bash
canary serve --no-open
canary codex --version
canaryctl thread list --json
```
