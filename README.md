# shadcn-plus

A CLI for installing and managing shadcn/ui components and presets, formerly named compadcn.

V2 is under development. This checkout includes multi-registry search and
installation, dependency graphs, read-only usage audits, exact cleanup plans,
bounded plan application, conflict-aware recovery, and shareable component
collections with explicit legacy preset migration, portable agent guidance, and
CI policy checks with reviewed baselines.

## Features

- **Registry management** - Search, install, and inventory official/custom/private items
- **Usage analysis** - Inspect dependency graphs and explain runtime/development use
- **Reviewed cleanup** - Preview exact changes and retain uncertain/shared resources
- **Verification and recovery** - Apply checked plans with backups and conflict-aware restore
- **Collections** - Share qualified component selections and explicitly migrate old presets
- **Agents and CI** - Use compact results, reviewed baselines, and a bundled portable skill

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

Doctor, inventory, graph, audit, why, search, add, plan, apply, restore, operation,
collection, check, agent, help, version, and CLI errors support these output modes. Add requires explicit
addresses and `--yes` outside an interactive terminal. Apply and restore also
require `--yes` outside an interactive terminal. Legacy lint/remove and preset workflows do not yet support
`--json` or `--plain`; they return
`OUTPUT_MODE_UNSUPPORTED` instead of mixing terminal text with machine output.
Workflows requiring prompts fail with `INTERACTIVE_REQUIRED` when no interactive
terminal is available or `--no-interactive` is set. `preset list` and `preset show`
remain available without prompts. Legacy workflows return nonzero exit codes for
validation, filesystem, and subprocess failures; cancellation remains a normal
outcome. Legacy file cleanup is still non-transactional. Use the new plan/apply
workflow for checked file deletion with backups and recovery.

Inventory, graph, audit/why, search, add, plan, apply, restore, check, and collection migration/install share one task display. Progress is
automatic in an interactive terminal; `--progress` opts into append-only stderr
stages when output is plain or JSON, and `--no-progress` disables it. JSON stdout
remains one envelope. Task stages include actual catalog status/cache results,
source discovery, analysis passes, and file verification; unknown-duration work
uses elapsed time rather than percentages. Progress callbacks are available to API
callers as `onProgress(event)` without loading terminal rendering.

`TERM=dumb` uses plain output. `NO_COLOR` is respected, and `ACCESSIBLE=1` enables
Clack's static prompt output with append-only task feedback. Pickers have bounded
visible rows, keyboard hints, and a selected count. Escape/Ctrl+C before installation
returns exit `0` with JSON `status: "cancelled"` or a plain cancellation message.
Signals abort in-flight registry/analysis work. Interrupting a started installer
returns exit `2` with `INSTALL_INTERRUPTED`: files may already have changed.
Windows cancellation also terminates the package-manager wrapper's descendants.

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
is available on `doctor`, `inventory`, `graph`, `audit`, `why`, `search`, `add`, and
the `plan` subcommands, `apply`, `restore`, `operation`, `check`, and collection install/migration.

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
Legacy preset/lint/remove commands keep their existing behavior. The new
plan/apply workflow uses the shared inventory, graph, and audit services.

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

### `shadcn-plus plan`

Generate reviewable file-cleanup artifacts without deleting files or executing
verification scripts. All configured compatible registries use the same planning
and ownership rules.

```bash
# Propose a batch of observed ownership mappings, then review the saved JSON.
shadcn-plus plan snapshot --out .shadcn-plus/ownership.json --json

# Use that reviewed baseline for automatic unused-item planning.
shadcn-plus plan prune --ownership .shadcn-plus/ownership.json --out .shadcn-plus/plans/cleanup.json --json

# An explicit named proposal can accept an unverified local mapping.
shadcn-plus plan remove @company/unused-widget --include-unverified --json

# Changes since a reviewed snapshot require a named inclusion.
shadcn-plus plan remove @company/unused-widget --ownership .shadcn-plus/ownership.json --include-modified --json

# Recheck scope, analysis, ownership, and exact operations; do not apply them.
shadcn-plus plan check .shadcn-plus/plans/cleanup.json --json
```

