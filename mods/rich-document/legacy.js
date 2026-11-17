import { View, div, image } from 'gpui-kit';
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from 'gpui-base';
import { props, readTextFile, watchFolder, settings, theme, exec, appHome, nextCommand, shared, setShared, focused, spaces, openOverlay, closeOverlay, notify } from 'herdr';
import { parseMarkdown, resolveDocumentLink, relativeDocumentPath, isDocumentChange } from './parser.js';
import { renderBlocks } from './render.js';
import { documentPalette, documentTheme, codeOptions } from './appearance.js';
import {writeFile, mkdir, unlink} from 'fs/promises';

const nameOf = path => path.split('/').pop() || path;
const dirOf = path => path.slice(0,path.lastIndexOf('/')) || '/';
const IMAGE = String.raw`import os,sys,json,hashlib,shutil,struct,re
source,cache=sys.argv[1:3]
st=os.stat(source)
if st.st_size>25*1024*1024: raise ValueError('Image exceeds 25 MiB')
ext=source.rsplit('.',1)[-1].lower()
with open(source,'rb') as f: data=f.read(1024*1024)
if ext=='svg':
 text=data.decode('utf-8-sig'); box=re.search(r'viewBox\s*=\s*[\x22\x27]([^\x22\x27]+)',text)
 dims=[float(x) for x in re.split(r'[ ,]+',box[1].strip())] if box else [0,0,300,150]
 def dim(key,fallback):
  m=re.search(r'\b'+key+r'\s*=\s*[\x22\x27]([\d.]+)',text); return float(m[1]) if m else fallback
 width,height=dim('width',dims[2]),dim('height',dims[3])
elif data.startswith(b'\x89PNG\r\n\x1a\n'): width,height=struct.unpack('>II',data[16:24])
elif data[:2]==b'\xff\xd8':
 i=2; width=height=0
 while i+9<len(data):
  if data[i]!=255: i+=1; continue
  while i<len(data) and data[i]==255: i+=1
  marker=data[i]; i+=1
  if marker in (0xd8,0xd9) or 0xd0<=marker<=0xd7: continue
  size=int.from_bytes(data[i:i+2],'big')
  if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf): height,width=struct.unpack('>HH',data[i+3:i+7]); break
  if size<2: break
  i+=size
elif data[:4]==b'RIFF' and data[8:12]==b'WEBP':
 if data[12:16]==b'VP8X': width,height=1+int.from_bytes(data[24:27],'little'),1+int.from_bytes(data[27:30],'little')
 elif data[12:16]==b'VP8L':
  bits=int.from_bytes(data[21:25],'little');width,height=(bits&0x3fff)+1,((bits>>14)&0x3fff)+1
 else: width,height=struct.unpack('<HH',data[26:30]);width&=0x3fff;height&=0x3fff
else: raise ValueError('Unsupported image format')
if width<=0 or height<=0: raise ValueError('Invalid image dimensions')
os.makedirs(cache,exist_ok=True)
key=hashlib.sha256((source+':'+str(st.st_mtime_ns)+':'+str(st.st_size)).encode()).hexdigest()+'.'+ext
dest=os.path.join(cache,key)
if not os.path.exists(dest): shutil.copyfile(source,dest)
print(json.dumps(dict(path='mods/rich-document/.cache/'+key,width=width,height=height)))`;

const PREFERENCE='rich-document.reading';
const isMermaid=block=>block.type==='code'&&block.language.toLowerCase()==='mermaid';

