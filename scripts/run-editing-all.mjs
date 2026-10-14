import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync, cpSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runtimeGroups } from './editing-suites.mjs';
import { loadSuite } from '../tests/editing/fixture-loader.ts';
import { hash, json, walk, sourcePins, tapCounts, verifyCoverage, reusableStage } from './editing-coverage.mjs';
export async function runAll() {
  assert.equal(process.version,'v24.19.0');
  assert.ok(process.env.EDITAC_EDITING_ALL_OUTPUT,'EDITAC_EDITING_ALL_OUTPUT must be a new evidence directory');
  const root=resolve('.'), directory=resolve(process.env.EDITAC_EDITING_ALL_OUTPUT);
  mkdirSync(directory); // refuse to overwrite earlier success or failure
  const receipt={schemaVersion:1,profile:'infrastructure',deployed:false,node:process.version,started:new Date().toISOString(),
    coreRevision:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
    architectureRevision:spawnSync('git',['-C','../architecture','rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
    sourcePins:sourcePins(root),fixturePins:loadSuite().hashes,stages:[],artifactPins:{},browserVersions:{},playwright:json('node_modules/playwright/package.json').version};
  const save=()=>writeFileSync(join(directory,'execution.json'),JSON.stringify(receipt,null,2)+'\n'); save();
  async function command(name,args,env={},executable=process.execPath) {
    const path=join(directory,`${name}.log`), fd=openSync(path,'wx'); let result;
    try { result=await runOwned(executable,args,{stdio:['ignore',fd,fd],env:{...process.env,...env}},name==='baseline'?600_000:300_000); } finally { closeSync(fd); }
    const bytes=readFileSync(path); const stage={name,command:[executable,...args],pid:result.pid,exit:result.status ?? 1,error:result.error,termination:result.termination,log:relative(directory,path),logSha256:hash(bytes),reports:[]};
    console.log(`${name}: exit ${stage.exit}; evidence ${path}`);return stage;
  }
  for (const script of ['build:wasm','build']) {
    const stage=await command(script.replace(':','-'),['run',script],{},'npm'); receipt.builds??=[];receipt.builds.push(stage);save(); if(stage.exit) return stage.exit;
  }
  for(const p of walk('packages').filter(p=>p.includes('/dist/')&&!p.endsWith('.map')))receipt.artifactPins[p]=hash(readFileSync(p));
  const packages={};receipt.packageBuilds=[];
  for(const name of ['core','web','markdown']) {
    const stage=await command(`pack-${name}`,['pack','--offline','--ignore-scripts','--workspace',`@edit-ac/${name}`,'--json','--pack-destination',directory],{},'npm');
    receipt.packageBuilds.push(stage);save();if(stage.exit)return stage.exit;
    const manifest=JSON.parse(readFileSync(join(directory,stage.log),'utf8'))[0],path=join(directory,manifest.filename);
    packages[name]={path,sha256:hash(readFileSync(path)),manifest};
  }
  receipt.packBuild=receipt.packageBuilds[0];const pack=packages.core.path;
  receipt.pack={path:relative(directory,pack),sha256:packages.core.sha256};
  const cachePath=join(directory,'packages.json');writeFileSync(cachePath,JSON.stringify(packages,null,2)+'\n');
  receipt.sharedPackages={path:relative(directory,cachePath),sha256:hash(readFileSync(cachePath))};
  let origin,originDirectory;
  if(process.env.EDITAC_EDITING_REUSE_OUTPUT) {originDirectory=resolve(process.env.EDITAC_EDITING_REUSE_OUTPUT);const path=join(originDirectory,'execution.json');origin=json(path);receipt.reuse={path,sha256:hash(readFileSync(path)),reason:'Unchanged owning stage dependencies and built artifacts; example page and coverage orchestration only. Baseline executes after example changes; integrity always executes.'};}
  const stages=[...runtimeGroups,'history-selection','baseline','integrity'];
  for(const name of stages){
    const old=origin?.stages.find(s=>s.name===name);
    if(old?.exit===0&&reusableStage(name,origin,receipt)) {
      cpSync(join(originDirectory,name),join(directory,name),{recursive:true});copyFileSync(join(originDirectory,old.log),join(directory,old.log));
      receipt.stages.push({...old,reused:true});
      for(const report of old.reports){const r=json(join(directory,report.path));if(r.browser)receipt.browserVersions[r.engine??r.browser.engine]=r.browser.version;}
      save();console.log(`${name}: retained passing raw evidence with unchanged dependency proof`);continue;
    }
    const output=join(directory,name);mkdirSync(output);
    const env={NODE_TEST_REPORTER:'tap',EDITAC_EDITING_OUTPUT:output,EDITAC_EDITING_PACK_TARBALL:pack,EDITAC_EDITING_PACKS:cachePath,
      EDITAC_EDITING_INPUT_OUTPUT:output,EDITAC_EDITING_LIFETIME_OUTPUT:output,EDITAC_EDITING_PRESENTERS_OUTPUT:output,
      EDITAC_HISTORY_SELECTION_OUTPUT:output,EDITAC_BASELINE_OUTPUT:output};
    const args=name==='integrity'?['--test','--test-reporter=tap','tests/editing/coverage.test.mjs']:
      ['--test-reporter=tap',...(runtimeGroups.includes(name)?['scripts/test-editing.mjs','--group',name]:['scripts/test-browser.mjs',name])];
    const stage=await command(name,args,env);receipt.stages.push(stage);
    try{stage.counts=tapCounts(readFileSync(join(directory,stage.log),'utf8'));}catch(e){stage.summaryError=e.message;}
    stage.reports=walk(output).filter(p=>p.endsWith('.json')).map(p=>({path:relative(directory,p),sha256:hash(readFileSync(p))}));
    for(const p of stage.reports){const r=json(join(directory,p.path));if(r.browser)receipt.browserVersions[r.engine??r.browser.engine]=r.browser.version;}
    save(); if(stage.exit!==0)return stage.exit;
  }
  assert.deepEqual(sourcePins(root),receipt.sourcePins,'sources changed during qualification');
  receipt.finished=new Date().toISOString();save();
  const report=verifyCoverage(receipt,{root,directory});writeFileSync(join(directory,'coverage.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`infrastructure: ${report.recipes.length} recipes, ${report.regressions.length} REG cases, ${report.guards.length} guards; releaseQualified=false`);
  return 0;
}

// Capture ancestry while the stage root is alive. Recheck each exact command
// before signaling; unrelated browsers and shared development servers are absent.
function processTree(pid) {
  const result=spawnSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'});
  if(result.status!==0)throw Error('Cannot establish owned stage process tree');
  const rows=result.stdout.trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return {pid:Number(m[1]),parent:Number(m[2]),command:m[3]};});
  const owned=[];const visit=id=>{for(const row of rows.filter(r=>r.parent===id)){owned.push(row);visit(row.pid);}};visit(pid);
  return owned;
}
async function runOwned(executable,args,options,timeout) {
  const child=spawn(executable,args,options); let error,termination,cleanup=Promise.resolve();
  const signal=async reason=>{
    if(termination)return;termination={reason,processes:processTree(child.pid)};
    const stop=row=>{const current=spawnSync('ps',['-p',String(row.pid),'-o','command='],{encoding:'utf8'});if(current.status===0&&current.stdout.trim()===row.command){try{process.kill(row.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}};
    // Closing the owned browser makes pending actions reject and lets after hooks
    // dispose consumers/listeners before stopping any remaining launcher.
    for(const row of termination.processes.filter(r=>/chrome-headless-shell|Firefox|firefox|MiniBrowser/.test(r.command)&&!r.command.includes('--type=')))stop(row);
    await new Promise(resolve=>setTimeout(resolve,2000));
    for(const row of [...termination.processes].reverse())stop(row);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  };
  const terminate=reason=>{cleanup=signal(reason).catch(e=>{error=e.message;child.kill('SIGTERM');});};
  const timer=setTimeout(()=>terminate('stage timeout'),timeout);
  const interrupt=()=>terminate('runner interrupted');process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  child.once('error',e=>{error=e.message;});
  const status=await new Promise(resolve=>child.once('close',resolve));
  clearTimeout(timer);await cleanup;process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);
  return {pid:child.pid,status:termination?1:status,error,termination};
}
