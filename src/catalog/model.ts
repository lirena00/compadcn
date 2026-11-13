import type { InventoryItem, InventoryReport } from "../inventory/types.js";
import { CliError } from "../core/errors.js";

export interface CatalogEntry {
  id: string;
  address: string;
  scope: string;
  sourceId: string;
  namespace: string;
  type: string;
  title?: string;
  description?: string;
  presence: InventoryItem["presence"];
  origin: InventoryItem["originConfidence"];
  metadata: InventoryItem["manifest"];
  sourceStatus: InventoryReport["sources"][number]["status"];
}

export interface CatalogFilters {
  query?: string;
  registries?: string[];
  types?: string[];
  presence?: "any" | CatalogEntry["presence"];
  scope?: string;
}

export interface CatalogSearchReport {
  catalogVersion: 1;
  projectRoot: string;
  scopes: string[];
  entries: CatalogEntry[];
  totalEntries: number;
  matchedEntries: number;
  omittedEntries: number;
  sources: InventoryReport["sources"];
  diagnostics: InventoryReport["diagnostics"];
  complete: boolean;
}

export function validateCatalogFilters(filters: CatalogFilters): void {
  if (filters.presence && !["any", "present", "partial", "absent", "unknown"].includes(filters.presence)) throw new CliError("INVALID_OPTIONS", "Presence must be any, present, partial, absent, or unknown.");
  if (filters.registries?.some((value)=>!/^@[\w-]+$/.test(value)) || filters.types?.some((value)=>!/^((registry:)?[a-z][a-z-]*)$/.test(value))) throw new CliError("INVALID_OPTIONS", "Registry filters must be @namespaces and type filters must be registry types such as ui or registry:block.");
}

export function catalogEntries(report: InventoryReport): CatalogEntry[] {
  const sources = new Map(report.sources.map((source)=>[source.source.id, source]));
  return report.items.map((item)=>{
    const source=sources.get(item.sourceId)!;
    return { id:item.id, address:item.qualifiedName, scope:item.scope, sourceId:item.sourceId, namespace:source.source.namespace,
      type:item.type, ...(item.title ? {title:item.title} : {}), ...(item.description ? {description:item.description} : {}),
      presence:item.presence, origin:item.originConfidence, metadata:item.manifest, sourceStatus:source.status };
  });
}

export function createCatalogIndex(entries: CatalogEntry[], filters: CatalogFilters = {}) {
  validateCatalogFilters(filters);
  const types=new Set(filters.types?.map((type)=>type.startsWith("registry:") ? type : `registry:${type}`));
  const registries=new Set(filters.registries);
  const pool=entries.filter((entry)=>(!filters.scope || entry.scope===filters.scope) && (!registries.size || registries.has(entry.namespace)) &&
    (!types.size || types.has(entry.type)) && (!filters.presence || filters.presence==="any" || filters.presence===entry.presence));
  const text=new Map(pool.map((entry)=>[entry.id,`${entry.address} ${entry.title ?? ""} ${entry.description ?? ""} ${entry.type} ${entry.presence}`.normalize("NFKC").toLowerCase()]));
  let previous="", terms:string[]=[];
  const matches=(query:string,id:string) => {
    if(query!==previous){previous=query;terms=query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);}
    const value=text.get(id);
    return value!==undefined && terms.every((term)=>value.includes(term));
  };
  return {entries:pool,matches,search:(query=filters.query ?? "")=>pool.filter(({id})=>matches(query,id))};
}

export function searchInventory(report: InventoryReport, filters: CatalogFilters = {}, limit = 50): CatalogSearchReport {
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new CliError("INVALID_OPTIONS","Search limit must be between 1 and 1000.");
  const entries=catalogEntries(report),matched=createCatalogIndex(entries,filters).search();
  return {catalogVersion:1,projectRoot:report.projectRoot,scopes:report.scopes,entries:matched.slice(0,limit),totalEntries:entries.length,
    matchedEntries:matched.length,omittedEntries:Math.max(0,matched.length-limit),sources:report.sources,
    diagnostics:[...report.diagnostics,...report.sources.flatMap(({diagnostics})=>diagnostics),...report.items.flatMap(({diagnostics})=>diagnostics)],complete:report.complete};
}
