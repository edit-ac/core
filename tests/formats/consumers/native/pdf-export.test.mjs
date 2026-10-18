import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function run(program,args,name,cwd=process.cwd()){
 const start=performance.now();const r=spawnSync(program,args,{cwd,env:process.env,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
 writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(resolve(output,name+'-command.json'),JSON.stringify({program,args,cwd,exit:r.status,signal:r.signal,hostEndToEndMs:performance.now()-start},null,2)+'\n');
 assert.ifError(r.error);assert.equal(r.status,0,`see ${name}.log`);return r.stdout;
}
for(const name of ['text','rich','structure','reader','captured','frozen-input','loss','assets','invalid','limits','cancel','completion','authority']){
 test(`actual isolated native PDF semantic export: ${name}`,()=>{
  const raw=run('python3',['tests/formats/consumers/native/pdf-export-case.py',name],'pdf-export-'+name);
  assert.equal(JSON.parse(raw).passed,true);
 });
}

test('native PDF build enables only the admitted optional publication stack',()=>{
 const graph=run('cargo',['tree','--manifest-path','crates/editac-formats-native/Cargo.toml','--locked','--offline','--features','pdf-export','-e','normal'],'pdf-enabled-graph');
 assert.match(graph,/krilla v0\.8\.2/);assert.match(graph,/rustybuzz/);assert.match(graph,/png v0\.18\.1/);
 assert.ok(!/docx-rs/.test(graph));
 assert.ok(!/docx-rs|zip v|quick-xml|reqwest/.test(graph));
});


test('disabled native executable omits every complete optional font asset',()=>{
 const p=JSON.parse(readFileSync(resolve(output,'prepared.json')));const base=readFileSync(p.binaries.native.path);const pdf=readFileSync(p.binaries['pdf-native'].path);
 for(const name of ['NotoSans-Regular.ttf','NotoNaskhArabic-Regular.ttf','NotoSans-Bold.ttf','NotoSans-Italic.ttf','NotoSans-BoldItalic.ttf','NotoSansMono-Regular.ttf']){
  const font=readFileSync(resolve('fixtures/formats/fonts',name));assert.equal(base.includes(font),false,name);assert.equal(pdf.includes(font),true,name);
 }
});
