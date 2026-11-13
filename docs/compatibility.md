# Compatibility and verification

shadcn-plus requires Node.js **22.12.0 or newer**. CI runs the CLI regression
suite and a fresh package-consumer check on Windows and Linux with Node 22.12.0
and Node 24. This verifies those combinations; it does not certify every Node,
framework, package-manager, or registry version.

## Real application corpus

`pnpm run verify:frameworks` creates independent temporary applications, installs
locked dependencies, builds each application, audits its live and unused private
components, reviews a fixed ownership ground truth, plans one exact deletion,
applies it with real build verification, and restores the original bytes. Shared
utilities, live components, configuration, styles, manifests, and lockfiles must
remain unchanged. CI runs this corpus on Windows and Linux with Node 24.

| Application | Source and component paths | UI dependency | CSS | Install/check runner |
| --- | --- | --- | --- | --- |
| Next 16.4.6 App Router | TSX, root `app`, `components/ui` | Radix Slot 1.5.0 | Tailwind 4.3.5 | npm |
| Next 16.4.6 Pages Router | JSX, `src/pages`, `src/components/ui` | Radix Slot 1.5.0 | Tailwind 3.4.19 | pnpm |
| Vite 7.3.8 + React 19.3.1 | JSX, `src/design/primitives/nested` | Base UI 1.9.0 | Tailwind 4.3.5 | pnpm |

The fixtures use React 19.3.1, real PostCSS integrations, and the React Vite
plugin. They cover selected combinations, rather than every cross product.
Framework build output is included in the baseline before cleanup planning.
Reference-free Next route/root-params declarations imported by `next-env.d.ts`
are retained as generated type resources and hashed into graph identity. A
declaration importing local code or using a path reference keeps the ordinary
excluded-input safeguards; it is not silently ignored.
Dynamic framework configuration needs an explicit entry policy: the Vite fixture
uses `src/main.jsx`. Generic React projects also need explicit runtime entries
when no supported entry convention or package export establishes them.

The corpus validates analysis and cleanup of registry-shaped installed files.
It does not run upstream installation against every real registry. Upstream
installer argument, failure, and target behavior has separate focused regression
coverage. Yarn and Bun detection/runner contracts are covered with process
fixtures; their full framework install/build lifecycle is not certified here.
Private catalogs must implement a compatible registry schema and provide their
credentials through the configured environment. Catalog-less sources require
known item addresses. Unsupported formats or unresolved references keep analysis
incomplete and block cleanup.

## Package verification

`pnpm run verify:package` compiles into an empty temporary staging directory,
creates a real npm archive, checks its file allowlist, installs it into a fresh
consumer, and exercises the installed bin, public API, TypeScript declarations,
and bundled agent skill. The package includes built modules, the portable skill,
CI examples, README, license, and metadata. Local research, delivery notes,
fixtures, tests, and the retired v1 deletion modules are excluded.

Normal `npm pack` runs the clean/build `prepack` hook, so old local build output
cannot leak into the archive. Package verification does not publish, create a
release, or create a tag. Publishing remains a separate explicit action.

## Reproducible measurements

`pnpm run benchmark` measures fresh-process help/version startup, cold and warm
inventory, audit latency, indexed picker queries, and full/summary JSON bytes.
Its functional assertions use **20 configured registries**, two catalog pages
per source, 20 present candidates, 20 available-only items, shared dependencies,
a cross-registry cycle, an authenticated source, and a real request timeout that
must block cleanup. Twenty is a verification fixture size, not a registry limit.
The picker measurement uses 10,000 synthetic entries and 1,000 queries.

The script reports Node, platform, architecture, raw startup samples, median
startup/query times, and query p95. Loopback timings depend on the machine,
cache, and competing load. No arbitrary timing threshold controls CI. Output
bytes are not token counts: agent token consumption and comparisons with
upstream shadcn or standalone Knip are **not measured** by this harness. No
percentage reduction in model tokens or agent time is claimed.

Framework and package scripts print their temporary workspaces. Logs, receipts,
plans, and measurement reports remain there for inspection, outside the
repository; dependency installs can use substantial temporary disk space.

## v1 command changes

- `lint` / `l` now aliases read-only `audit`, including JSON and plain output.
- `remove` / `rm` now requires explicit references and previews `plan remove`.
  Applying a reviewed artifact requires a separate `apply --plan` invocation.
- Cleanup never rewrites imports or uninstalls package candidates. Live files,
  incomplete analysis, ambiguous ownership, and shared resources remain protected.
- Existing `preset` commands remain available for compatibility. Use
  `collection migrate` to review and export old custom presets, and collection
  commands for the v2 multi-registry workflow.

Passing these checks establishes bounded evidence for the documented fixtures.
Applications with custom loaders, generated runtime inputs, unusual entry
conventions, or unsupported source formats require explicit configuration or an
adapter before unused findings can support a cleanup plan.
