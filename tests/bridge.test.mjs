import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parseMarkdown,resolveDocumentLink,relativeDocumentPath,isDocumentChange} from '../mods/rich-document/parser.js';

async function host(){
  const disk=new Map([['/docs/one.md','# One'],['/docs/two.md','# Two']]);
  const messages=[],writes=[],stored=new Map();let handler;
  const cx={spawn(fn){Promise.resolve(fn(cx)).catch(error=>{throw error;});},timer:{every(){}},notify(){}};
  const moduleExports={
    'gpui-kit':{View:class {},div(){}},
    'gpui-base':{WebViewState:{new(){return {on(_event,fn){handler=fn;},post_message(value){messages.push(JSON.parse(value));},release(){}};}},WebView:{}},
    herdr:{props:()=>({file:'/docs/one.md'}),appHome:()=>'/app',theme:()=>({background:'#fafafa'}),shared:()=>({}),setShared(){},
      readTextFile:async file=>disk.get(file)??null,
      writeTextFile:async(file,source,expected)=>{writes.push({file,source,expected});if(disk.get(file)!==expected)throw Error('stale snapshot');disk.set(file,source);},
      watchFolder:()=>new Promise(()=>{}),exec:async()=>({code:0,stdout:'{}'}),notify(){}},
    './parser.js':{parseMarkdown,resolveDocumentLink,relativeDocumentPath,isDocumentChange},
    './legacy.js':{default:class {}},
  };
  const context=vm.createContext({console,Map,Set,Promise,JSON,Number,String,Error,localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}});
  const text=process.env.HERDR_TEST_BASELINE?execFileSync('git',['show',process.env.HERDR_TEST_BASELINE+':mods/rich-document/main.js'],{encoding:'utf8'}):await readFile(new URL('../mods/rich-document/main.js',import.meta.url),'utf8');
  const entry=new vm.SourceTextModule(text,{context});
  await entry.link(specifier=>{const exports=moduleExports[specifier];return new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});});
  await entry.evaluate();const view=new entry.namespace.default();view.init({},cx);
  const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
  const send=async message=>{handler(JSON.stringify(message),cx);await flush();};
  await send({type:'ready'});
  return {view,messages,writes,disk,send,flush};
}

test('a failed open keeps the original document writable',async()=>{
  const h=await host();
  await h.send({type:'open',file:'/docs/missing.md'});
  assert.equal(h.view.file,'/docs/one.md');
  await h.send({type:'save',id:1,file:'/docs/one.md',source:'# Updated',expected:'# One'});
  assert.equal(h.disk.get('/docs/one.md'),'# Updated');
  assert.equal(h.messages.at(-1).type,'saved');
});
test('a concurrent disk edit is never overwritten by Save',async()=>{
  const h=await host();h.disk.set('/docs/one.md','# External');
  await h.send({type:'save',id:1,file:'/docs/one.md',source:'# Draft',expected:'# One'});
  assert.equal(h.disk.get('/docs/one.md'),'# External');
  assert.equal(h.messages.at(-1).type,'error');
  assert.match(h.messages.at(-1).message,/draft is kept/);
});
test('stale saves return an error instead of leaving the page waiting',async()=>{
  const h=await host();await h.send({type:'open',file:'/docs/two.md'});
  await h.send({type:'save',id:1,file:'/docs/one.md',source:'# Draft',expected:'# One'});
  assert.equal(h.messages.at(-1).type,'error');
  assert.equal(h.writes.length,0);
});
