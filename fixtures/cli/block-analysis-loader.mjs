export function resolve(specifier, context, nextResolve) {
  if (["typescript", "shadcn/schema", "shadcn/registry"].includes(specifier)) {
    throw new Error(`Unexpected analysis import: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
