import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { isObject, readObject } from "../project/files.js";
import { parseReferences } from "./references.js";
import { digest } from "../registry/source.js";

// These imports describe generated route names, not application consumers.
// Keep their bytes in the graph identity, without making .next/types (which
// contains its own package.json) an independently analyzed application scope.
// Only reference-free declarations qualify. Custom/generated source imports
// must continue through ordinary resolution and the excluded-input safeguards.
export function nextGeneratedDeclaration(from: string, target: string, scope: string): string | undefined {
  if (from !== join(scope, "next-env.d.ts") || !/^\.next\/(?:dev\/)?types\/(?:routes|root-params)\.d\.ts$/.test(relative(scope, target).replaceAll("\\", "/"))) return;
  const manifest = readObject(join(scope, "package.json"), "PACKAGE_JSON_INVALID");
  if (![manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(value => isObject(value) && Object.hasOwn(value, "next"))) return;
  if (statSync(target).size > 2 * 1024 * 1024) return;
  const bytes = readFileSync(target), text = bytes.toString("utf8"), parsed = parseReferences(target, text);
  const directives = ts.preProcessFile(text);
  if (parsed.errors.length || parsed.references.length || directives.referencedFiles.length || directives.typeReferenceDirectives.length) return;
  return digest(bytes);
}
