export function resolve(specifier, context, nextResolve) {
  if (["typescript", "shadcn/schema", "shadcn/registry", "knip", "parse5", "diff", "zod"].includes(specifier)) {
    throw new Error(`Unexpected analysis import: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
