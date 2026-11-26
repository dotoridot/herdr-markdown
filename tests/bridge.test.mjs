import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parseMarkdown,resolveDocumentLink,relativeDocumentPath,isDocumentChange} from '../mods/rich-document/parser.js';

async function host(machine=null){
  const disk=new Map([['/docs/one.md','# One'],['/docs/two.md','# Two']]);
  const messages=[],writes=[],clipboard=[],commands=[],stored=new Map();let handler;
  const cx={spawn(fn){Promise.resolve(fn(cx)).catch(error=>{throw error;});},timer:{every(){}},notify(){},read_from_clipboard:()=>'/docs/한글.md',write_to_clipboard:text=>clipboard.push(text)};
  const moduleExports={
    'gpui-kit':{View:class {},div(){}},
    'gpui-base':{WebViewState:{new(){return {on(_event,fn){handler=fn;},post_message(value){messages.push(JSON.parse(value));},release(){}};}},WebView:{}},
    herdr:{run:(command,args)=>commands.push({command,args}),spaces:()=>[{id:'active-space',active:true,machine}],props:()=>({file:'/docs/one.md'}),appHome:()=>'/app',theme:()=>({background:'#fafafa'}),shared:()=>({}),setShared(){},
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
  return {view,messages,writes,clipboard,commands,disk,send,flush};
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
test('null bytes cannot turn an editable text file into an unreadable binary file',async()=>{
  const h=await host();
  await h.send({type:'save',id:1,file:'/docs/one.md',source:'# Draft\0',expected:'# One'});
  assert.equal(h.disk.get('/docs/one.md'),'# One');
  assert.equal(h.messages.at(-1).type,'error');
  assert.equal(h.writes.length,0);
});

test('a path paste returns the clipboard text to the requesting editor',async()=>{
  const h=await host();
  await h.send({type:'paste-path',id:7});
  assert.equal(JSON.stringify(h.messages.at(-1)),JSON.stringify({type:'path-paste',id:7,text:'/docs/한글.md'}));
  const count=h.messages.length;
  await h.send({type:'paste-path',id:'invalid'});
  assert.equal(h.messages.length,count);
});

test('a code block copy writes its text to the clipboard',async()=>{
  const h=await host();
  await h.send({type:'copy-code',text:'val answer = 42'});
  await h.send({type:'copy-code',text:42});
  await h.send({type:'copy-code',text:'x'.repeat(1024*1024+1)});
  assert.deepEqual(h.clipboard,['val answer = 42']);
});


test('a Finder Markdown drop opens a separate tab and retains the current draft',async()=>{
  const h=await host();
  await h.send({type:'draft',snapshot:{file:'/docs/one.md',baseline:'# One',draft:'# Unsaved'}});
  await h.send({type:'open-drop',file:'/docs/한글.MD'});
  assert.deepEqual(h.commands.map(command=>JSON.parse(JSON.stringify(command))),[
    {command:'tab.new',args:{space:'active-space',name:'한글.MD',mod:'rich-document',props:{file:'/docs/한글.MD'}}}
  ]);
  assert.equal(h.view.file,'/docs/one.md');
  assert.equal(h.view.drafts.get('/docs/one.md').draft,'# Unsaved');
  assert.equal(h.writes.length,0);
  await h.send({type:'open-drop',file:'relative.md'});
  await h.send({type:'open-drop',file:'/docs/two.txt'});
  assert.equal(h.commands.length,1);
});


test('a Finder drop in a remote space does not create a tab',async()=>{
  const h=await host('remote-machine');
  await h.send({type:'open-drop',file:'/docs/two.md'});
  assert.equal(h.commands.length,0);
  assert.equal(h.view.file,'/docs/one.md');
});
