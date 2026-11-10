import type { Diagnostic } from "../project/types.js";

export interface SourceDescriptor {
  id: string;
  originId: string;
  namespace: string;
  scope: string;
  configPath: string;
  style: string;
  authenticated: boolean;
}

export interface RemoteFile {
  path: string;
  type: string;
  target?: string;
  contentHash?: string;
}

export interface RemoteItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  files: RemoteFile[];
  dependencies: string[];
  devDependencies: string[];
  registryDependencies: { id: string; reference: string }[];
}

export interface RegistryDocument {
  items: RemoteItem[];
  pagination?: { total: number; offset: number; limit: number; hasMore: boolean };
}

export interface FetchResult {
  document: RegistryDocument;
  fetchedAt: string;
  cache: "network" | "fresh-cache" | "revalidated" | "stale-cache";
  diagnostic?: Diagnostic;
}

export interface CatalogResult {
  source: SourceDescriptor;
  status: "ready" | "stale" | "catalog-unavailable" | "error";
  items: RemoteItem[];
  pages: number;
  fetchedAt?: string;
  diagnostics: Diagnostic[];
}
