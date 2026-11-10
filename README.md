# shadcn-plus

A CLI for installing and managing shadcn/ui components and presets, formerly named compadcn.

V2 is under development. This checkout includes multi-registry inventory, dependency
graphs, and read-only usage audits alongside the existing component and preset
commands. Ownership adoption and cleanup plans are still being implemented.

## Features

- **Easy component installation** - Add ShadCN components with a single command
- **Smart linting** - Find and remove unused components from your project
- **Import cleanup** - Automatically removes imports when components are deleted
- **Dependency removal** - Optionally remove unused dependencies when components are deleted
- **Custom presets** - Create and save your own component collections

## Local development

```bash
pnpm install --frozen-lockfile
pnpm run build
node dist/cli.js --help
pnpm test
```

The package exports `createProgram` and `runCli` for integration without starting
the executable on import. `runCli(argv)` returns an exit code; only the executable
sets the process exit code.

## Output and automation

```bash
shadcn-plus --plain --help
shadcn-plus --json --version
shadcn-plus --json preset show --help
```

Put output options before `--help` or `--version`, which complete parsing
immediately. JSON responses contain `schemaVersion`, `toolVersion`, `status`, and
either `data` or `error`. Plain CLI errors go to stderr; JSON errors are returned
as one structured response on stdout. Parser/runner errors return exit code `2`.

Doctor, inventory, graph, audit, why, help, version, and CLI errors support these output modes. Existing component and
preset workflows do not yet support `--json` or `--plain`; they return
`OUTPUT_MODE_UNSUPPORTED` instead of mixing terminal text with machine output.
Workflows requiring prompts fail with `INTERACTIVE_REQUIRED` when no interactive
terminal is available or `--no-interactive` is set. `preset list` and `preset show`
remain available without prompts. Legacy workflows return nonzero exit codes for
validation, filesystem, and subprocess failures; cancellation remains a normal
outcome. File cleanup is still non-transactional until plan/apply is implemented.

## Installation

Once the renamed package is published:

```bash
npm install -g shadcn-plus
# or
pnpm add -g shadcn-plus
# or
yarn global add shadcn-plus
```

## Commands

### `shadcn-plus doctor`

Inspect project configuration without installing packages, fetching registries,
executing framework configs, or modifying project files.

```bash
shadcn-plus doctor
shadcn-plus doctor --cwd ./apps/web --json
shadcn-plus --plain doctor --cwd ./src/features
```

Doctor selects the nearest `package.json` from the chosen directory, stopping at
the Git/worktree boundary. At a workspace root, select the intended app/package
with `doctor --cwd`; it does not choose an app automatically. `--cwd` currently
is available on `doctor`, `inventory`, `graph`, `audit`, and `why`.

It reports the framework inferred from dependencies, conventional source folders,
package manager and its metadata location, workspace members, compiler configs,
and resolved `components.json` aliases. Supported discovery fixtures cover:

- Next.js with and without `src`, and Vite React in TypeScript and JavaScript.
- TS/JS path mappings, JSONC, package/local `extends`, and Vite project references.
- Local `package.json#imports` and shared workspace package `exports`, including
  wildcard source extensions such as `./src/components/*.tsx`.
- pnpm YAML and package.json workspace arrays/object patterns, with exclusions.

Unresolved aliases, conflicting destinations/conditions, malformed direct configs,
and paths outside the selected project/workspace make discovery incomplete and
return exit code `2`. A resolved UI directory that has not been created yet is a
warning. Generic React and unknown frameworks are identified with warnings: this
command checks configuration locations, not build or usage-analysis compatibility.
It does not run a compiler/typecheck or evaluate aliases in executable Vite/Next
configs. Distinct conditional exports and external workspace patterns need explicit
support and are reported instead of guessed.

JSON success stores the context in `data`. Incomplete discovery uses the existing
error envelope with code `PROJECT_NOT_READY` and the partial context under
`error.details.context`. Fatal input errors such as `CWD_INVALID` use the same error
contract. Plain mode is also the default when output is piped. Configuration
contents and registry authentication values are excluded from the report.

