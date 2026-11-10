export { createProgram } from "./cli/create-program.js";
export { runCli } from "./cli/run.js";
export { packageInfo } from "./lib/packageInfo.js";
export { CliError } from "./core/errors.js";
export { CliOutput, getOutputMode } from "./cli/output.js";
export type { OutputMode, OutputOptions, OutputWriter } from "./cli/output.js";
export type { ProgramOptions } from "./cli/create-program.js";
export type { CommandSuccess, CommandFailure, CommandResult } from "./core/results.js";
export type { DiscoveryOptions } from "./project/discover.js";
export type { ProjectContext, Diagnostic, ResolvedAlias, Workspace, WorkspacePackage } from "./project/types.js";
export type { InventoryOptions } from "./inventory/build.js";
export type { InventoryReport, InventoryItem, ItemFile, LocalFile } from "./inventory/types.js";
export type { SourceDescriptor, RemoteItem, RemoteFile } from "./registry/types.js";

// Keep importing the API and constructing/helping the CLI free of filesystem scans.
export async function discoverProject(
  options: import("./project/discover.js").DiscoveryOptions = {}
): Promise<import("./project/types.js").ProjectContext> {
  const discovery = await import("./project/discover.js");
  return discovery.discoverProject(options);
}

export async function buildInventory(
  options: import("./inventory/build.js").InventoryOptions = {}
): Promise<import("./inventory/types.js").InventoryReport> {
  const inventory = await import("./inventory/build.js");
  return inventory.buildInventory(options);
}
