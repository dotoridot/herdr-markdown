export function documentTheme(t, appearance='current') {
  if(appearance==='current')return t;
  if(appearance==='dark')return {
    background:'#181818',foreground:'#ebebeb',muted:'#a3a3a3',dim:'#a3a3a3',
    border:'#363636',surface:'#1e1e1e',raised:'#1e1e1e',chrome:'#121212',
    accent:'#ebebeb',hover:'#303030',selected:'#262626',selection:'#60a5fa40',
    ansi1:'#f87171',ansi2:'#a3a3a3',ansi3:'#ebebeb',ansi4:'#ebebeb',ansi5:'#a3a3a3',ansi6:'#ebebeb',
  };
  return {
    background:'#fafafa',foreground:'#171717',muted:'#666666',dim:'#666666',
    border:'#d9d9d9',surface:'#ededed',raised:'#f1f1f1',chrome:'#f5f5f5',
    accent:'#171717',hover:'#e5e5e5',selected:'#ededed',selection:'#2563eb33',
    ansi1:'#b91c1c',ansi2:'#666666',ansi3:'#171717',ansi4:'#171717',ansi5:'#666666',ansi6:'#171717',
  };
}

export function documentPalette(t, appearance='current') {
  t=documentTheme(t,appearance);
  return {
    paper:t.background, foreground:t.foreground, muted:t.muted, dim:t.dim,
    border:t.border, code:t.surface, quote:t.raised || t.surface,
    link:t.accent, header:t.chrome || t.surface, toolbar:t.chrome || t.surface,
    hover:t.hover, selected:t.selected, selection:t.selection || t.selected, error:t.ansi1,
    dark:appearance==='light'?false:luminance(t.background)<0.45,
  };
}

function luminance(color) {
  const hex=String(color).replace('#','');
  return [0,2,4].reduce((sum,index)=>sum+parseInt(hex.slice(index,index+2),16)/255,0)/3;
}

export function textColors(p) {
  return {foreground:p.foreground,muted_foreground:p.muted,link:p.link,selection:p.dark?'#60a5fa40':'#2563eb33',
    code_background:p.code,border:p.border,dark:p.dark};
}

export function codeOptions(block, configuration, colors, size) {
  const language={ts:'js',tsx:'js',jsx:'js',sh:'bash',shell:'bash',py:'python','c++':'cpp',cc:'cpp',md:'markdown'}[block.language] || block.language || 'text';
  return {
    value:block.text, language, readonly:true, folding:false, line_numbers:false,
    soft_wrap:false, font_family:configuration.font_family, font_size:size,
    colors:{foreground:colors.foreground,muted_foreground:colors.muted,background:colors.surface,
      border:colors.border,selection:colors.selection || colors.selected,caret:colors.foreground},
    syntax:{keyword:colors.ansi5,string:colors.ansi2,comment:colors.dim,function:colors.ansi4,type:colors.ansi3,number:colors.ansi1,constant:colors.ansi6},
  };
}
