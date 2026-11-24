import {Editor, Node} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {createLowlight,common} from 'lowlight';
import groovy from 'highlight.js/lib/languages/groovy';
import {Markdown} from '@tiptap/markdown';
import {TableKit} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import mermaid from 'mermaid';

const $=id=>document.getElementById(id);
const viewport=$('viewport'),sourceInput=$('source-editor'),pathInput=$('path');
let file='',baseline='',draft='',mode='rich',loading=false,saving=false,version=0,ready=false;
let preferences={appearance:'light',fontSize:17,wide:false};
let external=null,sourceChanged=false,settingContent=false,richSource='';
const positions={rich:0,source:0},documents=new Map();
const imageViews=new Map();let imageId=0;
let saveId=0,diagramId=0,pathPasteId=0,pendingPathPaste,preferencesTimer,saveTimer;
const send=message=>window.ipc?.postMessage(JSON.stringify(message));
const controlCharacter=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// HTML stays inert and round-trips as Markdown instead of being executed or dropped.
const RawBlock=Node.create({
  name:'rawBlock',group:'block',atom:true,
  addAttributes(){return {source:{default:''}};},
  parseHTML(){return [{tag:'pre[data-raw-markdown="'+this.name+'"]',priority:1000,getAttrs:element=>({source:element.textContent||''})}];},
  renderHTML({node}){return ['pre',{'data-raw-markdown':node.type.name,contenteditable:'false'},['code',{},node.attrs.source]];},
  renderText({node}){return node.attrs.source;},
  markdownTokenName:'html',
  parseMarkdown(token){return {type:'rawBlock',attrs:{source:token.raw}};},
  renderMarkdown(node){return node.attrs.source;},
});

const Frontmatter=RawBlock.extend({
  name:'frontmatter',markdownTokenName:'frontmatter',
  parseMarkdown(token){return {type:'frontmatter',attrs:{source:token.raw}};},
  markdownTokenizer:{name:'frontmatter',level:'block',start:src=>src.startsWith('---\n')||src.startsWith('---\r\n')?0:-1,
    tokenize(src){const match=src.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);return match?{type:'frontmatter',raw:match[0]}:undefined;}},
});
const RawInline=Node.create({
  name:'rawInline',group:'inline',inline:true,atom:true,
  addAttributes(){return {source:{default:''}};},
  parseHTML(){return [{tag:'code[data-raw-inline]',priority:1000,getAttrs:element=>{
    try{const source=JSON.parse(element.getAttribute('data-raw-source'));if(typeof source==='string')return {source};}catch{}
    return {source:element.textContent||''};
  }}];},
  renderHTML({node}){
    const source=node.attrs.source,isControl=source.length===1&&controlCharacter.test(source);
    return ['code',{'data-raw-inline':'true','data-raw-source':JSON.stringify(source),'data-control-character':isControl?'true':null,contenteditable:'false'},
      isControl?'[U+'+source.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')+']':source];
  },
  renderText({node}){return node.attrs.source;},
  markdownTokenName:'rawInline',parseMarkdown(token){return {type:'rawInline',attrs:{source:token.raw}};},
  renderMarkdown(node){return node.attrs.source;},
  markdownTokenizer:{name:'rawInline',level:'inline',start:src=>{
    const angle=src.indexOf('<'),control=src.search(controlCharacter);
    return angle<0?control:control<0?angle:Math.min(angle,control);
  },tokenize(src){
    if(src.length&&controlCharacter.test(src[0]))return {type:'rawInline',raw:src[0]};
    const match=src.match(/^(?:<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)(?:\s[^>]*?)?>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][\w:-]*(?:\s[^>]*?)?\/?>)/);return match?{type:'rawInline',raw:match[0]}:undefined;
  }},
});

// Unlabeled code stays plain like GitHub instead of guessing a language.
const lowlight=createLowlight(common);lowlight.register({groovy});lowlight.registerAlias({groovy:['gradle']});
const highlighter={...lowlight,highlightAuto:()=>({type:'root',children:[]})};

