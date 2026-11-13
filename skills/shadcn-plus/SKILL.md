---
name: shadcn-plus
description: Inspect shadcn component inventory, explain usage and dependencies, check CI policy, and prepare reviewed cleanup plans with the shadcn-plus CLI. Use for component maintenance and cleanup in projects with official, custom, or private shadcn registries.
---

Use the project's pinned shadcn-plus executable. Respect the user's project,
package manager, configured registries, and existing authorization. If the CLI is
unavailable, report that or install it only within the task's authorized scope.

## Start small

Select the intended app/package explicitly in a workspace. Start with:

```sh
shadcn-plus audit --cwd <app> --json --summary
```

Read coverage and diagnostics before interpreting counts. For the relevant finding:

```sh
shadcn-plus why <reference> --cwd <app> --json
```

Use inventory/search for catalog questions and graph for dependency questions.
Prefer a focused explanation over repeatedly requesting a full graph or audit.
Available catalog entries and observed local files are different states. Unknown
usage, transformed files, and candidate ownership are not deletion permission.
Keep namespace-qualified addresses, including private registries.

## CI and existing findings

```sh
shadcn-plus check --cwd <app> --json --summary
shadcn-plus check --cwd <app> --baseline <reviewed.json> --json --limit 20
```

Exit 0 means policy passed within complete coverage; exit 1 means new policy
violations; exit 2 means incomplete coverage, interruption, or invalid inputs.
Counts include omitted findings. Inspect `error.details.check` on failure and use
its finding references with `why`. Inspect the full audit if diagnostics were
omitted. A baseline accepts reviewed findings; it does not fix them or authorize
cleanup. Create a baseline only when accepting existing findings is part of the
user's request, rather than using it as an automatic fix for a failed check.

## Reviewed cleanup

Within an authorized cleanup task, prepare an exact artifact:

```sh
shadcn-plus plan prune --cwd <app> --ownership <reviewed-ownership.json> --out <new-plan.json> --json --summary
shadcn-plus plan check <plan.json> --cwd <app> --json
```

If ownership is not established, inspect `plan snapshot` output before treating
it as an accepted local baseline. It records observed files, not upstream install
history. Named `plan remove` requests can accept unverified or modified mappings
only when that inclusion is within the user's authorization. Those flags never
waive active usage, ambiguous ownership, shared resources, or incomplete analysis.
Inspect `error.details.plan` and stop mutation when the plan is blocked.

Apply only the reviewed plan within the user's authorized scope:

```sh
shadcn-plus apply --plan <plan.json> --cwd <app> --yes --json
```

Application revalidates the plan and runs its configured project scripts. Use
`--precheck` when a before-check baseline is needed. Check scripts may change
other files; recovery covers this operation's deletions. Inspect
`error.details.operation` after failure or interruption. Use `operation <id>` to
inspect persisted recovery state and `restore <id>` for authorized recovery.
Preserve conflicts; do not force overwrite another writer's files. If subprocess
shutdown is unconfirmed, stop remaining checks before restoring.

Keep package candidates and shared theme/config effects retained. `lint` aliases read-only audit; `remove` aliases read-only named planning.
Do not bypass a blocked plan with shell
deletion or import rewriting. A `--yes` flag suppresses a prompt, without expanding
the task's existing permission.

## Shared selections

Use `collection show` and `collection install <file> --yes --json` for an authorized
installation. Collections carry addresses and intent; destination projects supply
registry bindings and credentials. `collection migrate` previews legacy presets
until an explicit output directory is provided. Do not rewrite instruction files,
editor settings, personal stores, or CI baselines as an unrelated side effect.
