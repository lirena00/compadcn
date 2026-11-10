import { register } from "node:module";

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
register("./mock-workflows-loader.mjs", import.meta.url);
