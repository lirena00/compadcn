import { existsSync } from "node:fs";
import { join } from "node:path";
import { registryConfigItemSchema } from "shadcn/schema";
import { CliError } from "../core/errors.js";
import { isObject, readObject } from "../project/files.js";
import type { Diagnostic } from "../project/types.js";
import type { SourceDescriptor } from "./types.js";
import { digest } from "../core/hash.js";

export { digest } from "../core/hash.js";
type Definition = { url: string; headers?: Record<string, string>; params?: Record<string, string> };
const builtin = "https://ui.shadcn.com/r/styles/{style}/{name}.json";

export class RegistrySource {
  readonly descriptor: SourceDescriptor;
  #definition: Definition;
  #secrets: string[] = [];
  #references = new Map<string, string>();

  constructor(namespace: string, definition: Definition, scope: string, configPath: string, style: string, env: NodeJS.ProcessEnv, readonly direct = false) {
    const secrets = new Set<string>();
    const expand = (value: string): string => value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
      const result = env[name];
      if (result === undefined || result === "") throw new CliError("REGISTRY_ENV_MISSING", "A configured registry environment variable is missing.");
      if (result.length >= 4) secrets.add(result);
      return result;
    });
    const entries = (record: Record<string, string> = {}): Record<string, string> => Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, expand(value)])
    );
    this.#definition = { url: expand(definition.url), headers: entries(definition.headers), params: entries(definition.params) };
    for (const value of [...Object.values(this.#definition.headers!), ...Object.values(this.#definition.params!)]) {
      if (value.length >= 4) secrets.add(value);
      const token = value.replace(/^Bearer\s+/i, "");
      if (token.length >= 4) secrets.add(token);
    }
    if (!direct && (!this.#definition.url.includes("{name}") || /\{(?!name\}|style\})/.test(this.#definition.url))) {
      throw new CliError("REGISTRY_URL_INVALID", "Registry URL must contain {name} and only supported placeholders.");
    }
    const url = new URL(this.#definition.url.replaceAll("{name}", "registry").replaceAll("{style}", encodeURIComponent(style)));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new CliError("REGISTRY_URL_INVALID", "Registry URLs must use HTTP(S) without embedded user credentials.");
    }
    for (const value of url.searchParams.values()) if (value.length >= 4) secrets.add(value);
    // Validate headers now; errors never include their values.
    try { new Headers(this.#definition.headers); } catch {
      throw new CliError("REGISTRY_CONFIG_INVALID", "Registry headers are invalid.");
    }
    const authenticated = secrets.size > 0 || Object.keys(definition.headers ?? {}).length > 0 ||
      Object.keys(definition.params ?? {}).length > 0 || !!url.search;
    const identity = digest(JSON.stringify([this.#definition.url, style, this.#definition.params, this.#definition.headers, authenticated ? scope : null]));
    this.descriptor = { id: digest(JSON.stringify([scope, namespace, identity])), originId: identity, namespace, scope, configPath, style, authenticated };
    this.#secrets = [...secrets].sort((a, b) => b.length - a.length);
  }

  request(name: string, page?: { offset: number; limit: number }): { url: URL; headers: Headers; key: string } {
    if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new CliError("REGISTRY_ITEM_INVALID", "Registry item name is invalid.");
    }
    const value = this.direct ? this.#definition.url : this.#definition.url.replaceAll("{name}", name.split("/").map(encodeURIComponent).join("/"))
      .replaceAll("{style}", encodeURIComponent(this.descriptor.style));
    const url = new URL(value);
    for (const [key, value] of Object.entries(this.#definition.params ?? {})) url.searchParams.append(key, value);
    if (page) { url.searchParams.set("offset", String(page.offset)); url.searchParams.set("limit", String(page.limit)); }
    const headers = new Headers(this.#definition.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    const sortedHeaders = [...headers.entries()].sort(([a], [b]) => a.localeCompare(b));
    const key = digest(JSON.stringify([3, url.href, sortedHeaders, this.descriptor.authenticated ? this.descriptor.scope : null]));
    return { url, headers, key };
  }

  redact(value: string): string {
    for (const secret of this.#secrets) value = value.replaceAll(secret, "[redacted]");
    return value;
  }

  rememberReference(value: string): string {
    const id = digest(value);
    this.#references.set(id, value);
    try {
      const url = new URL(value);
      for (const secret of [url.password, ...url.searchParams.values()]) if (secret.length >= 4 && !this.#secrets.includes(secret)) this.#secrets.push(secret);
      this.#secrets.sort((a, b) => b.length - a.length);
    } catch { /* Qualified references contain no URL credentials. */ }
    return id;
  }

  originalReference(id: string): string | undefined { return this.#references.get(id); }

  toJSON(): SourceDescriptor { return this.descriptor; }
}

export function loadRegistrySources(root: string, env: NodeJS.ProcessEnv = process.env): { sources: RegistrySource[]; diagnostics: Diagnostic[] } {
  const sources: RegistrySource[] = [];
  const diagnostics: Diagnostic[] = [];
  const packagePath = join(root, "package.json");
  const componentsPath = join(root, "components.json");
  try {
    const manifest = readObject(packagePath, "PACKAGE_JSON_INVALID");
    const components = existsSync(componentsPath) ? readObject(componentsPath, "CONFIG_INVALID") : {};
    const definitions = new Map<string, { value: unknown; path: string }>([["@shadcn", { value: builtin, path: "shadcn@4.23.0" }]]);
    // Verified against getRegistriesConfig in shadcn 4.23.0: components override
    // package entries, and both override the built-in namespace. No parent merge.
    for (const [object, path] of [[manifest, packagePath], [components, componentsPath]] as const) {
      if (object.registries === undefined) continue;
      if (!isObject(object.registries)) {
        diagnostics.push({ code: "REGISTRY_CONFIG_INVALID", severity: "error", message: "Registries must be a namespace-to-source object.", path });
        continue;
      }
      for (const [namespace, value] of Object.entries(object.registries)) definitions.set(namespace, { value, path });
    }
    const style = typeof components.style === "string" && components.style &&
      !(components.style === "new-york" && isObject(components.tailwind) && components.tailwind.config === "") ? components.style : "new-york-v4";
    for (const [namespace, { value, path }] of definitions) {
      try {
        if (!/^@[\w-]+$/.test(namespace)) throw new CliError("REGISTRY_NAMESPACE_INVALID", "Registry namespace must start with @ and contain only letters, digits, underscores or hyphens.");
        const parsed = registryConfigItemSchema.safeParse(value);
        if (!parsed.success) throw new CliError("REGISTRY_CONFIG_INVALID", "Registry definition must be a URL template or an object with string URL, headers and params.");
        const definition = typeof parsed.data === "string" ? { url: parsed.data } : parsed.data;
        sources.push(new RegistrySource(namespace, definition, root, path, style, env));
      } catch (error) {
        diagnostics.push({ code: error instanceof CliError ? error.code : "REGISTRY_URL_INVALID", severity: "error", message: `${namespace}: ${error instanceof CliError ? error.message : "Registry URL is invalid."}`, path });
      }
    }
  } catch (error) {
    diagnostics.push({ code: error instanceof CliError ? error.code : "REGISTRY_CONFIG_INVALID", severity: "error", message: "Cannot read registry configuration for the selected package.", path: root });
  }
  return { sources, diagnostics };
}
