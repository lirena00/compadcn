import { registryItemFileSchema, registryItemSchema, registryItemTypeSchema, registryPaginationSchema, registrySchema } from "shadcn/schema";
import { CliError } from "../core/errors.js";
import { isObject } from "../project/files.js";
import { digest, type RegistrySource } from "./source.js";
import type { RegistryDocument, RemoteItem } from "./types.js";

function safeReference(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "[unsupported-address]";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return value; }
}

function item(input: unknown, source: RegistrySource): RemoteItem {
  const parsed = registryItemSchema.safeParse(input);
  if (!parsed.success) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry item does not match the pinned shadcn schema.");
  const data = parsed.data;
  // Remember opaque addresses only in memory. Public/cache projections omit URL
  // credentials; graph traversal can recover them from a fresh parent manifest.
  const references = (data.registryDependencies ?? []).map((value) => {
    const id = source.rememberReference(value);
    const reference = source.redact(safeReference(value));
    return { id, reference, ...(reference !== value ? { requiresOriginal: true } : {}) };
  });
  if (!data.name || data.name.split("/").some((part) => !part || part === "." || part === "..")) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry item name is invalid.");
  return {
    name: source.redact(data.name), type: data.type,
    ...(data.title ? { title: source.redact(data.title) } : {}),
    ...(data.description ? { description: source.redact(data.description) } : {}),
    files: (data.files ?? []).map((file) => {
      const contentHash = typeof file.content === "string" ? digest(file.content) : undefined;
      return { path: source.redact(file.path), type: file.type,
        ...(file.target ? { target: source.redact(file.target) } : {}), ...(contentHash ? { contentHash } : {}) };
    }),
    dependencies: (data.dependencies ?? []).map((value) => source.redact(safeReference(value))),
    devDependencies: (data.devDependencies ?? []).map((value) => source.redact(safeReference(value))),
    registryDependencies: references,
    resources: (["css", "cssVars", "tailwind", "envVars", "config", "font"] as const).flatMap((kind) =>
      kind in data && data[kind as keyof typeof data] !== undefined ? [{ kind, fingerprint: digest(JSON.stringify(data[kind as keyof typeof data])) }] : []),
  };
}

function cachedItem(input: unknown, source: RegistrySource): RemoteItem {
  const invalid = (): never => { throw new CliError("REGISTRY_CACHE_INVALID", "Cached registry item projection is invalid."); };
  if (!isObject(input) || typeof input.name !== "string" || !input.name || input.name.split("/").some((part) => !part || part === "." || part === "..") ||
    !registryItemTypeSchema.safeParse(input.type).success || !Array.isArray(input.files) || !Array.isArray(input.registryDependencies) ||
    (input.title !== undefined && typeof input.title !== "string") || (input.description !== undefined && typeof input.description !== "string")) return invalid();
  const strings = (values: unknown): string[] => {
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return invalid();
    return values.map((value: string) => source.redact(safeReference(value)));
  };
  return {
    name: source.redact(input.name), type: input.type as string,
    ...(typeof input.title === "string" ? { title: source.redact(input.title) } : {}),
    ...(typeof input.description === "string" ? { description: source.redact(input.description) } : {}),
    files: input.files.map((file: unknown) => {
      const parsed = registryItemFileSchema.safeParse(file);
      if (!parsed.success || !isObject(file) || (file.contentHash !== undefined && (typeof file.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(file.contentHash)))) return invalid();
      return { path: source.redact(parsed.data.path), type: parsed.data.type,
        ...(parsed.data.target ? { target: source.redact(parsed.data.target) } : {}),
        ...(typeof file.contentHash === "string" ? { contentHash: file.contentHash } : {}) };
    }),
    dependencies: strings(input.dependencies), devDependencies: strings(input.devDependencies),
    registryDependencies: input.registryDependencies.map((reference: unknown) => {
      if (!isObject(reference) || typeof reference.id !== "string" || !/^[a-f0-9]{64}$/.test(reference.id) || typeof reference.reference !== "string") return invalid();
      if (reference.requiresOriginal !== undefined && typeof reference.requiresOriginal !== "boolean") return invalid();
      return { id: reference.id, reference: source.redact(safeReference(reference.reference)), ...(reference.requiresOriginal ? { requiresOriginal: true } : {}) };
    }),
    resources: Array.isArray(input.resources) ? input.resources.map((value: unknown) => {
      if (!isObject(value) || !["css", "cssVars", "tailwind", "envVars", "config", "font"].includes(String(value.kind)) ||
        typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return invalid();
      return { kind: value.kind as NonNullable<RemoteItem["resources"]>[number]["kind"], fingerprint: value.fingerprint };
    }) : invalid(),
  };
}

export function parseDocument(input: unknown, source: RegistrySource, kind: "catalog" | "item", cached = false): RegistryDocument {
  if (cached) {
    if (!isObject(input) || !Array.isArray(input.items)) throw new CliError("REGISTRY_CACHE_INVALID", "Cached registry document is invalid.");
    const items = input.items.map((value: unknown) => cachedItem(value, source));
    if (kind === "item" && items.length !== 1) throw new CliError("REGISTRY_CACHE_INVALID", "Cached item response must contain one manifest.");
    const pagination = input.pagination;
    if (pagination !== undefined && !registryPaginationSchema.safeParse(pagination).success) throw new CliError("REGISTRY_CACHE_INVALID", "Cached pagination is invalid.");
    return { items, ...(pagination ? { pagination: pagination as RegistryDocument["pagination"] } : {}) };
  }
  if (kind === "item") return { items: [item(input, source)] };
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success || parsed.data.include?.length) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry endpoint must serve a valid flattened catalog.");
  return { items: parsed.data.items.map((value) => item(value, source)), ...(parsed.data.pagination ? { pagination: parsed.data.pagination } : {}) };
}
