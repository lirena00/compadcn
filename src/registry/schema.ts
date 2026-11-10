import { registryItemSchema, registrySchema } from "shadcn/schema";
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

function item(input: unknown, source: RegistrySource, cached: boolean): RemoteItem {
  const parsed = registryItemSchema.safeParse(input);
  if (!parsed.success) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry item does not match the pinned shadcn schema.");
  const data = parsed.data;
  const raw = isObject(input) ? input : {};
  if (!data.name || data.name.split("/").some((part) => !part || part === "." || part === "..")) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry item name is invalid.");
  return {
    name: source.redact(data.name), type: data.type,
    ...(data.title ? { title: source.redact(data.title) } : {}),
    ...(data.description ? { description: source.redact(data.description) } : {}),
    files: (data.files ?? []).map((file, index) => {
      const rawFile: unknown = Array.isArray(raw.files) ? raw.files[index] : undefined;
      const contentHash = typeof file.content === "string" ? digest(file.content) : cached && isObject(rawFile) &&
        typeof rawFile.contentHash === "string" && /^[a-f0-9]{64}$/.test(rawFile.contentHash) ? rawFile.contentHash : undefined;
      return { path: source.redact(file.path), type: file.type,
        ...(file.target ? { target: source.redact(file.target) } : {}), ...(contentHash ? { contentHash } : {}) };
    }),
    dependencies: (data.dependencies ?? []).map((value) => source.redact(safeReference(value))),
    devDependencies: (data.devDependencies ?? []).map((value) => source.redact(safeReference(value))),
    registryDependencies: (data.registryDependencies ?? []).map((value) => ({ id: digest(value), reference: source.redact(safeReference(value)) })),
  };
}

export function parseDocument(input: unknown, source: RegistrySource, kind: "catalog" | "item", cached = false): RegistryDocument {
  if (cached) {
    if (!isObject(input) || !Array.isArray(input.items)) throw new CliError("REGISTRY_CACHE_INVALID", "Cached registry document is invalid.");
    // The normalized dependency records are converted back for upstream validation.
    const items = input.items.map((value: unknown) => item(isObject(value) ? { ...value, registryDependencies: [] } : value, source, true));
    for (let index = 0; index < items.length; index++) {
      const value: unknown = input.items[index];
      if (isObject(value) && Array.isArray(value.registryDependencies)) {
        items[index]!.registryDependencies = value.registryDependencies.map((reference: unknown) => {
          if (!isObject(reference) || typeof reference.id !== "string" || !/^[a-f0-9]{64}$/.test(reference.id) || typeof reference.reference !== "string") {
            throw new CliError("REGISTRY_CACHE_INVALID", "Cached registry dependency is invalid.");
          }
          return { id: reference.id, reference: source.redact(safeReference(reference.reference)) };
        });
      }
    }
    const pagination = input.pagination;
    if (pagination !== undefined && (!isObject(pagination) || !Number.isInteger(pagination.total) || !Number.isInteger(pagination.offset) ||
      !Number.isInteger(pagination.limit) || typeof pagination.hasMore !== "boolean")) throw new CliError("REGISTRY_CACHE_INVALID", "Cached pagination is invalid.");
    return { items, ...(pagination ? { pagination: pagination as RegistryDocument["pagination"] } : {}) };
  }
  if (kind === "item") return { items: [item(input, source, false)] };
  const parsed = registrySchema.safeParse(input);
  if (!parsed.success || parsed.data.include?.length) throw new CliError("REGISTRY_SCHEMA_INVALID", "Registry endpoint must serve a valid flattened catalog.");
  return { items: parsed.data.items.map((value) => item(value, source, false)), ...(parsed.data.pagination ? { pagination: parsed.data.pagination } : {}) };
}
