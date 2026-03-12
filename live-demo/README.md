# Live Demo

This directory hosts an isolated, deterministic Canary demo workspace that uses the real SQLite schema, the real Canary runtime server and UI bundle, and the real `canaryctl` CLI.

The default scenario now plays like a believable feature branch: the agent updates the review service to normalize a new upstream state, tightens store-level triage rules, updates the app to surface merge-ready and stale review work, and leaves focused review threads on the parts a human should double-check.
It now also includes a later review-store follow-up that makes an earlier file brief and thread go stale, then keeps working so the final frame still looks like a live branch in motion.

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
- The SQLite database is isolated to a live-demo-specific canary home under the system temp directory.
- File diffs come from a real watcher against the generated workspace.
- The demo now creates a monitor session plus a wrapped Codex actor session with a real `CANARY_SESSION_TOKEN`.
- Typed review threads and file briefs are created by invoking the real `canaryctl` CLI inside that wrapped actor context.
- The default replay intentionally leaves one outdated thread and one outdated file brief visible at the end so you can inspect stale-context UI states without racing the playback.
- The default replay also seeds one thread body with literal escaped newlines so you can visually confirm the UI normalizes legacy `\n` text into real paragraphs and bullets.
- The default scenario seeds half-open line ranges so thread anchors land on the intended file spans.
- The browser UI and API come from the built Canary runtime in `packages/canary/dist/`.

## Prerequisite

If the built Canary artifacts are missing, run:

```bash
pnpm build
```
