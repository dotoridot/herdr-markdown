import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root=new URL('./',import.meta.url);
const vendor=new URL('vendor/',root);
await mkdir(vendor,{recursive:true});
const bundle=await readFile(new URL('node_modules/mermaid/dist/mermaid.min.js',root));
const version=JSON.parse(await readFile(new URL('node_modules/mermaid/package.json',root),'utf8')).version;
await writeFile(new URL('mermaid.min.js',vendor),bundle);
await copyFile(new URL('node_modules/mermaid/LICENSE',root),new URL('MERMAID-LICENSE',vendor));
await writeFile(new URL('manifest.json',vendor),JSON.stringify({version,sha256:createHash('sha256').update(bundle).digest('hex')})+'\n');