const DiagramCode=CodeBlockLowlight.extend({
  addNodeView(){return ({node})=>{
    const dom=document.createElement('div');
    if(node.attrs.language!=='mermaid'){
      let current=node,copied;
      const bar=document.createElement('div'),copy=document.createElement('button');
      const pre=document.createElement('pre'),code=document.createElement('code');
      dom.className='code-block';bar.className='code-toolbar';bar.contentEditable='false';
      const language=value=>{code.className=value?'language-'+value:'';};
      language(node.attrs.language);
      copy.type='button';copy.className='code-copy';copy.textContent='Copy';copy.setAttribute('aria-live','polite');
      copy.onclick=()=>{
        // An empty block would only clear the clipboard.
        if(!current.textContent)return;
        send({type:'copy-code',text:current.textContent});
        copy.textContent='Copied';clearTimeout(copied);copied=setTimeout(()=>{copy.textContent='Copy';},1500);
      };
      bar.append(copy);pre.append(code);dom.append(bar,pre);
      return {dom,contentDOM:code,update(next){
          if(next.type!==current.type||next.attrs.language==='mermaid')return false;
          current=next;language(next.attrs.language);return true;
        },
        destroy(){clearTimeout(copied);},
        stopEvent(event){return bar.contains(event.target);},
        ignoreMutation(m){return bar.contains(m.target);}};
    }

    let current=node,request=0,timer;
    const preview=document.createElement('div');
    const frame=document.createElement('div'),fit=document.createElement('button');
    frame.contentEditable='false';
    fit.type='button';fit.className='mermaid-fit';fit.hidden=true;fit.textContent='Fit diagram';
    preview.className='mermaid-preview';
    preview.setAttribute('role','region');preview.setAttribute('aria-label','Mermaid diagram');
    frame.append(fit,preview);dom.append(frame);
    const updateOverflow=()=>{
      const wide=preview.scrollWidth>preview.clientWidth+1;
      fit.hidden=!wide&&!preview.classList.contains('mermaid-fitted');
      preview.tabIndex=wide?0:-1;
    };
    const resize=new ResizeObserver(updateOverflow);
    fit.onclick=()=>{
      const fitted=preview.classList.toggle('mermaid-fitted');
      fit.textContent=fitted?'Actual size':'Fit diagram';
      preview.scrollLeft=0;
      updateOverflow();
    };
    const render=()=>{
      clearTimeout(timer);const token=++request;
      timer=setTimeout(async()=>{
        try{
          const dark=preferences.appearance==='dark',source=current.textContent;
          const fontSize=Math.max(16,preferences.fontSize)+'px';
          const fontFamily='DM Sans Variable, Noto Sans KR Variable, sans-serif';
          await document.fonts.load(fontSize+' '+fontFamily,source).catch(()=>{});
          if(request!==token||!dom.isConnected)return;
          mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,
            maxTextSize:100000,maxEdges:1000,theme:'base',fontFamily,htmlLabels:false,
            flowchart:{wrappingWidth:260},themeVariables:{darkMode:dark,fontFamily,fontSize,useGradient:false,
              primaryColor:dark?'#262626':'#ededed',primaryTextColor:dark?'#ebebeb':'#171717',
              primaryBorderColor:dark?'#777777':'#888888',lineColor:dark?'#ebebeb':'#171717',
              background:dark?'#181818':'#fafafa'},
            secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges']});
          const {svg}=await mermaid.render('diagram-'+(++diagramId),source);
          if(request!==token||!dom.isConnected)return;
          preview.innerHTML=svg;
          preview.classList.remove('mermaid-error');
          const diagram=preview.firstElementChild;
          const width=diagram.viewBox?.baseVal.width;
          if(width>0){
            diagram.style.removeProperty('max-width');
            diagram.setAttribute('width',String(width));
          }
          resize.observe(preview);
          updateOverflow();
        }catch{
          if(request!==token||!dom.isConnected)return;
          preview.textContent='Diagram unavailable. Check the Mermaid code in Source.';
          preview.classList.add('mermaid-error');
          preview.classList.remove('mermaid-fitted');
          fit.textContent='Fit diagram';
          updateOverflow();
        }
      },180);
    };
    const themeChanged=()=>render();document.addEventListener('themechange',themeChanged);
    render();
    return {dom,update(next){
        if(next.type!==current.type||next.attrs.language!=='mermaid')return false;
        if(next.textContent!==current.textContent){current=next;render();}
        return true;
      },
      destroy(){request++;clearTimeout(timer);resize.disconnect();document.removeEventListener('themechange',themeChanged);},
      stopEvent(event){return frame.contains(event.target);},
      ignoreMutation(m){return frame.contains(m.target);}};
  };},
});

