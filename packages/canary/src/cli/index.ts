#!/usr/bin/env node

import process from "node:process";
import { isSupportedAgent } from "canary-observers";
import { runAgentWrapper, runServe } from "../app/run-canary.js";

interface ParsedArgs {
  command: "serve" | string | null;
  agentArgs: string[];
  openUi: boolean;
  port?: number;
}

function usage(): void {
  process.stderr.write(
    "Usage: canary serve [--no-open] [--port <number>] | canary <codex|claude> [agent-args...]\n"
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let openUi = true;
  let port: number | undefined;
  let command: string | null = null;
  const agentArgs: string[] = [];

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if ((!command || command === "serve") && current === "--no-open") {
      openUi = false;
      continue;
    }

    if ((!command || command === "serve") && current === "--port") {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new Error("`--port` expects a number.");
      }
      port = Number(value);
      continue;
    }

    if (!command) {
      command = current;
      continue;
    }

    agentArgs.push(current);
  }

  return {
    command,
    agentArgs,
    openUi,
    port
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command) {
    usage();
    return 1;
  }

  if (parsed.command === "serve") {
    return runServe({
      openUi: parsed.openUi,
      port: parsed.port
    });
  }

  if (!isSupportedAgent(parsed.command)) {
    usage();
    return 1;
  }

  return runAgentWrapper({
    agent: parsed.command,
    agentArgs: parsed.agentArgs
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
