import { readFileSync, appendFileSync, unlinkSync } from "node:fs";
import { acquireCleanupLock, createOperationJournal } from "../../dist/changes/journal.js";
import { readTarget, writeExclusive } from "../../dist/changes/transaction-files.js";
import { randomUUID } from "node:crypto";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8")), id = randomUUID();
acquireCleanupLock(plan.project.root, id);
const journal = createOperationJournal(plan.project.root, id, plan), operation = plan.operations[0];
const { bytes, stat } = readTarget(plan.project.root, operation);
writeExclusive(journal.backupPath(0), bytes);
journal.append({ type: "backup", index: 0, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs });
journal.append({ type: "phase", value: "applying" });
journal.append({ type: "delete-intent", index: 0 });
unlinkSync(plan.project.root + "/" + operation.path);
appendFileSync(journal.path, '{"sequence":');
console.log(id);
// Intentionally exit without a completion record or releasing the lock.
