import type { Diagnostic } from "../project/types.js";

export interface EntryRoot {
  id: string;
  path: string;
  scope: string;
  role: "runtime" | "development" | "public";
  reason: string;
}

export interface AnalysisScope {
  root: string;
  files: string[];
  publicContract: boolean;
}

export interface RootPolicy {
  analysisRoot: string;
  roots: EntryRoot[];
  scopes: AnalysisScope[];
  diagnostics: Diagnostic[];
  complete: boolean;
}

export interface KnipRun {
  mode: "all" | "production";
  unusedFiles: string[];
  unusedPackages: { path: string; name: string; development: boolean }[];
  unresolved: { path: string; line?: number; column?: number }[];
  durationMs: number;
  complete: boolean;
  diagnostics: Diagnostic[];
}

export interface KnipAnalysis {
  version: "6.45.0";
  configFingerprint: string;
  all: KnipRun;
  production: KnipRun;
  complete: boolean;
}
