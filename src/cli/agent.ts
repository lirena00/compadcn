import { getAgentSkill, installAgentSkill } from "../agent/skill.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";
import { terminalText } from "./text.js";

export async function runAgentSkill(options: { out?: string }, outputOptions: OutputOptions): Promise<void> {
  const mode = getOutputMode(outputOptions);
  if (options.out) {
    const installed = await installAgentSkill(options.out);
    new CliOutput(mode).success({ skill: installed }, `Wrote shadcn-plus agent skill: ${terminalText(installed.output, 4096)}`);
  } else {
    const skill = await getAgentSkill(); new CliOutput(mode).success({ skill }, skill.content);
  }
}
