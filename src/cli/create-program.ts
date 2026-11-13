import { Command } from "commander";
import { packageInfo } from "../lib/packageInfo.js";
import { CliError } from "../core/errors.js";
import { type OutputOptions, validateOutputOptions } from "./output.js";

export interface ProgramOptions {
  writeInformation?: (text: string) => void;
}

export function createProgram(options: ProgramOptions = {}): Command {
  const program = new Command()
    .name(packageInfo.name)
    .description(packageInfo.description)
    .version(packageInfo.version)
    .option("--json", "Output structured JSON for supported commands")
    .option("--plain", "Output plain text for supported commands")
    .option("--no-interactive", "Disable interactive prompts")
    .option("--progress", "Show task stages on stderr (automatic in an interactive terminal)")
    .option("--no-progress", "Disable task progress output")
    .exitOverride()
    .configureOutput({
      writeOut: options.writeInformation ?? ((text) => process.stdout.write(text)),
      // The runner renders parser errors using the selected output contract.
      writeErr: () => {},
      outputError: () => {},
    });

  program.action(() => program.help());

  program.hook("preAction", async (_program, command) => {
    const outputOptions = program.opts<OutputOptions>();
    validateOutputOptions(outputOptions);
    if (command === program) return;
    if (command === doctorCommand || command === inventoryCommand || command === graphCommand || command === auditCommand || command === whyCommand || command === searchCommand) return;
    if (command === planCommand || command.parent === planCommand) return;
    if (command === applyCommand || command === restoreCommand || command === operationCommand) return;
    if (command === addCommand) {
      const settings=command.opts();
      if ((!process.stdin.isTTY || !process.stdout.isTTY || outputOptions.interactive===false || outputOptions.json || outputOptions.plain || process.env.TERM==="dumb") && (!settings.yes || !command.args.length)) throw new CliError("INTERACTIVE_REQUIRED","Use explicit component addresses with --yes for noninteractive add.");
      return;
    }

    if (outputOptions.json || outputOptions.plain) {
      throw new CliError(
        "OUTPUT_MODE_UNSUPPORTED",
        "This legacy workflow does not support --json or --plain yet. " +
          "Doctor, inventory, graph, audit, why, search, add, plan, apply, restore, operation, help, and version output support both modes."
      );
    }

    const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
      outputOptions.interactive !== false && process.env.TERM !== "dumb";
    const isReadOnlyPreset = command.parent?.name() === "preset" &&
      ["list", "show"].includes(command.name());

    if (!canPrompt && !isReadOnlyPreset) {
      throw new CliError(
        "INTERACTIVE_REQUIRED",
        "This legacy workflow requires an interactive terminal. " +
          "Run it in a terminal without --no-interactive."
      );
    }

    if (canPrompt) {
      const { renderTitle } = await import("../utils/renderTitle.js");
      renderTitle();
    }
  });

  const doctorCommand = program
    .command("doctor")
    .description("Inspect project configuration and resolved aliases without changing files")
    .option("-c, --cwd <path>", "Project directory (or a directory inside the target package)", ".")
    .action(async (doctorOptions: { cwd: string }) => {
      const { runDoctor } = await import("./doctor.js");
      runDoctor(doctorOptions.cwd, program.opts<OutputOptions>());
    });

  const inventoryCommand = program
    .command("inventory")
    .description("Inspect configured catalogs and local file ownership candidates")
    .option("-c, --cwd <path>", "Target project or workspace package", ".")
    .option("--workspace", "Include all configured workspace packages")
    .option("--item <address>", "Inspect a known @namespace/item in the target package (repeatable)",
      (value: string, previous: string[]) => [...previous, value], [])
    .option("--offline", "Read cached registry metadata without network requests")
    .option("--refresh", "Revalidate cached registry metadata")
    .option("--no-cache", "Disable persistent registry caching")
    .option("--cache-dir <path>", "Registry metadata cache directory")
    .option("-j, --concurrency <number>", "Maximum concurrent registry operations (1-16)", "4")
    .option("--timeout <milliseconds>", "Timeout per request attempt (maximum 60000)", "10000")
    .action(async (inventoryOptions) => {
      const { runInventory } = await import("./inventory.js");
      await runInventory(inventoryOptions, program.opts<OutputOptions>());
    });

  const graphCommand = program
    .command("graph")
    .description("Graph registry declarations and observed local imports")
    .option("-c, --cwd <path>", "Target project or workspace package", ".")
    .option("--workspace", "Include all workspace consumers and configured registries")
    .option("--scope <scope>", "Graph seed scope: installed or catalog", "installed")
    .option("--item <address>", "Select an @namespace/item, official bare name, or HTTP(S) item URL (repeatable)",
      (value: string, previous: string[]) => [...previous, value], [])
    .option("--offline", "Read cached registry metadata without network requests")
    .option("--refresh", "Revalidate cached registry metadata")
    .option("--no-cache", "Disable persistent registry caching")
    .option("--cache-dir <path>", "Registry metadata cache directory")
    .option("-j, --concurrency <number>", "Maximum concurrent registry operations (1-16)", "4")
    .option("--timeout <milliseconds>", "Timeout per request attempt (maximum 60000)", "10000")
    .option("--max-items <number>", "Registry closure limit (1-10000)", "2000")
    .option("--max-files <number>", "Source parsing limit (1-100000)", "20000")
    .option("--mermaid", "Export Mermaid text (included in the envelope with --json)")
    .option("--focus <reference>", "Show a node and its direct dependencies by address, path, label, or ID")
    .option("--reverse", "Show dependents in a focused view")
    .option("--transitive", "Traverse the full dependency/dependent closure in a focused view")
    .action(async (graphOptions) => {
      const { runGraph } = await import("./graph.js");
      await runGraph(graphOptions, program.opts<OutputOptions>());
    });

  const searchCommand = program.command("search [query]")
    .description("Search configured registry catalogs and local-file presence without installing")
    .option("-c, --cwd <path>","Target project or workspace package",".")
    .option("--workspace","Search every configured workspace registry")
    .option("--item <address>","Include a known item from a catalog-less source (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .option("--registry <namespace>","Filter by @namespace (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .option("--type <type>","Filter by registry type such as ui or block (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .option("--presence <state>","Filter local-file presence: any, present, partial, absent, unknown","any")
    .option("--limit <number>","Maximum matches in the result (1-1000)","50")
    .option("--offline","Read cached registry metadata without network requests")
    .option("--refresh","Revalidate cached registry metadata")
    .option("--no-cache","Disable persistent registry caching")
    .option("--cache-dir <path>","Registry metadata cache directory")
    .option("-j, --concurrency <number>","Maximum concurrent registry operations (1-16)","4")
    .option("--timeout <milliseconds>","Timeout per request attempt (maximum 60000)","10000")
    .action(async(query:string|undefined,searchOptions)=>{
      const {runSearch}=await import("./search.js");
      await runSearch(query,searchOptions,program.opts<OutputOptions>());
    });

  const auditCommand = configureAuditCommand(program.command("audit")
    .description("Classify local component usage with bounded entry and reference evidence"))
    .option("--summary", "Return counts, coverage, diagnostics and snapshot IDs without finding details")
    .action(async (auditOptions) => {
      const { runAudit } = await import("./audit.js");
      await runAudit(auditOptions, program.opts<OutputOptions>());
    });

  const whyCommand = configureAuditCommand(program.command("why <reference>")
    .description("Explain a local item, managed file, or related package by address, path, or ID"))
    .action(async (reference: string, auditOptions) => {
      const { runAudit } = await import("./audit.js");
      await runAudit(auditOptions, program.opts<OutputOptions>(), reference);
    });

  const planCommand = program.command("plan")
    .description("Create ownership snapshots and exact read-only cleanup proposals")
    .allowExcessArguments(false)
    .action(()=>planCommand.help());

  configurePlanningCommand(planCommand.command("snapshot").description("Propose observed registry ownership mappings for review"))
    .option("--item <reference>","Restrict the snapshot to a named observed item (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .action(async(options)=>{
      const {runPlan}=await import("./plan.js");await runPlan("snapshot",[],options,program.opts<OutputOptions>());
    });

  configurePlanningCommand(planCommand.command("prune").description("Propose cleanup of eligible unused items from a reviewed ownership snapshot"))
    .option("--ownership <path>","Reviewed ownership snapshot JSON")
    .option("--verify-script <name>","Require a named package script during future application (repeatable)",(value:string,previous:string[]=[])=>[...previous,value])
    .action(async(options)=>{
      const {runPlan}=await import("./plan.js");await runPlan("prune",[],options,program.opts<OutputOptions>());
    });

  configurePlanningCommand(planCommand.command("remove <references...>").description("Propose whole unused file sets for explicitly named items or unmapped managed files"))
    .option("--ownership <path>","Reviewed ownership snapshot JSON")
    .option("--include-unverified","Accept the observed mapping of these named unverified targets")
    .option("--include-modified","Include these named targets if changed since the reviewed snapshot")
    .option("--verify-script <name>","Require a named package script during future application (repeatable)",(value:string,previous:string[]=[])=>[...previous,value])
    .action(async(references:string[],options)=>{
      const {runPlan}=await import("./plan.js");await runPlan("remove",references,options,program.opts<OutputOptions>());
    });

  planCommand.command("check <path>").description("Revalidate a saved plan's input scope, analysis, and exact operations without applying it")
    .option("-c, --cwd <path>","Target project/workspace package",".")
    .option("--offline","Use cached registry metadata")
    .option("--refresh","Revalidate registry metadata")
    .option("--no-cache","Disable persistent registry caching")
    .option("--cache-dir <path>","Registry metadata cache directory")
    .option("-j, --concurrency <number>","Maximum concurrent registry operations (1-16)","4")
    .option("--timeout <milliseconds>","Timeout per registry request attempt (maximum 60000)","10000")
    .option("--analysis-timeout <milliseconds>","Timeout per Knip pass (1-300000)","60000")
    .action(async(path:string,options)=>{
      const {runPlanCheck}=await import("./plan.js");await runPlanCheck(path,options,program.opts<OutputOptions>());
    });

  const applyCommand = program.command("apply").description("Apply one freshly revalidated cleanup plan with backups and required verification")
    .requiredOption("--plan <path>", "Saved ready cleanup plan JSON")
    .option("-c, --cwd <path>", "Target project/workspace package", ".")
    .option("-y, --yes", "Apply the exact reviewed plan without a prompt")
    .option("--verify", "Run all configured checks (always required)")
    .option("--precheck", "Also run checks before mutation; stop on pre-existing failures")
    .option("--verification-timeout <milliseconds>", "Timeout per verification script (1-1800000)", "120000")
    .option("--offline", "Revalidate using cached registry metadata")
    .option("--refresh", "Revalidate registry metadata")
    .option("--no-cache", "Disable persistent registry caching")
    .option("--cache-dir <path>", "Registry metadata cache directory")
    .option("-j, --concurrency <number>", "Maximum concurrent registry operations (1-16)", "4")
    .option("--timeout <milliseconds>", "Timeout per registry request attempt (maximum 60000)", "10000")
    .option("--analysis-timeout <milliseconds>", "Timeout per Knip pass (1-300000)", "60000")
    .action(async options => { const { runApply } = await import("./cleanup.js"); await runApply(options, program.opts<OutputOptions>()); });

  const restoreCommand = program.command("restore <operation-id>").description("Recover only a cleanup operation's missing files; preserve conflicts")
    .option("-c, --cwd <path>", "Original project/workspace package", ".")
    .option("-y, --yes", "Recover this operation without a prompt")
    .option("--recover-lock", "Recover this operation's lock only if its same-host owner process has stopped")
    .action(async (id: string, options) => { const { runRestore } = await import("./cleanup.js"); await runRestore(id, options, program.opts<OutputOptions>()); });

  const operationCommand = program.command("operation <operation-id>").description("Inspect a persisted cleanup or recovery receipt without changing files")
    .option("-c, --cwd <path>", "Original project/workspace package", ".")
    .action(async (id: string, options) => { const { runOperation } = await import("./cleanup.js"); await runOperation(id, options, program.opts<OutputOptions>()); });

  const presetCommand = program
    .command("preset")
    .alias("p")
    .description("Manage component presets")
    .action(async () => {
      const { runPresetUI } = await import("../commands/preset.js");
      await runPresetUI();
    });

  presetCommand
    .command("list")
    .alias("ls")
    .description("List all available presets")
    .option("-b, --builtin", "Show only builtin presets")
    .option("-c, --custom", "Show only custom presets")
    .action(async (options) => {
      const { listPresets } = await import("../commands/presetCommands.js");
      await listPresets(options);
    });

  presetCommand
    .command("show <preset_name>")
    .alias("s")
    .description("Show components in a preset")
    .action(async (presetName: string) => {
      const { showPreset } = await import("../commands/presetCommands.js");
      await showPreset(presetName);
    });

  presetCommand
    .command("install <preset_name>")
    .alias("i")
    .description("Install all components from a preset")
    .action(async (presetName: string) => {
      const { installPreset } = await import("../commands/presetCommands.js");
      await installPreset(presetName);
    });

  presetCommand
    .command("create <preset_name> [components...]")
    .alias("c")
    .description("Create a new custom preset")
    .option("-d, --description <description>", "Preset description")
    .option("-b, --base <preset_names>", "Base presets to extend (comma-separated)")
    .action(async (presetName: string, components: string[], options) => {
      const { createPreset } = await import("../commands/presetCommands.js");
      await createPreset(presetName, components, options);
    });

  presetCommand
    .command("delete <preset_name>")
    .alias("del")
    .description("Delete a custom preset")
    .action(async (presetName: string) => {
      const { deletePreset } = await import("../commands/presetCommands.js");
      await deletePreset(presetName);
    });

  program
    .command("lint")
    .alias("l")
    .description("Find unused ShadCN components")
    .action(async () => {
      const { runLintUI } = await import("../commands/lint.js");
      await runLintUI();
    });

  const addCommand = program
    .command("add")
    .alias("a")
    .description("Search configured registries and install selected components")
    .option("-c, --cwd <path>","Target project or workspace package",".")
    .option("-o, --overwrite", "Overwrite existing files")
    .option("-y, --yes","Install explicit selections without confirmation")
    .option("--registry <namespace>","Filter the picker by @namespace (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .option("--type <type>","Filter the picker by registry type (repeatable)",(value:string,previous:string[])=>[...previous,value],[])
    .option("--query <text>","Limit the picker to matching catalog entries")
    .option("--refresh","Revalidate cached registry metadata")
    .option("--no-cache","Disable persistent registry caching")
    .option("--cache-dir <path>","Registry metadata cache directory")
    .option("-j, --concurrency <number>","Maximum concurrent registry operations (1-16)","4")
    .option("--timeout <milliseconds>","Timeout per request attempt (maximum 60000)","10000")
    .argument("[components...]", "Component names to add (e.g., button card)")
    .action(async (components: string[], options) => {
      const { runAdd } = await import("./add.js");
      await runAdd(components, options, program.opts<OutputOptions>());
    });

  program
    .command("remove")
    .alias("rm")
    .description("Remove ShadCN UI components from your project")
    .argument("[components...]", "Component names to remove (e.g., button card)")
    .action(async (components: string[]) => {
      const { runRemoveUI } = await import("../commands/remove.js");
      await runRemoveUI(components);
    });

  return program;
}

function configureAuditCommand(command: Command): Command {
  const collect = (value: string, previous: string[]) => [...previous, value];
  return command
    .option("-c, --cwd <path>", "Target project or workspace package", ".")
    .option("--workspace", "Include all workspace consumers (the default inside a workspace)")
    .option("--entry <pattern>", "Runtime entry glob relative to the workspace/project root (repeatable)", collect, [])
    .option("--dev-entry <pattern>", "Additional development entry glob relative to the analysis root (repeatable)", collect, [])
    .option("--offline", "Read cached registry metadata without network requests")
    .option("--refresh", "Revalidate cached registry metadata")
    .option("--no-cache", "Disable persistent registry caching")
    .option("--cache-dir <path>", "Registry metadata cache directory")
    .option("-j, --concurrency <number>", "Maximum concurrent registry operations (1-16)", "4")
    .option("--timeout <milliseconds>", "Timeout per registry request attempt (maximum 60000)", "10000")
    .option("--analysis-timeout <milliseconds>", "Timeout per Knip pass (1-300000)", "60000")
    .option("--max-items <number>", "Registry closure limit (1-10000)", "2000")
    .option("--max-files <number>", "Source parsing limit (1-100000)", "20000");
}

function configurePlanningCommand(command:Command):Command {
  return configureAuditCommand(command)
    .option("--out <path>","Create a new JSON artifact without overwriting an existing file")
    .option("--summary","Omit operation diffs and input-file lists from terminal/JSON output")
    .option("--max-input-files <number>","Complete-scope fingerprint file limit (1-100000)","50000")
    .option("--max-input-bytes <number>","Complete-scope fingerprint byte limit (maximum 1073741824)","268435456");
}
