import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { parse } from "parse5";
import { globSync } from "tinyglobby";
import { CliError } from "../core/errors.js";
import { canonicalPath, isObject, isWithin, readObject } from "../project/files.js";
import type { ProjectContext, Diagnostic } from "../project/types.js";
import type { DependencyGraph } from "../graph/types.js";
import { fileId } from "../graph/model.js";
import { parseReferences } from "../graph/references.js";
import { ReferenceResolver } from "../graph/resolve.js";
import type { EntryRoot, RootPolicy } from "./types.js";

const code = /\.(?:[cm]?[jt]sx?)$/;
const development = /(?:^|\/)(?:__tests__|tests?|stories|__stories__|e2e|playwright|scripts)\/|\.(?:test|spec|stories|story)\.[^.]+$|(?:^|\/)(?:[^/]+\.config|vitest\.setup|jest\.setup)\.[^.]+$|(?:^|\/)\.storybook\//;
const nextApp = /^(?:src\/)?app\/(?:.*\/)?(?:page|layout|route|template|default|error|loading|not-found|global-error|global-not-found|forbidden|unauthorized|manifest|robots|sitemap|icon|apple-icon|opengraph-image|twitter-image)\.(?:[jt]sx?)$/;
const nextOther = /^(?:(?:src\/)?pages\/.*|(?:src\/)?(?:middleware|proxy|instrumentation|instrumentation-client))\.(?:[jt]sx?)$/;

