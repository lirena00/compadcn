export type TaskStage = "configuration" | "discovery" | "registry" | "graph" | "roots" | "analysis-all" | "analysis-production" | "classification" | "install" | "verification" | "planning" | "snapshot";

export interface TaskEvent {
  stage: TaskStage;
  state: "start" | "complete";
  message: string;
  completed?: number;
  total?: number;
  source?: { id: string; namespace: string; scope: string; status?: string; cache?: string[] };
}

export interface ProgressOptions { onProgress?: (event: TaskEvent) => void }

export function reportProgress(options: ProgressOptions, event: TaskEvent): void {
  options.onProgress?.(event);
}
