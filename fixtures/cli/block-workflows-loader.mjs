export function resolve(specifier, context, nextResolve) {
  if (
    ["@clack/prompts", "chalk", "gradient-string"].includes(specifier) ||
    /(?:^|\/)commands\//.test(specifier)
  ) {
    throw new Error(`Unexpected workflow import: ${specifier}`);
  }

  return nextResolve(specifier, context);
}