function configIsStatic(path: string): boolean {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const variables = new Map<string, ts.Expression>();
  let value: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) variables.set(declaration.name.text, declaration.initializer);
    }
    if (ts.isExportAssignment(statement)) value = statement.expression;
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText(source) === "module.exports") value = statement.expression.right;
  }
  if (value && ts.isIdentifier(value)) value = variables.get(value.text);
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (!value || !ts.isObjectLiteralExpression(value)) return false;
  // These settings can change entry discovery or resolution. They need an
  // explicit entry policy; evaluating a framework config is never required.
  const affectsRoots = new Set(["pageExtensions", "turbopack", "webpack", "root", "build", "plugins", "resolve"]);
  return value.properties.every((property) => !ts.isSpreadAssignment(property) && property.name && !ts.isComputedPropertyName(property.name) && !affectsRoots.has(property.name.getText(source).replace(/^["']|["']$/g, "")));
}

export function discoverRoots(graph: DependencyGraph, project: ProjectContext, options: { entries?: string[]; devEntries?: string[] } = {}): RootPolicy {
  const analysisRoot = project.workspace?.root ?? project.projectRoot;
  const diagnostics: Diagnostic[] = [];
  const roots = new Map<string, EntryRoot>();
  const files = graph.nodes.filter((node) => node.kind === "file" && node.path && code.test(node.path));
  const known = new Set(files.map(({ path }) => path!));
  const add = (path: string, scope: string, role: EntryRoot["role"], reason: string): void => {
    if (known.has(path)) roots.set(`${role}:${path}`, { id: fileId(path), path, scope, role, reason });
  };
  const explicit = (patterns: string[] | undefined, role: "runtime" | "development"): Set<string> => {
    const result = new Set<string>();
    if (!patterns?.length) return result;
    if (!patterns.some((pattern) => !pattern.startsWith("!")) || patterns.some((pattern) => pattern.includes("\0") || pattern.replace(/^!/, "").split(/[\\/]/).includes(".."))) {
      throw new CliError("INVALID_OPTIONS", "Entry patterns must include a positive pattern and stay within the analysis root.");
    }
    for (const path of globSync(patterns, { cwd: analysisRoot, absolute: true, followSymbolicLinks: false, expandDirectories: false, dot: true })) {
      const target = canonicalPath(path);
      if (!isWithin(analysisRoot, target)) throw new CliError("INVALID_OPTIONS", "Entry pattern resolves outside the analysis root.");
      if (known.has(target)) result.add(target);
    }
    if (!result.size) diagnostics.push({ code: "ENTRY_PATTERN_EMPTY", severity: "error", message: `Explicit ${role} entry patterns matched no analyzed source files.`, path: analysisRoot });
    return result;
  };
  const explicitRuntime = explicit(options.entries, "runtime");
  const explicitDevelopment = explicit(options.devEntries, "development");
  const resolver = new ReferenceResolver(analysisRoot, project);
  const scopes = graph.scopes.map((scope) => {
    const scoped = files.filter((file) => file.scope === scope).map(({ path }) => path!).sort();
    const manifest = readObject(resolve(scope, "package.json"), "PACKAGE_JSON_INVALID");
    const dependencies = { ...(isObject(manifest.devDependencies) ? manifest.devDependencies : {}), ...(isObject(manifest.dependencies) ? manifest.dependencies : {}) };
    const publicContract = manifest.exports !== undefined || manifest.main !== undefined || manifest.module !== undefined || manifest.types !== undefined;
    const explicitHere = scoped.filter((path) => explicitRuntime.has(path));
    for (const path of scoped) {
      const local = relative(scope, path).replaceAll("\\", "/");
      if (development.test(local) || explicitDevelopment.has(path)) add(path, scope, "development", explicitDevelopment.has(path) ? "explicit-development-entry" : "development-convention");
      if (explicitHere.length) {
        if (explicitRuntime.has(path)) add(path, scope, "runtime", "explicit-entry");
      } else if (Object.hasOwn(dependencies, "next") && (nextApp.test(local) || nextOther.test(local))) add(path, scope, "runtime", "next-route");
      else if (!Object.hasOwn(dependencies, "next") && !Object.hasOwn(dependencies, "vite") && /^(?:src\/)?(?:main|index|cli)\.(?:[cm]?[jt]sx?)$/.test(local)) add(path, scope, "runtime", "conventional-entry");
    }
    const collectTargets = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(collectTargets) : isObject(value) ? Object.values(value).flatMap(collectTargets) : [];
    for (const pattern of collectTargets(manifest.exports)) {
      if (!pattern.startsWith("./") || !isWithin(scope, resolve(scope, pattern))) {
        diagnostics.push({ code: "PUBLIC_EXPORT_UNSUPPORTED", severity: "error", message: "Public exports must use in-package targets.", path: scope }); continue;
      }
      for (const target of globSync(pattern, { cwd: scope, absolute: true, expandDirectories: false, followSymbolicLinks: false })) add(canonicalPath(target), scope, "public", "package-exports");
    }
    for (const field of ["main", "module", "types"]) if (typeof manifest[field] === "string") {
      const target = canonicalPath(resolve(scope, manifest[field]));
      if (isWithin(scope, target)) add(target, scope, "public", `package-${field}`);
    }
    const bins = typeof manifest.bin === "string" ? [manifest.bin] : isObject(manifest.bin) ? Object.values(manifest.bin).filter((value): value is string => typeof value === "string") : [];
    for (const bin of bins) add(canonicalPath(resolve(scope, bin)), scope, "runtime", "package-bin");
    const html = resolve(scope, "index.html");
    if (!explicitHere.length && existsSync(html) && !Object.hasOwn(dependencies, "next")) {
      const document = parse(readFileSync(html, "utf8"));
      const visit = (node: typeof document | (typeof document.childNodes)[number]): void => {
        if ("tagName" in node && node.tagName === "template") return;
        if ("tagName" in node && node.tagName === "script") {
          const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
          if (attrs.type === "module") {
            try {
              if (attrs.src) {
                const value = attrs.src.startsWith("/") ? resolve(scope, `.${attrs.src}`) : resolve(dirname(html), attrs.src);
                const path = canonicalPath(value);
                if (!known.has(path)) throw new Error("Unknown module entry");
                add(path, scope, "runtime", "html-module-entry");
              } else {
                const text = node.childNodes.map((child) => "value" in child ? child.value : "").join("");
                const parsed = parseReferences(resolve(scope, "inline-entry.ts"), text);
                if (parsed.errors.length) throw new Error("Invalid inline module");
                for (const reference of parsed.references) {
                  if (!reference.specifier) throw new Error("Computed inline module");
                  const target = resolver.resolve(reference.specifier, html);
                  if (target.kind === "file") add(target.path, scope, "runtime", "html-inline-import");
                }
              }
            } catch { diagnostics.push({ code: "HTML_ENTRY_UNRESOLVED", severity: "error", message: "HTML module entry cannot be resolved within the analyzed project.", path: html }); }
          }
        }
        if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      };
      visit(document);
    }
    if (!explicitHere.length) for (const path of scoped.filter((path) => /^(?:next|vite)\.config\./.test(basename(path)))) {
      if (!configIsStatic(path)) diagnostics.push({ code: "FRAMEWORK_ENTRY_POLICY_REQUIRED", severity: "error", message: "Framework config can alter entries or aliases; provide explicit --entry patterns. The config was not executed.", path });
    }
    if (scoped.length && !publicContract && ![...roots.values()].some((root) => root.scope === scope && root.role === "runtime")) {
      diagnostics.push({ code: "RUNTIME_ROOTS_UNKNOWN", severity: "error", message: "No supported runtime entry was found; provide --entry patterns for this scope.", path: scope });
    }
    return { root: scope, files: scoped, publicContract };
  });
  diagnostics.push(...resolver.diagnostics);
  return { analysisRoot, roots: [...roots.values()].sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role)), scopes,
    diagnostics, complete: !diagnostics.some(({ severity }) => severity === "error") };
}
