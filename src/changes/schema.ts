import { isAbsolute } from "node:path";
import { z } from "zod";
import { canonicalJSON, digest } from "../core/hash.js";
import { CliError } from "../core/errors.js";
import { packageInfo } from "../lib/packageInfo.js";
import { portablePath, ignoredDirectories } from "./paths.js";
import { validateDeletionDiff } from "./diff.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096);
const path = text.refine((value) => portablePath(value));
const scope = text.refine((value) => portablePath(value, true));
const strings = z.array(text).max(10000);
const diagnostic = z.strictObject({ code: text, severity: z.enum(["warning", "error"]), message: text, path: text.optional() });
const project = z.strictObject({ root: text.refine(isAbsolute), selected: scope, scopes: z.array(scope).min(1).max(10000) });
export const scopeFileSchema = z.strictObject({ path, kind: z.enum(["file", "link"]), sha256: hash, bytes: z.number().int().nonnegative(), mode: z.number().int().min(0).max(511), links: z.number().int().nonnegative() });
export const scopeSnapshotSchema = z.strictObject({
  snapshotVersion: z.literal(1), fingerprint: hash, root: text.refine(isAbsolute),
  files: z.array(scopeFileSchema).max(100000), excludedArtifacts: z.array(path).max(10),
  limits: z.strictObject({ files: z.number().int().min(1).max(100000), bytes: z.number().int().min(1).max(1073741824) }),
  complete: z.boolean(), diagnostics: z.array(diagnostic).max(100000),
});
const origin = z.strictObject({ nodeId: text, addresses: strings, sourceIds: strings, manifestHash: hash });
const ownedItem = z.strictObject({ id: text, addresses: strings, scope, origins: z.array(origin).min(1).max(10000),
  files: z.array(z.strictObject({ path, sha256: hash })).min(1).max(20000) });
const excluded = z.strictObject({ id: text, label: text, paths: z.array(path).max(20000), reasons: strings });
export const ownershipSnapshotSchema = z.strictObject({
  ownershipVersion: z.literal(1), id: hash, toolVersion: text, project,
  baseline: z.literal("observed-local-files"), items: z.array(ownedItem).max(10000),
  excluded: z.array(excluded).max(100000), diagnostics: z.array(diagnostic).max(100000), complete: z.boolean(),
});
const target = z.strictObject({ id: text, label: text, kind: z.enum(["item", "file"]), paths: z.array(path).min(1).max(20000),
  reasons: strings, ownership: z.enum(["snapshot", "explicit-unverified"]), modified: z.boolean() });
const verification = z.strictObject({ script: z.string().regex(/^[a-zA-Z0-9_][\w:.-]*$/), status: z.enum(["configured", "not-configured"]),
  required: z.boolean(), command: z.enum(["npm", "pnpm", "yarn", "bun"]), args: z.array(text).max(3), scriptHash: hash.optional() });
export const cleanupOperationSchema = z.strictObject({ id: hash, kind: z.literal("delete-file"), path,
  before: z.strictObject({ sha256: hash, bytes: z.number().int().nonnegative().max(2097152), mode: z.number().int().min(0).max(511) }),
  after: z.strictObject({ exists: z.literal(false) }), owners: strings, diff: z.string().max(8388608) });
export const cleanupPlanSchema = z.strictObject({
  planVersion: z.literal(1), id: hash, toolVersion: text, project,
  mode: z.enum(["prune", "remove"]), status: z.enum(["ready", "blocked", "empty"]),
  policy: z.strictObject({ targets: strings, includeUnverified: z.boolean(), includeModified: z.boolean(), entries: strings, devEntries: strings,
    maxItems: z.number().int().min(1).max(10000), maxFiles: z.number().int().min(1).max(100000), verificationScripts: strings.optional() }),
  analysis: z.strictObject({ snapshotId: hash, graphSnapshotId: hash, configurationFingerprint: hash, knipVersion: z.literal("6.45.0"), typescriptVersion: z.literal("5.8.3"),
    coverage: z.strictObject({ graph: z.boolean(), roots: z.boolean(), analyzer: z.boolean(), workspace: z.boolean() }) }),
  inputs: scopeSnapshotSchema, ownership: ownershipSnapshotSchema.optional(),
  selected: z.array(target).max(10000), excluded: z.array(excluded).max(100000),
  operations: z.array(cleanupOperationSchema).max(2000),
  retained: z.strictObject({ packages: z.array(z.strictObject({ name: text, scope, status: text, reasons: strings })).max(100000), resources: z.array(z.strictObject({ id: text, kind: text, scope })).max(100000) }),
  verification: z.array(verification).max(100), diagnostics: z.array(diagnostic).max(100000), complete: z.boolean(),
});

export type ScopeFile = z.infer<typeof scopeFileSchema>;
export type ScopeSnapshot = z.infer<typeof scopeSnapshotSchema>;
export type OwnershipSnapshot = z.infer<typeof ownershipSnapshotSchema>;
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;
export type CleanupOperation = z.infer<typeof cleanupOperationSchema>;

