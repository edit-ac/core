import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFixtureServer } from '../../browser/fixture-server.mjs';
import { hostOwner } from './host.mjs';
import { fixture, prepareConsumer, hash } from './artifacts.mjs';

if (process.argv.slice(2).some(a => a !== '--check')) throw Error('Use preview.mjs [--check]');
const check = process.argv.includes('--check');
const output = resolve(process.env.EDITAC_PRIMARY_FLOW_OUTPUT ?? 'tests/integrated-browser/primary-flow-20261018/.preview-evidence');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(resolve('.'), '.tmp-primary-flow-'));
let server, proxy, owner, browser, closing;
const facts = { packs: [], cleanup: {}, profile: 'on-demand local fixture preview' };
const run = async (command, args, log) => {
  const result = spawnSync(command,args,{encoding:'utf8',timeout:120000});
  await writeFile(join(output,log),`${result.stdout??''}\n${result.stderr??''}`);
  if(result.status!==0)throw Error(`${log}: ${result.status} ${result.error??''}`);return result.stdout;
};
async function close() {
  if(closing)return closing;
  closing=(async()=>{
    try { await browser?.close();facts.cleanup.browserClosed=true; }
    finally { try { if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}facts.cleanup.proxyClosed=true; }
      finally { try { await server?.close(); facts.cleanup.serverClosed=true; }
        finally { try { facts.hostExit=await owner?.close(); }
          finally { await rm(directory,{recursive:true,force:true});facts.cleanup.temporaryConsumerRemoved=true;await writeFile(join(output,'preview-receipt.json'),JSON.stringify(facts,null,2)); } } } }
  })();return closing;
}
try {
  for(const name of ['core','web']) {
    const dest=join(directory,name);await mkdir(dest);
    const pack=JSON.parse(await run('npm',['pack','--workspace',`@edit-ac/${name}`,'--json','--pack-destination',dest],`pack-${name}.log`))[0];
    const bytes=await readFile(join(dest,pack.filename));facts.packs.push({name,file:pack.filename,bytes:bytes.length,sha256:hash(bytes)});
    await run('tar',['-xzf',join(dest,pack.filename),'-C',dest],`extract-${name}.log`);
  }
  await prepareConsumer(directory,{facts,run});
  const prepared=join(directory,'fixture');await mkdir(prepared);
  await writeFile(join(prepared,'session.mjs'),await readFile(join(fixture,'session.mjs')));
  const bridge=`<script>window.hostRpc=async input=>(await fetch('/host-rpc',{method:'POST',body:JSON.stringify(input)})).json();window.hostFrame=async(bytes,writerId)=>(await fetch('/host-frame',{method:'POST',body:JSON.stringify({bytes,writerId})})).json();</script>`;
  let html=await readFile(join(fixture,'index.html'),'utf8');
  html=html.replace('<script type="module" src="/fixture/session.mjs"></script>',bridge+`<script type="module">import '/fixture/session.mjs';const f=window.productFlow;await f.mount();document.documentElement.dataset.ready='true';const status=document.querySelector('#status');let queue=Promise.resolve();const enqueue=action=>queue=queue.then(action).catch(e=>{status.textContent=e.message;});document.querySelector('#agent').onclick=()=>enqueue(async()=>{const r=await f.agentEdit('Agent ',crypto.randomUUID());status.textContent=r.first.data?.outcome??'Check receipt';});document.querySelector('#reopen').onclick=()=>enqueue(async()=>{await f.reopen();status.textContent='Reopened durable documents';});setInterval(()=>enqueue(()=>f.pull()),1000);</script>`);
  await writeFile(join(prepared,'index.html'),html);
  owner=await hostOwner(join(output,'host'));facts.host=owner.facts;
  server=await startFixtureServer({fixtureDirectory:prepared,coreDirectory:join(directory,'core/package/dist'),webDirectory:join(directory,'web/package/dist')});
  proxy=createServer(async(req,res)=>{
    try {
      if(req.method==='POST'&&['/host-rpc','/host-frame'].includes(req.url)) {
        let body='';for await(const chunk of req){body+=chunk;if(body.length>24*1024*1024)throw Error('Request limit');}
        const input=JSON.parse(body),result=req.url==='/host-rpc'?await owner.rpc(input):await owner.frame(input.bytes,input.writerId);
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));return;
      }
      const upstream=await fetch(server.url+req.url);res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));
    }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));}
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${proxy.address().port}`;
  facts.servers={pid:process.pid,workspace:process.cwd(),purpose:'PIN-1.3 packed preview',ports:[server.port,proxy.address().port],log:output};console.log(JSON.stringify({url,...facts.servers}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().then(()=>process.exit(0),()=>process.exit(1)));
  if(check) {
    const {chromium}=await import('playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);await page.waitForSelector('html[data-ready=true]');await page.getByRole('button',{name:'Apply prepared host-agent edit',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='committed');
    await page.getByRole('button',{name:'Flush and reopen',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Reopened durable documents');
    const rows=await page.evaluate(()=>window.productFlow.snapshot());if(errors.length||rows[0].texts[0]!=='Agent base'||rows[1].texts[0]!=='Agent base'||rows[2].texts[0]!=='Local note')throw Error('Preview agent/reopen check: '+JSON.stringify({errors,rows}));
    await page.evaluate(()=>window.productFlow.close());facts.counts={executed:1,passed:1,failed:0,skipped:0};await close();console.log(JSON.stringify({counts:facts.counts,cleanup:facts.cleanup}));
  }
}catch(error){facts.failure={message:error.message,stack:error.stack};await close();throw error;}
