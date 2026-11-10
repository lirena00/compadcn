import { CliError } from "../core/errors.js";
import { discoverProject } from "../project/discover.js";
import type { ProjectContext } from "../project/types.js";
import { CliOutput, getOutputMode, type OutputOptions } from "./output.js";

export function formatDoctor(context: ProjectContext): string {
  const lines = [
    `Project: ${context.projectRoot}`,
    `Framework: ${context.framework}`,
    `Workspace: ${context.workspace?.root ?? "standalone"}`,
    `Package manager: ${context.packageManager ? `${context.packageManager.name} (${context.packageManager.source} in ${context.packageManager.directory})` : "unresolved"}`,
    `Compiler configs: ${context.compilerConfigs.join(", ") || "none"}`,
    `Components config: ${context.components?.path ?? "unresolved"}`,
  ];
  for (const [name, target] of Object.entries(context.components?.resolvedAliases ?? {})) {
    lines.push(`Alias ${name}: ${target.specifier} -> ${target.path} (${target.source}${target.exists ? "" : ", not created"})`);
  }
  for (const diagnostic of context.diagnostics) {
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` [${diagnostic.path}]` : ""}`);
  }
  lines.push(context.ready ? "Discovery complete. Configuration targets resolved." : "Discovery incomplete. Resolve the errors above and rerun doctor.");
  return lines.join("\n");
}

export function runDoctor(cwd: string, options: OutputOptions): void {
  const context = discoverProject({ cwd });
  const text = formatDoctor(context);
  const mode = getOutputMode(options);
  if (!context.ready) {
    throw new CliError("PROJECT_NOT_READY", mode === "json" ? "Project configuration could not be fully resolved. See context diagnostics." : text, { context });
  }
  new CliOutput(mode).success(context, text);
}