The API exposes `await discoverProject({ cwd })` with the same context and
diagnostics, without changing `process.cwd()`. This service is the foundation for
the inventory/graph commands. Existing component workflows still use
their legacy discovery and cleanup behavior until those units are implemented.

### `shadcn-plus inventory`

Fetch every configured compatible registry catalog and inspect local files using
the same pipeline for official, custom, and private registries.

```bash
shadcn-plus inventory --cwd ./apps/web
shadcn-plus inventory --workspace --json
shadcn-plus inventory --cwd ./apps/web --item @company/dashboard --json
shadcn-plus inventory --refresh --plain
shadcn-plus inventory --offline --json
```

The pinned `shadcn@4.23.0` configuration behavior is covered by compatibility tests:
package.json registry entries augment the built-in `@shadcn` source, and entries in
the same package's `components.json` override them. Parent configs are not merged.
Each workspace namespace retains its own binding. By default the selected package
and configured shared alias owners are included; `--workspace` includes every
configured workspace package. Repeated `--item @namespace/name` addresses resolve
in the `--cwd` package, including for sources without an enumerable catalog.

String/object URL templates support `{name}`, `{style}`, `${ENV_VAR}` references,
headers, and query params. Missing environment variables produce diagnostics. Supply
credentials through the process environment; inventory does not load `.env` files.
Catalog pagination is followed up to 100 pages with four concurrent operations by
default. Use `--concurrency 1-16` and `--timeout <milliseconds>` when needed.

Registry metadata is cached for five minutes under
`~/.cache/shadcn-plus/registry-v3`. `--cache-dir <path>` selects another location;
`--no-cache` disables persistence. Conditional requests use ETag/Last-Modified when
available. Authenticated cache entries are isolated by request credentials and
package scope; credential changes cannot reuse an earlier context. Cache files
store normalized metadata and content hashes, excluding request URLs, header
values, raw source contents, environment configuration, and registry auth objects.
Cross-origin redirects are rejected. Short rate-limit backoffs are retried; long
server-requested waits return a diagnostic without retrying early.

Catalog records remain distinct from observed local files. Detailed manifests are
fetched for known requested items and catalog items that have local filename,
directory, or declared-target evidence. Inventory supports nested/multi-file items,
shared files, explicit `~/` and alias targets, conventional file-type destinations,
and JS extension conversion. Local scans cover configured alias directories, up to
20,000 relevant files per scope, excluding generated/dependency directories. Files
outside those directories are included when a fetched manifest targets them.

`presence: present` means every declared file was found at a resolved destination;
it does not prove an upstream origin. Origins stay `candidate`, `ambiguous`, or
`unknown`. Content comparisons distinguish exact raw content from differences that
may include customization or shadcn transformations. No transformed baseline or
installation history is inferred. Competing origins, missing files, failed
manifests, and unsupported destinations remain visible; no files are changed or
deleted. Counts distinguish catalog addresses, unique registry items, local files,
and item candidates, and deduplicate aliases/shared destinations.

A failing source leaves healthy results available. Catalog-less sources report
`catalog-unavailable`; cached metadata retained after a failed refresh reports
`stale`. Incomplete coverage returns exit code `2`, with the partial JSON report
under `error.details.report` and code `INVENTORY_INCOMPLETE`. Complete results use
`data`. Plain output summarizes the same snapshot. Cancellation and request/body
limits preserve incomplete coverage rather than reporting an empty clean inventory.

The API exposes `await buildInventory({ cwd, offline, cacheDir, items })`. Inventory
is read-only with respect to project files; its metadata cache is the only write.
Legacy add/preset/lint/remove commands keep their existing behavior. Ownership
adoption and cleanup plans follow in separate implementation units.

### `shadcn-plus graph`

Build a dependency snapshot from inventory and local source references:

