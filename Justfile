default:
  @just --list

install:
  corepack enable
  pnpm install

build:
  pnpm build

check:
  pnpm typecheck
  pnpm lint
  pnpm test

verify:
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm test

dev:
  pnpm dev

demo:
  pnpm build
  node live-demo/index.mjs start default
