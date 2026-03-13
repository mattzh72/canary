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

## Install

```bash
npm install -g @canaryctl/cli
```

To set up the agent skill:

```bash
canaryctl skill setup --codex
# or
canaryctl skill setup --claude-code
```

<details>
<summary>Development (from source)</summary>

```bash
corepack enable
pnpm install
pnpm build
```

To symlink local builds into your PATH:

```bash
pnpm install:local
```

This links `canary` and `canaryctl` into `~/.local/bin` and installs the Canary skill into `$CODEX_HOME/skills/canary`.

</details>

<details>
<summary>Releasing a new version</summary>

Push a tag and the GitHub Actions workflow handles the rest:

```bash
git tag v0.x.0
git push origin v0.x.0
```

This automatically creates a GitHub release and publishes all packages to npm.

</details>
