import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../core/hash.js";

export async function getAgentSkill(): Promise<{ name: string; format: string; content: string; sha256: string }> {
  const content = await readFile(new URL("../../skills/shadcn-plus/SKILL.md", import.meta.url), "utf8");
  return { name: "shadcn-plus", format: "agent-skills", content, sha256: digest(content) };
}

export async function installAgentSkill(directory: string): Promise<{ name: string; output: string; sha256: string }> {
  const { assertNewPath, writeNewFile } = await import("../collections/files.js");
  const skill = await getAgentSkill(), output = await assertNewPath(join(directory, "SKILL.md"));
  await mkdir(directory, { recursive: true }); await writeNewFile(output, skill.content);
  return { name: skill.name, output, sha256: skill.sha256 };
}
