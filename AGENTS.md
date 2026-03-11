# Repository Guidelines

This repository is a clean rewrite. Do not preserve the old single-package Canary architecture or its analyzer-oriented data model.

## Product Vision

Canary now has three coordinated surfaces:

- `canary`: runtime wrapper for Codex or Claude Code that launches the agent, captures file changes, persists session state, and serves the local review UI
- `canaryctl`: direct-to-SQLite CLI for opening, replying to, and querying review threads plus updating file briefs
- `skills`: a canonical installable instruction bundle that teaches the model when and how to call `canaryctl`

The goal is to help the engineer understand generated code, keep a mental model of the evolving codebase, and see exactly which lines merit review because the agent made a design decision, open question, or tradeoff.

## Project Structure

The workspace uses `pnpm`.

- `packages/canary/`: runtime wrapper and React/Vite UI
- `packages/canaryctl/`: review artifact CLI
- `packages/canary-core/`: SQLite schema, migrations, repositories, and shared types
- `packages/canary-observers/`: agent definitions and future observer adapters
- `skills/`: canonical agent skill asset
- `docs/`: high-level design notes

Project state is written under `~/.canary/`, with the active SQLite database for each project at `~/.canary/projects/<project-hash>/canary.db`.

## Build and Development

Use Node.js 20+.

- `corepack enable`
- `pnpm install`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

For runtime smoke checks:

- `node packages/canary/dist/cli/index.js --no-open codex --version`
- `node packages/canaryctl/dist/cli/index.js thread list --json`

## Live Demo

The repository includes an isolated live demo under `live-demo/` that replays a deterministic Canary session against a generated workspace.

- Build artifacts first: `pnpm build`
- List scenarios: `node live-demo/index.mjs list`
- Reset the generated workspace: `node live-demo/index.mjs reset`
- Start the default demo: `node live-demo/index.mjs start default`
- Useful variants:
  - `node live-demo/index.mjs start default --interval 1200`
  - `node live-demo/index.mjs start default --interval 75 --no-hold`
  - `node live-demo/index.mjs start default --port 4310 --open`

The demo workspace is recreated under `live-demo/workspace/` on each run, and its SQLite database lives in an isolated live-demo-specific canary home under the system temp directory.

## Coding Style

- Use TypeScript with ESM imports and explicit `.js` extensions in local package source.
- Use 2-space indentation, semicolons, and double-quoted strings.
- Keep package boundaries hard:
  - `canary-core` owns schema and repositories
  - `canary` owns runtime capture and UI serving
  - `canaryctl` owns direct review artifact creation/query
  - `skills` contain instructions only, not code
- Do not add backward-compatibility layers for the removed design unless explicitly requested.

## Testing Expectations

Before finishing work, run the relevant workspace verification commands:

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

If you touch runtime or CLI flows, prefer a direct smoke test against the built entrypoints.

## Commit and PR Guidance

Use short, imperative commit subjects with a capitalized first word, for example `Split runtime and review CLI`.

PRs should include:

- a concise summary
- verification commands run
- screenshots for UI changes in `packages/canary/src/client/`

## Security and Configuration

- Do not commit captured project state from `~/.canary/`
- Do not commit secrets
- Prefer environment variables for any future external service configuration
