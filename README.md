# shadcn-plus

A CLI for installing and managing shadcn/ui components and presets, formerly named compadcn.

V2 is under development. This checkout retains the existing component and preset commands while its new foundations are implemented. Multi-registry auditing and cleanup plans are not implemented yet.

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

Doctor, inventory, help, version, and CLI errors support these output modes. Existing component and
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
is available on `doctor` and `inventory`.

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
the upcoming inventory/graph commands. Existing component workflows still use
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
`~/.cache/shadcn-plus/registry-v2`. `--cache-dir <path>` selects another location;
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
Legacy add/preset/lint/remove commands keep their existing behavior. Dependency
graph construction, usage analysis, ownership adoption, and cleanup plans follow
in separate implementation units.

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
