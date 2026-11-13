import type { WriteStream } from "node:tty";
import { terminalText } from "./text.js";

// Progress never takes ownership of stdin or raw mode. Terminal Ctrl+C keeps
// reaching the task's signal handler, including between Clack prompts.
export function createTaskDisplay(output:WriteStream,elapsed:()=>string) {
  let timer:ReturnType<typeof setInterval>|undefined;
  let message="",frame=0;
  const frames=["-","\\","|","/"];
  const paint=()=>{
    const line=`${frames[frame++%frames.length]} [${elapsed()}] ${message}`;
    output.write(`\r\u001b[2K${terminalText(line,Math.max(0,(output.columns ?? 80)-1))}`);
  };
  const clear=()=>{
    if(timer){clearInterval(timer);timer=undefined;output.write("\r\u001b[2K");}
  };
  const finish=(status:string,value:string)=>{clear();output.write(`${status}: ${value}\n`);};
  return {
    start(value:string){clear();message=value;paint();timer=setInterval(paint,120);timer.unref();},
    message(value:string){message=value;},
    clear,
    stop(value:string){finish("DONE",value);},
    error(value:string){finish("ERROR",value);},
    cancel(value:string){finish("CANCELLED",value);},
  };
}
