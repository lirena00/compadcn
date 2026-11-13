import { runAdd } from "../cli/add.js";

// Preserve the existing internal entry point while using the registry workflow.
export async function runAddUI(componentsToAdd:string[]=[],options:{overwrite?:boolean}={}):Promise<void> {
  await runAdd(componentsToAdd,{cwd:".",registry:[],type:[],cache:true,concurrency:"4",timeout:"10000",...options},{});
}
