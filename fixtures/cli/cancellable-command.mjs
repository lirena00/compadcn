import { runCli } from "../../dist/index.js";

const before = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
process.on("message", (message) => { if (message === "cancel") process.emit("SIGINT"); });
const code = await runCli([process.execPath, "shadcn-plus", ...process.argv.slice(2)]);
process.exitCode = code;
process.send?.({ before, after: { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") } }, () => process.disconnect());
