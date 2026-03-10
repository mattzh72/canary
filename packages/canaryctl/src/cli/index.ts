#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import type { ThreadSeverity, ThreadType } from "canary-core";
import { runExplainFile } from "../commands/explain-file.js";
import { runThreadOpen } from "../commands/thread-open.js";
import { runThreadReply } from "../commands/thread-reply.js";

const THREAD_TYPES: ThreadType[] = [
  "decision",
  "assumption",
  "risk",
  "scope_extension"
];
const THREAD_SEVERITIES: ThreadSeverity[] = ["low", "medium", "high"];

function collectString(value: string | undefined, label: string): string {
  if (!value || !value.trim()) {
    throw new Error(`Missing required option: ${label}`);
  }
  return value.trim();
}

function collectLineNumber(value: string | undefined, label: string): number {
  const raw = collectString(value, label);
  const lineNumber = Number.parseInt(raw, 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return lineNumber;
}

function collectThreadType(value: string | undefined): ThreadType {
  const type = collectString(value, "type") as ThreadType;
  if (!THREAD_TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}`);
  }
  return type;
}

function collectThreadSeverity(value: string | undefined): ThreadSeverity {
  const severity = collectString(value, "severity") as ThreadSeverity;
  if (!THREAD_SEVERITIES.includes(severity)) {
    throw new Error(`Invalid severity: ${severity}`);
  }
  return severity;
}

async function main(): Promise<void> {
  const program = new Command();
  program.name("canaryctl").description("Canary review and annotation CLI");

  const thread = program.command("thread");
  thread
    .command("open <file>")
    .requiredOption("--start <line>")
    .requiredOption("--end <line>")
    .requiredOption("--type <type>")
    .requiredOption("--severity <severity>")
    .requiredOption("--title <title>")
    .requiredOption("--body <body>")
    .option("--json", "Print JSON")
    .action(async (file: string, options) => {
      const startLine = collectLineNumber(options.start, "start");
      const endLine = collectLineNumber(options.end, "end");
      if (endLine <= startLine) {
        throw new Error(`Invalid range: end (${endLine}) must be greater than start (${startLine})`);
      }

      await runThreadOpen({
        cwd: process.cwd(),
        file,
        startLine,
        endLine,
        type: collectThreadType(options.type),
        severity: collectThreadSeverity(options.severity),
        title: collectString(options.title, "title"),
        body: collectString(options.body, "body"),
        json: Boolean(options.json)
      });
    });

  thread
    .command("reply <threadId>")
    .requiredOption("--body <body>")
    .option("--json", "Print JSON")
    .action(async (threadId: string, options) => {
      await runThreadReply({
        cwd: process.cwd(),
        threadId,
        body: collectString(options.body, "body"),
        json: Boolean(options.json)
      });
    });

  const explain = program.command("explain");
  explain
    .command("file <file>")
    .requiredOption("--summary <summary>")
    .option("--details <details>")
    .option("--json", "Print JSON")
    .action(async (file: string, options) => {
      await runExplainFile({
        cwd: process.cwd(),
        file,
        summary: collectString(options.summary, "summary"),
        details: options.details,
        json: Boolean(options.json)
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
