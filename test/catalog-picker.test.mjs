import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { pickCatalog } from "../dist/cli/catalog-picker.js";
import { createCatalogIndex } from "../dist/catalog/model.js";

function entry(id,address,extra={}){return {id,address,scope:"/app",sourceId:"source",namespace:address.split("/")[0],type:"registry:ui",presence:"absent",origin:"unknown",metadata:"catalog",sourceStatus:"ready",...extra};}
const entries=[entry("official","@shadcn/dialog"),entry("custom","@company/dialog"),entry("other","@company/menu")];

function terminal(t,columns=80,rows=24){
  const previous=process.env.TERM;process.env.TERM="xterm-256color";
  t.after(()=>{if(previous===undefined)delete process.env.TERM;else process.env.TERM=previous;});
  const input=new PassThrough(),output=new PassThrough();let rendered="";const raw=[];
  input.isTTY=true;input.isRaw=false;input.setRawMode=(value)=>{input.isRaw=value;raw.push(value);};
  output.isTTY=true;output.columns=columns;output.rows=rows;
  output.on("data",(chunk)=>{rendered+=chunk.toString();});
  t.after(()=>{input.destroy();output.destroy();});
  return {input,output,raw,text:()=>stripVTControlCharacters(rendered)};
}
const tick=()=>new Promise((resolve)=>setTimeout(resolve,20));
async function key(io,value){io.input.write(value);await tick();}

test("precomputed search keeps same-name namespaces distinct and combines registry/type/query filters",()=>{
  const index=createCatalogIndex([...entries,entry("block","@company/dashboard",{type:"registry:block",description:"Account dialog and menu"})],{registries:["@company"],types:["block"]});
  assert.deepEqual(index.search("DIALOG menu").map(({id})=>id),["block"]);
  assert.equal(index.search("@shadcn").length,0);
});

test("real Clack picker retains hidden selections across search changes and shows the selected count",async(t)=>{
  const io=terminal(t);const controller=new AbortController();t.after(()=>controller.abort());
  const pending=pickCatalog(entries,{},controller.signal,false,io);
  await tick();await key(io,"@shadcn");await key(io,"\t");
  assert.match(io.text(),/1 selected/);
  await key(io,"\u007f".repeat("@shadcn".length));
  await key(io,"@company");await key(io,"\t");
  await key(io,"\r");
  assert.deepEqual((await pending).sort(),["custom","official"],io.text().split("\n").filter((line)=>line.includes("Search:")).slice(-8).join("\n"));
  assert.equal(io.input.isRaw,false);
  assert.ok(io.raw.includes(true));
});

for(const value of ["\u001b","\u0003"]){
  test(`real Clack picker cancels with ${value==="\u001b"?"Escape":"Ctrl+C"} and restores raw mode`,async(t)=>{
    const io=terminal(t),controller=new AbortController();t.after(()=>controller.abort());
    const pending=pickCatalog(entries,{},controller.signal,false,io);
    const rejected=assert.rejects(pending,{name:"CommandCancelled"});
    await tick();await key(io,value);await rejected;
    assert.equal(io.input.isRaw,false);
    assert.equal(io.input.listenerCount("keypress"),0);
  });
}

test("real picker supports abort, disabled observed files, no matches and narrow terminal output",async(t)=>{
  const io=terminal(t,36,12),controller=new AbortController();
  const pending=pickCatalog([entry("present","@company/present",{presence:"present"}),...entries],{},controller.signal,false,io);
  const rejected=assert.rejects(pending,{name:"CommandCancelled"});
  await tick();await key(io,"does-not-exist");assert.match(io.text(),/No matches found/);
  controller.abort();await rejected;assert.equal(io.input.isRaw,false);
  assert.match(io.text(),/Tab:/);
});

test("observed files cannot be selected without overwrite and terminal resize preserves selection",async(t)=>{
  const io=terminal(t),controller=new AbortController();t.after(()=>controller.abort());
  const pending=pickCatalog([entry("present","@company/present",{presence:"present"}),...entries],{},controller.signal,false,io);
  await tick();await key(io,"\t");
  io.output.columns=38;io.output.rows=14;io.output.emit("resize");
  await key(io,"\u001b[B");await key(io,"\t");await key(io,"\r");
  assert.deepEqual(await pending,["official","custom"]);
  assert.equal(io.input.isRaw,false);
});

test("an all-present catalog has a clear empty state and overwrite explicitly enables it",async(t)=>{
  await assert.rejects(pickCatalog([entry("present","@company/present",{presence:"present"})],{},new AbortController().signal),{code:"CATALOG_NO_AVAILABLE"});
  const io=terminal(t),controller=new AbortController();t.after(()=>controller.abort());
  const pending=pickCatalog([entry("present","@company/present",{presence:"present"})],{},controller.signal,true,io);
  await tick();await key(io,"\t");await key(io,"\r");assert.deepEqual(await pending,["present"]);
});

test("accessible prompt mode can complete the same selection without animation",async(t)=>{
  const previous=process.env.ACCESSIBLE;process.env.ACCESSIBLE="1";
  t.after(()=>{if(previous===undefined)delete process.env.ACCESSIBLE;else process.env.ACCESSIBLE=previous;});
  const io=terminal(t),controller=new AbortController();t.after(()=>controller.abort());
  const pending=pickCatalog(entries,{},controller.signal,false,io);
  await tick();await key(io,"\t");await key(io,"\r");assert.deepEqual(await pending,["official"]);
  assert.match(io.text(),/items selected/);
});
