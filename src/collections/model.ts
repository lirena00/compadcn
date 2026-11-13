import { z } from "zod";
import { CliError } from "../core/errors.js";
import { isQualifiedAddress, requestedAddresses } from "../catalog/requests.js";

export const collectionSchema = z.strictObject({
  collectionVersion: z.literal(1), name: z.string().min(1).max(256).refine(value => !!value.trim()),
  description: z.string().max(4096),
  items: z.array(z.string().max(4096).refine(isQualifiedAddress)).min(1).max(1000).refine(items => new Set(items).size === items.length),
});
export type Collection = z.infer<typeof collectionSchema>;
export interface CreateCollectionOptions { name: string; description?: string; items?: string[]; bases?: Collection[] }

export function parseCollection(input: unknown): Collection {
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > 1024 * 1024) throw new CliError("COLLECTION_INVALID", "Collection files must be at most 1 MiB.");
    try { input = JSON.parse(input.replace(/^\uFEFF/, "")); } catch { throw new CliError("COLLECTION_INVALID", "Collection is not valid JSON."); }
  }
  const result = collectionSchema.safeParse(input);
  if (!result.success) throw new CliError("COLLECTION_INVALID", "Use a version 1 collection with a name, description, and 1–1000 unique qualified item addresses. Registry configuration, scripts, and dependency metadata do not belong in a collection.");
  if (Buffer.byteLength(JSON.stringify(result.data, null, 2) + "\n") > 1024 * 1024) throw new CliError("COLLECTION_INVALID", "Collection files must be at most 1 MiB.");
  return result.data;
}

export function createCollection(options: CreateCollectionOptions): Collection {
  const inherited = (options.bases ?? []).flatMap(base => parseCollection(base).items);
  return parseCollection({ collectionVersion: 1, name: options.name, description: options.description ?? "", items: requestedAddresses([...inherited, ...(options.items ?? [])]) });
}
