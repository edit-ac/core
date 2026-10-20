import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile, rm, stat, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cpus, totalmem, platform, arch, loadavg } from 'node:os';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { chromium } from 'playwright';
import { corpus, sizes, summary } from './corpus.mjs';
import { describeAsset, compression } from '../../scripts/browser-size-contract.mjs';
import { requireTestNode } from '../../scripts/test-toolchain.mjs';
import { stopOwnedProcess } from '../../scripts/owned-processes.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here,'../..');
export function options(args, manifest) {
  const opts = { quick: false, fixtures: ['task','long'], profiles: manifest.profiles.map(p=>p.id), timeout: 180000, commandRoute: 'text' };
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if (arg === '--quick') opts.quick=true;
    else if (arg === '--skip-build') opts.skipBuild=true;
    else if (['--output','--source','--revision','--fixtures','--profiles','--runs','--warmups','--samples','--timeout','--command-route'].includes(arg)) {
      const value=args[++i]; if (!value || value.startsWith('--')) throw Error(`Missing value for ${arg}`);
      opts[arg === '--command-route' ? 'commandRoute' : arg.slice(2)] = ['--fixtures','--profiles'].includes(arg) ? value.split(',') : value;
    } else throw Error(`Unknown comparison option ${arg}`);
  }
  for (const [key, known] of [['fixtures',Object.keys(sizes)],['profiles',manifest.profiles.map(p=>p.id)]]) {
    if (!opts[key].length || new Set(opts[key]).size !== opts[key].length || opts[key].some(n=>!known.includes(n))) throw Error(`Expected unique known ${key}`);
  }
  const policy=manifest[opts.quick?'quick':'full'];
  for (const [key,fallback] of [['runs',policy.runs],['warmups',policy.warmups],['samples',policy.operationSamples],['timeout',180000]]) {
    opts[key]=Number(opts[key] ?? fallback);
    if (!Number.isSafeInteger(opts[key]) || opts[key] < (key==='warmups'?0:1) || opts[key] > (key==='timeout'?600000:1000)) throw Error(`Invalid ${key}`);
  }
  if (opts.skipBuild && !opts.source) throw Error('--skip-build requires an explicit frozen --source');
  if (opts.source && opts.revision) throw Error('--source and --revision are mutually exclusive');
  if (!['text','editor'].includes(opts.commandRoute)) throw Error('Expected text or editor command route');
  return opts;
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function command(cmd,args,cwd,log,env={},allowFailure=false) {
  const stream=createWriteStream(log);
  let child;
  const stop=()=>{ if(child)stopOwnedProcess(child); }; process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let code;
  try { code=await new Promise((done,reject)=>{
    child=spawn(cmd,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});child.once('error',reject);child.once('close',(exit,signal)=>done(exit??signal));
  }); } finally { process.off('SIGINT',stop);process.off('SIGTERM',stop);await new Promise(done=>stream.end(done)); }
  if (code!==0 && !allowFailure) throw Error(`${cmd} ${args.join(' ')} failed (${code}); see ${log}`);
  return code;
}
async function readJson(path) { return JSON.parse(await readFile(path,'utf8')); }
export function report(result) {
  const lines=['# Local editor comparison', '', `Status: **${result.status}**. Diagnostic desktop measurements, no release qualification.`, '',
    `Source: edit.ac \`${result.metadata.revision}\` (${result.metadata.sourcePolicy}). Node ${result.metadata.node}; Chromium ${result.metadata.browser??'not launched'}; ${result.metadata.cpu}.`,
    '', `Mode ${result.mode}; ${result.plan.warmups} discarded warmup runs + ${result.plan.runs} measured runs, ${result.plan.samples} insert/delete samples per position/run. Profiles rotate each run; serial pages; loopback HTTP, cache disabled for cold reload, 1280×900, no CPU/network throttling.`,
    '', `edit.ac text command route: **${result.plan.editacTextCommandRoute??'editor (historical benchmark)'}**. Route changes are separate experiments; historical editor-route samples do not measure the dedicated typing path.`,
    '', 'Commands use each public API through DOM/layout. These are not compositor-paint or native input measurements. Fixture preparation and verification are outside timing windows. Cold loads restore prepared IndexedDB data for durable profiles; minimal profiles parse the fixture anew. Warm activation reuses loaded modules/WASM and restores local data.',
    '', `Case counts (including warmups): ${JSON.stringify(result.counts??{})}. Failed cases preserve their evidence; subsequent repetitions of the same failed case are explicitly skipped. Neither failures nor skips qualify a baseline.`,
    '', '## Results', '', '| Profile | Fixture | Outcome | Cold editable p50 ms | Warm editable p50 ms | Insert middle p50 ms | Delete middle p50 ms | Local restore p50 ms | Adapter gzip KB |', '|---|---|---|---:|---:|---:|---:|---:|---:|'];
  const number=n=>n==null?'Not yet measured':n.toFixed(2);
  for (const profile of result.profiles) for (const fixture of result.fixtures) {
    const get=metric=>result.summary[`${profile.id}/${fixture.name}/${metric}`]?.p50;
    const bytes=result.bundles[profile.id]?.reduce((n,a)=>n+a.gzip,0);
    const failed=result.errors.some(e=>e.profile===profile.id&&e.fixture===fixture.name);
    const outcome=failed?'Failed; see evidence':get('insert.middle')==null?'Not yet measured':'Measured';
    lines.push(`| ${profile.id} (${profile.group}) | ${fixture.name} | ${outcome} | ${number(get('cold.accepted-edit'))} | ${number(get('warm.accepted-edit'))} | ${number(get('insert.middle'))} | ${number(get('delete.middle'))} | ${number(get('local.restore'))} | ${number(bytes==null?null:bytes/1000)} |`);
  }
  lines.push('', '## Interpretation and provenance', '',
    '- Durability-enabled profiles include CRDT and IndexedDB costs, but their guarantees and protocols differ. They are exploratory capability comparisons, not proof of complete feature equivalence.',
    '- Minimal profiles disable collaboration/persistence; the plain-contenteditable reference has no rich editor guarantees. Keep these separate from edit.ac Task.',
    '- Adapter transfer costs include their integration code, required split JS, WASM and shared essential CSS, exclude the measurement harness and document data. gzip level 9, fixed metadata; Brotli and asset hashes are in results.json. Optional feature costs not exercised here remain unmeasured.',
    '- p50/min/max and sample counts are diagnostic. p95 requires at least 100 samples and p99 at least 1000; fewer samples are Inconclusive. Operations from the same run are correlated.',
    `- Load averages: ${result.metadata.loadStart.join(', ')} at start; ${result.metadata.loadEnd?.join(', ')??'unavailable'} at end. Other active work may affect these early results. processes-before.txt/processes-after.txt retain the process inventory.`,
    '', '## Default Task size gate', '', result.sizeGate ? `Executable SDK size check exit: ${result.sizeGate.exit}. ${JSON.stringify(result.sizeGate.result??{error:result.sizeGate.error})}. See size-gate/manifest.json and size-gate.log. Adapter bytes above are a separate diagnostic inventory.` : 'Not yet measured.',
    '', '## Capability differences', '');
  for (const profile of result.profiles) lines.push(`- **${profile.id}**: ${profile.durability}; ${profile.collaboration}. ${profile.differences.join('; ')}.`);
  lines.push('', '## Not yet measured', '', ...result.notYetMeasured.map(x=>`- ${x}`), '', '## Failures', '', ...result.errors.map(x=>`- ${x.profile??'setup'}/${x.fixture??''}: ${x.message}`));
  if (!result.errors.length) lines.push('None. All reported cases asserted exact editor and rendered text; durable profiles restored a newly persisted sentinel edit.');
  lines.push('', '## Reproduce', '', '```sh', result.metadata.command, '```', '', 'Raw samples (including discarded warmups): raw.json and raw.jsonl. Exact fixtures, manifest, package lock, built adapters, esbuild metafiles, frozen edit.ac sources and logs are retained in this directory. No paid inference or remote services were used.', '');
  return lines.join('\n');
}
async function main() {
  await requireTestNode();
  const manifest=await readJson(join(here,'../manifest.json')), opts=options(process.argv.slice(2),manifest);
  const output=resolve(root,opts.output??`benchmark-results/comparison-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`);
  await mkdir(output,{recursive:true});
  // Never reuse sample files: failed evidence must survive reruns.
  for(const name of ['raw.jsonl','results.json']) {
    try { await stat(join(output,name)); throw Error(`Results already exist: ${output}. Choose a new --output.`); } catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const source=opts.source?resolve(root,opts.source):join(output,'source');
  const git=(...args)=>{ const r=spawnSync('git',args,{cwd:opts.source?source:root,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim(); };
  const revision=opts.source?await readFile(join(source,'.comparison-revision'),'utf8'):git('rev-parse',`${opts.revision??'HEAD'}^{commit}`);
  const result={version:1,mode:opts.quick?'quick':'full',status:'running',metadata:{revision:revision.trim(),sourcePolicy:'frozen committed source; no working-tree edits',
    timestamp:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,cores:cpus().length,totalMemoryBytes:totalmem(),platform:platform(),arch:arch(),loadStart:loadavg(),esbuild:esbuildVersion,zlib:process.versions.zlib,
    buildPolicy:opts.skipBuild?'Explicit prebuilt snapshot; see original build logs':'Fresh release build of verified Git archive',
    command:`npm --prefix benchmarks/comparison run bench -- ${process.argv.slice(2).map(x=>/^[\w/.,:-]+$/.test(x)?x:JSON.stringify(x)).join(' ')}`},
    plan:{warmups:opts.warmups,runs:opts.runs,samples:opts.samples,order:'rotating serial profiles',timeoutMs:opts.timeout,editacTextCommandRoute:opts.commandRoute},profiles:manifest.profiles.filter(p=>opts.profiles.includes(p.id)),
    fixtures:opts.fixtures.map(corpus),notYetMeasured:manifest.notYetMeasured,bundles:{},raw:[],summary:{},errors:[],cleanup:{},compression};
  let browser,server;
  const failedCases=new Map();
  const interrupted=()=>{ result.interrupted=true;void browser?.close().catch(()=>{}); };process.on('SIGINT',interrupted);process.on('SIGTERM',interrupted);
  const save=async()=>{ await writeFile(join(output,'results.json'),JSON.stringify({...result,raw:undefined},null,2)+'\n');await writeFile(join(output,'raw.json'),JSON.stringify(result.raw,null,2)+'\n');await writeFile(join(output,'summary.md'),report(result)); };
  try {
    await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await copyFile(join(here,'package-lock.json'),join(output,'comparison-package-lock.json'));
    await writeFile(join(output,'processes-before.txt'),spawnSync('ps',['-axo','pid,ppid,%cpu,rss,comm'],{encoding:'utf8'}).stdout);
    if (!opts.source) {
      await mkdir(source);
      await command('git',['archive','--format=tar',`--output=${join(output,'source.tar')}`,revision.trim()],root,join(output,'archive.log'));
      await command('tar',['-xf',join(output,'source.tar'),'-C',source],root,join(output,'extract.log'));
      await rm(join(output,'source.tar'));
      await writeFile(join(source,'.comparison-revision'),revision.trim()+'\n');
    }
    // Verify the archived inputs against Git, including explicit --source runs.
    // Generated dist/target files are separately hashed below, never mistaken
    // for committed source. Do not permit a working-tree copy to masquerade as
    // the named revision.
    const tree=spawnSync('git',['ls-tree','-rz','--full-tree',revision.trim()],{cwd:root,encoding:'utf8'});
    if(tree.status!==0)throw Error('Cannot verify frozen source revision');
    const sourceHashes={};
    for(const entry of tree.stdout.split('\0').filter(Boolean)) {
      const [header,path]=entry.split('\t'),[mode,type,oid]=header.split(' ');
      if(type!=='blob'||mode==='120000')throw Error(`Unsupported frozen source entry: ${path}`);
      const bytes=await readFile(join(source,path));
      const blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if(blob!==oid)throw Error(`Frozen source differs from ${revision.trim()}: ${path}`);
      sourceHashes[path]=hash(bytes);
    }
    await writeFile(join(output,'source-hashes.json'),JSON.stringify(sourceHashes,null,2)+'\n');
    result.metadata.sourceHash=hash(Buffer.from(JSON.stringify(sourceHashes)));
    if (!opts.skipBuild) {
      console.log('Installing and building frozen edit.ac source; logs stay in the output directory.');
      await command('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],source,join(output,'install.log'));
      await command('npm',['run','build:wasm'],source,join(output,'build-wasm.log'));
      await command('npm',['run','build'],source,join(output,'build-js.log'));
    }
    const wasmPath=join(source,'packages/core/dist/wasm/editac_wasm_bg.wasm');
    result.metadata.wasmHash=hash(await readFile(wasmPath));
    result.metadata.dependencyVersions=(await readJson(join(here,'package.json'))).dependencies;
    result.metadata.comparisonLockHash=hash(await readFile(join(here,'package-lock.json')));
    result.metadata.sourceLockHash=hash(await readFile(join(source,'package-lock.json')));
    for(const [name,version] of Object.entries(result.metadata.dependencyVersions)) {
      if((await readJson(join(here,'node_modules',name,'package.json'))).version!==version)throw Error(`Installed ${name} does not match pin ${version}; run npm ci`);
    }
    const gateDirectory=join(output,'size-gate');
    const gateExit=await command(process.execPath,['scripts/check-browser-size.mjs'],source,join(output,'size-gate.log'),{EDITAC_BROWSER_SIZE_OUTPUT:gateDirectory},true);
    try { const receipt=await readJson(join(gateDirectory,'manifest.json'));result.sizeGate={exit:gateExit,result:receipt.result,profile:receipt.profile}; }
    catch(error) { result.sizeGate={exit:gateExit,error:error.message}; }
    await mkdir(join(output,'fixtures'));
    for(const fixture of result.fixtures) await writeFile(join(output,'fixtures',`${fixture.name}.json`),JSON.stringify(fixture)+'\n');
    const assetRoot=join(output,'assets'); await mkdir(assetRoot);
    const css='body{font-family:system-ui;margin:24px}#editor{width:800px;white-space:pre-wrap;overflow-wrap:anywhere;outline:none}p,h2,pre,.code{margin:0 0 8px}pre,.code{font-family:monospace;white-space:pre-wrap}.bold{font-weight:bold}.italic{font-style:italic}';
    result.metadata.harnessHashes={};await mkdir(join(output,'harness'));
    for (const name of (await readdir(here)).filter(n=>n.endsWith('.mjs'))) { const bytes=await readFile(join(here,name));result.metadata.harnessHashes[name]=hash(bytes);await writeFile(join(output,'harness',name),bytes); }
    for (const profile of result.profiles) {
      const directory=join(assetRoot,profile.id);await mkdir(directory);
      const bundled=await build({entryPoints:[join(here,`${profile.id}.mjs`)],outdir:directory,entryNames:'adapter',bundle:true,minify:true,splitting:true,format:'esm',platform:'browser',target:'es2022',metafile:true,
        alias:{'@edit-ac/core':join(source,'packages/core/dist/index.js'),'@edit-ac/web':join(source,'packages/web/dist/index.js')},logLevel:'silent'});
      await writeFile(join(directory,'essential.css'),css);
      const files=Object.keys(bundled.metafile.outputs).map(path=>resolve(path));
      if(profile.id==='editac-task') { await mkdir(join(directory,'wasm'));await copyFile(wasmPath,join(directory,'wasm/editac_wasm_bg.wasm'));files.push(join(directory,'wasm/editac_wasm_bg.wasm')); }
      files.push(join(directory,'essential.css'));
      result.bundles[profile.id]=await Promise.all(files.map(async path=>describeAsset(relative(directory,path),path.endsWith('.wasm')?'wasm':path.endsWith('.css')?'css':'js',await readFile(path))));
      await writeFile(join(directory,'metafile.json'),JSON.stringify(bundled.metafile,null,2)+'\n');
    }
    await build({entryPoints:[join(here,'browser.mjs')],outfile:join(output,'browser.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
    server=createServer(async(req,res)=>{
      try {
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/') {
          const profile=result.profiles.find(p=>p.id===url.searchParams.get('profile')),fixture=result.fixtures.find(f=>f.name===url.searchParams.get('fixture'));
          if(!profile||!fixture)throw Error('Unknown page');
          const bootstrap=JSON.stringify({profile:profile.id,fixture,durable:profile.group==='durable',textCommandRoute:opts.commandRoute,databaseName:`comparison-${profile.id}-${fixture.name}`}).replaceAll('<','\\u003c');
          res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/${profile.id}/essential.css"><div id="editor" contenteditable="true" spellcheck="false"></div><script>Object.assign(window,${bootstrap})</script><script type="module" src="/browser.js"></script>`);return;
        }
        const file=resolve(output,`.${decodeURIComponent(url.pathname)}`);
        if(!file.startsWith(output+sep)||(!url.pathname.startsWith('/assets/')&&url.pathname!=='/browser.js'))throw Error('Invalid asset');
        const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':'text/javascript');res.setHeader('Cache-Control','no-store');res.end(bytes);
      } catch(error) {res.statusCode=404;res.end(error.message);}
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    result.metadata.server={pid:process.pid,port:server.address().port,workspace:root,purpose:'comparison fixture HTTP',launcher:process.execPath};
    browser=await chromium.launch({headless:true});result.metadata.browser=browser.version();
    result.metadata.playwright=(await readJson(join(here,'node_modules/playwright/package.json'))).version;
    for(let run=-opts.warmups;run<opts.runs;run++) {
      const rotation=(run+opts.warmups)%result.profiles.length;
      const profiles=[...result.profiles.slice(rotation),...result.profiles.slice(0,rotation)];
      for(const fixture of result.fixtures) for(const profile of profiles) {
        if(result.interrupted)throw Error('Benchmark interrupted');
        const caseKey=`${profile.id}/${fixture.name}`;
        if(failedCases.has(caseKey)) {
          const sample={profile:profile.id,fixture:fixture.name,run,measured:run>=0,status:'skipped',reason:`Earlier case failed: ${failedCases.get(caseKey)}`};
          result.raw.push(sample);await appendFile(join(output,'raw.jsonl'),JSON.stringify(sample)+'\n');
          console.log(`${run<0?'warmup':'run '+(run+1)} ${caseKey}: skipped after preserved failure`);continue;
        }
        const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        const sample={profile:profile.id,fixture:fixture.name,run,measured:run>=0,status:'running',stage:'bootstrap'};
        let timer;
        try {
          const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
          const task=(async()=>{
            await page.goto(`http://127.0.0.1:${server.address().port}/?profile=${profile.id}&fixture=${fixture.name}`);await page.waitForFunction(()=>window.comparison);
            sample.stage='prepare fixture';
            await page.evaluate(()=>window.comparison.prepare());
            sample.stage='cold page reload';
            await page.reload();await page.waitForFunction(()=>window.comparison);
            sample.stage='measure and assert';
            const measured=await page.evaluate(samples=>window.comparison.run(samples),opts.samples);
            if(errors.length)throw Error(errors.join('; '));return measured;
          })();
          Object.assign(sample,await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Case exceeded ${opts.timeout}ms during ${sample.stage}`)),opts.timeout);})]),{status:'passed',stage:'complete'});
        } catch(error) {sample.status='failed';sample.error=error.message;failedCases.set(caseKey,error.message);result.errors.push({profile:profile.id,fixture:fixture.name,run,message:error.message});}
        finally {clearTimeout(timer);await context.close();}
        result.raw.push(sample);await appendFile(join(output,'raw.jsonl'),JSON.stringify(sample)+'\n');
        console.log(`${run<0?'warmup':'run '+(run+1)} ${profile.id}/${fixture.name}: ${sample.status}${sample.error?' — '+sample.error:''}`);
      }
    }
    result.status=result.errors.length?'failed':'measured';
    if(result.errors.length)process.exitCode=1;
  } catch(error) {result.errors.push({message:error.message});result.status='failed';process.exitCode=1;console.error(error.message);}
  finally {
    try {await browser?.close();result.cleanup.browserClosed=true;} catch(error){result.cleanup.browserError=error.message;process.exitCode=1;}
    if(server){server.closeAllConnections();await new Promise(done=>server.close(done));result.cleanup.serverClosed=true;}
    process.off('SIGINT',interrupted);process.off('SIGTERM',interrupted);
    for(const sample of result.raw.filter(s=>s.measured&&s.status==='passed'))for(const [metric,values] of Object.entries(sample.metrics)) {
      const key=`${sample.profile}/${sample.fixture}/${metric}`;(result.summary[key]??=[]).push(...values);
    }
    result.summary=Object.fromEntries(Object.entries(result.summary).map(([key,values])=>[key,summary(values)]));
    result.counts={planned:(opts.runs+opts.warmups)*result.profiles.length*result.fixtures.length,executed:result.raw.filter(s=>s.status!=='skipped').length,
      passed:result.raw.filter(s=>s.status==='passed').length,failed:result.raw.filter(s=>s.status==='failed').length,skipped:result.raw.filter(s=>s.status==='skipped').length};
    result.metadata.loadEnd=loadavg();await writeFile(join(output,'processes-after.txt'),spawnSync('ps',['-axo','pid,ppid,%cpu,rss,comm'],{encoding:'utf8'}).stdout);
    await save();console.log(`Report: ${join(output,'summary.md')}`);
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
