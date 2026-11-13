import { CliError } from "../core/errors.js";

export const installableTypes = new Set(["registry:ui", "registry:component", "registry:block", "registry:hook", "registry:lib", "registry:page", "registry:file", "registry:item"]);

export function isQualifiedAddress(value: string): boolean {
  return /^@[\w-]+\/[\w./-]+$/.test(value) && value.split("/").slice(1).every(part => part && part !== "." && part !== "..");
}

export function requestedAddresses(values: string[]): string[] {
  const result = values.map(value => value.startsWith("@") ? value : `@shadcn/${value}`);
  if (result.some(value => !isQualifiedAddress(value))) throw new CliError("INVALID_ARGUMENT", "Component requests must be official names or configured @namespace/item addresses.");
  return [...new Set(result)];
}
