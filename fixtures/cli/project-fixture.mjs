import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function createProject(t, files = {}) {
  const prefix = join(tmpdir(), "shadcn-plus-test-");
  const root = mkdtempSync(prefix);
  t.after(() => {
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(prefix)), "Cleanup must stay in its generated fixture");
    rmSync(target, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries({ ".git": "", ...files })) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
