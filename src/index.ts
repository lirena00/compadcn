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
export { createCatalogIndex, searchInventory } from "./catalog/model.js";
export type { CatalogEntry, CatalogFilters, CatalogSearchReport } from "./catalog/model.js";
export type { SearchOptions } from "./catalog/search.js";
export type { CleanupPlan, CleanupOperation, OwnershipSnapshot, ScopeSnapshot } from "./changes/schema.js";
export type { CleanupPlanOptions } from "./changes/build.js";
export type { OwnershipOptions } from "./changes/ownership.js";
export type { PlanCheckResult } from "./changes/check.js";
export type { ApplyOptions } from "./changes/apply.js";
export type { RestoreOptions } from "./changes/restore.js";
export type { OperationReceipt, VerificationResult } from "./changes/transaction-types.js";
export type { Collection, CreateCollectionOptions } from "./collections/model.js";
export type { CollectionList } from "./collections/files.js";
export type { MigrationOptions, MigrationReport, MigrationIssue } from "./collections/migrate.js";

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

export async function searchCatalog(options:import("./catalog/search.js").SearchOptions={}):Promise<import("./catalog/model.js").CatalogSearchReport> {
  return (await import("./catalog/search.js")).searchCatalog(options);
}

export async function createCleanupPlan(options:import("./changes/build.js").CleanupPlanOptions={}):Promise<import("./changes/schema.js").CleanupPlan> {
  return (await import("./changes/build.js")).createCleanupPlan(options);
}

export async function createOwnershipSnapshot(options:import("./changes/ownership.js").OwnershipOptions={}):Promise<import("./changes/schema.js").OwnershipSnapshot> {
  return (await import("./changes/ownership.js")).createOwnershipSnapshot(options);
}

export async function checkCleanupPlan(plan:unknown,options:import("./changes/build.js").CleanupPlanOptions={}):Promise<import("./changes/check.js").PlanCheckResult> {
  return (await import("./changes/check.js")).checkCleanupPlan(plan,options);
}

export async function parseCleanupPlan(value:unknown):Promise<import("./changes/schema.js").CleanupPlan> {
  return (await import("./changes/schema.js")).parseCleanupPlan(value);
}

export async function parseOwnershipSnapshot(value:unknown):Promise<import("./changes/schema.js").OwnershipSnapshot> {
  return (await import("./changes/schema.js")).parseOwnershipSnapshot(value);
}

export async function applyCleanupPlan(value:unknown, options:import("./changes/apply.js").ApplyOptions={}):Promise<import("./changes/transaction-types.js").OperationReceipt> {
  return (await import("./changes/apply.js")).applyCleanupPlan(value, options);
}

export async function restoreCleanupOperation(id:string, options:import("./changes/restore.js").RestoreOptions={}):Promise<import("./changes/transaction-types.js").OperationReceipt> {
  return (await import("./changes/restore.js")).restoreCleanupOperation(id, options);
}

export async function inspectCleanupOperation(id:string, options:Pick<import("./changes/restore.js").RestoreOptions,"cwd">={}):Promise<import("./changes/transaction-types.js").OperationReceipt> {
  return (await import("./changes/restore.js")).inspectCleanupOperation(id, options);
}

export async function createCollection(options:import("./collections/model.js").CreateCollectionOptions):Promise<import("./collections/model.js").Collection> {
  return (await import("./collections/model.js")).createCollection(options);
}
export async function parseCollection(value:unknown):Promise<import("./collections/model.js").Collection> {
  return (await import("./collections/model.js")).parseCollection(value);
}
export async function readCollection(path:string):Promise<import("./collections/model.js").Collection> {
  return (await import("./collections/files.js")).readCollection(path);
}
export async function writeCollection(value:unknown,path:string):Promise<string> {
  return (await import("./collections/files.js")).writeCollection(value,path);
}
export async function listCollections(directory:string):Promise<import("./collections/files.js").CollectionList> {
  return (await import("./collections/files.js")).listCollections(directory);
}
export async function migrateLegacyPresets(options:import("./collections/migrate.js").MigrationOptions={}):Promise<import("./collections/migrate.js").MigrationReport> {
  return (await import("./collections/migrate.js")).migrateLegacyPresets(options);
}