```bash
shadcn-plus graph --cwd ./apps/web --json
shadcn-plus graph --workspace --mermaid > dependencies.mmd
shadcn-plus graph --scope catalog --item @company/dashboard --json
shadcn-plus graph --focus @company/dashboard --transitive --plain
shadcn-plus graph --focus src/components/ui/button.tsx --reverse --transitive --json
shadcn-plus graph --offline --json
```

Installed scope is the default: seeds are item candidates with observed local
files, followed by their registry dependency closure. Catalog scope seeds available
items; repeated `--item` selects specific seeds. Bare names resolve to the official
`@shadcn` binding in that package, including when declared by a custom registry.
Namespaced dependencies retain their package's configuration. HTTP(S) item URLs
use their own request context and never inherit another registry's headers.
GitHub repository/source addresses and relative registry dependencies currently
produce explicit unresolved relationships.

The graph distinguishes registry dependency declarations, candidate file ownership,
observed file imports, observed npm imports, built-ins, declared npm specifications,
and retained CSS/theme/config/env/font effects. Registry relationships do not imply
that customized code still imports a dependency. Package nodes represent requests
and observed import names; no lockfile-installed version is inferred. Presence,
origin confidence, fetch status, and unresolved nodes remain visible. Shared files
have one file node; item nodes retain workspace bindings. Inventory coverage in a
graph concerns potentially local or explicitly inspected candidates. Destination
diagnostics on unselected, available-only catalog records are summarized as a
warning; selecting an affected item still returns incomplete graph coverage.

The pinned TypeScript 5.8.3 compiler API parses JS/TS/JSX/TSX imports, re-exports,
barrels, literal dynamic imports, literal CommonJS references, and type-only
references. Evidence includes one-based source locations and syntax. Resolution
covers TS/JS paths, applicable Vite references, package imports, and unlinked
workspace exports. Comments do not create edges. Computed imports/requires, module
globs, locally shadowed `require` calls, unresolved mappings, and unsupported MDX/Vue/Svelte parsing make source
coverage incomplete. Non-code imported files are retained without interpreting
their internal dependencies. Framework configs are not executed.

By default source scanning covers the selected inventory scopes; `--workspace`
also scans workspace consumers without their own `components.json`. This command
does not identify application entry points, classify unused components, or establish
cleanup eligibility. `coverage.usage` is `not-analyzed`; use `audit` for usage
classification. Shared effects and unsupported resources remain retained.

JSON contains a graph version, deterministic content snapshot ID, typed nodes and
edges, direct dependency/dependent indexes, source/registry cycles with edge IDs,
coverage flags, manifest hashes/fetch status, and diagnostics. `--focus` selects a direct neighborhood;
`--reverse` selects dependents, and `--transitive` follows the full closure. Ambiguous
names return node choices instead of picking a workspace. A focused view includes
its base snapshot ID. Mermaid uses opaque node IDs and encoded labels, with edge
kinds/phases and cycle/unresolved markers from the same graph. `--json --mermaid`
includes the diagram text in the structured response.

Registry traversal is bounded by `--max-items` (default 2,000); extra relationships
point to an unresolved limit node. Source parsing uses `--max-files` (default
20,000); files above 2 MiB are not parsed. Hitting a limit returns partial coverage.
Cycles are detected iteratively, including self-loops. Incomplete JSON uses exit
code `2`, code `GRAPH_INCOMPLETE`, and `error.details.graph`. Plain diagnostics go
to stderr. Mermaid text remains on stdout with diagnostics on stderr and exit `2`
when coverage is incomplete, so the diagram artifact remains usable.

Opaque URL dependency credentials are kept only in memory. Cache v3 stores safe
references and effect fingerprints; older cache projections are not reused.
Online traversal can re-fetch a parent manifest to recover an opaque URL. Offline
traversal reports an unresolved edge when that original address is unavailable.
Project files are never modified; only the registry metadata cache may be written.

