import {build} from 'esbuild';
await build({entryPoints:['src/editor.js'],bundle:true,format:'iife',target:'safari16',outfile:'mods/rich-document/editor/editor.js',minify:true,legalComments:'linked'});
