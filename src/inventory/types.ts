import type { Diagnostic } from "../project/types.js";
import type { CatalogResult, RemoteItem } from "../registry/types.js";

export interface ItemFile {
  registryPath: string;
  path?: string;
  mapping?: "explicit-target" | "type-default";
  present: boolean;
  contentHash?: string;
  comparison: "exact-remote" | "different-or-transformed" | "unknown";
  diagnostic?: Diagnostic;
}

export interface InventoryItem extends RemoteItem {
  id: string;
  ownerId: string;
  originItemId: string;
  sourceId: string;
  scope: string;
  qualifiedName: string;
  inCatalog: boolean;
  manifest: "catalog" | "fetched" | "stale" | "error";
  presence: "present" | "partial" | "absent" | "unknown";
  originConfidence: "candidate" | "ambiguous" | "unknown";
  mappedFiles: ItemFile[];
  diagnostics: Diagnostic[];
}

export interface LocalFile {
  id: string;
  path: string;
  contentHash: string;
  ownerCandidates: string[];
  origin: "candidate" | "ambiguous" | "unknown";
}

export interface InventoryReport {
  projectRoot: string;
  scopes: string[];
  sources: (Omit<CatalogResult, "items"> & { itemCount: number; ageMs?: number })[];
  items: InventoryItem[];
  files: LocalFile[];
  counts: {
    sources: number;
    incompleteSources: number;
    catalogAddresses: number;
    catalogItems: number;
    presentItemCandidates: number;
    partialItemCandidates: number;
    localFiles: number;
    ambiguousFiles: number;
    unknownFiles: number;
  };
  diagnostics: Diagnostic[];
  complete: boolean;
}
