import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { convertPathToPattern, globSync } from "tinyglobby";
import { CliError } from "../core/errors.js";
import { canonicalPath, isWithin } from "../project/files.js";
import type { Diagnostic, ProjectContext } from "../project/types.js";
import { digest } from "../registry/source.js";
import { fileId, GraphStore, nodeId } from "./model.js";
import { parseReferences } from "./references.js";
import { ReferenceResolver } from "./resolve.js";

const excluded = ["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", ".cache"].map((name) => `**/${name}/**`);
const sourcePattern = /\.(?:[cm]?[jt]sx?|mdx|vue|svelte)$/;
const supported = /\.(?:[cm]?[jt]sx?)$/;

export function sourceGraph(store: GraphStore, project: ProjectContext, roots: string[], options: { maxFiles: number; signal?: AbortSignal }): { complete: boolean; diagnostics: Diagnostic[]; scopes: string[] } {
  const boundary = project.workspace?.root ?? project.projectRoot;
  const resolver = new ReferenceResolver(boundary, project);
  const diagnostics: Diagnostic[] = [];
  const pending = new Set<string>();
  const visited = new Set<string>();
  const scopes = new Set(roots);
  const packages = project.workspace?.packages ?? [];
  const fail = (code: string, message: string, path: string): void => { diagnostics.push({ code, message, path, severity: "error" }); };
  for (const root of roots) {
    try {
      const nestedPackages = packages.filter((pkg) => pkg.root !== root && isWithin(root, pkg.root)).map((pkg) => `${convertPathToPattern(relative(root, pkg.root))}/**`);
      for (const file of globSync("**/*", { cwd: root, absolute: true, dot: true, followSymbolicLinks: false, expandDirectories: false, ignore: [...excluded, ...nestedPackages] }).sort()) {
        if (sourcePattern.test(file)) pending.add(canonicalPath(file));
      }
    } catch { fail("SOURCE_SCAN_FAILED", "Could not enumerate project source files.", root); }
  }
  const queue = [...pending].sort();
  for (let offset = 0; offset < queue.length; offset++) {
    const path = queue[offset]!;
    if (visited.has(path)) continue;
    if (visited.size >= options.maxFiles) { fail("GRAPH_FILE_LIMIT", "Source graph exceeds the configured file limit.", project.projectRoot); break; }
    if (options.signal?.aborted) { fail("GRAPH_CANCELLED", "Source graph construction was cancelled.", project.projectRoot); break; }
    visited.add(path);
    let owner = project.projectRoot;
    const id = fileId(path);
    try {
      owner = resolver.scopeOf(path);
      scopes.add(owner);
      if (!isWithin(boundary, path)) throw new CliError("SOURCE_TARGET_OUTSIDE_SCOPE", "Source file resolves outside the selected project/workspace.");
      const stat = statSync(path);
      if (stat.size > 2 * 1024 * 1024) throw new CliError("SOURCE_FILE_TOO_LARGE", "Source file exceeds the 2 MiB parsing limit.");
      const bytes = readFileSync(path);
      store.node({ id, kind: "file", label: path, path, scope: owner, state: "present", contentHash: digest(bytes) });
      if (!supported.test(path)) throw new CliError("SOURCE_FORMAT_UNSUPPORTED", "Source format needs a dedicated reference adapter.");
      const parsed = parseReferences(path, bytes.toString("utf8"));
      for (const error of parsed.errors) fail("SOURCE_PARSE_FAILED", `Cannot parse source at ${error.line}:${error.column}.`, path);
      for (const reference of parsed.references) {
        const safeReference = reference.specifier && /^[a-z][a-z\d+.-]*:/i.test(reference.specifier) && !reference.specifier.startsWith("node:") ? "[URL or virtual import]" : reference.specifier;
        const evidence = { path, line: reference.line, column: reference.column, syntax: reference.syntax, ...(safeReference ? { reference: safeReference } : {}) };
        try {
          if (!reference.specifier) throw new CliError(reference.syntax === "shadowed-require" ? "SOURCE_SHADOWED_REQUIRE" : "SOURCE_COMPUTED_REFERENCE",
            reference.syntax === "shadowed-require" ? "Locally bound require calls need an explicit resolution adapter." : "Computed imports/requires and module globs cannot be resolved by this graph adapter.");
          const target = resolver.resolve(reference.specifier, path);
          let to: string;
          if (target.kind === "file") {
            to = fileId(target.path);
            store.node({ id: to, kind: "file", label: target.path, path: target.path, scope: resolver.scopeOf(target.path), state: "present",
              ...(!sourcePattern.test(target.path) ? { retained: true, resourceKind: "non-code-file" } : {}) });
            store.edge({ from: id, to, kind: "file-import", phase: reference.phase, status: "resolved", evidence });
            if (sourcePattern.test(target.path) && !pending.has(target.path)) { pending.add(target.path); queue.push(target.path); }
          } else if (target.kind === "builtin") {
            to = nodeId("builtin", target.name);
            store.node({ id: to, kind: "resource", label: target.name, scope: target.scope, state: "present", resourceKind: "node-builtin", retained: true });
            store.edge({ from: id, to, kind: "builtin-import", phase: reference.phase, status: "resolved", evidence });
          } else {
            to = nodeId("package", target.scope, target.name);
            store.node({ id: to, kind: "package", label: target.name, scope: target.scope, state: "unknown", packageName: target.name, ...(target.manifestSpec ? { manifestSpec: target.manifestSpec } : {}) });
            store.edge({ from: id, to, kind: "package-import", phase: reference.phase, status: "resolved", evidence });
          }
        } catch (error) {
          const code = error instanceof CliError ? error.code : "SOURCE_IMPORT_UNRESOLVED";
          const to = nodeId("unresolved-source", path, String(reference.line), String(reference.column), code);
          store.node({ id: to, kind: "unresolved", label: code, scope: owner, state: "unresolved" });
          store.edge({ from: id, to, kind: "file-import", phase: reference.phase, status: "unresolved", evidence });
          fail(code, error instanceof CliError ? error.message : "Cannot resolve source import.", path);
        }
      }
    } catch (error) {
      store.node({ id, kind: "file", label: path, path, scope: owner, state: "unknown" });
      fail(error instanceof CliError ? error.code : "SOURCE_READ_FAILED", error instanceof CliError ? error.message : "Cannot read source file.", path);
    }
  }
  diagnostics.push(...resolver.diagnostics);
  return { complete: !diagnostics.some(({ severity }) => severity === "error"), diagnostics, scopes: [...scopes].sort() };
}
