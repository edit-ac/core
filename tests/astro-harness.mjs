import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export async function startAstroConsumer(mode) {
  if (mode === 'static') {
    const root=resolve('examples/astro/dist-static');
    const server=createServer(async(req,res)=>{
      try {
        let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if (!path.includes('.')) path=path.replace(/\/$/,'')+'/index.html';
        const target=resolve(root,'.'+path);
        if(!target.startsWith(root+sep)) throw Error('outside root');
        const body=await readFile(target);
        res.writeHead(200,{'Content-Type':path.endsWith('.wasm')?'application/wasm':path.endsWith('.html')?'text/html':'text/javascript'}).end(body);
      } catch {res.writeHead(404).end();}
    });
    await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
    return {url:`http://127.0.0.1:${server.address().port}`,pid:process.pid,port:server.address().port,
      close:async()=>{server.closeAllConnections();await new Promise(yes=>server.close(yes));}};
  }
  // Reserve a local port; the standalone adapter owns the actual listener.
  const reserve=createServer(); await new Promise(yes=>reserve.listen(0,'127.0.0.1',yes));
  const port=reserve.address().port; await new Promise(yes=>reserve.close(yes));
  const child=spawn(process.execPath,['examples/astro/dist-ssr/server/entry.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const close=async()=>{if(child.exitCode!==null || child.signalCode!==null)return;child.kill('SIGTERM');await new Promise(yes=>child.once('exit',yes));};
  const url=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null)throw Error(log);
      try {if((await fetch(url)).ok){ready=true;break;}}catch{}
      await new Promise(yes=>setTimeout(yes,50));
    }
    assert.ok(ready,`SSR listener not ready: ${log}`);
  } catch(error){await close();throw error;}
  return {url,pid:child.pid,port,launcher:process.execPath,log:()=>log,close};
}
