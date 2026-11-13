import assert from "node:assert/strict";
import test from "node:test";
import { sameFileIdentity } from "../dist/core/file-identity.js";

test("Windows missing device IDs do not hide changed inodes or known device mismatches", () => {
  const path = { ino: 42, dev: 0 }, handle = { ino: 42, dev: 1234 };
  assert.equal(sameFileIdentity(path, handle, "win32"), true);
  assert.equal(sameFileIdentity(handle, path, "win32"), true);
  assert.equal(sameFileIdentity(path, handle, "linux"), false);
  assert.equal(sameFileIdentity(path, { ...handle, ino: 43 }, "win32"), false);
  assert.equal(sameFileIdentity({ ino: 42, dev: 999 }, handle, "win32"), false);
  assert.equal(sameFileIdentity(handle, handle, "linux"), true);
});
