import { performance } from "node:perf_hooks";
import { CliError } from "../core/errors.js";
import { CommandCancelled } from "../core/cancellation.js";
import type { TaskEvent } from "../core/progress.js";
import { getOutputMode, type OutputOptions } from "./output.js";
import { terminalText } from "./text.js";

export interface TaskContext {
  signal: AbortSignal;
  onProgress: (event: TaskEvent) => void;
  pause: () => void;
  beginMutation: () => void;
}

export async function runTask<T>(title: string, options: OutputOptions, operation: (context: TaskContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const mode = getOutputMode(options);
  const visible = options.progress ?? mode === "interactive";
  const animated = visible && mode === "interactive" && !!process.stderr.isTTY && !["1","true"].includes(process.env.ACCESSIBLE ?? "");
  let display: ReturnType<typeof import("@clack/prompts")["spinner"]> | undefined;
  let started = false, mutating = false;
  let lastPaint = 0;
  const began = performance.now();
  const active = new Map<string, string>();
  const completed = new Set<string>();
  const elapsed = () => `${((performance.now() - began) / 1000).toFixed(1)}s`;
  const pause = () => { if (started) display?.clear(); started = false; };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    if (animated) {
      const { spinner } = await import("@clack/prompts");
      display = spinner({ output: process.stderr, indicator: "timer", onCancel: abort });
    }
    const onProgress = (event: TaskEvent) => {
      if (!visible || controller.signal.aborted) return;
      let message = event.message;
      if (event.source) {
        if (event.state === "start") active.set(event.source.id, event.source.namespace);
        else { active.delete(event.source.id); completed.add(event.source.id); }
        if (animated && active.size) message = `Catalogs: ${completed.size} finished; waiting for ${[...active.values()].slice(0, 2).join(", ")}${active.size > 2 ? ` +${active.size - 2}` : ""}`;
        else if (event.source.cache?.length) message += ` (${event.source.cache.join(", ")})`;
      }
      message = terminalText(message, Math.max(24, Math.min(process.stderr.columns ?? 100, 160) - 8));
      if (display) {
        if (!started) { display.start(message); started = true; }
        else if (performance.now() - lastPaint >= 100 || event.state === "complete") display.message(message);
        lastPaint = performance.now();
      } else if (!event.source || event.state === "complete") {
        process.stderr.write(`[${elapsed()}] ${event.stage} ${event.state}: ${message}\n`);
      }
    };
    const result = await operation({ signal: controller.signal, onProgress, pause, beginMutation: () => { mutating = true; pause(); } });
    if (controller.signal.aborted) throw new CommandCancelled();
    if (started) {
      const incomplete = typeof result === "object" && result !== null && "complete" in result && result.complete === false;
      display?.stop(`${title} finished${incomplete ? " with incomplete coverage" : ""} (${elapsed()})`);
      started = false;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted && mutating) {
      if (started) display?.error("Installation interrupted");
      throw new CliError("INSTALL_INTERRUPTED", "Installation was interrupted after the installer started. Project files may have changed; inspect the project before retrying.");
    }
    if (controller.signal.aborted || error instanceof CommandCancelled) {
      if (started) display?.cancel("Cancelled");
      throw error instanceof CommandCancelled ? error : new CommandCancelled();
    }
    if (started) display?.error(`${title} failed (${elapsed()})`);
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
