import {readFile,writeFile,mkdir,access,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

const payload=process.argv[2]==='--request'?await readFile(process.argv[3],'utf8'):process.argv[2];
const {sources,palette,cache}=JSON.parse(payload);
if(!Array.isArray(sources)||!sources.every(source=>typeof source==='string'))throw Error('Invalid Mermaid sources');
await mkdir(cache,{recursive:true});
const version=JSON.parse(await readFile(new URL('vendor/manifest.json',import.meta.url),'utf8')).version;
const diagrams=[],pending=[];
for(const source of sources){
  const key=createHash('sha256').update(JSON.stringify(['png-v1',version,source,palette])).digest('hex');
  const metadata=path.join(cache,key+'.json');
  try {
    const entry=JSON.parse(await readFile(metadata,'utf8'));
    await access(path.join(cache,key+'.png'));
    diagrams.push({...entry,source});
  }catch {pending.push({source,key,metadata});}
}
let browser;
try {
  if(pending.length){
    const {default:puppeteer}=await import('puppeteer-core');
    const candidates=[process.env.HERDR_MERMAID_CHROME,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
    let executablePath;
    for(const candidate of candidates){try{await access(candidate);executablePath=candidate;break;}catch{}}
    if(!executablePath)throw Error('Mermaid 렌더링에 사용할 로컬 Chrome을 찾지 못했습니다.');
    browser=await puppeteer.launch({executablePath,headless:true,timeout:15000,
      args:['--disable-background-networking','--disable-component-update','--no-first-run']});
    const page=await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({width:1200,height:900,deviceScaleFactor:2});
    await page.setRequestInterception(true);
    page.on('request',request=>request.abort());
    await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; connect-src \'none\'"><style>body{margin:0}#diagram{display:inline-block;padding:16px}</style><div id="diagram"></div>');
    const bundle=new URL('vendor/mermaid.min.js',import.meta.url);
    await page.addScriptTag({content:await readFile(bundle,'utf8')});
    await page.evaluate(p=>{
      document.body.style.background=p.paper;
      globalThis.mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,
        maxTextSize:100000,maxEdges:1000,fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif',
        theme:'base',themeVariables:{darkMode:p.dark,background:p.paper,primaryColor:p.quote,
          primaryTextColor:p.foreground,primaryBorderColor:p.border,lineColor:p.foreground,
          secondaryColor:p.selected,tertiaryColor:p.header,fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif'},
        secure:['secure','securityLevel','startOnLoad','maxTextSize','suppressErrorRendering','maxEdges']});
    },palette);
    for(const {source,key,metadata} of pending){
      try {
        const size=await page.evaluate(async source=>{
          const {svg}=await globalThis.mermaid.render('diagram-svg',source);
          const container=document.getElementById('diagram');container.innerHTML=svg;
          const element=container.querySelector('svg'),box=element.viewBox.baseVal;
          const width=Math.max(1,Math.ceil(box.width)),height=Math.max(1,Math.ceil(box.height));
          if(width>8192||height>8192||width*height>16000000)throw Error('다이어그램이 너무 큽니다. 나누어 표시해 주세요.');
          element.style.maxWidth='none';element.setAttribute('width',String(width));element.setAttribute('height',String(height));
          container.style.width=width+'px';
          await document.fonts.ready;
          return {width:width+32,height:height+32};
        },source);
        const temp=path.join(cache,key+'.'+randomUUID()+'.png');
        try {
          await (await page.$('#diagram')).screenshot({path:temp,type:'png'});
          await rename(temp,path.join(cache,key+'.png'));
        }finally {await unlink(temp).catch(()=>{});}
        const entry={path:'mods/rich-document/.cache/'+key+'.png',...size};
        await writeFile(metadata,JSON.stringify(entry));
        diagrams.push({source,...entry});
      }catch(error){diagrams.push({source,error:String(error.message || error).slice(0,600)});}
    }
  }
}finally {await browser?.close();}
process.stdout.write(JSON.stringify({diagrams})+'\n');
