# Live Demo

This directory hosts an isolated, deterministic Canary demo workspace that uses the real SQLite schema, the real Canary UI bundle, the real overview/search API shape, and the real `canaryctl` CLI.

The default scenario now plays like a believable feature branch: the agent updates the review service to normalize a new upstream state, tightens store-level triage rules, updates the app to surface merge-ready and stale review work, and leaves focused review threads on the parts a human should double-check.

## Commands

List available scenarios:

```bash
node live-demo/index.mjs list
```

Reset the generated workspace:

```bash
node live-demo/index.mjs reset
```

Start the default replay:

```bash
node live-demo/index.mjs start default
```

Useful options:

```bash
node live-demo/index.mjs start default --interval 1200
node live-demo/index.mjs start default --interval 75 --no-hold
node live-demo/index.mjs start default --port 4310 --open
```

## Behavior

- The generated project lives under `live-demo/workspace/`.
- Every run wipes and recreates that workspace from `live-demo/template/`.
- The SQLite database is isolated to `live-demo/workspace/.canary/canary.db`.
- File diffs come from a real watcher against the generated workspace.
- Typed review threads and file briefs are created by invoking the real `canaryctl` CLI.
- The default scenario seeds half-open line ranges so thread anchors land on the intended file spans.
- The browser UI is the built Canary client bundle from `packages/canary/dist/client/`.

## Prerequisite

If the built Canary artifacts are missing, run:

```bash
pnpm build
```
