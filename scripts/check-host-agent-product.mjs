// Deterministic local launcher/selection contract; no provider transport.
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from '../examples/host-agent-product/setup.mjs';
const output=resolve(process.argv[2]);await mkdir(output,{recursive:true});
const facts={command:[process.execPath,...process.argv.slice(1)],cases:[]};
for(const args of [[],['unknown'],['workspace','extra']]){
 const result=spawnSync(process.execPath,['tests/scenarios/host-agent-product.mjs',...args],{cwd:root,encoding:'utf8'});
 facts.cases.push({id:'reject-selection-'+JSON.stringify(args),pass:result.status!==0,exit:result.status});
 assert.notEqual(result.status,0);
}
let child,preview,url;
try{
 child=spawn(process.execPath,['examples/host-agent-product/launch.mjs','--workspace'],{cwd:root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
 facts.pid=child.pid;let stdout='',stderr='';child.stderr.on('data',b=>stderr+=b);
 await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Launcher startup timeout: '+stderr)),30000);child.once('exit',code=>{clearTimeout(timer);fail(Error('Launcher exited '+code+': '+stderr));});child.stdout.on('data',b=>{stdout+=b;const match=stdout.match(/(http:\/\/127\.0\.0\.1:\d+)[\s\S]*Evidence: (.+)/);if(match){url=match[1];preview=match[2].trim();clearTimeout(timer);done();}});});
 assert.equal(new URL(url).hostname,'127.0.0.1');
 const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/installed-workspace.mjs/);
 const module=await fetch(url+'/fixture/installed-workspace.mjs');assert.equal(module.status,200);
 facts.url=url;facts.preview=preview;facts.cases.push({id:'documented-workspace-launch',pass:true});
}catch(error){facts.failure=error.stack;process.exitCode=1;}
finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Launcher teardown timeout')),10000);child.once('exit',()=>{clearTimeout(timer);done();});});}
 if(preview){const receipt=JSON.parse(await readFile(resolve(preview,'preview.json')));facts.processes=receipt.processes;assert.equal(receipt.listenerStopped,true);assert.equal(receipt.owner.closed,true);facts.cases.push({id:'launcher-owner-listener-teardown',pass:true});}
 facts.counts={executed:facts.cases.length,passed:facts.cases.filter(c=>c.pass).length,failed:facts.failure?1:0,skipped:0};
 await writeFile(resolve(output,'launcher.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify({output,counts:facts.counts,failure:facts.failure}));
}
