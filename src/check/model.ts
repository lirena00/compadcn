import { z } from "zod";
import { CliError } from "../core/errors.js";
import { canonicalJSON, digest } from "../core/hash.js";
import { packageInfo } from "../lib/packageInfo.js";
import { portablePath } from "../changes/paths.js";
import type { AuditReport } from "../audit/types.js";

export const rules = ["unused-item", "unused-file", "unused-package", "unknown-usage"] as const;
const level = z.enum(["error", "warning", "off"]), hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096), local = text.refine(value => portablePath(value, true));
export const checkPolicySchema = z.strictObject({ policyVersion: z.literal(1), rules: z.strictObject({
  "unused-item": level.default("error"), "unused-file": level.default("error"),
  "unused-package": level.default("warning"), "unknown-usage": level.default("warning"),
}) });
export type CheckPolicy = z.infer<typeof checkPolicySchema>;
export const findingSchema = z.strictObject({ id: hash, rule: z.enum(rules), level: z.enum(["error", "warning"]),
  kind: z.enum(["item", "file", "package"]), target: text, scopes: z.array(local).min(1).max(10000),
  paths: z.array(local).max(100000), addresses: z.array(text).max(10000), reasons: z.array(text).max(10000), evidenceFingerprint: hash });
export type CheckFinding = z.infer<typeof findingSchema>;
export const checkBaselineSchema = z.strictObject({ baselineVersion: z.literal(1), id: hash, toolVersion: text,
  engines: z.strictObject({ knip: z.literal("6.45.0"), typescript: z.literal("5.8.3") }),
  project: z.strictObject({ selected: local, scopes: z.array(local).min(1).max(10000) }),
  contextFingerprint: hash, policyFingerprint: hash, entries: z.array(findingSchema).max(100000) });
export type CheckBaseline = z.infer<typeof checkBaselineSchema>;
export interface CheckReport {
  checkVersion: 1; status: "passed" | "failed" | "incomplete"; complete: boolean;
  project: CheckBaseline["project"]; contextFingerprint: string; policyFingerprint: string; auditSnapshotId: string;
  coverage: AuditReport["coverage"]; auditCounts: AuditReport["counts"]; policy: CheckPolicy;
  baseline: { provided: boolean; compatible: boolean; accepted: number; resolved: number };
  counts: { total: number; errors: number; warnings: number; newErrors: number; newWarnings: number; known: number; byRule: Record<CheckFinding["rule"], number> };
  findings: (Omit<CheckFinding, "evidenceFingerprint"> & { reference: string; known: boolean; omitted: { paths: number; addresses: number; scopes: number; reasons: number } })[]; omittedFindings: number;
  diagnostics: AuditReport["diagnostics"]; omittedDiagnostics: number;
}

function decode(value: unknown, kind: string): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value) > 16 * 1024 * 1024) throw new CliError(`${kind}_INVALID`, "Check artifacts must be at most 16 MiB.");
  try { return JSON.parse(value.replace(/^\uFEFF/, "")); } catch { throw new CliError(`${kind}_INVALID`, "Check artifact is not valid JSON."); }
}
export function parseCheckPolicy(value?: unknown): CheckPolicy {
  const result = checkPolicySchema.safeParse(decode(value ?? { policyVersion: 1, rules: {} }, "CHECK_POLICY"));
  if (!result.success) throw new CliError("CHECK_POLICY_INVALID", "Use a version 1 policy with known rule names and error/warning/off levels.");
  return result.data;
}
export function identifyFinding(body: Omit<CheckFinding, "id">): CheckFinding { return { ...body, id: digest(canonicalJSON(body)) }; }
export function sealBaseline(body: Omit<CheckBaseline, "id">): CheckBaseline { return { ...body, id: digest(canonicalJSON(body)) }; }
export function parseCheckBaseline(value: unknown): CheckBaseline {
  const parsed = checkBaselineSchema.safeParse(decode(value, "CHECK_BASELINE"));
  if (!parsed.success) throw new CliError("CHECK_BASELINE_INVALID", "Baseline does not match the supported strict versioned schema.");
  const baseline = parsed.data, { id, ...body } = baseline;
  if (baseline.toolVersion !== packageInfo.version) throw new CliError("CHECK_BASELINE_INCOMPATIBLE", "Create a reviewed baseline with the current tool version.");
  if (digest(canonicalJSON(body)) !== id || new Set(baseline.entries.map(entry => entry.id)).size !== baseline.entries.length || baseline.entries.some(({ id, ...finding }) => identifyFinding(finding).id !== id)) throw new CliError("CHECK_BASELINE_INVALID", "Baseline integrity or finding identities are invalid.");
  return baseline;
}
