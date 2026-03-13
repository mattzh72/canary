import type { AgentKind } from "@canaryctl/core";

export interface AgentDefinition {
  kind: AgentKind;
  label: string;
  command: string;
  installHint: string;
}

const AGENTS: Record<AgentKind, AgentDefinition> = {
  codex: {
    kind: "codex",
    label: "Codex",
    command: "codex",
    installHint: "Install the Codex CLI and make sure `codex` is on PATH."
  },
  claude: {
    kind: "claude",
    label: "Claude Code",
    command: "claude",
    installHint: "Install Claude Code and make sure `claude` is on PATH."
  }
};

export function isSupportedAgent(value: string): value is AgentKind {
  return value === "codex" || value === "claude";
}

export function getAgentDefinition(kind: AgentKind): AgentDefinition {
  return AGENTS[kind];
}

export function listAgents(): AgentDefinition[] {
  return Object.values(AGENTS);
}
