#!/usr/bin/env node

import process from "node:process";
import { isSupportedAgent } from "canary-observers";
import { runCanary } from "../app/run-canary.js";

interface ParsedArgs {
  agent: string | null;
  agentArgs: string[];
  openUi: boolean;
  port?: number;
}

function usage(): void {
  process.stderr.write("Usage: canary [--no-open] [--port <number>] <codex|claude> [agent-args...]\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let openUi = true;
  let port: number | undefined;
  let agent: string | null = null;
  const agentArgs: string[] = [];

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if (!agent && current === "--no-open") {
      openUi = false;
      continue;
    }

    if (!agent && current === "--port") {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new Error("`--port` expects a number.");
      }
      port = Number(value);
      continue;
    }

    if (!agent) {
      agent = current;
      continue;
    }

    agentArgs.push(current);
  }

  return {
    agent,
    agentArgs,
    openUi,
    port
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.agent || !isSupportedAgent(parsed.agent)) {
    usage();
    return 1;
  }

  return runCanary({
    agent: parsed.agent,
    agentArgs: parsed.agentArgs,
    openUi: parsed.openUi,
    port: parsed.port
  });
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
