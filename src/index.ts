export { createProgram } from "./cli/create-program.js";
export { runCli } from "./cli/run.js";
export { packageInfo } from "./lib/packageInfo.js";
export { CliError } from "./core/errors.js";
export { CliOutput, getOutputMode } from "./cli/output.js";
export type { OutputMode, OutputOptions, OutputWriter } from "./cli/output.js";
export type { ProgramOptions } from "./cli/create-program.js";
export type { CommandSuccess, CommandFailure, CommandCancellation, CommandResult } from "./core/results.js";
export type { TaskEvent, TaskStage, ProgressOptions } from "./core/progress.js";
export type { DiscoveryOptions } from "./project/discover.js";
export type { ProjectContext, Diagnostic, ResolvedAlias, Workspace, WorkspacePackage } from "./project/types.js";
export type { InventoryOptions } from "./inventory/build.js";
export type { InventoryReport, InventoryItem, ItemFile, LocalFile } from "./inventory/types.js";
export type { SourceDescriptor, RemoteItem, RemoteFile } from "./registry/types.js";
export type { GraphOptions } from "./graph/build.js";
export type { DependencyGraph, GraphNode, GraphEdge, EdgeKind, GraphCycle } from "./graph/types.js";
export { graphNeighbors } from "./graph/model.js";
export { selectGraph, formatMermaid } from "./graph/export.js";
export { explainAudit } from "./audit/why.js";
export type { AuditOptions } from "./audit/build.js";
export type { AuditReport, WhyReport, FileFinding, ItemFinding, PackageFinding, UsageState } from "./audit/types.js";
export type { EntryRoot } from "./analysis/types.js";
export type { UsageProof } from "./analysis/reachability.js";

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

export async function buildDependencyGraph(
  options: import("./graph/build.js").GraphOptions = {}
): Promise<import("./graph/types.js").DependencyGraph> {
  const graph = await import("./graph/build.js");
  return graph.buildDependencyGraph(options);
}

export async function auditProject(
  options: import("./audit/build.js").AuditOptions = {}
): Promise<import("./audit/types.js").AuditReport> {
  const audit = await import("./audit/build.js");
  return audit.auditProject(options);
}
