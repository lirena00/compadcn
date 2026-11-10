import { resolve } from "node:path";
import { isObject, readObject } from "../project/files.js";
import type { DependencyGraph } from "../graph/types.js";
import type { KnipAnalysis, RootPolicy } from "../analysis/types.js";
import type { ReachIndex } from "../analysis/reachability.js";
import type { ItemFinding, PackageFinding } from "./types.js";

export function auditPackages(graph: DependencyGraph, policy: RootPolicy, analysis: KnipAnalysis, items: ItemFinding[], runtime: ReachIndex, all: ReachIndex, reliable: boolean): PackageFinding[] {
  const results: PackageFinding[] = [];
  const retainedFramework = new Set(["react", "react-dom", "next", "vite", "typescript"]);
  const itemForNode = new Map(items.flatMap((item) => item.nodeIds.map((id) => [id, item] as const)));
  const fileOwners = new Map<string, ItemFinding[]>();
  for (const item of items) for (const file of item.files) { const rows=fileOwners.get(file)??[]; rows.push(item);fileOwners.set(file,rows); }
  const byPackage = new Map<string, DependencyGraph["edges"]>();
  for (const edge of graph.edges) if (edge.kind === "declared-package" || edge.kind === "package-import") {
    const rows = byPackage.get(edge.to) ?? []; rows.push(edge); byPackage.set(edge.to, rows);
  }
  const manifests = new Map<string, ReturnType<typeof readObject>>();
  const unused = (run: KnipAnalysis["all"]) => new Set(run.unusedPackages.map(({path,name})=>`${path}\0${name}`));
  const allUnused = unused(analysis.all), productionUnused = unused(analysis.production);
  const publicScopes = new Set(policy.scopes.filter(({publicContract})=>publicContract).map(({root})=>root));
  for (const node of graph.nodes) {
    if (node.kind !== "package" || !node.packageName) continue;
    const edges = byPackage.get(node.id) ?? [];
    const declaredBy = edges.filter((edge) => edge.kind === "declared-package").flatMap(({ from }) => itemForNode.has(from) ? [itemForNode.get(from)!] : []);
    const imports = edges.filter((edge) => edge.kind === "package-import");
    if (!declaredBy.length && !imports.some(({ from }) => fileOwners.has(from))) continue;
    const manifestPath = resolve(node.scope, "package.json");
    const manifest = manifests.get(manifestPath) ?? readObject(manifestPath, "PACKAGE_JSON_INVALID");
    manifests.set(manifestPath, manifest);
    const declared = { ...(isObject(manifest.devDependencies) ? manifest.devDependencies : {}), ...(isObject(manifest.dependencies) ? manifest.dependencies : {}) };
    const unusedAll = allUnused.has(`${manifestPath}\0${node.packageName}`);
    const unusedProduction = productionUnused.has(`${manifestPath}\0${node.packageName}`);
    const reasons: string[] = [];
    let status: PackageFinding["status"] = "retain";
    if (imports.some(({ from, phase }) => runtime.has(from) && phase === "runtime")) { status = "runtime"; reasons.push("OBSERVED_RUNTIME_PACKAGE_IMPORT"); }
    else if (imports.some(({ from }) => all.has(from))) { status = "development-only"; reasons.push("OBSERVED_DEVELOPMENT_PACKAGE_IMPORT"); }
    else {
      if (!reliable) reasons.push("ANALYSIS_INCOMPLETE");
      if (!Object.hasOwn(declared, node.packageName)) reasons.push("PACKAGE_NOT_DECLARED");
      if (retainedFramework.has(node.packageName)) reasons.push("FRAMEWORK_PACKAGE_RETAINED");
      if (publicScopes.has(node.scope) || (isObject(manifest.peerDependencies) && Object.hasOwn(manifest.peerDependencies, node.packageName))) reasons.push("PUBLIC_PACKAGE_REQUIREMENT");
      if (isObject(manifest.scripts) && Object.values(manifest.scripts).some((value) => typeof value === "string" && value.includes(node.packageName!))) reasons.push("SCRIPT_PACKAGE_REQUIREMENT");
      if (declaredBy.some(({ usage }) => usage !== "unused-candidate")) reasons.push("RETAINED_ITEM_REQUIREMENT");
      if (imports.some(({ from }) => !fileOwners.has(from) || fileOwners.get(from)!.some(({ usage }) => usage !== "unused-candidate"))) reasons.push("RETAINED_SOURCE_REQUIREMENT");
      if (!unusedAll || !unusedProduction) reasons.push("KNIP_PACKAGE_USE_OR_UNCERTAINTY");
      if (!reasons.length) { status = "candidate"; reasons.push("ANALYZERS_AGREE_PACKAGE_UNUSED"); }
    }
    results.push({ id: node.id, name: node.packageName, scope: node.scope, status, reasons, relatedItems: [...new Set([...declaredBy, ...imports.flatMap(({from})=>fileOwners.get(from)??[])].map(({ id }) => id))].sort(), cleanup: { eligible: false } });
  }
  return results.sort((a,b)=>a.scope.localeCompare(b.scope)||a.name.localeCompare(b.name));
}
