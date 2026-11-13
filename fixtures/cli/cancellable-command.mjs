import { runCli } from "../../dist/index.js";

if(process.env.SHADCN_PLUS_SIMULATE_TASK_TTY){
  for(const stream of [process.stdin,process.stdout,process.stderr])Object.defineProperty(stream,"isTTY",{value:true});
  process.env.TERM="xterm-256color";
}

const before = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
process.on("message", (message) => { if (message === "cancel") process.emit("SIGINT"); });
const code = await runCli([process.execPath, "shadcn-plus", ...process.argv.slice(2)]);
process.exitCode = code;
process.send?.({ before, after: { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") } }, () => process.disconnect());
