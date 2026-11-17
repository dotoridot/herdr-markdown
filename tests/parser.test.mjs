import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown} from '../mods/rich-document/parser.js';

test('inline code preserves literal angle brackets in paths and table cells',()=>{
  const source='`sessions/<세션 ID>.md`\n\n| Path |\n| --- |\n| `concepts/<주제>.md` |';
  const blocks=parseMarkdown(source);
  assert.equal(blocks[0].text,'`sessions/<세션 ID>.md`');
  assert.equal(blocks[1].rows[0][0],'`concepts/<주제>.md`');
});
test('literal entities inside code are not decoded',()=>{
  assert.equal(parseMarkdown('`&lt;literal&gt;`')[0].text,'`&lt;literal&gt;`');
});
test('raw HTML outside code stays escaped',()=>{
  assert.equal(parseMarkdown('<script>alert(1)</script>')[0].text,'&lt;script&gt;alert(1)&lt;/script&gt;');
});