function button(id,label,action,p,selected=false,enabled=true) {
  return div().id(id).h(30).px(10).flex_none().flex().items_center().justify_center().rounded(5)
    .text_size(12).text_color(enabled ? selected ? p.link : p.foreground : p.dim)
    .bg(selected ? p.selected : p.toolbar).cursor_default().role('button').accessibility_label(label).disabled(!enabled)
    .when(enabled,el=>el.hover(s=>s.bg(p.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .on_click((e,cx)=>{cx.stop_propagation();action(cx,e);})).child(label);
}

export default class RichDocument extends View {
  init(_props,cx) {
    const p=props() || {},saved=shared(PREFERENCE) || {};
    this.appearance=['current','dark'].includes(saved.appearance)?saved.appearance:'light';
    this.fontSize=Number.isFinite(saved.fontSize)?Math.max(11,Math.min(24,saved.fontSize)):17;
    this.wide=saved.wide===true;this.mode='document';this.width=1000;
    this.history=[];this.images=new Map();this.diagrams=new Map();this.diagramSizes=new Map();this.expanded=new Set();this.codeEditors=new Map();
    this.root=p.root || spaces().find(space=>space.id===focused()?.space)?.folder || focused()?.cwd || dirOf(p.file || '/');
    if(p.menu){this.file=p.file;return;}
    this.pathInput=InputState.new({value:p.file || '',placeholder:'Absolute Markdown file path'});
    this.pathInput.on('submit',(_e,cx)=>this.open(this.pathInput.value(),cx,true));
    if(p.file)this.open(p.file,cx,false);
    cx.timer.every(10000,cx=>{if(this.file&&this.watchUnavailable)this.scheduleReload(cx);});
    cx.spawn(async cx=>{for (;;) {
      const command=await nextCommand();if(this.closed)return;
      if(command==='refresh'){this.diagramKey=null;this.reload(cx);}
      else if(command==='source'||command==='document'){this.mode=command;cx.notify();}
    }});
  }
  savePreferences(){setShared(PREFERENCE,{appearance:this.appearance,fontSize:this.fontSize,wide:this.wide});}
  setAppearance(value,cx){this.appearance=value;this.savePreferences();this.syncEditors();this.loadDiagrams(cx);cx.notify();}
  open(file,cx,remember=false) {
    file=String(file).trim();
    if(!file.startsWith('/')){this.message='Enter an absolute file path.';cx.notify();return;}
    if(remember&&this.file&&this.file!==file)this.history.push(this.file);
    if(this.file!==file){
      this.source=undefined;this.blocks=[];this.images=new Map();this.diagrams=new Map();this.diagramSizes=new Map();this.diagramKey=null;this.diagramRequest=null;this.diagramBusy=false;this.expanded.clear();
      this.releaseEditors();
    }
    this.file=file;this.pathInput.set_value(file);this.message=null;this.watchUnavailable=false;
    const token=this.watchToken={};
    this.reload(cx);
    if((props() || {}).on)return;
    cx.spawn(async cx=>{
      try {
        while(!this.closed&&this.watchToken===token){
          const paths=await watchFolder(dirOf(file));
          if(this.watchToken!==token||this.closed)return;
          if(isDocumentChange(paths,file))this.scheduleReload(cx);
        }
      }catch {if(this.watchToken===token){this.watchUnavailable=true;cx.notify();}}
    });
  }
  scheduleReload(cx) {
    const token=this.refreshToken={};
    cx.spawn(async cx=>{await cx.sleep(180);if(!this.closed&&this.refreshToken===token)this.reload(cx);});
  }
  reload(cx) {
    if(!this.file)return;
    const file=this.file,request=this.request={};this.loading=true;this.error=null;
    cx.spawn(async cx=>{
      try {
        const source=await readTextFile(file,{on:(props() || {}).on || null});
        if(this.closed||this.request!==request)return;
        if(source===null)throw Error('The file is missing or cannot be read.');
        if(source.includes('\0'))throw Error('Choose a Markdown or text file. Binary files cannot be displayed.');
        if(source!==this.source){
          this.source=source;this.blocks=parseMarkdown(source);this.syncEditors();
        }
        this.loadDiagrams(cx);
        this.loadImages(cx);
      }catch(error){if(this.request===request)this.error=String(error.message || error);}
      finally {if(!this.closed&&this.request===request){this.loading=false;cx.notify();}}
    });cx.notify();
  }
  loadImages(cx) {
    if((props() || {}).on)return;
    const file=this.file,request=this.request;
    cx.spawn(async cx=>{
      const images=new Map();
      for(const block of (this.blocks || []).filter(block=>block.type==='image')){
        try {
          const link=resolveDocumentLink(file,block.href);if(!link.file)continue;
          const result=await exec('python3',['-c',IMAGE,link.file,appHome()+'/mods/rich-document/.cache']);
          if(this.closed||this.request!==request)return;
          if(result.code===0){const item=JSON.parse(result.stdout);if(item.path?.startsWith('mods/rich-document/.cache/'))images.set(block.href,item);}
        }catch { /* Keep alternate text and path available when a local image cannot load. */ }
      }
      if(!this.closed&&this.request===request){this.images=images;cx.notify();}
    });
  }
  loadDiagrams(cx) {
    const sources=[...new Set((this.blocks || []).filter(isMermaid).map(block=>block.text))];
    const palette=documentPalette(theme(),this.appearance);
    const key=JSON.stringify([sources,palette.paper,palette.foreground,palette.link,palette.dark]);
    if(key===this.diagramKey)return;
    this.diagramKey=key;
    const request=this.diagramRequest={};
    if(!sources.length){this.diagrams=new Map();this.diagramSizes=new Map();this.diagramBusy=false;this.diagramError=null;return;}
    this.diagramBusy=true;this.diagramError=null;
    cx.spawn(async cx=>{
      const requestPath=appHome()+'/mods/rich-document/.cache/request-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.json';
      try {
        await mkdir(appHome()+'/mods/rich-document/.cache',{recursive:true});
        await writeFile(requestPath,JSON.stringify({sources,palette,cache:appHome()+'/mods/rich-document/.cache'}));
        const result=await exec('node',[appHome()+'/mods/rich-document/renderer/render.mjs','--request',requestPath]);
        if(this.closed||this.diagramRequest!==request)return;
        if(result.code!==0)throw Error((result.stderr || result.stdout || 'Mermaid rendering failed.').trim().slice(-600));
        const output=JSON.parse(result.stdout),diagrams=new Map();
        for(const item of output.diagrams || [])if(item.source&&(!item.path||item.path.startsWith('mods/rich-document/.cache/')))diagrams.set(item.source,item);
        this.diagrams=diagrams;
        const sizes=new Map();
        for(const [index,block]of this.blocks.entries())if(isMermaid(block)){
          const item=diagrams.get(block.text);
          if(item?.path)sizes.set('rich-'+this.file+'-'+index,{width:item.width,height:item.height});
        }
        this.diagramSizes=sizes;
      }catch(error){if(this.diagramRequest===request){this.diagramError=String(error.message || error);this.diagramKey=null;}}
      finally {try{await unlink(requestPath);}catch{} if(!this.closed&&this.diagramRequest===request){this.diagramBusy=false;cx.notify();}}
    });
  }
  follow(href,cx) {
    try {
      const link=resolveDocumentLink(this.file,href);
      if(link.url)cx.open_url(link.url);
      else if(link.file)this.open(link.file,cx,true);
      else {this.message='Anchor navigation is unavailable in the fallback preview. Find the heading in Source.';cx.notify();}
    }catch(error){this.message=String(error.message || error);cx.notify();}
  }
  back(cx){const previous=this.history.pop();if(previous)this.open(previous,cx,false);}
  editorSignature(){return JSON.stringify([documentTheme(theme(),this.appearance),settings().font_family,settings().font_size,this.fontSize]);}
  syncEditors() {
    const colors=documentTheme(theme(),this.appearance),configuration=settings(),signature=this.editorSignature();
    const next=new Map();
    for(const [index,block]of (this.blocks || []).entries())if(block.type==='code'){
      const id='rich-'+(this.file || 'empty')+'-'+index+(isMermaid(block)?'-raw':'');
      const previous=this.codeEditors.get(id);
      const state=previous&&previous.text===block.text&&previous.language===block.language&&this.editorStyle===signature?previous.state:
        EditorState.new(codeOptions(block,configuration,colors,this.fontSize*0.88));
      next.set(id,{state,text:block.text,language:block.language});
    }
    for(const [id,entry]of this.codeEditors)if(next.get(id)?.state!==entry.state)entry.state.release();
    this.codeEditors=next;
    if(this.sourceEditor&&(this.sourceEditor.value()!==this.source||this.editorStyle!==signature)){
      this.sourceEditor.release();this.sourceEditor=null;
    }
    if(!this.sourceEditor)this.sourceEditor=EditorState.new({...codeOptions({text:this.source || '',language:'markdown'},configuration,colors,configuration.font_size || 14),soft_wrap:true});
    this.editorStyle=signature;
  }
  releaseEditors(){this.sourceEditor?.release();this.sourceEditor=null;for(const entry of this.codeEditors.values())entry.state.release();this.codeEditors.clear();}
  openMenu(event,cx) {
    if(!this.file)return;
    cx.stop_propagation();
    openOverlay({mod:'rich-document',props:{menu:true,file:this.file,root:this.root,on:(props() || {}).on || null},kind:'popup',width:250,height:162,at:event.position});
  }
  renderMenu() {
    const p=props(),palette=documentPalette(theme());
    const item=(id,label,action,enabled=true)=>button(id,label,cx=>{action(cx);closeOverlay(p.overlay);},palette,false,enabled).w_full().justify_start().h(34);
    return v_flex().id('rich-document-file-menu').w_full().p(5).gap(2).bg(palette.toolbar)
      .on_mouse_down_out((_e,_cx)=>closeOverlay(p.overlay))
      .child(item('rich-document-reveal','Reveal in Finder',cx=>cx.spawn(async _cx=>{
        try {const result=await exec('/usr/bin/open',['-R',this.file]);if(result.code!==0)throw Error(result.stderr || 'File not found.');}
        catch(error){notify({title:'Could not reveal file',body:String(error.message || error),level:'error'});}
      }),!p.on))
      .child(item('rich-document-copy-path','Copy path',cx=>cx.write_to_clipboard(this.file)))
      .child(item('rich-document-copy-relative','Copy relative path',cx=>cx.write_to_clipboard(relativeDocumentPath(this.file,this.root))).tooltip('Root folder: '+this.root))
      .child(item('rich-document-menu-close','Close',()=>{}));
  }
  render(cx) {
    if((props() || {}).menu)return this.renderMenu();
    const PAPER=documentPalette(theme(),this.appearance),CHROME=documentPalette(theme());
    const b=(id,label,action,selected=false,enabled=true)=>button(id,label,action,CHROME,selected,enabled);
    if(this.source!==undefined&&this.editorStyle!==this.editorSignature()&&!this.editorUpdatePending){
      this.editorUpdatePending=true;
      cx.spawn(async cx=>{await cx.sleep(0);try{if(!this.closed){this.syncEditors();this.loadDiagrams(cx);cx.notify();}}finally{this.editorUpdatePending=false;}});
    }
    const width=Math.max(180,Math.min(this.width-64,this.wide?1800:820));
    const available=this.source!==undefined;
    return v_flex().id('rich-document-root').size_full().min_w(0).min_h(0).bg(PAPER.paper).text_color(PAPER.foreground).font_family(settings().ui_font_family).text_size(14)
      .on_mouse_down('right',(event,cx)=>this.openMenu(event,cx))
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().bg(CHROME.toolbar).border_b_1().border_color(CHROME.border)
        .child(Input.new(this.pathInput).id('rich-document-path').flex_1().min_w(0).h(30).px(8).text_size(12).text_color(CHROME.foreground).accessibility_label('Document file path'))
        .child(b('rich-document-open','Open',cx=>this.open(this.pathInput.value(),cx,true)))
        .child(b('rich-document-file','File',(cx,event)=>this.openMenu(event,cx),false,Boolean(this.file))))
      .child(h_flex().h(42).flex_none().px(12).gap(3).items_center().bg(CHROME.toolbar).border_b_1().border_color(CHROME.border).overflow_x_scroll()
        .child(b('rich-document-back','←',cx=>this.back(cx),false,this.history.length>0))
        .child(b('rich-document-view','Rich',cx=>{this.mode='document';cx.notify();},this.mode==='document'))
        .child(b('rich-document-source','Source',cx=>{this.mode='source';cx.notify();},this.mode==='source'))
        .child(div().w(1).h(18).mx(5).bg(CHROME.border))
        .child(b('rich-document-light','Light',cx=>this.setAppearance('light',cx),this.appearance==='light'))
        .child(b('rich-document-dark','Dark',cx=>this.setAppearance('dark',cx),this.appearance==='dark'))
        .child(b('rich-document-current','App theme',cx=>this.setAppearance('current',cx),this.appearance==='current'))
        .child(b('rich-document-width',this.wide?'Full width':'Reading width',cx=>{this.wide=!this.wide;this.savePreferences();cx.notify();}))
        .child(b('rich-document-smaller','A−',cx=>{this.fontSize=Math.max(11,this.fontSize-1);this.savePreferences();cx.notify();}))
        .child(b('rich-document-larger','A+',cx=>{this.fontSize=Math.min(24,this.fontSize+1);this.savePreferences();cx.notify();}))
        .child(b('rich-document-refresh','Reload',cx=>{this.diagramKey=null;this.reload(cx);},false,Boolean(this.file)&&!this.loading)))
      .when(Boolean(this.error||this.message),el=>el.child(div().px(24).py(10).bg(PAPER.quote).text_color(this.error?PAPER.error:PAPER.foreground).text_size(12).child(this.error||this.message)))
      .when(!available&&this.loading,el=>el.child(div().p(24).text_color(PAPER.muted).child('Loading document…')))
      .when(available&&this.mode==='source'&&Boolean(this.sourceEditor),el=>el.child(Editor.new(this.sourceEditor).flex_1().min_h(0)))
      .when(this.mode==='document',el=>el.child(v_flex().id('rich-document-scroll-'+(this.file || 'empty')).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().bg(PAPER.paper)
        .on_size_change((size,cx)=>{const w=size.width/(settings().zoom || 1);if(Math.abs(w-this.width)>2){this.width=w;cx.notify();}})
        .child(v_flex().id('rich-document-paper').flex_none().w(width).max_w_full().mx_auto().py(36).gap(5).children(renderBlocks(this.blocks || [],{
          idPrefix:'rich-'+(this.file || 'empty'),palette:PAPER,font:settings().ui_font_family,fontSize:this.fontSize,width,
          onCode:(block,{id})=>{const state=this.codeEditors.get(id)?.state;if(!state)return div().p(12).child('Preparing code…');const lines=block.text.split('\n').length;return Editor.new(state).w_full().min_w(0).h(Math.max(72,Math.min(520,lines*this.fontSize*0.88*1.65+24)));},
          isDiagramExpanded:id=>this.expanded.has(id),onToggleDiagram:(id,cx)=>{if(this.expanded.has(id))this.expanded.delete(id);else this.expanded.add(id);cx.notify();},
          onDiagram:(block,{id,width})=>{
            const item=this.diagrams.get(block.text);
            if(item?.path){const w=Math.min(width,item.width);return image(item.path).w(w).h(w*item.height/item.width);}
            const previous=this.diagramSizes.get(id);
            if(this.diagramBusy&&previous){
              const w=Math.min(width,previous.width);
              return div().id(id+'-pending').w(w).h(w*previous.height/previous.width).flex_none().flex().items_center().justify_center()
                .bg(PAPER.quote).text_color(PAPER.muted).text_size(13).child('Updating diagram…');
            }
            const error=item?.error || this.diagramError || (!this.diagramBusy?'No Mermaid rendering result.':null);
            return error?div().p(14).bg(PAPER.quote).text_color(PAPER.error).text_size(13).child('Diagram unavailable. Expand Source to inspect its code.').tooltip(error):null;
          },
          onLink:(url,cx)=>this.follow(url,cx),onImage:(block,{width})=>{const item=this.images.get(block.href);if(!item)return null;const w=Math.min(width,item.width);return image(item.path).w(w).h(w*item.height/item.width);}
        })))
        .when(!this.file,el=>el.child(div().p(32).text_color(PAPER.muted).child('Enter an absolute Markdown path above and choose Open.')))))
      .child(h_flex().h(25).flex_none().px(16).gap(12).items_center().bg(CHROME.toolbar).border_t_1().border_color(CHROME.border).text_size(11).text_color(CHROME.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.file?nameOf(this.file):'Markdown tab'))
        .child(div().child(this.file?this.loading?'Refreshing':this.watchUnavailable?'File watching unavailable; checking periodically':(props() || {}).on?'Remote file; reload manually':'Watching local changes':'Markdown'))
        .child(div().child('Read-only preview')));
  }
  close(){this.closed=true;this.request=null;this.watchToken=null;this.refreshToken=null;this.diagramRequest=null;this.pathInput?.release();this.releaseEditors();}
}
