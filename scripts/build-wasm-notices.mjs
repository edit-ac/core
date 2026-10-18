import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Offline, locked dependency closure; no network or credentials in builds.
const result=spawnSync('cargo',['metadata','--locked','--offline','--filter-platform','wasm32-unknown-unknown','--format-version','1'],{encoding:'utf8',maxBuffer:16*1024*1024});
if(result.error||result.status!==0)throw result.error??Error(result.stderr);
const metadata=JSON.parse(result.stdout);
const markdown = process.argv.includes('--markdown');
// Workspace metadata unifies features from unrelated native consumers. Ask
// Cargo for the selected artifact's normal/build closure before choosing notices.
const selected = markdown ? 'editac-markdown-wasm' : 'editac-wasm';
const tree=spawnSync('cargo',['tree','--locked','--offline','-p',selected,'--target','wasm32-unknown-unknown','--edges','normal,build','--prefix','none','--format','{p}'],{encoding:'utf8',maxBuffer:16*1024*1024});
if(tree.error||tree.status!==0)throw tree.error??Error(tree.stderr);
const ids=new Set();
for(const line of tree.stdout.trim().split('\n')){
 const match=line.match(/^(\S+) v(\S+)(?: |$)/);
 if(!match)throw Error(`Unrecognized Cargo package: ${line}`);
 const packages=metadata.packages.filter(p=>p.name===match[1]&&p.version===match[2]);
 if(packages.length!==1)throw Error(`Ambiguous Cargo package: ${line}`);
 ids.add(packages[0].id);
}
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
await writeFile(new URL(markdown ? '../packages/markdown/THIRD-PARTY-NOTICES.txt' : '../packages/core/THIRD-PARTY-NOTICES.txt',import.meta.url),notices.join('').trimEnd()+'\n');
console.log(`WASM notices: ${ids.size} locked packages`);