The API exposes `await buildDependencyGraph(options)`, `graphNeighbors(graph, id,
{ direction: "dependents", transitive: true })`, `selectGraph`, and `formatMermaid`.
Help/version/API imports remain lazy with respect to source scanning and the
TypeScript runtime.

### `shadcn-plus audit` and `shadcn-plus why <reference>`

Classify observed local items from every configured compatible registry, then
explain an item, managed file, or related package:

```bash
shadcn-plus audit --cwd ./apps/web --json
shadcn-plus audit --summary --json
shadcn-plus why @company/dashboard --plain
shadcn-plus why src/components/ui/button.tsx --json
shadcn-plus audit --offline --json
shadcn-plus audit --entry 'apps/web/src/main.tsx' --dev-entry 'apps/web/tests/**/*.ts' --json
```

Audit includes all workspace consumers by default, including packages without a
`components.json`. Counts group identical observed file footprints and keep all
candidate addresses and competing origins. Available catalog entries without local
files are excluded from usage totals. Managed files without a matching registry
manifest remain visible as unknown-origin findings.

Usage has four states: `runtime`, `development-only`, `unused-candidate`, and
`unknown`. Runtime paths follow resolved imports from application entries;
development paths include test/story/config/script roots and type-only imports.
An unused candidate requires agreement between the bounded reference graph and
both all-source and production runs of pinned `knip@6.45.0`, with complete graph,
root, analyzer, and workspace coverage. Analyzer disagreement retains the file
with a diagnostic. Known runtime paths can remain visible during incomplete source
analysis; missing coverage never becomes evidence of absence.

Entry discovery supports conventional Next app/pages routes, Vite HTML module
entries, generic `src/main`/`src/index` entries, and source package bins/exports.
Executable project configuration is never evaluated. Knip uses a generated static
configuration with its framework plugins disabled; it does not load the project's
Knip configuration or infer arbitrary plugin entries. Only simple framework
configuration objects with recognized non-entry settings permit default entry
discovery. Custom settings, config wrappers/plugins, or unsupported entry layouts
require repeated `--entry` patterns. These replace runtime conventions in the
workspace scopes they match. Patterns are relative to the workspace root (or
project root outside a workspace); `--dev-entry` adds development roots. A missing
match returns incomplete coverage. Supply all runtime roots for each overridden
scope. Public package contracts remain retained even with explicit entries.
Inline HTML imports of npm packages lack source-graph evidence and return
incomplete coverage; move them into a source module for a complete audit.

Public exports, partial multi-file items, CSS/theme/config/env/font effects,
ambiguous ownership, and retained registry dependents carry retention reasons.
Registry dependency declarations explain retention separately from source usage.
Unused is a usage finding, not permission to delete: every cleanup eligibility
flag remains false. Related package findings retain framework/peer/public/script
requirements and shared consumers; package candidates are advisory only. No source,
imports, manifests, lockfiles, or packages are changed. Registry cache writes and
temporary generated analysis configuration are the only writes; temporary files
are removed after analysis.

`why` accepts a qualified item address, file path, finding/node ID, or related
package name. Ambiguous references return `WHY_AMBIGUOUS` with choices. Evidence
includes a representative root-to-file import path with source locations (up to
64 steps), direct consumers (up to 12, with the full count), and retention reasons.
Unmatched references return `WHY_NOT_FOUND` only when coverage is complete;
otherwise they return `WHY_UNRESOLVED` with diagnostics.

JSON uses the shared output envelope. A complete audit exits `0`, including when
unused candidates exist. Incomplete analysis exits `2` with `AUDIT_INCOMPLETE` and
the partial report in `error.details.audit` or explanation in `error.details.why`.
`--summary` omits item/file/package/root details while preserving counts, snapshot
IDs, coverage, diagnostics, analyzer version, and measured pass durations. Timings
are excluded from snapshot hashes. Plain errors go to stderr; JSON stdout remains
one response. The registry/cache/limit flags supported by `graph` also apply here;
`--analysis-timeout` bounds each of two sequential Knip passes (default 60000 ms,
maximum 300000 ms). There is no audit fix/removal flag.

