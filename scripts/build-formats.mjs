import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(root,'packages/formats/dist');mkdirSync(resolve(out,'runtime'),{recursive:true});
function run(p,args,quiet=false){const r=spawnSync(p,args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,RUSTFLAGS:'-C link-arg=--max-memory=67108864'}});if(!quiet)process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error||r.status!==0)throw r.error??Error(`${p}: ${r.status}`);return r.stdout;}
if(run('wasm-bindgen',['--version']).trim()!=='wasm-bindgen 0.2.129')throw Error('Wrong bindgen version');
run('cargo',['build','--manifest-path','crates/editac-formats-wasm/Cargo.toml','--target','wasm32-unknown-unknown','--release','--locked','--offline']);
const target=process.env.CARGO_TARGET_DIR?resolve(root,process.env.CARGO_TARGET_DIR):resolve(root,'crates/editac-formats-wasm/target');
run('wasm-bindgen',[resolve(target,'wasm32-unknown-unknown/release/editac_formats_wasm.wasm'),'--target','web','--out-dir',resolve(out,'runtime'),'--out-name','editac_formats_wasm']);
for(const name of ['index.js','index.d.ts','worker.js'])copyFileSync(resolve(root,'packages/formats/src',name),resolve(out,name));
// Record exact normal dependency versions/licenses from locked Cargo metadata.
const md=JSON.parse(run('cargo',['metadata','--manifest-path','crates/editac-formats-wasm/Cargo.toml','--locked','--offline','--filter-platform','wasm32-unknown-unknown','--format-version=1'],true));
const notices=md.packages.map(p=>({name:p.name,version:p.version,license:p.license,source:p.source,manifest:p.manifest_path})).sort((a,b)=>a.name.localeCompare(b.name));
const licenseText=['Third-party notices for optional format worker, locked offline dependency closure.\n'];
for(const p of md.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name))){
 const directory=dirname(p.manifest_path);
 const names=readdirSync(directory).filter(n=>/^(LICENSE|COPYING|NOTICE)/i.test(n)&&statSync(resolve(directory,n)).isFile()).sort();
 licenseText.push(`\n${p.name} ${p.version}: ${p.license}\n${p.repository??''}\n`);
 if(!names.length){
  if(p.name==='yrs'&&p.version==='0.28.0')licenseText.push(readFileSync(resolve(root,'scripts/licenses/yrs-0.28.0.LICENSE'),'utf8'));
  else if(p.name==='docx-rs'&&p.version==='0.4.22'){
   const provenance=JSON.parse(readFileSync(resolve(root,'scripts/licenses/docx-rs-0.4.22.source.json'),'utf8'));
   const license=readFileSync(resolve(root,'scripts/licenses/docx-rs-0.4.22.LICENSE'));
   if(createHash('sha256').update(license).digest('hex')!==provenance.sha256)throw Error('DOCX license provenance mismatch');
   licenseText.push(provenance.source+'\n'+license.toString('utf8'));
  } else if(p.name==='krilla'&&p.version==='0.8.2'){
   const provenance=JSON.parse(readFileSync(resolve(root,'scripts/licenses/krilla-0.8.2.source.json')));
   for(const [name,record] of Object.entries(provenance.files)){
    const bytes=readFileSync(resolve(root,'scripts/licenses',name));
    if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Krilla notice provenance mismatch');
    licenseText.push(record.source+'\n'+bytes.toString('utf8'));
   }
  } else throw Error(`Missing license: ${p.name}`);
 }
 for(const n of names)licenseText.push(n+'\n'+readFileSync(resolve(directory,n),'utf8')+'\n');
}
// Bundled publication faces are reviewed immutable optional assets.
const fontFiles={};
for(const file of ['provenance.json','rich-provenance.json']){
 const manifest=JSON.parse(readFileSync(resolve(root,'fixtures/formats/fonts',file)));
 for(const [name,record] of Object.entries(manifest.files)){
  const data=readFileSync(resolve(root,'fixtures/formats/fonts',name));
  if(createHash('sha256').update(data).digest('hex')!==record.sha256)throw Error(`Font provenance mismatch: ${name}`);
  if(/\.ttf$/.test(name))fontFiles[name]={bytes:data.length,sha256:record.sha256};
 }
}
licenseText.push('\nBundled Noto publication fonts (six exact faces; SIL Open Font License 1.1)\n'+readFileSync(resolve(root,'fixtures/formats/fonts/OFL.txt'),'utf8'));
writeFileSync(resolve(root,'packages/formats/THIRD-PARTY-NOTICES.txt'),licenseText.join(''));
const assets={};for(const name of readdirSync(resolve(out,'runtime'))){const p=resolve(out,'runtime',name);if(statSync(p).isFile())assets[name]={bytes:statSync(p).size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')};}
const sourcePins={};
function pinTree(directory){for(const name of readdirSync(resolve(root,directory))){const path=directory+'/'+name;if(name==='target')continue;const info=statSync(resolve(root,path));if(info.isDirectory())pinTree(path);else if(/\.rs$|Cargo\.(toml|lock)$/.test(name))sourcePins[path]=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');}}
for(const crate of ['editac-formats-wasm','editac-formats','editac-core','editac-session','editac-diff','editac-markdown'])pinTree('crates/'+crate);
for(const path of ['scripts/build-formats.mjs','scripts/licenses/docx-rs-0.4.22.LICENSE','scripts/licenses/docx-rs-0.4.22.source.json','packages/formats/src/index.js','packages/formats/src/worker.js','packages/formats/src/index.d.ts','packages/formats/capabilities.json'])sourcePins[path]=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
for(const name of ['krilla-0.8.2.source.json',...Object.keys(JSON.parse(readFileSync(resolve(root,'scripts/licenses/krilla-0.8.2.source.json'))).files)]){const path='scripts/licenses/'+name;sourcePins[path]=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');}
for(const name of [...Object.keys(fontFiles),'OFL.txt','provenance.json','rich-provenance.json']){const path='fixtures/formats/fonts/'+name;sourcePins[path]=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');}
writeFileSync(resolve(out,'build-receipt.json'),JSON.stringify({schemaVersion:1,bundledFonts:fontFiles,sourcePins,toolchain:'1.97.1',bindgen:'0.2.129',maximumLinearMemoryBytes:67108864,assets,dependencies:notices.map(({manifest,...p})=>p)},null,2)+'\n');
console.log(JSON.stringify({assets,dependencies:notices.length}));