`snapshot` proposes mappings for observed registry items using current local
hashes, source identities, and manifest hashes. Repeated `--item <reference>`
restricts the proposal. Review it before passing it to `--ownership`: that argument
accepts the supplied local mapping as a baseline. The snapshot establishes an
observed file state; it does not reconstruct installation history or a pristine
transformed upstream version. Ambiguous origins, partial mappings, linked files,
and incomplete analysis remain excluded. No project state is written automatically.

`prune` includes only wholly unused, unchanged, mapped items with complete
analysis. Without a reviewed ownership snapshot, inferred ownership remains
blocked. `remove <references...>` restricts the proposal to named observed items
or unmapped files inside managed directories. `--include-unverified` and
`--include-modified` apply only to these named requests. They do not waive live or
development usage, public contracts, partial items, ambiguous ownership, unresolved
analysis, retained consumers, or shared-resource protection. Named multi-item
requests produce no executable operations if any named target is blocked.

Plans retain imports in application code, packages, lockfiles, CSS/theme/config/
environment/font effects, and files outside the selected package. Read-only
analysis includes workspace consumers by default, even without their own
`components.json`. A retained source consumer or registry-declared dependent blocks
deletion of its dependency. Orphan pairs/cycles can be proposed together when their
entire dependency set is eligible. Shared ownership cannot become a partial file
deletion. Select an owning item instead of one file from its multi-file manifest.

Every operation is an explicit relative `delete-file` path with its before-hash,
byte count, permissions, owners, and an exact unified deletion diff. No operation
contains a filesystem glob. JSON artifacts retain CRLF/BOM/no-final-newline bytes;
terminal previews escape control characters. Content IDs detect changes to an
artifact, and `plan check` also regenerates eligibility and operations from fresh
analysis, so recalculating an ID does not establish deletion eligibility.

Input preconditions cover every ordinary non-generated file under the analyzed
workspace, including consumers, compiler/framework configuration, manifests, and
lockfiles. Resolved compiler settings also have a fingerprint, including inherited
configuration. Added, removed, changed, or linked inputs invalidate a saved plan;
changes detected during planning produce a blocked proposal. Generated/dependency
directories, `.shadcn-plus`, TypeScript `.tsbuildinfo`, and lint cache files
(`.eslintcache`/`.stylelintcache`) are excluded. A reference that relies on an excluded
input prevents a ready plan. Source/configuration symlinks and deletion targets
with multiple hard links remain unsupported. Plans are bound to the creating
workspace location and selected package; choose the same `--cwd` for checking.

Use `--out <new.json>` to create a bare versioned artifact. It never overwrites an
existing file or writes over project configuration, and artifacts should live
outside managed component directories or under `.shadcn-plus`. Output paths are
relative to the invoking directory. `--out` is the only requested artifact write;
the registry metadata cache retains its existing behavior. The output artifact
does not invalidate its own input fingerprint. Blocked proposals can also be saved
for inspection and contain no executable operations.

JSON success exposes `data.plan` or `data.ownership`, with `output` when a file was
written. `--summary` omits operation diffs and input-file lists from the response;
the saved artifact remains complete. Ready and empty plans exit `0`. Blocked or
incomplete proposals exit `2` with `PLAN_BLOCKED` or `PLAN_INCOMPLETE` and their
partial plan under `error.details.plan`. Incomplete ownership uses
`OWNERSHIP_INCOMPLETE`. Stale checks exit `2` with `PLAN_STALE` and change details.
Plain errors go to stderr; JSON stays one response on stdout.

Planning uses audit's entry/cache/request/analysis flags. `--max-input-files`
defaults to 50,000 (maximum 100,000), and `--max-input-bytes` defaults to 256 MiB
(maximum 1 GiB). Previews are limited to 2 MiB per file, 2,000 deletion operations,
and 8 MiB of combined diff text. Hitting a limit retains affected items or blocks
incomplete input coverage. Default verification descriptors cover package
scripts `typecheck`, `lint`, and `build`; missing scripts are `not-configured`, not
a pass. Repeated `--verify-script <name>` requires selected scripts and blocks a
plan if one is missing. Planning and checking never run these scripts.

