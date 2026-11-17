import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "gpui-base";
import {textColors} from './appearance.js';

const HEADINGS = [1.85, 1.4, 1.15, 1, 0.92, 0.88];
const MONO = "SFMono-Regular";

function escapeText(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function safeMarkdown(value) {
  // The document is data: raw HTML stays visible instead of becoming rich nodes.
  const source = String(value ?? ""), inlineCode = /(`+)[\s\S]*?\1/g;
  const escapeTags = text => text.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>]*?)?\s*\/?>|<![^<>]*>|<\?[^<>]*\?>/g, escapeText);
  let result = "", cursor = 0;
  for (const match of source.matchAll(inlineCode)) {
    result += escapeTags(source.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return result + escapeTags(source.slice(cursor));
}

function headingText(text) {
  return String(text ?? "").replace(/^(\s*)(\d+)([.)])(?=\s)/, "$1$2\\$3")
    .replace(/^(\s*)([#>*+-])(?=\s)/, "$1\\$2");
}

function displayWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) {
    if (char === "\t") width += 4;
    else if (/[\u0300-\u036f\u200d\ufe00-\ufe0f]/u.test(char)) continue;
    else width += char.codePointAt(0) >= 0x1100 ? 2 : 1;
  }
  return width;
}

function rich(id, text, o, size = o.fontSize) {
  return TextView.markdown(id, safeMarkdown(text))
    .selectable(true).scrollable(false).w_full().min_w(0).max_w_full().flex_none()
    .font_family(o.font).text_size(size).line_height(1.65).text_color(o.palette.foreground).text_colors(textColors(o.palette))
    .on_link_click((url, cx) => { if (o.onLink) o.onLink(url, cx); });
}

function breakLongText(text) {
  return text.replace(/[\w./:@%+?=&~-]{18,}/g, word => {
    const parts = [];
    for (let index = 0; index < word.length; index += 12) parts.push(word.slice(index, index + 12));
    return parts.join("\u200b");
  });
}

function cellDisplayMarkdown(value) {
  const source = String(value ?? ""), tokens = /(`+)([\s\S]*?)\1|(!?\[([^\]\n]*)\]\((?:\\.|[^\\)\n])*\))|<https?:\/\/[^>\n]+>|https?:\/\/[^\s<]+/g;
  let result = "", cursor = 0;
  for (const match of source.matchAll(tokens)) {
    result += breakLongText(source.slice(cursor, match.index));
    if (match[1]) result += match[1] + breakLongText(match[2]) + match[1];
    else if (match[3]) result += match[3].replace(match[4], breakLongText(match[4]));
    else if (match[0].startsWith("<")) {
      const url = match[0].slice(1, -1);
      result += `[${breakLongText(url)}](<${url}>)`;
    } else result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + breakLongText(source.slice(cursor));
}

function copyButton(id, label, value, o) {
  return div().id(id).h(24).px(7).flex_none().flex().items_center().rounded(4)
    .font_family(o.font).text_size(11).text_color(o.palette.muted).cursor_default()
    .role("button").accessibility_label(label).tooltip(label)
    .hover(style => style.bg(o.palette.header).text_color(o.palette.foreground))
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_click((_event, cx) => { cx.stop_propagation(); cx.write_to_clipboard(value); })
    .child(label);
}

function tableWidths(block, width, fontSize) {
  const count = (block.rows || []).reduce((count, row) => Math.max(count, row.length), Math.max(block.header?.length || 0, 1));
  const minimum = Math.max(90, Math.round(fontSize * 6.5));
  const total = Math.max(width, count * minimum);
  const sample = [block.header || [], ...(block.rows || []).slice(0, 16)];
  const weights = Array.from({ length: count }, (_, index) => {
    const lengths = sample.map(row => Math.min(100, displayWidth(row[index])));
    const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    return Math.max(1, Math.min(2.8, Math.sqrt(Math.max(1, mean) / 12)));
  });
  const sum = weights.reduce((sum, weight) => sum + weight, 0);
  const spare = total - count * minimum;
  return weights.map(weight => minimum + spare * weight / sum);
}