const LocalImage=Image.extend({
  addNodeView(){return ({node})=>{
    let current=node;
    const dom=document.createElement('span'),img=document.createElement('img'),label=document.createElement('span');
    dom.contentEditable='false';dom.append(img,label);const id=++imageId;
    const refresh=()=>{img.removeAttribute('src');img.hidden=true;label.textContent=current.attrs.alt||'Loading image…';
      if(String(current.attrs.src).startsWith('data:image/')){img.src=current.attrs.src;img.hidden=false;label.textContent='';}
      else send({type:'image',id,href:current.attrs.src});};
    imageViews.set(id,{resolve(path){img.src=new URL(path,location.href).href;img.alt=current.attrs.alt||'';img.hidden=false;label.textContent='';},fail(){label.textContent=current.attrs.alt||'Image preview unavailable.';}});
    refresh();return {dom,update(next){if(next.type!==current.type)return false;const changed=next.attrs.src!==current.attrs.src;current=next;if(changed)refresh();return true;},destroy(){imageViews.delete(id);}};
  };},
});

const editor=new Editor({
  element:$('rich-editor'),extensions:[
    StarterKit.configure({codeBlock:false,link:{openOnClick:false,autolink:false,protocols:['http','https','mailto']}}),
    DiagramCode.configure({lowlight:highlighter}),Markdown,TableKit.configure({table:{resizable:false}}),
    LocalImage.configure({allowBase64:true}),TaskList,TaskItem.configure({nested:true,HTMLAttributes:{'data-type':'taskItem'}}),RawBlock,Frontmatter,RawInline,
  ],content:'',contentType:'markdown',editable:false,
  editorProps:{attributes:{'aria-label':'Rich Markdown editor',spellcheck:'false'},
    handleTextInput:(_view,_from,_to,text)=>{
      if(!controlCharacter.test(text))return false;
      notice('A control key was ignored. Existing control characters can be inspected in Source.');return true;
    },
    handleDOMEvents:{
      keydown:(view,event)=>{
        if(!window.__HERDR_DOCUMENT_HOST__||!event.isTrusted||event.isComposing||!event.metaKey||event.ctrlKey||
          event.altKey||event.shiftKey||event.key.toLowerCase()!=='c'||view.state.selection.empty)return false;
        // Herdr's WKWebView delivers Cmd+C without dispatching the platform copy action.
        if(!document.execCommand('copy'))return false;
        event.preventDefault();
        return true;
      },
      click:(_view,event)=>{
        const link=event.target.closest?.('a');
        if(link&&(event.metaKey||event.ctrlKey)){
          event.preventDefault();positions[mode]=viewport.scrollTop;
          if(file){documents.set(file,snapshot());send({type:'draft',snapshot:snapshot()});}
          send({type:'follow',href:link.getAttribute('href')});return true;
        }
        return false;
      },
    }},
  onUpdate(){if(settingContent)return;draft=editor.getMarkdown();richSource=draft;version++;sourceChanged=true;changed();},
});

