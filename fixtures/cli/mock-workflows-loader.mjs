export function resolve(specifier, context, nextResolve) {
  if (specifier === "@clack/prompts") {
    return { url: new URL("./mock-prompts.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "fs" && process.env.SHADCN_PLUS_READ_FAIL &&
    /\/(scanForUsedComponents|removeImports)\.js$/.test(context.parentURL ?? "")) {
    return { url: new URL("./failing-fs.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
