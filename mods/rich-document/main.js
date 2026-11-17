import {View,div} from 'gpui-kit';
import * as base from 'gpui-base';
import {props,appHome,readTextFile,writeTextFile,watchFolder,shared,setShared,theme,exec,notify} from 'herdr';
import {resolveDocumentLink,relativeDocumentPath,isDocumentChange} from './parser.js';
import Legacy from './legacy.js';

const PREFERENCE='rich-document.reading';
const MAX_LENGTH=1024*1024;
const errorMessage=error=>String(error?.message||error);
const byteLength=value=>{let count=0;for(const char of value){const n=char.codePointAt(0);count+=n<128?1:n<2048?2:n<65536?3:4;}return count;};

export default class Markdown extends View {
  init(_props,cx){
    this.history=[];this.file=null;this.closed=false;this.ready=false;this.loading=false;
    this.drafts=new Map();
    if(!base.WebViewState||!base.WebView||(props()||{}).menu||(props()||{}).on){
      this.legacy=new Legacy();this.legacy.init(_props,cx);return;
    }
    this.web=base.WebViewState.new({asset_root:appHome()+'/mods/rich-document/editor',entry:'index.html'});
    this.web.on('message',(message,cx)=>this.receive(message,cx));
  }
  post(message){if(!this.closed&&this.web)this.web.post_message(JSON.stringify(message));}
  preferences(){
    const saved=shared(PREFERENCE)||{};
    const host=String(theme().background).replace('#','');
    const hostDark=parseInt(host.slice(0,2),16)<128;
    return {appearance:saved.appearance==='current'?(hostDark?'dark':'light'):saved.appearance==='dark'?'dark':'light',
      fontSize:Number.isFinite(saved.fontSize)?saved.fontSize:17,wide:saved.wide===true};
  }
  receive(raw,cx){
    let message;try{message=typeof raw==='string'?JSON.parse(raw):JSON.parse(raw?.message||raw?.data||'null');}catch{return;}
    if(!message||typeof message.type!=='string')return;
    if(message.type==='ready'){
      this.ready=true;this.post({type:'preferences',preferences:this.preferences()});
      const file=(props()||{}).file;if(file)this.open(file,cx);
    }else if(message.type==='preferences'){
      const p=message.preferences;
      if(p&&['light','dark'].includes(p.appearance)&&Number.isFinite(p.fontSize))setShared(PREFERENCE,{appearance:p.appearance,fontSize:Math.max(11,Math.min(24,p.fontSize)),wide:p.wide===true});
    }else if(message.type==='open'&&typeof message.file==='string')this.open(message.file,cx,true);
    else if(message.type==='reload'&&this.file)this.reload(cx,true);
    else if(message.type==='back'){
      const file=this.history.at(-1);if(file)this.reload(cx,false,file,false,true);
    }else if(message.type==='save')this.save(message,cx);
    else if(message.type==='image'&&Number.isInteger(message.id)&&typeof message.href==='string'&&this.file){
      const file=this.file;
      cx.spawn(async cx=>{
        try{
          const link=resolveDocumentLink(file,message.href);
          if(!link.file)throw Error('Only local document images are loaded.');
          const result=await exec('python3',['-c',
            'import sys,pathlib,hashlib,shutil,json\np=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2]);s=p.stat()\nif s.st_size>16*1024*1024: raise ValueError("Image exceeds 16 MiB")\next=p.suffix.lower()\nif ext not in [".png",".jpg",".jpeg",".webp",".svg",".gif",".avif"]: raise ValueError("Unsupported image format")\nroot.mkdir(parents=True,exist_ok=True)\nname=hashlib.sha256((str(p)+str(s.st_mtime_ns)+str(s.st_size)).encode()).hexdigest()+ext\nshutil.copyfile(p,root/name)\nprint(json.dumps({"path":"cache/"+name}))',
            link.file,appHome()+'/mods/rich-document/editor/cache']);
          if(result.code!==0)throw Error('Image could not be loaded.');
          if(!this.closed&&this.file===file)this.post({type:'image',id:message.id,path:JSON.parse(result.stdout).path});
        }catch{if(!this.closed)this.post({type:'image',id:message.id});}
      });
    }
    else if(message.type==='draft'){
      const draft=message.snapshot;
      if(draft?.file===this.file&&typeof draft.draft==='string'&&byteLength(draft.draft)<=MAX_LENGTH&&typeof draft.baseline==='string'){
        this.drafts.set(this.file,draft);localStorage.setItem('draft:'+this.file,JSON.stringify(draft));
      }
    }else if(message.type==='follow'&&typeof message.href==='string'){
      try{
        const link=resolveDocumentLink(this.file,message.href);
        if(link.file)this.open(link.file,cx,true);
        else if(link.url)cx.open_url(link.url);
      }catch(error){this.post({type:'error',message:errorMessage(error)});}
    }else if(message.type==='file-action'&&this.file){
      if(message.action==='copy-path')cx.write_to_clipboard(this.file);
      else if(message.action==='copy-relative')cx.write_to_clipboard(relativeDocumentPath(this.file,(props()||{}).root||this.file.slice(0,this.file.lastIndexOf('/'))));
      else if(message.action==='reveal')cx.spawn(async()=>{
        try{const result=await exec('/usr/bin/open',['-R',this.file]);if(result.code!==0)throw Error(result.stderr||'File not found.');}
        catch(error){notify({title:'Could not reveal file',body:errorMessage(error),level:'error'});}
      });
    }
  }
  open(file,cx,remember=false){
    if(this.saving)return;
    file=file.trim();
    if(!file.startsWith('/')){this.post({type:'error',message:'Enter an absolute local file path.'});return;}
    if((props()||{}).on){this.post({type:'error',message:'Remote files are read-only. Open a local copy to edit.'});return;}
    this.reload(cx,false,file,remember);
  }
  reload(cx,force=false,file=this.file,remember=false,back=false){
    if(!file)return;
    const request=this.request={};this.loading=true;
    if(force||file!==this.file)this.post({type:'loading'});
    cx.spawn(async cx=>{
      try{
        const source=await readTextFile(file);
        if(this.closed||request!==this.request)return;
        if(source===null)throw Error('Cannot read this file. Check the path and choose Open again.');
        if(source.includes('\0'))throw Error('This is a binary file. Choose a Markdown or text file.');
        if(source.length>MAX_LENGTH)throw Error('This document exceeds the 1 MiB editing limit.');
        const changed=file!==this.file;
        if(changed){
          if(remember&&this.file)this.history.push(this.file);
          if(back)this.history.pop();
          this.file=file;
          const token=this.watchToken={};
          cx.spawn(async cx=>{
            try{
              while(!this.closed&&this.watchToken===token){
                const paths=await watchFolder(file.slice(0,file.lastIndexOf('/'))||'/');
                if(this.closed||this.watchToken!==token)return;
                if(!this.loading&&isDocumentChange(paths,file))this.reload(cx);
              }
            }catch{if(!this.closed&&this.watchToken===token)this.post({type:'error',message:'File watching is unavailable. Use Reload to check the file.'});}
          });
        }
        this.disk=source;this.loading=false;
        let snapshot=this.drafts.get(file);
        if(force){snapshot=null;this.drafts.delete(file);localStorage.removeItem('draft:'+file);}
        else if(!snapshot){try{snapshot=JSON.parse(localStorage.getItem('draft:'+file)||'null');}catch{}}
        this.post({type:force?'reloaded':'document',file,source,snapshot,canBack:this.history.length>0});
      }catch(error){if(!this.closed&&request===this.request){this.loading=false;this.post({type:'error',message:errorMessage(error)});}}
    });
  }
  save(message,cx){
    if(this.saving||this.loading||message.file!==this.file||typeof message.source!=='string'||typeof message.expected!=='string'){
      this.post({type:'error',message:'The document is busy or has changed. Wait for it to finish and save again.'});return;
    }
    if(byteLength(message.source)>MAX_LENGTH){this.post({type:'error',message:'This document exceeds the 1 MiB editing limit. Shorten it before saving.'});return;}
    this.saving=true;
    const {file,source,expected,id}=message;
    cx.spawn(async cx=>{
      try{
        await writeTextFile(file,source,expected);
        if(this.closed)return;
        this.disk=source;
        const draft=this.drafts.get(file);
        if(draft){draft.baseline=source;this.drafts.set(file,draft);localStorage.setItem('draft:'+file,JSON.stringify(draft));}
        this.post({type:'saved',file,source,id});
      }catch(error){if(!this.closed)this.post({type:'error',message:'Could not save. The file may have changed on disk. Your draft is kept. '+errorMessage(error)});}
      finally{this.saving=false;}
    });
  }
  render(cx){
    if(this.legacy)return base.v_flex().size_full().min_h(0)
      .child(div().flex_none().px(12).py(7).bg(theme().surface).text_color(theme().foreground).text_size(12)
        .child('Read-only preview. Source / Rich editing requires the Herdr Markdown WebView host.'))
      .child(this.legacy.render(cx).flex_1().min_h(0));
    return base.WebView.new(this.web).size_full();
  }
  close(){this.closed=true;this.request=null;this.watchToken=null;this.web?.release();this.legacy?.close();}
}
