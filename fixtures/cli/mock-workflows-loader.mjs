export function resolve(specifier, context, nextResolve) {
  if (specifier === "@clack/prompts") {
    return { url: new URL("./mock-prompts.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
