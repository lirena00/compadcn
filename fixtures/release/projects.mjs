// Pairwise corpus, deliberately separate projects rather than a synthetic
// framework detector. Each case is installed, built, cleaned, rebuilt and restored.
export const cases = [
  { id: "next-app", framework: "next-app", tsx: true, ui: "components/ui", library: "radix", tailwind: 4, manager: "npm" },
  { id: "next-pages", framework: "next-pages", tsx: false, ui: "src/components/ui", library: "radix", tailwind: 3, manager: "pnpm" },
  { id: "vite-react", framework: "vite", tsx: false, ui: "src/design/primitives/nested", library: "base", tailwind: 4, manager: "pnpm" },
];

export function projectFiles(spec, registryURL, manifest) {
  const ext = spec.tsx ? "tsx" : "jsx", isVite = spec.framework === "vite";
  const shared = `import { clsx } from "clsx";\nexport const classes = clsx("px-4", "py-2");\n`;
  const live = spec.library === "radix"
    ? `"use client";\nimport { Slot } from "@radix-ui/react-slot";\nimport { classes } from "./shared";\nexport function Live() { return <Slot className={classes}><button>Live fixture</button></Slot>; }\n`
    : `import { Button } from "@base-ui/react/button";\nimport { classes } from "./shared";\nexport function Live() { return <Button className={classes}>Live fixture</Button>; }\n`;
  const dead = `import { classes } from "./shared";\nexport function Dead() { return <button className={classes}>Unused fixture</button>; }\n`;
  const files = {
    ".git": "",
    "package.json": JSON.stringify({ ...manifest, packageManager: `${spec.manager}@${spec.manager === "npm" ? "10.9.2" : "10.13.1"}`, scripts: { build: isVite ? "vite build" : "next build --webpack", ...(spec.tsx ? { typecheck: "tsc --noEmit" } : {}) } }, null, 2),
    "components.json": JSON.stringify({ style: "new-york", rsc: !isVite, tsx: spec.tsx, tailwind: { config: spec.tailwind === 3 ? "tailwind.config.cjs" : "", css: "styles.css", baseColor: "neutral", cssVariables: true }, aliases: { ui: `./${spec.ui}`, components: `./${spec.ui}`, utils: `./${spec.ui}/shared` }, registries: { "@shadcn": `${registryURL}/${spec.id}/official/{name}.json`, "@private": { url: `${registryURL}/${spec.id}/private/{name}.json`, headers: { Authorization: "Bearer ${RELEASE_REGISTRY_TOKEN}" } } } }),
    [`${spec.ui}/live.${ext}`]: live,
    [`${spec.ui}/dead.${ext}`]: dead,
    [`${spec.ui}/shared.${spec.tsx ? "ts" : "js"}`]: shared,
    "styles.css": spec.tailwind === 3 ? "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n" : '@import "tailwindcss";\n',
    "postcss.config.cjs": spec.tailwind === 3 ? 'module.exports = { plugins: { "tailwindcss-v3": {}, autoprefixer: {} } };\n' : 'module.exports = { plugins: { "@tailwindcss/postcss": {} } };\n',
  };
  if (spec.tailwind === 3) files["tailwind.config.cjs"] = 'module.exports = { content: ["./src/**/*.{js,jsx}"], theme: { extend: {} }, plugins: [] };\n';
  if (spec.tsx) files["tsconfig.json"] = JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }] }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] });
  if (spec.framework === "next-app") {
    files["app/layout.tsx"] = 'import "../styles.css";\nexport default function Layout({children}: {children: React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }\n';
    files["app/page.tsx"] = 'import { Live } from "../components/ui/live";\nexport default function Page() { return <main><Live /></main>; }\n';
  } else if (spec.framework === "next-pages") {
    files["src/pages/_app.jsx"] = 'import "../../styles.css";\nexport default function App({Component, pageProps}) { return <Component {...pageProps} />; }\n';
    files["src/pages/index.jsx"] = 'import { Live } from "../components/ui/live";\nexport default function Page() { return <main><Live /></main>; }\n';
  } else {
    files["index.html"] = '<html lang="en"><head><title>Fixture</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n';
    files["src/main.jsx"] = 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { Live } from "./design/primitives/nested/live";\nimport "../styles.css";\ncreateRoot(document.getElementById("root")).render(<Live />);\n';
    files["vite.config.js"] = 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n';
  }
  const item = (name) => ({ name, type: "registry:ui", registryDependencies: name === "shared" ? [] : ["@shadcn/shared"], ...(name === "shared" ? { dependencies: ["clsx"] } : {}), files: [{ path: `${name}.${name === "shared" ? spec.tsx ? "ts" : "js" : ext}`, type: "registry:ui", content: name === "live" ? live : name === "dead" ? dead : shared }] });
  return { files, official: [item("live"), item("shared")], private: [item("dead")] };
}
