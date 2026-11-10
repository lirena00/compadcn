import { createHash } from "node:crypto";

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
