import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT ?? '.artifacts/formats/consumers');

const commands=[];
function run(p,args,cwd){const r=spawnSync(p,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});const n=commands.length;writeFileSync(resolve(output,`prepare-${n}.log`),(r.stdout??'')+(r.stderr??''));commands.push({program:p,args,cwd,exit:r.status,signal:r.signal});writeFileSync(resolve(output,'prepare-commands.json'),JSON.stringify(commands,null,2)+'\n');if(r.error||r.status!==0)throw r.error??Error(`prepare ${n}: ${r.status}`);return r.stdout;}
run('python3',['tests/formats/consumers/docx-import-fixtures.py',resolve(output,'docx-import-fixtures')],process.cwd());
const archives=[];
for(const name of ['core','formats','web']){
 const raw=run('npm',['pack','--ignore-scripts','--json','--pack-destination',output],resolve('packages',name));
 const [packed]=JSON.parse(raw);const path=resolve(output,packed.filename);
 archives.push({name,path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),bytes:readFileSync(path).length,unpackedSize:packed.unpackedSize,files:packed.files});
}
const consumer=resolve(output,'packed-consumer-'+createHash('sha256').update(JSON.stringify(archives.map(a=>[a.name,a.sha256]))).digest('hex').slice(0,16));mkdirSync(consumer,{recursive:true});
writeFileSync(resolve(consumer,'package.json'),JSON.stringify({name:'local-format-consumer',private:true,type:'module',dependencies:Object.fromEntries(archives.map(a=>[`@edit-ac/${a.name}`,`file:${a.path}`]))},null,2)+'\n');
run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock-only=false'],consumer);
const disabled=resolve(output,'disabled-consumer-'+archives.find(a=>a.name==='core').sha256.slice(0,16));mkdirSync(disabled,{recursive:true});
writeFileSync(resolve(disabled,'package.json'),JSON.stringify({name:'disabled-local-format-consumer',private:true,type:'module',dependencies:{'@edit-ac/core':`file:${archives.find(a=>a.name==='core').path}`}},null,2)+'\n');
run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund'],disabled);
writeFileSync(resolve(output,'packed-artifacts.json'),JSON.stringify({consumer,disabled,archives},null,2)+'\n');
console.log(JSON.stringify({consumer,archives:archives.map(({files,...a})=>a)}));
