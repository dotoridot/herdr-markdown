import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import puppeteer from 'puppeteer-core';

const root=resolve('mods/rich-document/editor');
const sample='# Project notes\n\nEdit this paragraph directly. 한글 입력도 확인합니다.\n\n| Path | State |\n| --- | --- |\n| `sessions/<session ID>.md` | Ready |\n| `concepts/<주제>.md` | Draft |\n\n```js\nconst answer = 42;\n```\n\n- [ ] Write a note\n- [x] Check the preview\n';

test('Source and Rich editor behavior in a headless browser',async t=>{
  const server=createServer(async(req,res)=>{
    const name=decodeURIComponent(req.url.split('?')[0]);
    const path=resolve(root,'.'+(name==='/'?'/index.html':name));
    if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
    try{const bytes=await readFile(name==='/editor.js'&&process.env.HERDR_TEST_BUNDLE?process.env.HERDR_TEST_BUNDLE:path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(path)]||'application/octet-stream');res.end(bytes);}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await puppeteer.launch({executablePath:process.env.HERDR_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
  try{
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',error=>{errors.push(error.message);process.stderr.write('Browser error: '+error.stack+'\n');});
    await page.evaluateOnNewDocument(()=>{Object.defineProperty(window,'__HERDR_DOCUMENT_HOST__',{value:true});window.testMessages=[];window.ipc={postMessage:value=>window.testMessages.push(JSON.parse(value))};});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>window.testMessages.some(m=>m.type==='ready'),{timeout:5000});
    const load=async source=>page.evaluate(source=>window.herdrMarkdown.receive({type:'document',file:'/example/notes.md',source}),source);
    await load(sample);

    await t.test('inline code displays angle brackets and literal entities correctly',async()=>{
      const codes=await page.$$eval('.tiptap td code',nodes=>nodes.map(node=>node.textContent));
      assert.deepEqual(codes,['sessions/<session ID>.md','concepts/<주제>.md']);
      await load(sample+'\nLiteral `&lt;keep&gt;` and `decisions/<topic>.md`.\n');
      assert.ok(await page.$eval('.tiptap',node=>node.textContent.includes('&lt;keep&gt;')));
    });
    await t.test('a task checkbox stays alongside its text',async()=>{
      const sideBySide=await page.$eval('.tiptap ul[data-type="taskList"] li',node=>{
        const checkbox=node.querySelector('input').getBoundingClientRect();
        const text=node.querySelector('div').getBoundingClientRect();
        return checkbox.right<=text.left&&Math.abs(checkbox.top-text.top)<20;
      });
      assert.equal(sideBySide,true);
    });
    await t.test('opening and switching views does not rewrite the document',async()=>{
      await page.click('#source-button');
      assert.equal(await page.$eval('#source-editor',node=>node.value),sample+'\nLiteral `&lt;keep&gt;` and `decisions/<topic>.md`.\n');
      await page.click('#rich-button');
      assert.equal(await page.evaluate(()=>window.herdrMarkdown.snapshot().draft),sample+'\nLiteral `&lt;keep&gt;` and `decisions/<topic>.md`.\n');
      assert.equal(await page.$eval('#save',node=>node.disabled),true);
    });
    await t.test('typing inside formatted body creates a save request with original baseline',async()=>{
      await page.click('.tiptap p');
      await page.keyboard.type(' Edited here.');
      assert.equal(await page.$eval('#save',node=>node.disabled),false);
      await page.click('#save');
      const saved=await page.evaluate(()=>window.testMessages.filter(m=>m.type==='save').at(-1));
      assert.ok(saved.source.includes('Edited here.'));
      assert.ok(saved.source.includes('concepts/<주제>.md'));
      assert.equal(saved.expected,sample+'\nLiteral `&lt;keep&gt;` and `decisions/<topic>.md`.\n');
      await page.evaluate(m=>window.herdrMarkdown.receive({type:'saved',id:m.id,file:m.file,source:m.source}),saved);
    });
    await t.test('Source edits appear as formatting in Rich',async()=>{
      await page.click('#source-button');
      await page.$eval('#source-editor',node=>{node.value+='\n## Added from source\n\n**Formatted text**\n';node.dispatchEvent(new Event('input'));});
      await page.click('#rich-button');
      assert.equal(await page.$eval('.tiptap h2',node=>node.textContent),'Added from source');
      assert.equal(await page.$eval('.tiptap strong',node=>node.textContent),'Formatted text');
    });
    await t.test('external changes keep unsaved input and report the conflict',async()=>{
      const before=await page.evaluate(()=>window.herdrMarkdown.snapshot().draft);
      await load('# External update');
      assert.equal(await page.evaluate(()=>window.herdrMarkdown.snapshot().draft),before);
      assert.match(await page.$eval('#notice',node=>node.textContent),/changed on disk/);
    });
    await t.test('explicit dark and light themes use Docpilot tokens and local fonts',async()=>{
      await page.click('#dark-button');await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.$eval('body',node=>getComputedStyle(node).backgroundColor),'rgb(24, 24, 24)');
      assert.match(await page.$eval('.tiptap',node=>getComputedStyle(node).fontFamily),/DM Sans Variable/);
      assert.match(await page.$eval('.tiptap code',node=>getComputedStyle(node).fontFamily),/JetBrains Mono/);
      assert.equal(await page.$eval('.tiptap',node=>getComputedStyle(node).cursor),'text');
      assert.equal(await page.$eval('#source-editor',node=>getComputedStyle(node).cursor),'text');
      const loaded=await page.evaluate(()=>Array.from(document.fonts).filter(font=>font.status==='loaded').map(font=>font.family));
      assert.ok(loaded.includes('DM Sans Variable'));assert.ok(loaded.includes('Noto Sans KR Variable'));assert.ok(loaded.includes('JetBrains Mono'));
      await page.click('#light-button');
      assert.equal(await page.$eval('body',node=>getComputedStyle(node).backgroundColor),'rgb(250, 250, 250)');
      const alpha=await page.$eval('body',node=>getComputedStyle(node).getPropertyValue('--selection').trim());
      assert.equal(alpha,'#2563eb33');
    });
    await t.test('controls and document remain within 320px viewport',async()=>{
      await page.setViewport({width:320,height:640});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.ok(await page.$eval('#save',node=>node.getBoundingClientRect().right<=innerWidth));
    });
    await t.test('text controls preserve font size changes and visible keyboard focus at narrow widths',async()=>{
      await page.click('#larger');
      assert.equal(await page.$eval('.tiptap',node=>getComputedStyle(node).fontSize),'18px');
      await page.click('#source-button');await page.keyboard.press('Tab');
      await page.$eval('#source-editor',node=>node.focus());
      assert.equal(await page.$eval('#source-editor',node=>getComputedStyle(node).outlineWidth),'2px');
      await page.click('#rich-button');
    });
    await t.test('an unrelated rich edit preserves frontmatter, raw HTML attributes, and comments',async()=>{
      const special='---\ntitle: Sample\nlayout: post\n---\n\n# A\n\nKeep <span data-example="yes">inline HTML</span> here.\n\n<!-- keep this comment -->\n\nEdit this paragraph.\n';
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/notes.md',source}),special);
      await page.evaluate(()=>{const e=window.herdrMarkdown.editor;e.commands.focus('end');e.commands.insertContent(' More.');});
      const saved=await page.evaluate(()=>window.herdrMarkdown.snapshot().draft);
      assert.ok(saved.startsWith('---\ntitle: Sample\nlayout: post\n---'),saved);
      assert.ok(saved.includes('<span data-example="yes">inline HTML</span>'),saved);
      assert.ok(saved.includes('<!-- keep this comment -->'),saved);
      assert.ok(saved.includes('More.'),saved);
    });
    await t.test('document link history restores the latest draft scroll position',async()=>{
      await page.setViewport({width:1000,height:700});
      const long='# Long document\n\n'+Array.from({length:100},(_,i)=>'Paragraph '+i+' has enough text to scroll.\n\n').join('');
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/notes.md',source}),long);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{const e=window.herdrMarkdown.editor;e.commands.focus('start');e.commands.insertContent('Edited. ');});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.$eval('#viewport',node=>{node.scrollTop=1000;});
      await new Promise(resolve=>setTimeout(resolve,220));
      assert.ok(await page.$eval('#viewport',node=>node.scrollTop)>=900,'fixture scrolled before navigation');
      await page.evaluate(()=>window.herdrMarkdown.receive({type:'document',file:'/example/other.md',source:'# Other'}));
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'document',file:'/example/notes.md',source}),long);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.ok(await page.$eval('#viewport',node=>node.scrollTop)>=900);
      assert.match(await page.evaluate(()=>window.herdrMarkdown.snapshot().draft),/Edited/);
    });
    await t.test('link Back restores a clean document selection without an edit or scroll',async()=>{
      await page.setViewport({width:1000,height:700});
      const source='# Back position\n\n[Other](other.md)\n\nA final paragraph.\n';
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/back.md',source}),source);
      await new Promise(resolve=>setTimeout(resolve,220));
      const linkStyle=()=>page.$eval('.tiptap a',node=>{
        const style=getComputedStyle(node);
        return {cursor:style.cursor,weight:style.fontWeight};
      });
      await page.hover('.tiptap a');
      assert.deepEqual(await linkStyle(),{cursor:'text',weight:'600'});
      await page.keyboard.down('Meta');
      assert.equal((await linkStyle()).cursor,'pointer');
      await page.keyboard.up('Meta');
      assert.equal((await linkStyle()).cursor,'text');
      await page.mouse.move(5,5);
      await page.keyboard.down('Meta');
      await page.hover('.tiptap a');
      assert.equal((await linkStyle()).cursor,'pointer');
      await page.click('.tiptap a');
      await page.keyboard.up('Meta');
      const selection=await page.evaluate(()=>window.herdrMarkdown.snapshot().richSelection);
      await page.evaluate(()=>window.herdrMarkdown.receive({type:'loading'}));
      await page.evaluate(()=>window.herdrMarkdown.receive({type:'document',file:'/example/other.md',source:'# Other'}));
      await new Promise(resolve=>setTimeout(resolve,220));
      await page.click('#back');
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'document',file:'/example/back.md',source}),source);
      await new Promise(resolve=>setTimeout(resolve,220));
      assert.deepEqual(await page.evaluate(()=>window.herdrMarkdown.snapshot().richSelection),selection);
      assert.equal(await page.$eval('#viewport',node=>node.scrollTop),0);
    });
    await t.test('Rich copy and paste preserve frontmatter and raw HTML as source fragments',async()=>{
      const special='---\ntitle: Clipboard\n---\n\n# Copy\n\nKeep <span data-test="yes">inline</span> here.\n\nControl: \u001c.\n\n<!-- comment -->\n';
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/clipboard.md',source}),special);
      const result=await page.evaluate(()=>{
        const e=window.herdrMarkdown.editor;e.commands.selectAll();
        const clip=e.view.serializeForClipboard(e.state.selection.content());
        const data=new DataTransfer();data.setData('text/html',clip.dom.innerHTML);data.setData('text/plain',clip.text);
        e.commands.focus('end');
        e.view.dom.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
        return {source:window.herdrMarkdown.snapshot().draft,text:clip.text};
      });
      assert.equal((result.source.match(/---\ntitle: Clipboard\n---/g)||[]).length,2,result.source);
      assert.equal((result.source.match(/<span data-test="yes">inline<\/span>/g)||[]).length,2,result.source);
      assert.ok(result.text.includes('title: Clipboard'),result.text);
      assert.ok(result.text.includes('<span data-test="yes">inline</span>'),result.text);
      assert.equal((result.source.match(/\u001c/g)||[]).length,2);
      assert.ok(result.text.includes('\u001c'));
    });
    await t.test('existing control characters are visible and preserved, while control key text is rejected',async()=>{
      await page.evaluate(()=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/control.md',source:'Normal \u001c text.\n'}));
      assert.equal(await page.$eval('[data-control-character]',node=>node.textContent),'[U+001C]');
      const result=await page.evaluate(()=>{
        const e=window.herdrMarkdown.editor,selection=e.state.selection;
        const handled=e.view.someProp('handleTextInput',fn=>fn(e.view,selection.from,selection.to,'\u001c',()=>e.state.tr));
        e.commands.focus('end');e.commands.insertContent(' Valid.');
        return {handled,draft:window.herdrMarkdown.snapshot().draft};
      });
      assert.equal(result.handled,true);
      assert.equal((result.draft.match(/\u001c/g)||[]).length,1,'existing source byte is preserved, invalid key did not add another');
      assert.ok(result.draft.includes('Valid.'));
    });
    await t.test('Cmd+C dispatches native copy for selected Rich text',async()=>{
      const selection=await page.evaluate(()=>{
          window.herdrMarkdown.receive({type:'reloaded',file:'/example/copy.md',source:'**복사할 텍스트** 뒤쪽'});
        const {view}=window.herdrMarkdown.editor;
        view.dom.focus();
        window.herdrMarkdown.editor.commands.setTextSelection({from:1,to:8});
        window.richCopy=[];
        const run=document.execCommand.bind(document);
        document.execCommand=(command,...args)=>{
          if(command==='copy')window.richCopy.push({selected:getSelection().toString()});
          return run(command,...args);
        };
        document.addEventListener('copy',event=>{
          window.richCopy.push({text:event.clipboardData.getData('text/plain'),html:event.clipboardData.getData('text/html')});
        });
        return getSelection().toString();
      });
      assert.equal(selection,'복사할 텍스트');
      await page.keyboard.down('Meta');
      await page.keyboard.press('c');
      await page.keyboard.up('Meta');
      const [request,data]=await page.evaluate(()=>window.richCopy);
      assert.equal(request?.selected,'복사할 텍스트');
      assert.equal(data?.text,'복사할 텍스트');
      assert.match(data?.html,/<strong>복사할 텍스트<\/strong>/);
    });
    await t.test('path shortcuts select, paste, and undo in the native host',async()=>{
      const path='/example/notes.md';
      await page.evaluate(path=>window.herdrMarkdown.receive({type:'reloaded',file:path,source:'# Path shortcuts'}),path);
      await page.$eval('#path',input=>{
        input.focus();
        input.setSelectionRange(1,1);
        // Match WKWebView behavior when no menu dispatches the editing action.
        input.addEventListener('keydown',event=>{if(event.metaKey)event.preventDefault();});
      });
      await page.keyboard.down('Meta');await page.keyboard.press('a');await page.keyboard.up('Meta');
      assert.deepEqual(await page.$eval('#path',input=>[input.selectionStart,input.selectionEnd]),[0,path.length]);
      await page.keyboard.down('Meta');await page.keyboard.press('v');await page.keyboard.up('Meta');
      const request=await page.evaluate(()=>window.testMessages.findLast(m=>m.type==='paste-path'));
      assert.ok(request);
      await page.evaluate(id=>window.herdrMarkdown.receive({type:'path-paste',id,text:'/example/한글.md'}),request.id);
      assert.equal(await page.$eval('#path',input=>input.value),'/example/한글.md');
      await page.keyboard.down('Meta');await page.keyboard.press('z');await page.keyboard.up('Meta');
      assert.equal(await page.$eval('#path',input=>input.value),path);
      await page.keyboard.down('Meta');await page.keyboard.down('Shift');await page.keyboard.press('z');
      await page.keyboard.up('Shift');await page.keyboard.up('Meta');
      assert.equal(await page.$eval('#path',input=>input.value),'/example/한글.md');

      await page.keyboard.down('Meta');await page.keyboard.press('v');await page.keyboard.up('Meta');
      const stale=await page.evaluate(()=>window.testMessages.findLast(m=>m.type==='paste-path'));
      await page.$eval('#path',input=>input.setSelectionRange(0,0));
      await page.evaluate(id=>window.herdrMarkdown.receive({type:'path-paste',id,text:'stale'}),stale.id);
      assert.equal(await page.$eval('#path',input=>input.value),'/example/한글.md');
    });
    await t.test('wide Mermaid diagrams keep long labels readable in a narrow pane',async()=>{
      const chart=[
        'flowchart LR',
        'subgraph Library["라이브러리 (Library.m)"]',
        'A["getVerificationTokenWithOptions"] -->|"NormalLoop 상태이고 session 갱신 필요"| B["restartSession"]',
        'end',
        'subgraph Module["모듈 (Module.m)"]',
        'C["restartDiagnose"] -->|"dispatch_after"| D[["backgroundSessionTask<br/>3.9.29부터 CONCURRENT"]]',
        'D --> E["diagnose"]',
        'E -->|"decodeFromStringBuffer"| F[("모듈 recursiveLock")]',
        'end',
        'B -->|"objc_msgSend"| C',
      ].join('\n');
      const source='```mermaid\n'+chart+'\n```\n';
      await page.setViewport({width:320,height:640});
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/diagram.md',source}),source);
      await page.waitForSelector('.mermaid-preview > svg',{timeout:5000});
      assert.equal(await page.$('.tiptap pre'),null);
      await page.click('#source-button');
      assert.equal(await page.$eval('#source-editor',textarea=>textarea.value),source);
      await page.click('#rich-button');
      await page.waitForSelector('.mermaid-preview[tabindex="0"]',{timeout:5000,visible:true});
      const geometry=async()=>page.$eval('.mermaid-preview > svg',svg=>({
        scale:svg.getBoundingClientRect().width/svg.viewBox.baseVal.width,
        labels:[...svg.querySelectorAll('g.label text, g.cluster-label text')].map(text=>{
          const box=text.getBoundingClientRect(),diagram=svg.getBoundingClientRect();
          return {text:text.textContent,fontSize:getComputedStyle(text).fontSize,
            insideSvg:box.width>0&&box.left>=diagram.left-1&&box.right<=diagram.right+1};
        }),
        scrollable:svg.parentElement.scrollWidth>svg.parentElement.clientWidth,
        keyboardReachable:svg.parentElement.tabIndex===0,
      }));
      const actual=await geometry();
      const borderStrokes=await page.$$eval('.mermaid-preview .node rect, .mermaid-preview .cluster rect',
        shapes=>shapes.map(shape=>getComputedStyle(shape).stroke).filter(stroke=>stroke!=='none'));
      assert.ok(borderStrokes.length>1&&borderStrokes.every(stroke=>stroke==='rgb(136, 136, 136)'),JSON.stringify(borderStrokes));
      assert.ok(actual.scale>=0.99,JSON.stringify(actual));
      assert.ok(actual.scrollable&&actual.keyboardReachable);
      assert.ok(actual.labels.length>=10,JSON.stringify(actual.labels));
      assert.ok(actual.labels.every(label=>label.insideSvg&&parseFloat(label.fontSize)>=16),JSON.stringify(actual.labels));
      assert.ok(actual.labels.some(label=>label.text.includes('getVerificationTokenWithOptions')));
      assert.ok(actual.labels.some(label=>label.text.includes('session 갱신 필요')));
      assert.ok(actual.labels.some(label=>label.text.includes('3.9.29부터 CONCURRENT')));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.$eval('.mermaid-preview',node=>{node.focus();node.scrollLeft=node.scrollWidth;});
      assert.ok(await page.$eval('.mermaid-preview',node=>node.scrollLeft>0));
      await page.click('.mermaid-fit');
      const fitted=await geometry();
      assert.ok(fitted.scale<1&&!fitted.scrollable&&!fitted.keyboardReachable);
      assert.equal(await page.$eval('.mermaid-fit',button=>button.textContent),'Actual size');
      await page.keyboard.press('Enter');
      assert.ok((await geometry()).scale>=0.99);

      const diagramId=await page.$eval('.mermaid-preview > svg',svg=>svg.id);
      await page.click('#larger');
      await page.waitForFunction(previous=>document.querySelector('.mermaid-preview > svg')?.id!==previous,{timeout:5000},diagramId);
      assert.ok((await geometry()).labels.every((label,i)=>parseFloat(label.fontSize)>parseFloat(actual.labels[i].fontSize)));
      assert.equal(await page.evaluate(()=>window.herdrMarkdown.snapshot().draft),source);
      await page.setViewport({width:900,height:640});
      await page.click('#dark-button');
      await page.evaluate(()=>window.herdrMarkdown.receive({
        type:'reloaded',file:'/example/compact-diagram.md',source:'```mermaid\nsequenceDiagram\nA->>B: 연결\n```\n',
      }));
      await page.waitForFunction(()=>document.querySelector('.mermaid-preview > svg')?.textContent.includes('연결'),{timeout:5000});
      assert.equal(await page.$eval('.mermaid-fit',button=>button.hidden),true);
    });
    await t.test('code blocks use GitHub highlighting, diff rows, and a Copy control',async()=>{
      const diff='@@ -1,2 +1,3 @@\n-    flavorDimensions "env", "region"\n+    flavorDimensions "client"\n+                    "fakefinder-${customer}_embedded-kr-${environment}${variant.buildType.name.capitalize()}-${defaultConfig.versionName}-with-a-very-long-suffix.aar"\n     unchanged line';
      const source='```kotlin\nval answer = 42 // note\n```\n\n```diff\n'+diff+'\n```\n\n```\nplain text\n```\n';
      await page.setViewport({width:480,height:640});
      await page.click('#light-button');
      await page.evaluate(source=>window.herdrMarkdown.receive({type:'reloaded',file:'/example/code.md',source}),source);
      const blocks=()=>page.$$eval('.code-block',nodes=>nodes.map(node=>({
        controls:[...node.querySelectorAll('.code-toolbar > *')].map(control=>control.textContent),
        keywords:[...node.querySelectorAll('code .hljs-keyword')].map(span=>span.textContent),
        spans:node.querySelectorAll('code [class^="hljs-"]').length,
      })));
      await page.waitForFunction(()=>document.querySelector('.code-block code .hljs-keyword'),{timeout:5000});
      const rendered=await blocks();
      assert.deepEqual(rendered.map(block=>block.controls),[['Copy'],['Copy'],['Copy']]);
      assert.deepEqual(rendered[0].keywords,['val']);
      assert.equal(rendered[2].spans,0);

      const rows=await page.$$eval('.code-block:nth-of-type(2) code .hljs-addition, .code-block:nth-of-type(2) code .hljs-deletion',spans=>spans.map(span=>{
        const pre=span.closest('pre'),box=span.getBoundingClientRect(),frame=pre.getBoundingClientRect();
        const lineHeight=parseFloat(getComputedStyle(pre).lineHeight)||parseFloat(getComputedStyle(pre).fontSize)*1.7;
        return {kind:span.className,background:getComputedStyle(span).backgroundColor,coversRow:box.left<=frame.left+20&&box.width>=pre.scrollWidth-40,
          singleLine:box.height<lineHeight*1.5};
      }));
      assert.equal(rows.length,3);
      assert.ok(rows.every(row=>row.coversRow&&row.singleLine),JSON.stringify(rows));
      assert.equal(rows.find(row=>row.kind.includes('addition')).background,'rgb(230, 255, 236)');
      assert.equal(rows.find(row=>row.kind.includes('deletion')).background,'rgb(255, 235, 233)');
      const hunk=await page.$eval('.code-block:nth-of-type(2) code .hljs-meta',span=>({background:getComputedStyle(span).backgroundColor,
        coversRow:span.getBoundingClientRect().width>=span.closest('pre').scrollWidth-40}));
      assert.deepEqual(hunk,{background:'rgb(221, 244, 255)',coversRow:true});
      const edges=await page.$eval('.code-block:nth-of-type(2)',block=>{
        const outer=block.getBoundingClientRect(),first=block.querySelector('code .hljs-meta').getBoundingClientRect();
        return {border:getComputedStyle(block).borderTopWidth,left:Math.round(first.left-outer.left),top:Math.round(first.top-outer.top),
          right:Math.round(outer.right-Math.min(first.right,outer.right))};
      });
      assert.deepEqual(edges,{border:'0px',left:0,top:0,right:0});

      const diffPre='.code-block:nth-of-type(2) pre';
      assert.ok(await page.$eval(diffPre,pre=>pre.scrollWidth>pre.clientWidth));

      await page.evaluate(()=>{window.testMessages.length=0;});
      await page.click('.code-block:nth-of-type(2) .code-copy');
      assert.deepEqual(await page.evaluate(()=>window.testMessages.filter(m=>m.type==='copy-code')),[{type:'copy-code',text:diff}]);
      assert.equal(await page.$eval('.code-block:nth-of-type(2) .code-copy',button=>button.textContent),'Copied');

      await page.click('#dark-button');
      assert.equal(await page.$eval('.code-block code .hljs-keyword',span=>getComputedStyle(span).color),'rgb(255, 123, 114)');
      await page.click('#source-button');
      assert.equal(await page.$eval('#source-editor',textarea=>textarea.value),source);
      await page.click('#rich-button');
      assert.equal(await page.evaluate(()=>window.herdrMarkdown.snapshot().draft),source);
      assert.equal(await page.$eval('#save',node=>node.disabled),true);
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
