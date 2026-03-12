import { spawn } from "node:child_process";
import { getAgentDefinition } from "canary-observers";
import type { AgentKind } from "canary-core";

export interface AgentRunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

interface RunAgentProcessParams {
  agent: AgentKind;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function runAgentProcess({
  agent,
  args,
  cwd,
  env
}: RunAgentProcessParams): Promise<AgentRunResult> {
  const definition = getAgentDefinition(agent);

  return new Promise((resolve, reject) => {
    const child = spawn(definition.command, args, {
      cwd,
      stdio: "inherit",
      env: env ?? process.env
    });

    child.once("error", (error) => {
      reject(
        new Error(`${definition.label} failed to start. ${definition.installHint} ${error.message}`)
      );
    });

    child.once("exit", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        signal
      });
    });
  });
}
