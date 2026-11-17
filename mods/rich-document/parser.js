const fence = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
const heading = line => line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
const listStart = line => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
const horizontal = line => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const escapeTags = text => {
  const escape = value => value.replace(/<(https?:\/\/[^>]+)>/g, '[$1]($1)').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let result='',cursor=0;
  for(const match of text.matchAll(/(`+)[\s\S]*?\1/g)){
    result+=escape(text.slice(cursor,match.index))+match[0];
    cursor=match.index+match[0].length;
  }
  return result+escape(text.slice(cursor));
};

export function splitCells(line) {
  const value = line.trim(), cells = [];
  let text = '', ticks = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && value[i + 1] === '|') { text += '|'; i++; continue; }
    if (c === '`') {
      let end = i; while (value[end] === '`') end++;
      const count = end - i; ticks = ticks === count ? 0 : ticks === 0 ? count : ticks;
      text += value.slice(i, end); i = end - 1; continue;
    }
    if (c === '|' && !ticks) { cells.push(text.trim()); text = ''; }
    else text += c;
  }
  cells.push(text.trim());
  if (value.startsWith('|')) cells.shift();
  if (value.endsWith('|') && !value.endsWith('\\|')) cells.pop();
  return cells;
}

function tableRule(line) {
  if (!line || !line.includes('|')) return null;
  const cells = splitCells(line);
  return cells.length && cells.every(c => /^:?-{3,}:?$/.test(c)) ? cells : null;
}

export function parseMarkdown(source) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [], definitions = [];
  let inFence = null;
  for (const line of lines) {
    const f = fence(line);
    if (f) { if (!inFence) inFence = f[1]; else if (f[1][0] === inFence[0] && f[1].length >= inFence.length && !f[2].trim()) inFence = null; }
    if (!inFence && /^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) definitions.push(line);
  }
  const refs = definitions.length ? '\n\n' + definitions.map(escapeTags).join('\n') : '';
  const inline = s => escapeTags(s.replace(/<br\s*\/?\s*>/gi, '  \n')) + refs;
  const starts = i => heading(lines[i]) || fence(lines[i]) || horizontal(lines[i]) || /^ {0,3}>/.test(lines[i]) || listStart(lines[i]) || tableRule(lines[i + 1]);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim() || /^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) { i++; continue; }
    const f = fence(line);
    if (f) {
      const body = []; i++;
      while (i < lines.length) {
        const close = fence(lines[i]);
        if (close && close[1][0] === f[1][0] && close[1].length >= f[1].length && !close[2].trim()) { i++; break; }
        body.push(lines[i++]);
      }
      blocks.push({type:'code', text:body.join('\n'), language:f[2].trim().split(/\s+/)[0] || ''}); continue;
    }
    const h = heading(line);
    if (h) { blocks.push({type:'heading', level:h[1].length, text:inline(h[2])}); i++; continue; }
    if (lines[i + 1] && /^ {0,3}(?:={3,}|-{3,})\s*$/.test(lines[i + 1]) && !horizontal(line)) {
      blocks.push({type:'heading', level:lines[i + 1].trim()[0] === '=' ? 1 : 2, text:inline(line)}); i += 2; continue;
    }
    if (horizontal(line)) { blocks.push({type:'hr'}); i++; continue; }
    const rule = tableRule(lines[i + 1]);
    if (rule && splitCells(line).length === rule.length) {
      const header = splitCells(line).map(inline), rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !starts(i)) {
        const cells = splitCells(lines[i++]);
        rows.push(header.map((_, n) => inline(cells[n] || '')));
      }
      blocks.push({type:'table', header, rows, align:rule.map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')}); continue;
    }
    const pic = line.trim().match(/^!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)$/);
    if (pic) { blocks.push({type:'image',alt:pic[1],href:pic[2].replace(/^<|>$/g,'')}); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const text = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) text.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      blocks.push({type:'quote',text:inline(text.join('\n'))}); continue;
    }
    if (listStart(line)) {
      const text = [lines[i++]];
      while (i < lines.length && lines[i].trim() && (listStart(lines[i]) || /^\s{2,}\S/.test(lines[i]))) text.push(lines[i++]);
      blocks.push({type:'list',text:inline(text.join('\n'))}); continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      const body = [];
      while (i < lines.length && /^(?: {4}|\t)/.test(lines[i])) body.push(lines[i++].replace(/^(?: {4}|\t)/,''));
      blocks.push({type:'code',text:body.join('\n'),language:''}); continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !starts(i) && !/^ {0,3}\[[^\]]+\]:/.test(lines[i])) paragraph.push(lines[i++]);
    blocks.push({type:'paragraph',text:inline(paragraph.join('\n'))});
  }
  return blocks;
}

export function resolveDocumentLink(file, href) {
  const link = String(href).trim();
  if (/^https?:\/\//i.test(link)) return {url:link};
  if (link.startsWith('//')) return {url:'https:'+link};
  if (link.startsWith('#')) return {anchor:link.slice(1)};
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('file:///')) throw new Error('This link format is not supported.');
  let value;
  try { value = decodeURIComponent(link.replace(/^file:\/\//,'').replace(/[?#].*$/,'')); }
  catch { throw new Error('Check the file path encoding.'); }
  const path = value.startsWith('/') ? value : file.slice(0,file.lastIndexOf('/')+1)+value;
  const parts = [];
  for (const part of path.split('/')) if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
  return {file:'/'+parts.join('/')};
}

export function relativeDocumentPath(file, root) {
  const parts=value=>String(value).split('/').filter(Boolean);
  const target=parts(file),base=parts(root);
  let index=0;while(index<target.length&&index<base.length&&target[index]===base[index])index++;
  return [...base.slice(index).map(()=>'..'),...target.slice(index)].join('/') || '.';
}

export function isDocumentChange(paths,file) {
  const normalized=value=>value.replace(/^\/private\/(?=(tmp|var)\/)/,'/').replace(/\/$/,'');
  const target=normalized(file),root=target.slice(0,target.lastIndexOf('/')) || '/';
  return paths.some(path=>normalized(path)===target || (normalized(path)||'/')===root);
}