The lazy API exposes `await auditProject({cwd, entries, devEntries, offline})` and
`explainAudit(report, reference)`. The latter reuses an existing snapshot without
fetching or re-running analysis. Help/version/API imports do not load Knip,
TypeScript, or the HTML parser. MDX/Vue/Svelte, computed references, unresolved
aliases, and unsupported configuration retain the graph's coverage limitations.
No performance or token-saving claim is inferred from these measurements.

### `shadcn-plus add [components...]`

Add ShadCN components to your project.

```bash
# Interactive mode - select components from a non installed components list
shadcn-plus add

# Add specific components
shadcn-plus add button card dialog
```

### `shadcn-plus remove [components...]`

Remove ShadCN components from your project.

```bash
# Interactive mode - select installed components to remove
shadcn-plus remove

# Remove specific components
shadcn-plus remove button card
```

**Features:**

- Interactive removal with confirmation
- Dependency conflict detection
- Automatic import cleanup from your codebase
- Optional dependency removal
- Validates internal dependencies before removal

### `shadcn-plus lint`

Find and remove unused ShadCN components from your project.

```bash
shadcn-plus lint
```

**Features:**

- Scans your entire codebase for component usage
- Identifies unused components
- Option to automatically remove unused components
- Provides removal commands for manual cleanup

### `shadcn-plus preset`

Manage component presets - collections of commonly used components.

```bash
# Interactive preset manager
shadcn-plus preset
```

#### Preset Subcommands

```bash
# List all available presets
shadcn-plus preset list
shadcn-plus preset list --builtin    # Show only builtin presets
shadcn-plus preset list --custom     # Show only custom presets

# Show components in a preset
shadcn-plus preset show core
shadcn-plus preset show "My Custom Preset"

# Install all components from a preset
shadcn-plus preset install dashboard
shadcn-plus preset install mobile

# Create a custom preset
shadcn-plus preset create "my-preset" button card input
shadcn-plus preset create "my-preset" --description "My custom components"
shadcn-plus preset create "my-preset" --base core,form  # Extend multiple existing presets
shadcn-plus preset create "dashboard-mobile" --base dashboard,mobile --description "Mobile dashboard components"

# Delete a custom preset
shadcn-plus preset delete "my-preset"
```

## Requirements

- Node.js 22.12.0 or higher
- A ShadCN project with `components.json` file
- Package manager: npm, pnpm, yarn, or bun

Package-manager detection uses the nearest project's `packageManager` field or
lockfile before the launcher environment. It supports `bun.lock` and `bun.lockb`,
and reports conflicting declarations/lockfiles instead of choosing silently.
The installer runners use npm/npx, pnpm dlx, modern Yarn dlx, or Bun bunx.
External installers/removers inherit terminal input and output so their prompts
and diagnostics remain visible. Configure `tailwind.cssVariables` in
`components.json`; the old add-time CSS-variable flags are not accepted by
upstream `shadcn add` and are no longer exposed.

## How It Works

1. **Component Detection**: Reads your `components.json` file to understand your project structure
2. **Package Manager Detection**: Automatically detects your package manager from lock files
3. **Smart Installation**: Uses the appropriate package manager to install components
4. **Usage Scanning**: Analyzes your codebase to find component usage patterns
5. **Dependency Management**: Handles both external and internal component dependencies

## File Structure

shadcn-plus works with the standard ShadCN project structure:

```
your-project/
├── components.json          # ShadCN configuration
├── src/
│   └── components/
│       └── ui/             # Components directory
│           ├── button.tsx
│           ├── card.tsx
│           └── ...
└── package.json
```

## Custom Presets

Custom presets continue to use the existing `~/.compadcn/custom-presets.json`
storage until an explicit migration is implemented. They can be:

- Created from scratch
- Based on existing presets
- Shared across projects

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request