export function withId<T extends object>(value: T): T & { id: string } {
  return { ...value, id: digest(canonicalJSON(value)) };
}

function checked<T extends { id: string; toolVersion: string }>(value: unknown, schema: z.ZodType<T>, kind: string): T {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 64 * 1024 * 1024) throw new CliError(`${kind}_INVALID`, "Artifact exceeds the 64 MiB size limit.");
    try { value = JSON.parse(value); } catch { throw new CliError(`${kind}_INVALID`, "Artifact is not valid JSON."); }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CliError(`${kind}_INVALID`, "Artifact does not match its supported strict versioned schema.");
  if (parsed.data.toolVersion !== packageInfo.version) throw new CliError(`${kind}_INCOMPATIBLE`, "Artifact was created by a different tool version; create a new artifact.");
  const { id, ...body } = parsed.data;
  if (id !== digest(canonicalJSON(body))) throw new CliError(`${kind}_TAMPERED`, "Artifact content no longer matches its identifier.");
  return parsed.data;
}

export function parseOwnershipSnapshot(value: unknown): OwnershipSnapshot {
  const snapshot=checked(value,ownershipSnapshotSchema,"OWNERSHIP");
  if(new Set(snapshot.items.map(({id})=>id)).size!==snapshot.items.length||snapshot.items.some((item)=>new Set(item.files.map(({path})=>path)).size!==item.files.length||new Set(item.origins.map(({nodeId})=>nodeId)).size!==item.origins.length))throw new CliError("OWNERSHIP_DUPLICATE","Ownership snapshot contains duplicate mappings.");
  return snapshot;
}
export function parseCleanupPlan(value: unknown): CleanupPlan {
  const plan = checked(value, cleanupPlanSchema, "PLAN");
  const { fingerprint, snapshotVersion: _version, complete: _complete, diagnostics: _diagnostics, ...inputs } = plan.inputs;
  if (fingerprint !== digest(canonicalJSON(inputs)) || inputs.root !== plan.project.root) throw new CliError("PLAN_INPUTS_INVALID", "Plan input fingerprint or root is inconsistent.");
  if (new Set(plan.inputs.files.map(({path})=>path)).size !== plan.inputs.files.length || new Set(plan.operations.map(({path})=>path)).size !== plan.operations.length || new Set(plan.selected.map(({id})=>id)).size !== plan.selected.length) throw new CliError("PLAN_DUPLICATE", "Plan contains duplicate inputs, targets, or operations.");
  const selected = new Map(plan.selected.map((target)=>[target.id,target]));
  const files = new Map(plan.inputs.files.map((file)=>[file.path,file]));
  for (const operation of plan.operations) {
    const file = files.get(operation.path);
    const {id, ...body} = operation;
    if (id !== digest(canonicalJSON(body)) || !file || file.kind !== "file" || file.links !== 1 || file.sha256 !== operation.before.sha256 || file.bytes !== operation.before.bytes || file.mode !== operation.before.mode || !operation.owners.length || operation.owners.some((owner)=>!selected.get(owner)?.paths.includes(operation.path)) ||
      !/\.(?:[cm]?[jt]sx?)$/.test(operation.path) || operation.path.split("/").some(part=>ignoredDirectories.has(part)) || (plan.project.selected!=="."&&!operation.path.startsWith(`${plan.project.selected}/`))) throw new CliError("PLAN_OPERATION_INVALID", "Operation is inconsistent with its owners, project scope, or input preconditions.");
    validateDeletionDiff(operation.path,operation.diff,operation.before.sha256,operation.before.bytes);
  }
  const operations = new Map(plan.operations.map((operation)=>[operation.path,operation]));
  if (plan.selected.some((target)=>target.paths.some((path)=>!operations.get(path)?.owners.includes(target.id)))) throw new CliError("PLAN_OPERATION_INVALID", "A selected target has an incomplete deletion set.");
  if (plan.status === "ready" && (!plan.complete || !plan.operations.length || !plan.inputs.complete || Object.values(plan.analysis.coverage).some((value)=>!value))) throw new CliError("PLAN_STATUS_INVALID", "A ready plan must have complete coverage and explicit operations.");
  if (plan.status !== "ready" && plan.operations.length) throw new CliError("PLAN_STATUS_INVALID", "A blocked or empty plan cannot contain executable operations.");
  if(plan.verification.some((step)=>canonicalJSON(step.args)!==canonicalJSON(["run",step.script])||(step.status==="configured")!==!!step.scriptHash))throw new CliError("PLAN_VERIFICATION_INVALID","Verification descriptors must reference package scripts exactly.");
  if(plan.status==="ready"&&plan.verification.some((step)=>step.required&&step.status!=="configured"))throw new CliError("PLAN_STATUS_INVALID","A ready plan cannot omit an explicitly required verification script.");
  if (plan.ownership) parseOwnershipSnapshot(plan.ownership);
  return plan;
}
