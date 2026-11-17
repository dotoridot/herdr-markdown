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
    await page.evaluateOnNewDocument(()=>{window.testMessages=[];window.ipc={postMessage:value=>window.testMessages.push(JSON.parse(value))};});
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
    await t.test('Rich copy and paste preserve frontmatter and raw HTML as source fragments',async()=>{
      const special='---\ntitle: Clipboard\n---\n\n# Copy\n\nKeep <span data-test="yes">inline</span> here.\n\n<!-- comment -->\n';
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
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
