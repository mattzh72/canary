import fs from "node:fs/promises";
import { getCanonicalCanarySkillPath, replaceSkillSymlink, resolveSkillInstallTargets } from "../skill/setup.js";

interface SkillSetupInput {
  codex?: boolean;
  claudeCode?: boolean;
}

export async function runSkillSetup(input: SkillSetupInput): Promise<void> {
  const targets = [
    input.codex ? "codex" : null,
    input.claudeCode ? "claude-code" : null
  ].filter((value): value is "codex" | "claude-code" => value !== null);

  if (targets.length === 0) {
    throw new Error("Choose at least one target: --codex or --claude-code");
  }

  const sourcePath = getCanonicalCanarySkillPath();
  const sourceStats = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    throw new Error(`Missing canonical Canary skill directory: ${sourcePath}`);
  }

  const installs = resolveSkillInstallTargets(targets);
  for (const install of installs) {
    const status = await replaceSkillSymlink(sourcePath, install.destinationPath);
    process.stdout.write(
      `[skill] ${status} ${install.target} -> ${install.destinationPath}\n`
    );
  }
}
