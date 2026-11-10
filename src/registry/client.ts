import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "../core/errors.js";
import { isObject } from "../project/files.js";
import { parseDocument } from "./schema.js";
import type { RegistrySource } from "./source.js";
import type { CatalogResult, FetchResult, RegistryDocument } from "./types.js";

export interface RegistryClientOptions {
  cacheDir?: string | false;
  offline?: boolean;
  refresh?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

interface CacheEntry {
  version: 3;
  fetchedAt: string;
  checkedAt: string;
  etag?: string;
  lastModified?: string;
  document: RegistryDocument;
}

export async function mapLimit<T, U>(values: T[], limit: number, operation: (value: T) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await operation(values[index]!);
    }
  }));
  return result;
}

export class RegistryClient {
  #inflight = new Map<string, Promise<FetchResult>>();
  #settled = new Map<string, FetchResult>();
  #cacheDir: string | false;
  #ttl: number;
  #timeout: number;
  #maxBytes: number;
  #fetch: typeof globalThis.fetch;

  constructor(private readonly options: RegistryClientOptions = {}) {
    this.#cacheDir = options.cacheDir === false ? false : resolve(options.cacheDir ?? join(homedir(), ".cache", "shadcn-plus", "registry-v3"));
    this.#ttl = options.ttlMs ?? 300_000;
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!Number.isFinite(this.#ttl) || this.#ttl < 0 || !Number.isFinite(this.#timeout) || this.#timeout <= 0 || this.#timeout > 60_000 ||
      !Number.isInteger(this.#maxBytes) || this.#maxBytes <= 0) throw new CliError("INVALID_OPTIONS", "Registry cache lifetime, timeout, or response size is invalid.");
  }

  fetch(source: RegistrySource, name: string, kind: "catalog" | "item", page?: { offset: number; limit: number }): Promise<FetchResult> {
    if (this.options.signal?.aborted) return Promise.reject(new CliError("REGISTRY_CANCELLED", "Registry request was cancelled."));
    const request = source.request(name, page);
    const key = `${kind}-${request.key}`;
    const settled = this.#settled.get(key);
    if (settled) return Promise.resolve(settled);
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const operation = this.#load(source, request, key, kind, name).then((result) => {
      this.#settled.set(key, result);
      return result;
    }).finally(() => { this.#inflight.delete(key); });
    this.#inflight.set(key, operation);
    return operation;
  }

  async recoverReferences(source: RegistrySource, name: string): Promise<FetchResult> {
    const request = source.request(name);
    const key = `item-${request.key}`;
    const result = await this.#load(source, request, key, "item", name, true);
    this.#settled.set(key, result);
    return result;
  }

  async #read(key: string, source: RegistrySource, kind: "catalog" | "item", name: string): Promise<CacheEntry | null> {
    if (!this.#cacheDir) return null;
    try {
      const input: unknown = JSON.parse(await readFile(join(this.#cacheDir, `${key}.json`), "utf8"));
      if (!isObject(input) || input.version !== 3 || typeof input.fetchedAt !== "string" || typeof input.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(input.fetchedAt)) || !Number.isFinite(Date.parse(input.checkedAt)) ||
        (input.etag !== undefined && typeof input.etag !== "string") || (input.lastModified !== undefined && typeof input.lastModified !== "string")) return null;
      const document = parseDocument(input.document, source, kind, true);
      if (kind === "item" && !source.direct && document.items[0]?.name !== name) return null;
      return { version: 3, fetchedAt: input.fetchedAt, checkedAt: input.checkedAt,
        ...(typeof input.etag === "string" ? { etag: input.etag } : {}),
        ...(typeof input.lastModified === "string" ? { lastModified: input.lastModified } : {}),
        document };
    } catch { return null; }
  }

  async #write(key: string, entry: CacheEntry): Promise<void> {
    if (!this.#cacheDir) return;
    await mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
    const target = join(this.#cacheDir, `${key}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  async #load(source: RegistrySource, request: ReturnType<RegistrySource["request"]>, key: string, kind: "catalog" | "item", name: string, fresh = false): Promise<FetchResult> {
    if (this.options.signal?.aborted) throw new CliError("REGISTRY_CANCELLED", "Registry request was cancelled.");
    const cached = fresh ? null : await this.#read(key, source, kind, name);
    if (cached && (this.options.offline || (!this.options.refresh && Date.now() - Date.parse(cached.checkedAt) < this.#ttl))) {
      const stale = Date.now() - Date.parse(cached.checkedAt) >= this.#ttl;
      return { document: cached.document, fetchedAt: cached.fetchedAt, cache: stale ? "stale-cache" : "fresh-cache",
        ...(stale ? { diagnostic: { code: "REGISTRY_CACHE_STALE", severity: "warning" as const, message: "Offline registry metadata is older than the cache lifetime." } } : {}) };
    }
    if (this.options.offline) throw new CliError("REGISTRY_CACHE_MISS", "Registry metadata is unavailable in the current offline cache context.");
    const headers = new Headers(request.headers);
    if (cached?.etag) headers.set("if-none-match", cached.etag);
    if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);
    try {
      const response = await this.#request(request.url, headers);
      if (response.status === 304) {
        if (!cached) throw new CliError("REGISTRY_RESPONSE_INVALID", "Registry returned 304 without a cached response.");
        await response.body?.cancel();
        const updated = { ...cached, checkedAt: new Date().toISOString() };
        let diagnostic;
        try { await this.#write(key, updated); } catch { diagnostic = { code: "REGISTRY_CACHE_WRITE_FAILED", severity: "warning" as const, message: "Registry metadata was revalidated but its cache could not be updated." }; }
        return { document: cached.document, fetchedAt: cached.fetchedAt, cache: "revalidated", ...(diagnostic ? { diagnostic } : {}) };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CliError(response.status === 401 ? "REGISTRY_UNAUTHORIZED" : response.status === 403 ? "REGISTRY_FORBIDDEN" : response.status === 404 ? "REGISTRY_NOT_FOUND" : "REGISTRY_HTTP_ERROR",
          `Registry request failed with HTTP ${response.status}.`, { status: response.status });
      }
      const input = await this.#json(response);
      const document = parseDocument(input, source, kind);
      if (kind === "item" && !source.direct && document.items[0]?.name !== name) throw new CliError("REGISTRY_ITEM_MISMATCH", "Requested manifest returned a different item name.");
      const now = new Date().toISOString();
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const entry: CacheEntry = { version: 3, fetchedAt: now, checkedAt: now, document,
        ...(etag ? { etag: source.redact(etag) } : {}), ...(lastModified ? { lastModified: source.redact(lastModified) } : {}) };
      let diagnostic;
      try { await this.#write(key, entry); } catch { diagnostic = { code: "REGISTRY_CACHE_WRITE_FAILED", severity: "warning" as const, message: "Registry metadata was fetched but could not be cached." }; }
      return { document, fetchedAt: now, cache: "network", ...(diagnostic ? { diagnostic } : {}) };
    } catch (error) {
      const failure = error instanceof CliError ? error : new CliError("REGISTRY_FETCH_FAILED", "Registry request failed or timed out.");
      if (cached && failure.code !== "REGISTRY_CANCELLED" && !this.options.signal?.aborted) {
        return { document: cached.document, fetchedAt: cached.fetchedAt, cache: "stale-cache", diagnostic: {
          code: failure.code, severity: "error", message: `${failure.message} Retaining cached metadata as stale.`,
        } };
      }
      if (this.options.signal?.aborted) throw new CliError("REGISTRY_CANCELLED", "Registry request was cancelled.");
      throw failure;
    }
  }

  async #request(initial: URL, headers: Headers): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const signal = AbortSignal.any([AbortSignal.timeout(this.#timeout), ...(this.options.signal ? [this.options.signal] : [])]);
      try {
        let url = initial;
        for (let redirects = 0; redirects <= 3; redirects++) {
          const response = await this.#fetch(url, { headers, signal, redirect: "manual" });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            const next = location ? new URL(location, url) : null;
            if (!next || redirects === 3 || next.origin !== initial.origin || next.username || next.password) {
              throw new CliError("REGISTRY_REDIRECT_BLOCKED", "Registry redirect leaves its configured origin or exceeds the redirect limit.");
            }
            url = next;
            continue;
          }
          if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
            const retryAfter = response.headers.get("retry-after");
            const seconds = retryAfter ? Number(retryAfter) : NaN;
            const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
            // Do not retry earlier than a long server-requested backoff.
            if (requested > 1000) return response;
            const wait = Number.isFinite(requested) && requested > 0 ? requested : 100 * (attempt + 1);
            await response.body?.cancel();
            await delay(wait, undefined, { signal: this.options.signal });
            break;
          }
          return response;
        }
      } catch (error) {
        if (error instanceof CliError || this.options.signal?.aborted || attempt === 2) throw error;
        await delay(100 * (attempt + 1), undefined, { signal: this.options.signal });
      }
    }
    throw new CliError("REGISTRY_FETCH_FAILED", "Registry request retries were exhausted.");
  }

  async #json(response: Response): Promise<unknown> {
    if (!response.body) throw new CliError("REGISTRY_RESPONSE_INVALID", "Registry response is empty.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > this.#maxBytes) throw new CliError("REGISTRY_RESPONSE_TOO_LARGE", "Registry response exceeds the configured size limit.");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof CliError) throw error;
      throw new CliError("REGISTRY_RESPONSE_INVALID", "Registry response is not readable JSON or its body timed out.");
    } finally { reader.releaseLock(); }
  }

  async catalog(source: RegistrySource): Promise<CatalogResult> {
    const result: CatalogResult = { source: source.descriptor, status: "ready", items: [], pages: 0, cache: [], diagnostics: [] };
    const names = new Set<string>();
    let offset = 0;
    try {
      for (let page = 0; page < 100; page++) {
        const fetched = await this.fetch(source, "registry", "catalog", { offset, limit: 100 });
        result.pages++;
        if (!result.cache.includes(fetched.cache)) result.cache.push(fetched.cache);
        result.fetchedAt = !result.fetchedAt || fetched.fetchedAt < result.fetchedAt ? fetched.fetchedAt : result.fetchedAt;
        if (fetched.cache === "stale-cache") result.status = "stale";
        if (fetched.diagnostic) result.diagnostics.push(fetched.diagnostic);
        for (const item of fetched.document.items) {
          if (names.has(item.name)) throw new CliError("REGISTRY_PAGINATION_INVALID", "Registry catalog repeats an item across pages.");
          names.add(item.name); result.items.push(item);
        }
        const pagination = fetched.document.pagination;
        if (pagination && (!Number.isInteger(pagination.total) || !Number.isInteger(pagination.offset) || !Number.isInteger(pagination.limit) ||
          pagination.total < 0 || pagination.offset !== offset || pagination.limit < 0 || (!pagination.hasMore && pagination.total !== result.items.length))) {
          throw new CliError("REGISTRY_PAGINATION_INVALID", "Registry pagination totals or offsets are inconsistent.");
        }
        if (!pagination?.hasMore) return result;
        if (pagination.limit <= 0 || !fetched.document.items.length) {
          throw new CliError("REGISTRY_PAGINATION_INVALID", "Registry pagination does not advance consistently.");
        }
        offset += pagination.limit;
      }
      throw new CliError("REGISTRY_PAGINATION_LIMIT", "Registry catalog exceeds the 100-page limit; inventory is incomplete.");
    } catch (error) {
      const failure = error instanceof CliError ? error : new CliError("REGISTRY_FETCH_FAILED", "Cannot read registry catalog.");
      result.status = failure.code === "REGISTRY_NOT_FOUND" && result.pages === 0 ? "catalog-unavailable" : "error";
      result.diagnostics.push({ code: result.status === "catalog-unavailable" ? "REGISTRY_CATALOG_UNAVAILABLE" : failure.code,
        severity: result.status === "catalog-unavailable" ? "warning" : "error", message: failure.message });
      return result;
    }
  }
}