function renderTable(block, id, o) {
  const widths = tableWidths(block, o.width, o.fontSize), count = widths.length;
  const header = block.header || [], rows = block.rows || [];
  const size = o.fontSize * 0.95;
  const cell = (value, row, column, isHeader) => {
    const cellId = `${id}-${row}-${column}`;
    const original = String(value ?? ""), display = cellDisplayMarkdown(original);
    const innerWidth = Math.max(1, widths[column] - 29);
    let frame = (isHeader ? TableHead.new(cellId, column + 1) : TableCell.new(cellId, column + 1))
      .w(widths[column]).max_w(widths[column]).min_w(0).flex_none().px(14).py(8)
      .text_color(o.palette.foreground).font_family(o.font).text_size(size);
    if (column < count - 1) frame = frame.border_r_1().border_color(o.palette.border);
    if (isHeader) frame = frame.bg(o.palette.header).font_semibold();
    const alignment = block.align?.[column];
    if (alignment === "center") frame = frame.text_center();
    else if (alignment === "right") frame = frame.text_right();
    return frame.child(v_flex().w(innerWidth).max_w(innerWidth).min_w(0).gap(4)
      .child(rich(`${cellId}-text`, display || "\u00a0", o, size)
        .w(innerWidth).max_w(innerWidth).whitespace_normal())
      .when(display !== original, node => node.child(h_flex().justify_end()
        .child(copyButton(`${cellId}-copy`, "Copy cell source", original, o)))));
  };
  const row = (values, rowIndex, isHeader, last) => {
    let frame = TableRow.new(`${id}-row-${rowIndex}`, rowIndex + 1).flex().flex_row().items_stretch().flex_none();
    if (!last) frame = frame.border_b_1().border_color(o.palette.border);
    return frame.children(widths.map((_, column) => cell(values[column], rowIndex, column, isHeader)));
  };
  return div().id(`${id}-scroll`).w_full().h_auto().min_w(0).flex_none().my(o.fontSize * 0.75).overflow_x_scrollbar()
    .child(Table.new(id).flex().flex_col().flex_none().w(widths.reduce((sum, width) => sum + width, 0))
      .border_1().border_color(o.palette.border).bg(o.palette.paper)
      .row_count(rows.length + 1).column_count(count).accessibility_label("Document table")
      .child(TableHeader.new(`${id}-head`).flex().flex_col().flex_none().child(row(header, 0, true, rows.length === 0)))
      .child(TableBody.new(`${id}-body`).flex().flex_col().flex_none()
        .children(rows.map((values, index) => row(values, index + 1, false, index === rows.length - 1)))));
}

function renderCode(block, id, o) {
  const text = String(block.text ?? "");
  return v_flex().id(id).w_full().min_w(0).flex_none().my(o.fontSize * 0.75)
    .rounded(8).border_1().border_color(o.palette.border).bg(o.palette.code).p(12).gap(8)
    .child(h_flex().w_full().items_center()
      .child(div().flex_1().text_size(11).text_color(o.palette.muted).child(block.language || 'text'))
      .child(copyButton(`${id}-copy`, "Copy code", text, o)))
    .child(o.onCode ? o.onCode(block,{id,width:o.width-24}) : div().p(12).text_color(o.palette.muted).child('Code unavailable. Inspect it in Source.'));
}