The lazy API exposes `createOwnershipSnapshot`, `createCleanupPlan`,
`checkCleanupPlan`, `parseCleanupPlan`, and `parseOwnershipSnapshot`. Parsing and
checking validate strict versioned schemas, integrity, paths, operation ownership,
and preview bytes. Use `apply` to execute a ready plan.

### `shadcn-plus apply`, `operation`, and `restore`

```bash
# Revalidate and apply the exact saved plan, then run its configured checks.
shadcn-plus apply --plan .shadcn-plus/plans/cleanup.json --yes --json

# Also establish a passing baseline before deleting files.
shadcn-plus apply --plan .shadcn-plus/plans/cleanup.json --yes --precheck --json

# Inspect a returned operation ID without changing files or fetching registries.
shadcn-plus operation <operation-id> --json

# Restore this operation's missing files without overwriting replacements.
shadcn-plus restore <operation-id> --yes --json

# Recover a lock left by this operation's stopped process on this host.
shadcn-plus restore <operation-id> --yes --recover-lock --json
```

Apply accepts only a ready plan from the same tool version, workspace location,
and selected package. It acquires a workspace cleanup lock and records the
operation before awaiting revalidation. It then reruns `plan check`, validates
ownership and remaining consumers, and compares the exact complete input scope.
`--yes` accepts the reviewed operation; it does not waive a stale plan or expand
its targets. Official, custom, and private registry items follow this same path.

Every target is backed up before any deletion. The saved plan, raw backup bytes,
timestamps, permissions, and hash-chained append-only journal live under
`.shadcn-plus/operations/<operation-id>`. Backup and journal writes are flushed
before source mutations; deletion intent is recorded before unlinking each file.
Targets are checked again immediately before deletion. The whole input scope is
checked after deletions and after verification; unexpected changes cause recovery
of this operation's files. Dirty repositories are supported, and the Git index is
left intact. Application does not rewrite imports, uninstall dependencies, update
lockfiles, or remove shared CSS/theme/configuration resources.

All configured checks from the plan run sequentially in the selected package via
its package manager. `--verify` is accepted for clarity; configured checks always
run, and there is no verification bypass. Their script hashes are checked again
before launching. Missing default scripts remain `not-configured`, and later
checks become `not-run` after a required failure. An operation marked `completed`
can have no configured checks: that is not a verified build. `--precheck` also
runs the checks before mutation and stops with `precheck-failed` on an existing
failure. Without a before-check, a post-check failure has no established baseline.

`--verification-timeout` defaults to 120,000 ms per script, up to 1,800,000 ms.
Verification uses ignored stdin and a noninteractive environment. Subprocess
output is discarded to avoid mixing logs or credentials into JSON and journals;
receipts record script names, phase, status, duration, and exit codes. Rerun a
failed package script directly to inspect its output. Timeout/cancellation stops
the verification process tree before attempting recovery. Windows uses Windows
PowerShell/CIM to track descendants across wrapper exits; POSIX uses a dedicated
process group. If shutdown cannot be confirmed, `VERIFICATION_TERMINATION_UNCONFIRMED`
leaves the operation `recovery-required` without automatic restoration. Stop the
remaining check processes before calling `restore`. Registry/cache/request
and analysis timeout flags match `plan check`; `--offline` requires usable cached
metadata for fresh revalidation.

On a filesystem failure, changed scope, failed check, or interruption after
mutation, automatic recovery considers only paths with a recorded deletion intent.
Missing paths can be recreated from hash-checked backups with their saved mode and
timestamps. Existing files with original bytes and permissions are accepted as
already recovered. Different files, linked parents, damaged backups, and changed
permissions become explicit conflicts and are preserved. Recovery stages complete
bytes and uses an exclusive hard link to avoid replacing a concurrently recreated
target. A completed staging/link step can be finished after interruption; a partial
or changed staging file remains a conflict for inspection.

`operation` reads persisted receipts without taking a mutation lock, running
scripts, or contacting registries. It reports planned paths, attempted deletions,
recorded deletions, recovered paths, conflicts, and verification outcomes. An
`interrupted` status means the journal has no terminal record; its owner might
still be running. `restore` requires no healthy current configuration or registry
access. It is idempotent while original files remain unchanged. Once recovery
starts, it finishes its bounded recovery pass rather than stopping midway on
cancellation. An incomplete final journal record is archived before recovery;
invalid complete records prevent automatic recovery.

