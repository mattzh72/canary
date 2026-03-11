#!/usr/bin/env node

import process from "node:process";
import { Command } from "commander";
import type { ArtifactFreshness, ThreadType } from "canary-core";
import { runBriefList } from "../commands/brief-list.js";
import { runExplainFile } from "../commands/explain-file.js";
import { runSkillSetup } from "../commands/skill-setup.js";
import { runTodoList } from "../commands/todo-list.js";
import { runThreadList } from "../commands/thread-list.js";
import { runThreadOpen } from "../commands/thread-open.js";
import { runThreadReply } from "../commands/thread-reply.js";
import { runThreadSetStatus } from "../commands/thread-set-status.js";

const THREAD_TYPES: ThreadType[] = [
  "decision",
  "question",
  "risk",
  "scope_change"
];
const THREAD_STATUSES = ["open", "resolved", "all"] as const;
const THREAD_PARTICIPANTS = ["agent", "user"] as const;
const ARTIFACT_FRESHNESS = ["active", "outdated", "all"] as const;

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

function collectPositiveInteger(value: string | undefined, label: string): number {
  const raw = collectString(value, label);
  const integer = Number.parseInt(raw, 10);
  if (!Number.isInteger(integer) || integer < 1) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return integer;
}

function collectThreadType(value: string | undefined): ThreadType {
  const type = collectString(value, "type") as ThreadType;
  if (!THREAD_TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}`);
  }
  return type;
}

function collectThreadStatus(value: string | undefined): "open" | "resolved" | "all" {
  const status = collectString(value, "status") as (typeof THREAD_STATUSES)[number];
  if (!THREAD_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  return status;
}

function collectThreadParticipant(value: string | undefined, label: string): "agent" | "user" {
  const participant = collectString(value, label) as (typeof THREAD_PARTICIPANTS)[number];
  if (!THREAD_PARTICIPANTS.includes(participant)) {
    throw new Error(`Invalid ${label}: ${participant}`);
  }
  return participant;
}

function collectFreshness(value: string | undefined, label: string): ArtifactFreshness | "all" {
  const freshness = collectString(value, label) as (typeof ARTIFACT_FRESHNESS)[number];
  if (!ARTIFACT_FRESHNESS.includes(freshness)) {
    throw new Error(`Invalid ${label}: ${freshness}`);
  }
  return freshness;
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

  thread
    .command("resolve <threadId>")
    .option("--json", "Print JSON")
    .action(async (threadId: string, options) => {
      await runThreadSetStatus({
        cwd: process.cwd(),
        threadId,
        status: "resolved",
        json: Boolean(options.json)
      });
    });

  thread
    .command("reopen <threadId>")
    .option("--json", "Print JSON")
    .action(async (threadId: string, options) => {
      await runThreadSetStatus({
        cwd: process.cwd(),
        threadId,
        status: "open",
        json: Boolean(options.json)
      });
    });

  thread
    .command("list")
    .option("--status <status>", "Filter by status: open, resolved, or all", "all")
    .option("--freshness <freshness>", "Filter by freshness: active, outdated, or all", "all")
    .option("--type <type>", "Filter by thread type")
    .option("--file <file>", "Filter by file path")
    .option("--pending-for <participant>", "Filter by whose reply is expected: agent or user")
    .option("--limit <count>", "Maximum number of threads to return", "30")
    .option("--json", "Print JSON")
    .action(async (options) => {
      await runThreadList({
        cwd: process.cwd(),
        status: collectThreadStatus(options.status),
        freshness: collectFreshness(options.freshness, "freshness"),
        type: options.type ? collectThreadType(options.type) : undefined,
        file: options.file,
        pendingFor: options.pendingFor
          ? collectThreadParticipant(options.pendingFor, "pending-for")
          : undefined,
        limit: collectPositiveInteger(options.limit, "limit"),
        json: Boolean(options.json)
      });
    });

  const brief = program.command("brief");
  brief
    .command("list")
    .option("--freshness <freshness>", "Filter by freshness: active, outdated, or all", "all")
    .option("--file <file>", "Filter by file path")
    .option("--limit <count>", "Maximum number of briefs to return", "30")
    .option("--json", "Print JSON")
    .action(async (options) => {
      await runBriefList({
        cwd: process.cwd(),
        freshness: collectFreshness(options.freshness, "freshness"),
        file: options.file,
        limit: collectPositiveInteger(options.limit, "limit"),
        json: Boolean(options.json)
      });
    });

  const todo = program.command("todo");
  todo
    .command("list")
    .option("--file <file>", "Filter by file path")
    .option("--limit <count>", "Maximum number of todo items to return", "30")
    .option("--json", "Print JSON")
    .action(async (options) => {
      await runTodoList({
        cwd: process.cwd(),
        file: options.file,
        limit: collectPositiveInteger(options.limit, "limit"),
        json: Boolean(options.json)
      });
    });

  const skill = program.command("skill");
  skill
    .command("setup")
    .option("--codex", "Install the Canary skill for Codex")
    .option("--claude-code", "Install the Canary skill for Claude Code")
    .action(async (options) => {
      await runSkillSetup({
        codex: Boolean(options.codex),
        claudeCode: Boolean(options.claudeCode)
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
