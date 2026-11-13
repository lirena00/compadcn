import { createProject } from "../cli/project-fixture.mjs";
import { registryServer, json, catalog } from "../registry/server.mjs";

export const componentBytes = Buffer.from('\uFEFFexport const Value=1;\r\n// without final newline');
export async function cleanupProject(t, { scripts = {}, extra = {}, unused = ["unused"] } = {}) {
  const server = await registryServer(t, (req, res) => {
    const path = new URL(req.url, "http://local").pathname, custom = path.startsWith("/private/");
    if (custom && req.headers.authorization !== "Bearer cleanup-private-token") { res.writeHead(401); return res.end(); }
    const name = path.split("/").at(-1).replace(/\.json$/, "");
    const items = (custom ? unused : ["used"]).map(name => ({ name, type: "registry:ui", files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content: componentBytes.toString() }] }));
    const value = name === "registry" ? catalog(items) : items.find(value => value.name === name);
    if (!value) { res.writeHead(404); return res.end(); } json(res, value);
  });
  const root = createProject(t, {
    "package.json": JSON.stringify({ packageManager: "npm@11.0.0", dependencies: { vite: "7", react: "19" }, scripts }),
    "components.json": JSON.stringify({ aliases: { ui: "./ui" }, registries: { "@shadcn": `${server.url}/official/{name}.json`, "@company": { url: `${server.url}/private/{name}.json`, headers: { Authorization: "Bearer ${CLEANUP_TOKEN}" } } } }),
    "index.html": '<script type="module" src="/src/main.tsx"></script>', "src/main.tsx": 'import {Value} from "../ui/used";console.log(Value);',
    "ui/used.tsx": componentBytes, ...Object.fromEntries(unused.map(name => [`ui/${name}.tsx`, componentBytes])), ...extra,
  });
  const env = { ...process.env, CLEANUP_TOKEN: "cleanup-private-token" };
  return { root, server, env, options: { cwd: root, cacheDir: false, env }, targets: unused.map(name => `@company/${name}`) };
}
