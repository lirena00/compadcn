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
  registryDependencies: RegistryReference[];
  resources?: ResourceDeclaration[];
}

export interface RegistryReference {
  id: string;
  reference: string;
  requiresOriginal?: boolean;
}

export interface ResourceDeclaration {
  kind: "css" | "cssVars" | "tailwind" | "envVars" | "config" | "font";
  fingerprint: string;
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
  cache: FetchResult["cache"][];
  fetchedAt?: string;
  diagnostics: Diagnostic[];
}
