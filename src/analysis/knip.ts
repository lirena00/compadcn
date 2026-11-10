import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execa } from "execa";
import { convertPathToPattern } from "tinyglobby";
import { CliError } from "../core/errors.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { canonicalPath, isObject, isWithin } from "../project/files.js";
import type { KnipAnalysis, KnipRun, RootPolicy } from "./types.js";

export interface AnalysisOptions { analysisTimeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }

export function parseKnipReport(input: string, policy: RootPolicy, mode: KnipRun["mode"], durationMs = 0): KnipRun {
  const data: unknown = JSON.parse(input);
  if (!isObject(data) || !Array.isArray(data.issues)) throw new CliError("KNIP_REPORT_INVALID", "Analysis JSON does not match the pinned Knip reporter contract.");
  const result: KnipRun = { mode, unusedFiles: [], unusedPackages: [], unresolved: [], durationMs, complete: true, diagnostics: [] };
  const known = new Set(policy.scopes.flatMap(({ files }) => files));
  for (const row of data.issues) {
    if (!isObject(row) || typeof row.file !== "string" || !Array.isArray(row.files) || !Array.isArray(row.unresolved)) throw new CliError("KNIP_REPORT_INVALID", "Analysis JSON contains an invalid issue row.");
    const path = canonicalPath(resolve(policy.analysisRoot, row.file));
    if (!isWithin(policy.analysisRoot, path)) throw new CliError("KNIP_REPORT_OUTSIDE_SCOPE", "Analysis reported a path outside its bounded project.");
    if (row.files.length) {
      if (!known.has(path)) throw new CliError("KNIP_REPORT_OUTSIDE_SCOPE", "Unused-file report includes a file outside the generated project set.");
      result.unusedFiles.push(path);
    }
    for (const issue of row.unresolved) {
      if (!isObject(issue) || typeof issue.name !== "string") throw new CliError("KNIP_REPORT_INVALID", "Unresolved analysis entry is invalid.");
      result.unresolved.push({ path, ...(typeof issue.line === "number" ? { line: issue.line } : {}), ...(typeof issue.col === "number" ? { column: issue.col } : {}) });
    }
    for (const field of ["dependencies", "devDependencies"] as const) {
      if (mode === "production" && field === "devDependencies" && row[field] === undefined) continue;
      if (!Array.isArray(row[field])) throw new CliError("KNIP_REPORT_INVALID", "Analysis dependency report is invalid.");
      for (const value of row[field]) {
        if (!isObject(value) || typeof value.name !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(value.name)) throw new CliError("KNIP_REPORT_INVALID", "Analysis package name is invalid.");
        result.unusedPackages.push({ path, name: value.name, development: field === "devDependencies" });
      }
    }
  }
  result.unusedFiles = [...new Set(result.unusedFiles)].sort();
  result.complete = !result.unresolved.length;
  if (!result.complete) result.diagnostics.push({ code: "KNIP_UNRESOLVED", severity: "error", message: `${mode} analysis contains ${result.unresolved.length} unresolved imports.` });
  return result;
}

export async function analyzeWithKnip(policy: RootPolicy, options: AnalysisOptions = {}): Promise<KnipAnalysis> {
  const timeout = options.analysisTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new CliError("INVALID_OPTIONS", "Analysis timeout must be between 1 and 300000 milliseconds.");
  const main = import.meta.resolve("knip");
  const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", main), "utf8"));
  if (!isObject(metadata) || metadata.version !== "6.45.0") throw new CliError("KNIP_VERSION_UNSUPPORTED", "Audit requires pinned Knip 6.45.0.");
  const schema: unknown = JSON.parse(await readFile(new URL("../schema.json", main), "utf8"));
  if (!isObject(schema) || !isObject(schema.definitions) || !isObject(schema.definitions.plugins) || !isObject(schema.definitions.plugins.properties)) throw new CliError("KNIP_SCHEMA_INVALID", "Pinned Knip configuration metadata is invalid.");
  // 6.45.0's published schema includes these two retired IDs which its CLI rejects.
  const obsolete = new Set(["node-test-runner", "tanstack-start"]);
  const plugins = Object.fromEntries(Object.keys(schema.definitions.plugins.properties).filter((name) => !obsolete.has(name)).map((name) => [name, false]));
  const workspaces = Object.fromEntries(policy.scopes.map((scope) => {
    const local = (path: string) => convertPathToPattern(relative(scope.root, path));
    const roots = policy.roots.filter((root) => root.scope === scope.root);
    return [relative(policy.analysisRoot, scope.root).replaceAll("\\", "/") || ".", {
      entry: roots.map((root) => local(root.path) + (root.role === "development" ? "" : "!")),
      project: scope.files.map((path) => `${local(path)}!`),
    }];
  }));
  const config = { ...plugins, workspaces };
  const fingerprint = digest(canonicalJSON(config));
  const prefix = join(tmpdir(), "shadcn-plus-analysis-");
  const directory = await mkdtemp(prefix);
  const path = join(directory, "knip.json");
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const run = async (mode: KnipRun["mode"]): Promise<KnipRun> => {
      const started = performance.now();
      const empty = (code: string, message: string): KnipRun => ({ mode, unusedFiles: [], unusedPackages: [], unresolved: [], durationMs: performance.now() - started,
        complete: false, diagnostics: [{ code, message, severity: "error" }] });
      if (options.signal?.aborted) return empty("ANALYSIS_CANCELLED", "Usage analysis was cancelled.");
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, NO_COLOR: "1", CI: "1" };
        delete env.FORCE_COLOR;
        const result = await execa(process.execPath, [fileURLToPath(new URL("../bin/knip.js", main)), "--directory", policy.analysisRoot, "--config", path,
          "--reporter", "json", "--no-progress", "--no-exit-code", "--no-config-hints", "--no-tag-hints", "--no-gitignore", "--include", "files,unresolved,dependencies", ...(mode === "production" ? ["--production"] : [])],
        { cwd: policy.analysisRoot, env, reject: false, timeout, cancelSignal: options.signal, forceKillAfterDelay: 1000, maxBuffer: 16 * 1024 * 1024, stdin: "ignore" });
        if (result.isCanceled) return empty("ANALYSIS_CANCELLED", "Usage analysis was cancelled.");
        if (result.timedOut) return empty("ANALYSIS_TIMEOUT", "Usage analysis exceeded its configured time limit.");
        if (result.failed || result.exitCode !== 0) return empty("KNIP_FAILED", `Pinned usage analysis failed (exit ${result.exitCode ?? "unknown"}). Project diagnostics are not treated as an empty clean result.`);
        const parsed = parseKnipReport(result.stdout, policy, mode, performance.now() - started);
        if (result.stderr.trim()) { parsed.complete = false; parsed.diagnostics.push({ code: "KNIP_DIAGNOSTIC", severity: "error", message: "Usage analysis emitted stderr diagnostics; coverage is incomplete." }); }
        return parsed;
      } catch (error) { return empty(error instanceof CliError ? error.code : "KNIP_REPORT_INVALID", error instanceof CliError ? error.message : "Usage analysis did not return a valid bounded report."); }
    };
    const all = await run("all");
    const production = await run("production");
    return { version: "6.45.0", configFingerprint: fingerprint, all, production, complete: all.complete && production.complete };
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(prefix))) throw new CliError("ANALYSIS_TEMP_SCOPE", "Analysis temporary directory left its generated scope.");
    await rm(target, { recursive: true, force: true });
  }
}