function renderMermaid(block,id,o) {
  const diagram=o.onDiagram?.(block,{id,width:o.width-24});
  const expanded=o.isDiagramExpanded?.(id) || false;
  return v_flex().id(id).w_full().min_w(0).flex_none().my(o.fontSize*0.75).gap(8)
    .child(h_flex().items_center().gap(8)
      .child(div().flex_1().text_size(12).text_color(o.palette.muted).child('Mermaid'))
      .child(div().id(`${id}-source`).h(28).px(9).flex().items_center().rounded(4)
        .role('button').accessibility_label(expanded?'Hide Mermaid source':'Show Mermaid source')
        .text_size(12).text_color(o.palette.link).cursor_default().hover(s=>s.bg(o.palette.hover))
        .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
        .on_click((_e,cx)=>{cx.stop_propagation();o.onToggleDiagram?.(id,cx);})
        .child(expanded?'Hide source':'Show source'))
      .child(copyButton(`${id}-copy`,'Copy code',block.text,o)))
    .child(diagram || div().p(16).bg(o.palette.quote).text_size(13).text_color(o.palette.muted).child('Preparing diagram…'))
    .when(expanded,node=>node.child(renderCode(block,`${id}-raw`,o)));
}

function renderImage(block, id, o) {
  const rendered = o.onImage?.(block, { id, width: o.width });
  if (rendered) return div().id(id).w_full().min_w(0).flex_none().my(o.fontSize * 0.75).child(rendered);
  return v_flex().id(id).w_full().min_w(0).flex_none().my(o.fontSize * 0.75).p(14).gap(6)
    .border_1().border_color(o.palette.border).rounded(6).bg(o.palette.quote)
    .child(TextView.html(`${id}-label`, escapeText(block.alt ? `Image: ${block.alt}` : "Image preview unavailable"))
      .selectable(true).scrollable(false).text_size(o.fontSize).font_family(o.font).text_color(o.palette.muted).text_colors({...textColors(o.palette),foreground:o.palette.muted}))
    .child(div().w_full().min_w(0).overflow_x_scrollbar()
      .child(TextView.html(`${id}-path`, escapeText(block.href)).selectable(true).scrollable(false)
        .font_family(MONO).text_size(o.fontSize * 0.85).text_color(o.palette.muted).text_colors({...textColors(o.palette),foreground:o.palette.muted})));
}

/** Read-only native rendering; onImage(block, { id, width }) may supply a ready image element. */
export function renderBlocks(blocks, options) {
  const o = {
    ...options,
    idPrefix: options.idPrefix || "rich-document",
    font: options.font || "Pretendard",
    fontSize: Number.isFinite(options.fontSize) ? Math.max(10, options.fontSize) : 14,
    width: Number.isFinite(options.width) ? Math.max(120, options.width) : 900,
  };
  return blocks.map((block, index) => {
    const id = `${o.idPrefix}-${index}`;
    if (block.type === "table") return renderTable(block, id, o);
    if (block.type === "code") return block.language.toLowerCase()==='mermaid'?renderMermaid(block,id,o):renderCode(block, id, o);
    if (block.type === "image") return renderImage(block, id, o);
    if (block.type === "hr") return div().id(id).w_full().h(1).flex_none()
      .my(o.fontSize * 1.5).bg(o.palette.border);
    if (block.type === "heading") {
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      const size = o.fontSize * HEADINGS[level - 1];
      // Keep heading text inline so the host's dark-theme heading scale does not replace ours.
      return div().id(id).w_full().min_w(0).flex_none().mt(index ? size * 1.15 : 0).mb(size * 0.5)
        .font_weight(level === 1 ? 700 : 600)
        .child(rich(`${id}-text`, headingText(block.text), o, size).line_height(1.3)
          .text_color(level >= 5 ? o.palette.muted : o.palette.foreground));
    }
    if (block.type === "quote") return div().id(id).w_full().min_w(0).flex_none()
      .my(o.fontSize * 0.75).border_l(3).border_color(o.palette.border).pl(16).pr(12).py(6).bg(o.palette.quote)
      .child(rich(`${id}-text`, block.text, o).text_color(o.palette.muted));
    return div().id(id).w_full().min_w(0).flex_none().my(o.fontSize * 0.375)
      .child(rich(`${id}-text`, block.text, o));
  });
}