function notice(text='',error=false,action){
  const node=$('notice');node.replaceChildren();node.hidden=!text;node.className=error?'error':'';
  node.append(document.createTextNode(text));
  if(action){const button=document.createElement('button');button.textContent=action.label;button.onclick=action.run;node.append(button);}
}
function update(){
  const dirty=draft!==baseline;
  $('save').disabled=!file||!dirty||saving||loading;
  $('reload').disabled=!file||loading||saving;
  pathInput.value=file||pathInput.value;
  $('document-name').textContent=file?.split('/').pop()||'Markdown';
  $('status').textContent=loading?'Loading…':saving?'Saving…':dirty?'Unsaved changes':'Saved';
  $('empty').hidden=Boolean(file);
  $('rich-shell').hidden=mode!=='rich'||!file;
  sourceInput.hidden=mode!=='source'||!file;
  $('format-toolbar').hidden=mode!=='rich'||!file;
  $('source-button').setAttribute('aria-pressed',String(mode==='source'));
  $('rich-button').setAttribute('aria-pressed',String(mode==='rich'));
  editor.setEditable(Boolean(file)&&!loading,false);
  sourceInput.readOnly=loading;
  if(mode==='source')resizeSource();
}
function snapshot(){
  return {file,baseline,draft,mode,positions:{...positions},sourceChanged,sourceSelection:[sourceInput.selectionStart,sourceInput.selectionEnd],
    richSelection:{from:editor.state.selection.from,to:editor.state.selection.to}};
}
function changed(){
  update();
  if(file){documents.set(file,snapshot());send({type:'draft',snapshot:snapshot()});}
}
function resizeSource(){sourceInput.style.height='0px';sourceInput.style.height=Math.max(viewport.clientHeight,sourceInput.scrollHeight)+'px';}
function setRich(source){settingContent=true;try{editor.commands.setContent(source,{contentType:'markdown',emitUpdate:false});richSource=source;}finally{settingContent=false;}}
function switchMode(next){
  if(mode===next)return;
  positions[mode]=viewport.scrollTop;
  if(next==='rich'&&draft!==richSource)setRich(draft);
  else sourceInput.value=draft;
  mode=next;update();
  requestAnimationFrame(()=>{viewport.scrollTop=positions[mode];if(mode==='rich')editor.commands.focus(undefined,{scrollIntoView:false});else sourceInput.focus({preventScroll:true});});
  changed();
}
function applyPreferences(next,persist=true){
  preferences={...preferences,...next};
  preferences.appearance=preferences.appearance==='dark'?'dark':'light';
  preferences.fontSize=Math.max(11,Math.min(24,Number(preferences.fontSize)||17));
  document.documentElement.dataset.theme=preferences.appearance;
  document.documentElement.style.setProperty('--body-size',preferences.fontSize+'px');
  document.body.classList.toggle('wide',preferences.wide===true);
  $('light-button').setAttribute('aria-pressed',String(preferences.appearance==='light'));
  $('dark-button').setAttribute('aria-pressed',String(preferences.appearance==='dark'));
  $('width-button').setAttribute('aria-pressed',String(preferences.wide===true));
  document.dispatchEvent(new Event('themechange'));
  if(persist)send({type:'preferences',preferences});
}
function confirmAction(message,action){
  $('confirm-message').textContent=message;$('accept-confirm').onclick=()=>{$('confirm-dialog').close();action();};
  $('confirm-dialog').showModal();$('cancel-confirm').focus();
}
function openFile(path){
  if(saving){notice('Wait for the current save to finish before opening another document.');return;}
  const open=()=>{positions[mode]=viewport.scrollTop;if(file)documents.set(file,snapshot());send({type:'open',file:path});};
  if(draft!==baseline&&path!==file)confirmAction('Your draft will be kept in this tab. Open another document?',open);else open();
}
function save(){
  if(!file||saving||loading||draft===baseline)return;
  saving=true;update();
  const id=++saveId;
  send({type:'save',id,file,source:draft,expected:baseline,version});
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>{
    if(saving&&saveId===id){saving=false;update();notice('Save confirmation did not arrive. Your draft is kept. Check the file before trying again.',true);}
  },20000);
}
function receive(message){
  let data;try{data=typeof message==='string'?JSON.parse(message):message;}catch{return;}
  if(!data||typeof data.type!=='string')return;
  if(data.type==='document'){
    if(typeof data.file!=='string'||typeof data.source!=='string')return;
    if(!data.force&&file===data.file&&draft!==baseline&&data.source!==baseline){
      external=data.source;loading=false;update();
      notice('This file changed on disk. Your draft is kept. Save to check for conflicts, or reload to use the disk version.',true);return;
    }
    if(!data.force&&file===data.file&&data.source===baseline){loading=false;update();return;}
    file=data.file;baseline=data.source;loading=false;sourceChanged=false;
    const saved=documents.get(file)||data.snapshot;
    const canRestore=saved?.file===file&&saved.baseline===baseline;
    draft=canRestore?saved.draft:baseline;
    if(canRestore){mode=saved.mode==='source'?'source':'rich';Object.assign(positions,saved.positions);sourceChanged=saved.sourceChanged===true;}
    else {positions.rich=0;positions.source=0;}
    setRich(draft);sourceInput.value=draft;update();
    requestAnimationFrame(()=>{
      if(canRestore&&mode==='source')sourceInput.setSelectionRange(...(saved.sourceSelection||[0,0]));
      if(canRestore&&mode==='rich'&&saved.richSelection){
        const end=editor.state.doc.content.size;
        editor.commands.setTextSelection({from:Math.min(end,saved.richSelection.from),to:Math.min(end,saved.richSelection.to)});
      }
      viewport.scrollTop=positions[mode];
    });
    notice(canRestore&&draft!==baseline?'Restored the unsaved draft from this tab.':'');
    if(saved?.draft!==undefined&&!canRestore&&saved.draft!==saved.baseline){
      const kept=saved.draft;notice('A recovered draft differs from the disk version.',true,{label:'Restore draft',run:()=>{draft=kept;setRich(draft);sourceInput.value=draft;changed();notice('Recovered draft restored. Save checks the current disk version.');}});
    }
    $('back').disabled=!data.canBack;
  }else if(data.type==='saved'){
    if(data.id!==saveId||data.file!==file)return;
    clearTimeout(saveTimer);
    saving=false;baseline=data.source;
    if(draft===baseline)sourceChanged=false;
    external=null;changed();notice('Saved.');
  }else if(data.type==='error'){
    clearTimeout(saveTimer);
    loading=false;saving=false;update();notice(data.message||'The operation failed. Try again.',true);
  }else if(data.type==='path-paste'){
    if(!pendingPathPaste||data.id!==pendingPathPaste.id)return;
    const {value,start,end}=pendingPathPaste;pendingPathPaste=null;
    if(typeof data.text==='string'&&data.text&&document.activeElement===pathInput&&
      pathInput.value===value&&pathInput.selectionStart===start&&pathInput.selectionEnd===end){
      document.execCommand('insertText',false,data.text.replace(/[\r\n]/g,''));
    }
  }else if(data.type==='preferences')applyPreferences(data.preferences,false);
  else if(data.type==='image'){
    const view=imageViews.get(data.id);if(data.path)view?.resolve(data.path);else view?.fail();
  }
  else if(data.type==='loading'){loading=true;update();}
  else if(data.type==='reloaded'){
    documents.delete(file);baseline='';draft='';external=null;receive({...data,type:'document',force:true});
  }
}
window.addEventListener('message',event=>receive(event.data));
// The native host calls this hook; the browser harness uses the same contract.
window.herdrMarkdown={receive,snapshot:()=>snapshot(),editor};
const updateLinkModifier=event=>{
  document.documentElement.classList.toggle('follow-links',event.metaKey||event.ctrlKey);
};
window.addEventListener('keydown',updateLinkModifier,true);
window.addEventListener('keyup',updateLinkModifier,true);
window.addEventListener('pointermove',updateLinkModifier,{capture:true,passive:true});
window.addEventListener('blur',()=>document.documentElement.classList.remove('follow-links'));
window.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();save();}
  if(event.key==='Escape')closeMenu();
});
pathInput.addEventListener('keydown',event=>{
  if(!window.__HERDR_DOCUMENT_HOST__||!event.isTrusted||event.isComposing||!event.metaKey||
    event.ctrlKey||event.altKey)return;
  const key=event.key.toLowerCase();
  if(event.shiftKey&&key!=='z')return;
  if(key==='a')pathInput.select();
  else if(key==='v'){
    const id=++pathPasteId;
    pendingPathPaste={id,value:pathInput.value,start:pathInput.selectionStart,end:pathInput.selectionEnd};
    send({type:'paste-path',id});
  }else if(key==='c'||key==='x'){
    if(pathInput.selectionStart!==pathInput.selectionEnd)document.execCommand(key==='c'?'copy':'cut');
  }else if(key==='z')document.execCommand(event.shiftKey?'redo':'undo');
  else return;
  event.preventDefault();
});
sourceInput.addEventListener('input',()=>{draft=sourceInput.value;version++;sourceChanged=true;resizeSource();changed();});
sourceInput.addEventListener('beforeinput',event=>{
  if(event.inputType==='insertText'&&event.data&&controlCharacter.test(event.data)){
    event.preventDefault();notice('A control key was ignored. Paste preserves the original source text.');
  }
});
sourceInput.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;event.preventDefault();
  const start=sourceInput.selectionStart,end=sourceInput.selectionEnd;
  sourceInput.setRangeText('  ',start,end,'end');sourceInput.dispatchEvent(new Event('input'));
});
viewport.addEventListener('scroll',()=>{
  positions[mode]=viewport.scrollTop;clearTimeout(preferencesTimer);
  preferencesTimer=setTimeout(()=>{if(file){documents.set(file,snapshot());send({type:'draft',snapshot:snapshot()});}},150);
},{passive:true});
new ResizeObserver(()=>{if(mode==='source')resizeSource();}).observe(viewport);
$('source-button').onclick=()=>switchMode('source');$('rich-button').onclick=()=>switchMode('rich');
$('light-button').onclick=()=>applyPreferences({appearance:'light'});$('dark-button').onclick=()=>applyPreferences({appearance:'dark'});
$('width-button').onclick=()=>applyPreferences({wide:!preferences.wide});
$('smaller').onclick=()=>applyPreferences({fontSize:preferences.fontSize-1});$('larger').onclick=()=>applyPreferences({fontSize:preferences.fontSize+1});
$('save').onclick=save;$('open-form').onsubmit=event=>{event.preventDefault();openFile(pathInput.value);};
$('back').onclick=()=>{
  if(saving)return;
  const back=()=>{
    positions[mode]=viewport.scrollTop;
    if(file){documents.set(file,snapshot());send({type:'draft',snapshot:snapshot()});}
    send({type:'back'});
  };
  if(draft!==baseline)confirmAction('Your draft will be kept. Open the previous document?',back);else back();
};
$('reload').onclick=()=>{
  const reload=()=>send({type:'reload'});
  if(draft!==baseline)confirmAction('Reload the disk version? Your current unsaved changes will be discarded.',reload);else reload();
};
const commands={bold:'toggleBold',italic:'toggleItalic',strike:'toggleStrike',bulletList:'toggleBulletList',orderedList:'toggleOrderedList',taskList:'toggleTaskList',blockquote:'toggleBlockquote',code:'toggleCode',codeBlock:'toggleCodeBlock',undo:'undo',redo:'redo'};
for(const button of document.querySelectorAll('[data-command]')){
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.onclick=()=>{
    const name=button.dataset.command,chain=editor.chain().focus();
    if(name==='heading1'||name==='heading2')chain.toggleHeading({level:name==='heading1'?1:2}).run();
    else if(name==='table')chain.insertTable({rows:3,cols:3,withHeaderRow:true}).run();
    else chain[commands[name]]().run();
  };
}
function closeMenu(){$('file-menu').hidden=true;$('file-menu-button').setAttribute('aria-expanded','false');}
$('file-menu-button').onclick=()=>{
  const menu=$('file-menu');menu.hidden=!menu.hidden;$('file-menu-button').setAttribute('aria-expanded',String(!menu.hidden));
  if(!menu.hidden)menu.querySelector('button').focus();
};
$('close-menu').onclick=()=>{closeMenu();$('file-menu-button').focus();};
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#file-menu,#file-menu-button'))closeMenu();});
for(const button of document.querySelectorAll('[data-file-action]'))button.onclick=()=>{send({type:'file-action',action:button.dataset.fileAction});closeMenu();};
$('cancel-confirm').onclick=()=>$('confirm-dialog').close();
$('confirm-dialog').addEventListener('click',event=>{if(event.target===$('confirm-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();}});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden)return;
  document.documentElement.classList.remove('follow-links');
  if(file)send({type:'draft',snapshot:snapshot()});
});
applyPreferences(preferences,false);update();ready=true;send({type:'ready'});
