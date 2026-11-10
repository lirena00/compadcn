import { createServer } from "node:http";

export async function registryServer(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    try { await handler(req, res, requests.length); } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

export function json(res, value, headers = {}) {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

export function catalog(items, pagination) {
  return { name: "fixture", homepage: "https://fixture.example", items, ...(pagination ? { pagination } : {}) };
}