Live locks cannot be stolen. Lock errors include the owning operation ID when
available. `--recover-lock` accepts only a matching operation whose same-host
process is provably stopped; foreign-host locks, reused/live PIDs, malformed locks,
and interrupted lock-recovery guards require inspection. An abrupt stop while the
initial journal or lock is being created may also require inspecting state before
clearing a lock. Keep the operation directory until recovery is finished.

These operations target local filesystems with exclusive creation and hard-link
support. They do not provide a cross-file atomic transaction, isolation from
arbitrary external writers, or universal power-loss durability. The implementation
checks real paths and file identities, but Node's portable APIs cannot make a
content comparison and path unlink one atomic operation. Network filesystem lock
semantics are unsupported; see [Node's file-system flags documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html#file-system-flags).
Verification scripts can change other files or external state; those effects are
not backed up or rolled back. Backups contain original source code and stay local;
exclude `.shadcn-plus/operations/`, `.shadcn-plus/plans/`, and runtime lock files
from version control. Reviewable check policies/baselines can be tracked separately.
No retention cleanup runs automatically.

JSON success returns `data.operation`. Outcomes `rolled-back`, `precheck-failed`,
and `recovery-required` exit `2`, using `CLEANUP_ROLLED_BACK`,
`CLEANUP_PRECHECK_FAILED`, or `CLEANUP_RECOVERY_REQUIRED`, with the receipt under
`error.details.operation`. Stale plans use `PLAN_STALE` with a `rejected` receipt.
Cancellation during revalidation exits normally with its operation ID and a
persisted `cancelled` receipt. Cancellation after mutation returns its recovery
outcome instead of reporting that nothing happened. Plain failures use stderr;
JSON stdout remains one response. Journals are versioned and limited to 16 MiB;
saved plans are limited to 64 MiB. The lazy API exposes `applyCleanupPlan`,
`inspectCleanupOperation`, and `restoreCleanupOperation`.

### `shadcn-plus check`

Run a read-only usage-policy gate using the same workspace audit and configured
official/custom/private registries. Check never deletes files, runs project
verification scripts, or treats a waiver as cleanup authorization.

```bash
shadcn-plus check --cwd apps/web --json
shadcn-plus check --cwd apps/web --json --summary
shadcn-plus check --cwd apps/web --policy .shadcn-plus/check-policy.json --json --limit 20
```

Policies are strict JSON with a version and rule levels. Unspecified rule levels
use these defaults:

```json
{
  "policyVersion": 1,
  "rules": {
    "unused-item": "error",
    "unused-file": "error",
    "unused-package": "warning",
    "unknown-usage": "warning"
  }
}
```

`unused-item` reports observed registry item groups. `unused-file` reports unused
unmapped files inside managed directories, avoiding duplicate reports for item
files. `unused-package` reports audit package candidates. `unknown-usage` preserves
uncertain item/unmapped-file findings for inspection. Each rule accepts `error`,
`warning`, or `off`. Workspace consumers are always included. Incomplete analysis
is independently blocking even when every rule is off.

| Exit | Meaning |
| --- | --- |
| `0` | Complete analysis with no new error-level policy findings |
| `1` | Complete analysis with new error-level findings (`CHECK_FAILED`) |
| `2` | Incomplete/interrupted analysis, incompatible baseline, or invalid inputs |

Success uses `data.check`; policy/coverage failures preserve the report under
`error.details.check`. Check returns compact workspace-relative paths, counts,
coverage, and at most 20 new findings by default. `--limit 0` or `--summary` hides
details without changing the outcome. `--limit` accepts 0–200; per-finding paths,
aliases, scopes, reasons, and diagnostics are also bounded with omission counts.
Use each finding's `reference` with `why` for full evidence. Use `audit` if more
diagnostics are needed. No token-saving percentage is assumed from compact output.

### Reviewed check baselines

```bash
# Record current complete findings in a new artifact, then review it.
shadcn-plus check baseline --cwd apps/web --policy .shadcn-plus/check-policy.json --out .shadcn-plus/check-baseline.json --json

# Explicitly accept the reviewed findings while blocking new errors.
shadcn-plus check --cwd apps/web --policy .shadcn-plus/check-policy.json --baseline .shadcn-plus/check-baseline.json --json
```

Baseline capture is an explicit review step. It records current findings, including
errors, without fixing them. Passing `--baseline` accepts those findings for CI;
do not regenerate it automatically to make a failed check green. Creation refuses
incomplete analysis and never overwrites an existing file. Select a new filename
when preparing an update, then review the change before replacing the tracked file.

Baselines have strict versioned schemas, content IDs, and portable finding
identities. They bind the selected package/workspace scopes, rule policy, tool and
engine versions, entry patterns, analysis limits, and project/compiler/registry
configuration. Changed context requires a newly reviewed artifact. Finding text
normalizes checkout line endings/BOMs, while cleanup keeps exact-byte checks.
Findings bind relative paths and evidence hashes, so changed unused item contents/manifests are
reviewed again; unrelated source additions can be checked as new findings. Absolute
checkout locations and credential-scoped cache IDs are excluded from waiver IDs.

Use matching policy/entry/limit settings during capture and checking. Baselines
can move between compatible checkouts; private-registry caches retain their own
credential/workspace isolation. Populate the CI cache before relying on offline
metadata. Baseline acceptance never suppresses coverage failures. Reports separate
new errors/warnings, accepted findings, and resolved baseline entries.
`--include-known` includes accepted findings in the bounded response.

Check artifacts are limited to 16 MiB. Keep reviewable policies/baselines tracked
while ignoring source backups, plans, and locks. The lazy API provides
`checkProject`, `createCheckBaseline`, `parseCheckPolicy`, and `parseCheckBaseline`.

### Agent skill and CI integration

```bash
# Read the bundled guide without scanning a project or contacting registries.
shadcn-plus agent skill
shadcn-plus agent skill --json

# Explicitly install a new skill file for a compatible agent host.
shadcn-plus agent skill --out .agents/skills/shadcn-plus --json
```

The bundled [Agent Skills](https://agentskills.io/specification) file lives at
`skills/shadcn-plus/SKILL.md` in the repository and npm package. It guides agents
through summary-first audits, focused explanations, exact plans, and recovery,
while preserving the user's existing authorization. It also explains CI exit codes
and why a baseline does not grant cleanup permission. Skill installation creates
only the requested `SKILL.md`; it does not replace existing skills, `AGENTS.md`,
editor settings, or personal configuration. Agent-host discovery locations vary;
choose the path your host supports. The lazy API exposes `getAgentSkill` and
`installAgentSkill`.

The [consumer workflow](examples/ci/shadcn-plus.yml) and
[policy example](examples/ci/check-policy.json) are also included in the npm
package. Use a pinned tool dependency, install the project's lockfile, then run
`pnpm exec shadcn-plus check` with explicit `--cwd`, policy, and reviewed baseline.
Supply the environment variables required by private registries through the CI
credential mechanism. Missing credentials remain incomplete coverage, rather than
a successful empty result. Keep the command's exit status intact.

The repository CI runs type checking, existing behavioral tests, and a package
dry run on Node 24. Its workflow uses SHA-pinned actions and read-only repository
permissions; it has no publication or release step. Full compatibility-matrix
verification remains part of release readiness.

### `shadcn-plus search [query]`

Search the inventory's combined catalogs without installing anything:

```bash
shadcn-plus search dialog
shadcn-plus search 'account menu' --registry @company --type ui --json
shadcn-plus search --presence present --workspace --json
shadcn-plus search --offline --limit 100 --plain
shadcn-plus search --item @private/known-component --json
```

Results preserve namespace and workspace identity when names collide. Search
matches all query words across qualified addresses, descriptions, titles, types,
and local presence. Repeated `--registry` and `--type` filters narrow the result;
type names accept `ui` or `registry:ui`. `--presence` accepts `any`, `present`,
`partial`, `absent`, or `unknown`. Presence refers to observed destination files,
not proven installation history. Default output shows 50 matches; `--limit 1-1000`
controls that projection and reports omitted counts.

Registry request/cache options match inventory. Healthy or stale entries remain
visible when a source fails. Incomplete search exits `2` with `CATALOG_INCOMPLETE`
and the report in `error.details.catalog`; complete results are under `data`.
Catalog-less sources can be inspected using repeated `--item @namespace/name`.
The lazy API exposes `searchCatalog(options)` and the pure `createCatalogIndex`
and `searchInventory` helpers for reuse of an existing inventory snapshot.

### `shadcn-plus add [components...]`

Open a searchable picker over configured catalogs, or supply explicit addresses:

```bash
shadcn-plus add --cwd ./apps/web
shadcn-plus add --registry @company --type block
shadcn-plus add --query dialog
shadcn-plus add button @company/user-menu
shadcn-plus add @company/user-menu --yes --json
shadcn-plus add button --overwrite --yes --plain
```

The picker uses pinned Clack 1.9.0. It searches precomputed local text over a single
inventory snapshot; keystrokes do not scan files or fetch catalogs. Type to filter,
use arrows to navigate, Tab to toggle a row (Space also works while navigating),
and Enter to review all selected items, including selections hidden by a query.
There is no select-all shortcut. Rows show qualified names and local presence;
focused hints include descriptions/types. Source status is displayed before the
picker, and healthy sources remain usable when another registry fails.

Picker filters apply before interactive text search. Local-file-present choices
are disabled unless `--overwrite` is set. An all-present/unavailable result reports
a clear empty state instead of an empty success. A single review shows the selected
items, file counts, shared-effect counts, overwrite policy, package manager, and
target project. `--yes` skips that review for explicit selections; noninteractive
add requires both `--yes` and component addresses.

Bare names resolve to the selected package's `@shadcn` source. Qualified names keep
their configured registry binding; the static legacy component list is not used
for add. Known items from catalog-less sources can be supplied explicitly. Add
targets one `--cwd` package; use `search --workspace` to browse other packages and
select their directory with `--cwd` when installing there. Selected manifests must
have fresh usable metadata and resolved file destinations. Style/theme/base-only
operations are delegated to their upstream workflows.

Installation runs pinned `shadcn@4.23.0` through the project's npm/pnpm/Yarn/Bun
launcher, using one qualified selection and upstream `--yes` after the review.
Existing complete local footprints are skipped unless overwrite is requested.
Interactive installer output remains live; plain/JSON installs suppress upstream
terminal output so the result contract stays clean. A failed installer returns
`INSTALL_FAILED`. Even after exit `0`, missing expected selected files return
`INSTALL_VERIFICATION_FAILED`. Successful results include added/skipped addresses
and the number of verified destinations.

The upstream installer manages dependency closure and shared configuration.
Verification checks selected file presence; it does not establish transformed
content provenance, verify every dependency/shared effect, or provide rollback.
Project configuration changes during selection stop installation with
`PROJECT_CHANGED`. Collection installation uses this same workflow. Legacy preset
installation retains its old runner; explicitly migrate presets into collection
files to use the current multi-registry installation path.

### `shadcn-plus collection`

Collections are portable JSON files containing component addresses and intent.
They describe what to install, independently of what is currently installed.
Counts come from their item lists; dependency declarations come from current
registries during installation.

```json
{
  "collectionVersion": 1,
  "name": "Dashboard",
  "description": "Shared controls for the customer dashboard",
  "items": ["@shadcn/button", "@company/chart"]
}
```

```bash
shadcn-plus collection create collections/base.json button @company/chart --name "Dashboard"
shadcn-plus collection create collections/app.json @shadcn/card --from collections/base.json
shadcn-plus collection list collections --json
shadcn-plus collection show collections/app.json --json
shadcn-plus collection install collections/app.json --cwd ./my-app --yes --json
```

`collections` is also accepted as a command alias. Create/show/list work without
a project or registry requests. Creation qualifies bare names as `@shadcn/name`;
saved files require qualified addresses. Repeated `--from` materializes composed
items, preserving first-seen order and removing duplicate addresses. Different
namespaces remain distinct. Composition does not create a live inheritance chain.
Use `--name` and `--description` for the new collection's display text.

Creation writes only the named new JSON file and any missing parent directories.
It never overwrites existing files or writes over project configuration. Paths
are relative to the invoking directory; install's `--cwd` selects the destination
project. List reads one directory of JSON files and reports invalid entries with
`COLLECTION_LIST_INCOMPLETE` instead of silently omitting them.

Share collection JSON files through your repository. Recipients configure their
own namespace bindings and authentication in their project. Collections do not
embed registry URLs, credentials, scripts, ownership claims, or copied dependency
metadata, and they are not version-pinned dependency lockfiles. Installation uses
the existing `add` selection, fresh metadata checks, confirmation, overwrite
policy, upstream delegation, and destination verification. It supports the same
compatible official/custom/private registries. Outside an interactive terminal,
`--yes` is required. Installation has the same side effects and rollback limits as
`add`; it does not use the cleanup operation journal.

### `shadcn-plus collection migrate`

Migration reads old `~/.compadcn/custom-presets.json` only when explicitly invoked.
Omitting `--out` previews the conversion without writing collection files or a
backup. Registry metadata may use the normal cache.

```bash
# Preview old custom presets against this project's configured registries.
shadcn-plus collection migrate --cwd ./my-app --json

# Choose the intended namespace for a colliding legacy name and write new files.
shadcn-plus collection migrate --cwd ./my-app --map button=@shadcn/button --out migrated-collections --json

# Import a particular legacy file/preset, with an explicit private mapping.
shadcn-plus collection migrate --from ./old-presets.json --preset dashboard --map widget=@company/widget --out dashboard-collections --json
```

Bare legacy names are resolved from current configured catalogs, not the old
hardcoded component/dependency list. Incomplete catalogs, unknown names, invalid
entries, and names matching different origins block writing. Equivalent aliases
for the same origin are collapsed; an available `@shadcn` address is preferred.
Already qualified addresses are preserved. Repeated `--map old=@namespace/item`
explicitly selects an address for every matching value in the selected presets.
If every reference is qualified or mapped, migration needs no project scan or
registry requests. Address availability is checked when the collection is installed.

Use repeated `--preset <id>` to select legacy record IDs rather than display names.
Without selection, all custom presets are considered. Names and descriptions are
preserved; copied npm/internal dependency arrays are discarded from collection
files. Malformed entries are reported rather than silently dropped. No collection
artifact is exposed for a blocked entry, and no output directory is created until
every selected entry is ready.

`--out` must name a new directory. Migration rechecks the source bytes before
writing, saves an exact `legacy-custom-presets.json.bak`, and writes one collection
per selected preset. Filenames combine a readable legacy-ID prefix and stable
suffix to avoid normalized-name collisions; display names remain unchanged.
The original storage is never edited, deleted, or used automatically on startup.
Share the resulting collection JSON files; keep the raw legacy backup local.

JSON create/show responses contain `data.collection`; list uses `data.collections`.
Install returns the existing `add` result. Migration returns `data.migration` with
`preview`, `blocked`, or `written` status, per-entry issues, source fingerprint,
backup, and written paths. Blocked migration exits `2` with `MIGRATION_BLOCKED`
and the report under `error.details.migration`. Existing outputs and changed source
data are rejected. If a filesystem error interrupts output, the original remains
intact and `MIGRATION_WRITE_FAILED` identifies the output directory and completed
writes for inspection before retrying in a new directory.

Collections are strict version-1 files, limited to 1 MiB, 1,000 unique addresses,
and 4,096 characters per address. Migration accepts up to 8 MiB of legacy data,
1,000 presets, and 1,000 component entries per preset. The lazy API provides
`createCollection`, `parseCollection`, `readCollection`, `writeCollection`,
`listCollections`, and `migrateLegacyPresets`.

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

Legacy custom presets retain their existing `~/.compadcn/custom-presets.json`
storage. Use `collection migrate` to explicitly create shareable collection files
and an exact backup. The legacy preset commands remain available and can be:

- Created from scratch
- Based on existing presets
- Shared across projects

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request
