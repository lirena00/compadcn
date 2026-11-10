import type { PackageManagerInfo } from "../utils/getUserPkgManager.js";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface WorkspacePackage {
  root: string;
  name?: string;
}

export interface Workspace {
  root: string;
  configPath: string;
  packages: WorkspacePackage[];
}

export interface ResolvedAlias {
  specifier: string;
  path: string;
  source: "relative" | "tsconfig" | "package-imports" | "workspace-exports";
  configPath: string;
  exists: boolean;
}

export interface ProjectContext {
  cwd: string;
  projectRoot: string;
  packageJsonPath: string;
  packageName?: string;
  framework: "next" | "vite-react" | "react" | "unknown";
  sourceRoots: string[];
  workspace: Workspace | null;
  packageManager: PackageManagerInfo | null;
  compilerConfigs: string[];
  components: {
    path: string;
    tsx: boolean;
    aliases: Record<string, string>;
    resolvedAliases: Record<string, ResolvedAlias>;
  } | null;
  diagnostics: Diagnostic[];
  ready: boolean;
}
