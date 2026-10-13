import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Offline, locked dependency closure; no network or credentials in builds.
const result=spawnSync('cargo',['metadata','--locked','--offline','--filter-platform','wasm32-unknown-unknown','--format-version','1'],{encoding:'utf8',maxBuffer:16*1024*1024});
if(result.error||result.status!==0)throw result.error??Error(result.stderr);
const metadata=JSON.parse(result.stdout);
const nodes=new Map(metadata.resolve.nodes.map(n=>[n.id,n]));
const ids=new Set(),todo=[metadata.packages.find(p=>p.name==='editac-wasm').id];
while(todo.length){const id=todo.pop();if(ids.has(id))continue;ids.add(id);todo.push(...nodes.get(id).dependencies);}
const notices=['Third-party notices for the locked edit.ac WASM build. Includes its build dependencies.\n'];
for(const pkg of metadata.packages.sort((a,b)=>a.name.localeCompare(b.name))){
 if(!ids.has(pkg.id)||!pkg.source)continue;
 const directory=dirname(pkg.manifest_path);
 const files=(await readdir(directory,{withFileTypes:true})).filter(f=>f.isFile()&&/^(LICENSE|COPYING|NOTICE)/i.test(f.name)).map(f=>f.name).sort();
 notices.push(`\n${pkg.name} ${pkg.version} — ${pkg.license}\n${pkg.repository??''}\n`);
 if(!files.length){
  // crates.io yrs omits the repository-root MIT license. This vendored copy is
  // from its .cargo_vcs_info.json revision 23b7f5693bbf9e7d26340c521ee8647f79bdfba2.
  if(pkg.name!=='yrs'||pkg.version!=='0.28.0')throw Error(`Missing distributed license text: ${pkg.name} ${pkg.version}`);
  notices.push(await readFile(new URL('./licenses/yrs-0.28.0.LICENSE',import.meta.url),'utf8'));
 }
 for(const file of files)notices.push(file+'\n'+await readFile(join(directory,file),'utf8')+'\n');
}
await writeFile(new URL('../packages/core/THIRD-PARTY-NOTICES.txt',import.meta.url),notices.join(''));
console.log(`WASM notices: ${ids.size} locked packages`);
